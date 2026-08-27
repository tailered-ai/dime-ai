/**
 * userMutation.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Tailered admin-console write-through endpoint (Phase 2, contract v1-mutation).
 *
 *   POST /api/admin/remote/user-mutation
 *
 * The tailered.ai worker signs a small mutation request with the SAME shared
 * secret pair as the Phase 1 snapshot push (tailered: ADMIN_SYNC_SECRET; dime:
 * TAILERED_SYNC_SECRET) and dime — the primary — executes a WHITELISTED subset
 * of the admin User Management mutations, then returns the freshly sanitized
 * contract-v1 user object so the tailered mirror can fold it in.
 *
 * Contract authority: docs/superpowers/specs/2026-08-27-dime-customer-writethrough-design.md
 * (tailered-os repo). The rules that matter here:
 *   - Whitelist v1: `update` over {role, hasAccess, expiryDate} and
 *     `forceLogout`. Passwords, create and delete stay on dime's own admin UI.
 *   - Whitelist v1.1: `setManualDiscordId` — the ONE identity field this
 *     channel may write, and only under dime's own setManualDiscordId rules
 *     (17–20 digit snowflake or "" to clear; never onto a user with a live
 *     discordId; rejected if the snowflake is any other user's live or manual
 *     Discord id — retired/soft-deleted rows included, because both columns
 *     are UNIQUE-indexed across ALL rows). The pre-write probe is only the
 *     cheap, clean error path: the write itself is the arbiter — a
 *     conditional update (`discordId IS NULL`) plus the unique indexes — so
 *     a claim that races the probe is a 409, never a 500 or a double claim.
 *     PREZ manages Discord connections from the Tailered console; every
 *     other identity/Discord operation still stays on dime's own admin UI.
 *   - Pre-auth ladder is a single uniform 404 {ok:false,error:"not_found"}
 *     for unprovisioned secret / missing signature / wrong signature — no
 *     oracle distinguishes the three. (dime's unknown /api paths fall through
 *     to the SPA, so byte-mimicry of "route absent" is not meaningful here;
 *     uniformity of the rejection is the property preserved.)
 *   - Anti-replay: body `sentAt` must be within ±5 minutes; the signature is
 *     over the raw body, and the `kind` discriminant keeps a captured Phase 1
 *     snapshot from ever replaying into this channel (or vice versa).
 *   - Signature verification is CONSTANT-TIME (crypto.timingSafeEqual over
 *     digest bytes) — customerSync.ts only ever signed; the verifier lives
 *     here.
 *   - Parity by construction with appUsers.updateUser (:1141-1230) and
 *     forceLogoutUser (:1280-1298): same update payload shape, same
 *     entitlement_events conditions/reasons (manual_grant / manual_revoke /
 *     manual_expiry_change), distinct actor "tailered-console" so remote
 *     mutations are attributable in the audit trail. The tRPC router itself
 *     is additive-only law and is never edited or imported.
 *   - Secret read from process.env at CALL time (cronAuth pattern) so a
 *     Railway variable change applies without a rebuild.
 *   - Detail of collaborator failures is logged server-side only; the wire
 *     response is always {ok:false,error:"internal_error"}.
 */

import { createHmac, timingSafeEqual } from "crypto";
import express from "express";
import type { SnapshotUser } from "../cron/customerSync";

export const REMOTE_MUTATION_PATH = "/api/admin/remote/user-mutation";
export const MUTATION_SIGNATURE_HEADER = "x-tailered-signature";
/** Mutation bodies are tiny; express.raw rejects anything above this with 413. */
export const MAX_MUTATION_BODY_BYTES = 64 * 1024;
/** Anti-replay window on the body's sentAt, both directions. */
const MAX_SENT_AT_SKEW_MS = 5 * 60 * 1000;

type Role = "owner" | "admin" | "handicapper" | "user";
/**
 * Roles this channel may ASSIGN. "owner" is deliberately excluded: Phase 1's
 * shared secret was read-only (snapshot push); this channel reuses the same
 * secret, so letting it mint owners would move owner-creation authority from
 * "an authenticated human owner in dime's admin" to "any holder of the sync
 * secret". Owner promotion stays in the dime admin. Demoting an existing owner
 * TO one of these is still allowed — a legitimate admin action.
 */
const SETTABLE_ROLES = ["admin", "handicapper", "user"] as const;
const SET_KEYS = ["role", "hasAccess", "expiryDate"] as const;

export type MutationSet = {
  role?: Role;
  hasAccess?: boolean;
  /** ISO-8601 or null (= lifetime). Converted to dime's ms representation. */
  expiryDate?: string | null;
};

export type RemoteMutation = {
  kind: "user-mutation";
  version: 1;
  sentAt: string;
  id: number;
  action: "update" | "forceLogout" | "setManualDiscordId";
  set?: MutationSet;
  /** setManualDiscordId only: 17–20 digit snowflake, or "" to clear. */
  manualDiscordId?: string;
};

/** A Discord snowflake is 17–20 digits (Discord spec). */
const SNOWFLAKE_RE = /^\d{17,20}$/;

/** Structural slice of the app_users row this module reads. */
export type MutationTargetRow = {
  id: number;
  username: string;
  hasAccess: boolean;
  expiryDate: number | null;
  stripePlanId: string | null;
  deletedAt: number | null;
} & Record<string, unknown>;

/**
 * Tri-state existence result. A lookup FAULT must never read as "user absent":
 * getAppUserById's legacy null merges the two, which for a privileged
 * grant/revoke would turn a transient DB outage into a silent no-op 404.
 */
export type UserLookup =
  | { status: "found"; user: MutationTargetRow }
  | { status: "not_found" }
  | { status: "unavailable" };

/** Strip CR/LF so a free-text value can't forge log lines (CodeQL js/log-injection). */
const logSafe = (v: unknown): string => String(v).replace(/[\r\n]+/g, " ");

export type EntitlementEventParams = {
  userId: number;
  stripeEventId: string | null;
  eventType: string;
  reason: string;
  actor?: string;
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
};

/** Injectable collaborators; every default lazy-imports the real module. */
export interface MutationDeps {
  lookupUser?: (id: number) => Promise<UserLookup>;
  updateUser?: (
    id: number,
    data: { role?: Role; hasAccess?: boolean; expiryDate?: number | null }
  ) => Promise<void>;
  /**
   * Set (snowflake) or clear (null) a user's pre-registered manual Discord id.
   * The write is conditional + unique-index guarded, so it reports the race
   * outcomes itself: "already_connected" (target gained a live discordId) or
   * "duplicate" (another row claimed the snowflake).
   */
  setManualDiscordId?: (
    id: number,
    value: string | null
  ) => Promise<"ok" | "already_connected" | "duplicate">;
  /** Uniqueness probe: any user holding this snowflake as live/manual id. */
  findByDiscordSnowflake?: (
    snowflake: string
  ) => Promise<{ id: number; username: string } | null>;
  incrementTokenVersion?: (id: number) => Promise<number>;
  recordEvent?: (params: EntitlementEventParams) => Promise<void>;
  loadSanitizedUser?: (id: number) => Promise<SnapshotUser | null>;
  now?: () => number;
}

/**
 * Verify `x-tailered-signature: sha256=<hex>` — HMAC-SHA256 of the raw body
 * with the shared secret. Hex is case-insensitive; the compare is
 * crypto.timingSafeEqual over the decoded digest bytes.
 */
export function verifyTaileredSignature(
  rawBody: string | Buffer,
  header: string | null | undefined,
  secret: string
): boolean {
  if (!header || !header.startsWith("sha256=")) return false;
  const provided = header.slice("sha256=".length).toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(provided)) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest();
  return timingSafeEqual(expected, Buffer.from(provided, "hex"));
}

function reject(
  status: number,
  error: string
): { status: number; body: unknown } {
  return { status, body: { ok: false, error } };
}

/** Parse + structurally validate the post-auth body. null = invalid. */
function parseSet(raw: unknown): MutationSet | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    return null;
  const obj = raw as Record<string, unknown>;
  const keys = Object.keys(obj);
  if (keys.length === 0) return null;
  if (keys.some(k => !(SET_KEYS as readonly string[]).includes(k))) return null;
  const set: MutationSet = {};
  if ("role" in obj) {
    if (!SETTABLE_ROLES.includes(obj.role as (typeof SETTABLE_ROLES)[number])) {
      return null;
    }
    set.role = obj.role as Role;
  }
  if ("hasAccess" in obj) {
    if (typeof obj.hasAccess !== "boolean") return null;
    set.hasAccess = obj.hasAccess;
  }
  if ("expiryDate" in obj) {
    const v = obj.expiryDate;
    if (v !== null && (typeof v !== "string" || Number.isNaN(Date.parse(v)))) {
      return null;
    }
    set.expiryDate = v as string | null;
  }
  return set;
}

/**
 * Full request ladder over an already-received raw body. Returns the HTTP
 * status + JSON body; the express registrar is a thin wire around this.
 */
export async function executeRemoteMutation(
  rawBody: string | Buffer,
  signature: string | null | undefined,
  deps: MutationDeps = {}
): Promise<{ status: number; body: unknown }> {
  const secret = process.env.TAILERED_SYNC_SECRET;
  if (!secret) return reject(404, "not_found"); // fail closed when unprovisioned
  if (!verifyTaileredSignature(rawBody, signature, secret)) {
    return reject(404, "not_found");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(
      typeof rawBody === "string" ? rawBody : rawBody.toString("utf8")
    );
  } catch {
    return reject(400, "invalid_body");
  }
  if (typeof parsed !== "object" || parsed === null)
    return reject(400, "invalid_body");
  const req = parsed as Record<string, unknown>;

  if (req.kind !== "user-mutation" || req.version !== 1) {
    return reject(400, "unsupported");
  }

  const now = (deps.now ?? Date.now)();
  const sentAtMs =
    typeof req.sentAt === "string" ? Date.parse(req.sentAt) : Number.NaN;
  if (
    Number.isNaN(sentAtMs) ||
    Math.abs(now - sentAtMs) > MAX_SENT_AT_SKEW_MS
  ) {
    return reject(409, "stale_request");
  }

  const id = req.id;
  if (typeof id !== "number" || !Number.isInteger(id) || id <= 0) {
    return reject(400, "invalid_body");
  }
  const action = req.action;
  if (
    action !== "update" &&
    action !== "forceLogout" &&
    action !== "setManualDiscordId"
  ) {
    return reject(400, "invalid_body");
  }
  // Only setManualDiscordId carries manualDiscordId; a stray one elsewhere is malformed.
  if (action !== "setManualDiscordId" && req.manualDiscordId !== undefined) {
    return reject(400, "invalid_body");
  }
  let set: MutationSet | null = null;
  let manualDiscordId: string | null = null; // normalized: snowflake, or null = clear
  if (action === "update") {
    set = parseSet(req.set);
    if (set === null) return reject(400, "invalid_body");
  } else {
    // forceLogout / setManualDiscordId carry no `set` — a stray one is malformed.
    if (req.set !== undefined) return reject(400, "invalid_body");
    if (action === "setManualDiscordId") {
      const v = req.manualDiscordId;
      if (typeof v !== "string") return reject(400, "invalid_body");
      const trimmed = v.trim();
      if (trimmed === "") {
        manualDiscordId = null; // explicit clear
      } else if (SNOWFLAKE_RE.test(trimmed)) {
        manualDiscordId = trimmed;
      } else {
        return reject(400, "invalid_discord_id");
      }
    }
  }

  try {
    const lookupUser =
      deps.lookupUser ??
      ((await import("../db")).lookupAppUserByIdFresh as unknown as NonNullable<
        MutationDeps["lookupUser"]
      >);
    const found = await lookupUser(id);
    if (found.status === "unavailable") {
      // A DB fault is not an absent user. Fail LOUD (500) so the console
      // retries — never silently no-op a grant/revoke as a 404. (codex/cursor P2)
      console.error(
        `[RemoteAdmin][user-mutation][FAIL] lookup unavailable userId=${logSafe(id)}`
      );
      return reject(500, "internal_error");
    }
    if (found.status === "not_found" || found.user.deletedAt != null) {
      return reject(404, "user_not_found");
    }
    const existing = found.user;

    if (action === "update") {
      const updateUser =
        deps.updateUser ??
        ((await import("../db")).updateAppUser as NonNullable<
          MutationDeps["updateUser"]
        >);
      const data: {
        role?: Role;
        hasAccess?: boolean;
        expiryDate?: number | null;
      } = {};
      if (set!.role !== undefined) data.role = set!.role;
      if (set!.hasAccess !== undefined) data.hasAccess = set!.hasAccess;
      const expiryTouched = set !== null && "expiryDate" in set!;
      const newExpiryMs = expiryTouched
        ? set!.expiryDate === null
          ? null
          : Date.parse(set!.expiryDate as string)
        : undefined;
      if (expiryTouched) data.expiryDate = newExpiryMs as number | null;

      await updateUser(id, data);

      // Audit parity with appUsers.updateUser:1197-1219 — an event ONLY when
      // access or expiry actually moved; identity-free edits stay quiet.
      const accessChanged =
        data.hasAccess !== undefined && data.hasAccess !== existing.hasAccess;
      const expiryChanged =
        expiryTouched && newExpiryMs !== (existing.expiryDate ?? null);
      if (accessChanged || expiryChanged) {
        const recordEvent =
          deps.recordEvent ??
          ((await import("../stripe/entitlementLedger"))
            .recordEntitlementEvent as NonNullable<
            MutationDeps["recordEvent"]
          >);
        await recordEvent({
          userId: id,
          stripeEventId: null,
          eventType: "admin.update_user",
          reason: accessChanged
            ? data.hasAccess
              ? "manual_grant"
              : "manual_revoke"
            : "manual_expiry_change",
          actor: "tailered-console",
          before: {
            hasAccess: existing.hasAccess,
            planId: existing.stripePlanId ?? null,
            expiryDate: existing.expiryDate ?? null,
          },
          after: {
            hasAccess: data.hasAccess ?? existing.hasAccess,
            planId: existing.stripePlanId ?? null,
            expiryDate: expiryTouched
              ? (newExpiryMs as number | null)
              : (existing.expiryDate ?? null),
          },
        });
      }
    } else if (action === "forceLogout") {
      const incrementTokenVersion =
        deps.incrementTokenVersion ??
        ((await import("../db")).incrementTokenVersion as NonNullable<
          MutationDeps["incrementTokenVersion"]
        >);
      await incrementTokenVersion(id);
    } else {
      // setManualDiscordId — the one identity write, under dime's own rules.
      if (manualDiscordId !== null) {
        // Never overwrite a live Discord connection: that id is authoritative.
        const liveDiscordId = existing.discordId as string | null | undefined;
        if (typeof liveDiscordId === "string" && liveDiscordId.length > 0) {
          return reject(409, "already_connected");
        }
        // Uniqueness: the snowflake must not be any OTHER user's live/manual id
        // (retired rows included). This probe is the cheap, clean error path;
        // the write below is the actual arbiter for anything that races it.
        const findByDiscordSnowflake =
          deps.findByDiscordSnowflake ??
          ((await import("../db"))
            .lookupAppUserByDiscordSnowflake as NonNullable<
            MutationDeps["findByDiscordSnowflake"]
          >);
        const clash = await findByDiscordSnowflake(manualDiscordId);
        if (clash && clash.id !== id) {
          return reject(409, "discord_id_taken");
        }
      }
      const setManualDiscordId =
        deps.setManualDiscordId ??
        ((await import("../db")).setAppUserManualDiscordId as NonNullable<
          MutationDeps["setManualDiscordId"]
        >);
      const wrote = await setManualDiscordId(id, manualDiscordId);
      if (wrote === "already_connected")
        return reject(409, "already_connected");
      if (wrote === "duplicate") return reject(409, "discord_id_taken");
    }

    const loadSanitizedUser =
      deps.loadSanitizedUser ??
      ((await import("../cron/customerSync"))
        .buildSanitizedUserById as NonNullable<
        MutationDeps["loadSanitizedUser"]
      >);
    const user = await loadSanitizedUser(id);
    if (!user) {
      // The row existed a moment ago; a missing reload is a fault, not a 404.
      console.error(
        `[RemoteAdmin][user-mutation][FAIL] sanitized reload empty userId=${logSafe(id)}`
      );
      return reject(500, "internal_error");
    }

    // Counts/fields only — never body content (the payload is member PII).
    console.log(
      `[RemoteAdmin][user-mutation][OK] action=${logSafe(action)} userId=${logSafe(id)}` +
        (set ? ` fields=${logSafe(JSON.stringify(Object.keys(set)))}` : "")
    );
    return { status: 200, body: { ok: true, user } };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(
      `[RemoteAdmin][user-mutation][FAIL] userId=${logSafe(id)} error=${logSafe(msg)}`
    );
    return reject(500, "internal_error");
  }
}

/**
 * Express registrar. MUST be mounted BEFORE express.json() (stripe-webhook
 * precedent, server/_core/index.ts) so the raw body survives for HMAC
 * verification. Sits before the global /api limiter for the same reason;
 * pre-auth cost is one HMAC over a ≤64 KB body.
 */
export function registerRemoteAdminRoute(
  app: express.Express,
  limiter?: express.RequestHandler
): void {
  // Sibling /api routes sit behind the global limiter (index.ts). This route
  // registers BEFORE it (raw body for HMAC), so it must carry the limiter
  // itself or it would be the one /api path exempt from flood control. (codex P2)
  const raw = express.raw({
    type: "application/json",
    limit: MAX_MUTATION_BODY_BYTES,
  });
  const chain = limiter ? [limiter, raw] : [raw];
  app.post(REMOTE_MUTATION_PATH, ...chain, async (req, res) => {
    const rawBody = Buffer.isBuffer(req.body)
      ? req.body
      : typeof req.body === "string"
        ? req.body
        : ""; // non-JSON content-type: raw parser skipped it — signature fails
    const header = req.headers[MUTATION_SIGNATURE_HEADER];
    const out = await executeRemoteMutation(
      rawBody,
      Array.isArray(header) ? header[0] : header
    );
    res.status(out.status).json(out.body);
  });
}
