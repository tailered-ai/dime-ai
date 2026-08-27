/**
 * customerSync.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Tailered customer-mirror push (Phase 1, contract v1).
 *
 * Builds a SANITIZED snapshot of the live customer base and POSTs it,
 * HMAC-SHA256-signed, to the tailered.ai ingest endpoint
 * (`POST /api/admin/customer-sync`). One-way, push-based; dime stays primary.
 *
 * Contract authority: docs/superpowers/specs/2026-08-26-dime-customer-mirror-design.md
 * (tailered-os repo). The rules that matter here:
 *   - Explicit ALLOW-LIST construction of every user object — the DB row is
 *     never spread, so credential/security columns (passwordHash, reset tokens,
 *     lockout state, tokenVersion, pending* checkout fields) cannot leak.
 *   - Row filter: `deletedAt IS NULL` only. `listAppUsers()` has no such
 *     filter, so it is enforced here — in the default Drizzle query AND again
 *     in the builder, so an injected row source cannot bypass it.
 *   - All timestamps are ISO-8601 strings or null; `expiryDate: null` = lifetime.
 *   - `entitled` / `accessSource` / plan resolution replicate
 *     appUsers.listUsers (server/routers/appUsers.ts:740-830) BY CONSTRUCTION —
 *     read for parity, never edited (additive-only law).
 *   - Header `x-dime-signature: sha256=<hex>` = HMAC-SHA256 of the raw body
 *     with TAILERED_SYNC_SECRET. The secret is never logged; neither is the
 *     payload body (it contains member PII).
 *   - Unconfigured env (either var unset) → explicit no-op result, never a crash.
 *
 * ENV (both optional; see server/_core/env.ts + .env.example):
 *   TAILERED_SYNC_URL    e.g. https://tailered.ai/api/admin/customer-sync
 *   TAILERED_SYNC_SECRET shared HMAC secret (tailered side: ADMIN_SYNC_SECRET)
 * Read from process.env at CALL time — same pattern as CRON_SECRET in
 * cronAuth.ts — so a Railway variable change applies on the next run without
 * a rebuild.
 */

import { createHmac } from "crypto";
import { eq, isNull } from "drizzle-orm";
import { appUsers, planPrices, subscriptionPlans } from "../../drizzle/schema";

// ─── Contract v1 shapes ──────────────────────────────────────────────────────

export type SnapshotPlan = {
  slug: string;
  name: string;
  planType: string;
  billingInterval: string | null;
  amountCents: number | null;
  currency: string | null;
  /** true/false when the exact price is known (null billingInterval = one-off
   *  = lifetime SKU); null when only the plan slug resolved. */
  isLifetime: boolean | null;
};

export type SnapshotUser = {
  id: number;
  email: string;
  username: string;
  role: "owner" | "admin" | "handicapper" | "user";
  hasAccess: boolean;
  /** ISO-8601 or null; null = lifetime access. */
  expiryDate: string | null;
  createdAt: string | null;
  lastSignedIn: string | null;
  termsAccepted: boolean;
  termsAcceptedAt: string | null;
  discordId: string | null;
  discordUsername: string | null;
  discordConnectedAt: string | null;
  manualDiscordId: string | null;
  /** Computed dime-side with listUsers' exact predicate — parity by construction. */
  entitled: boolean;
  pendingSetup: boolean;
  accessSource: "stripe" | "manual";
  plan: SnapshotPlan | null;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  stripeSubscriptionStatus: string | null;
  cancelAtPeriodEnd: boolean | null;
};

export type SnapshotV1 = {
  version: 1;
  source: "aisportsbettingmodels.com";
  generatedAt: string;
  users: SnapshotUser[];
};

// ─── Row / catalogue source types (dependency-injected for tests) ────────────

/**
 * The columns the builder READS from an app_users row. Extra keys (including
 * the forbidden credential columns a real DB row carries) are absorbed by the
 * index signature and ignored by the allow-list construction below.
 */
export type CustomerSourceRow = {
  id: number;
  email: string;
  username: string;
  role: "owner" | "admin" | "handicapper" | "user";
  hasAccess: boolean;
  expiryDate: number | null;
  deletedAt: number | null;
  termsAccepted: boolean;
  termsAcceptedAt: number | null;
  discordId: string | null;
  discordUsername: string | null;
  discordConnectedAt: number | null;
  manualDiscordId: string | null;
  createdAt: Date | null;
  lastSignedIn: Date | null;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  stripePlanId: string | null;
  planPriceId: number | null;
  stripeSubscriptionStatus: string | null;
  cancelAtPeriodEnd: boolean | null;
  pendingSetup: boolean;
} & Record<string, unknown>;

export type CataloguePlan = { slug: string; name: string; planType: string };

export type CataloguePrice = {
  amountCents: number | null;
  currency: string | null;
  billingInterval: string | null;
  plan: CataloguePlan;
};

export type BillingCatalogue = {
  byPriceId: Map<number, CataloguePrice>;
  byPlanSlug: Map<string, CataloguePlan>;
};

export interface SnapshotDeps {
  loadRows?: () => Promise<CustomerSourceRow[]>;
  loadCatalogue?: () => Promise<BillingCatalogue>;
  now?: () => number;
}

// ─── Default DB-backed loaders ───────────────────────────────────────────────
// `../db` is imported dynamically so that importing THIS module (e.g. from
// cronRoutes and its registration test) never drags in the DB pool machinery.

/**
 * Explicit column projection shared by both DB loaders = defense in depth:
 * sanitizeRow's allow-list already strips credential columns, but the query
 * itself never even fetches them (passwordHash, reset/lockout state,
 * tokenVersion, pending* checkout fields stay in the DB). Exactly the
 * CustomerSourceRow named columns — the 20 sanitizeRow reads + deletedAt (row
 * filter) — accessSource derives from stripeCustomerId, entitled from
 * hasAccess/expiryDate, both included.
 */
const CUSTOMER_ROW_PROJECTION = {
  id: appUsers.id,
  email: appUsers.email,
  username: appUsers.username,
  role: appUsers.role,
  hasAccess: appUsers.hasAccess,
  expiryDate: appUsers.expiryDate,
  deletedAt: appUsers.deletedAt,
  termsAccepted: appUsers.termsAccepted,
  termsAcceptedAt: appUsers.termsAcceptedAt,
  discordId: appUsers.discordId,
  discordUsername: appUsers.discordUsername,
  discordConnectedAt: appUsers.discordConnectedAt,
  manualDiscordId: appUsers.manualDiscordId,
  createdAt: appUsers.createdAt,
  lastSignedIn: appUsers.lastSignedIn,
  stripeCustomerId: appUsers.stripeCustomerId,
  stripeSubscriptionId: appUsers.stripeSubscriptionId,
  stripePlanId: appUsers.stripePlanId,
  planPriceId: appUsers.planPriceId,
  stripeSubscriptionStatus: appUsers.stripeSubscriptionStatus,
  cancelAtPeriodEnd: appUsers.cancelAtPeriodEnd,
  pendingSetup: appUsers.pendingSetup,
} as const;

async function loadRowsFromDb(): Promise<CustomerSourceRow[]> {
  const [{ getDb }, { withCircuitBreaker }] = await Promise.all([
    import("../db"),
    import("../dbCircuitBreaker"),
  ]);
  const db = await getDb();
  // An unavailable DB must THROW, never resolve to [] — the downstream mirror
  // replaces its whole table with the snapshot, so a silent empty result here
  // would read as "customer base is empty" and wipe it. pushCustomerSnapshot
  // converts the throw into {ok:false} and the hourly workflow goes red.
  if (!db) throw new Error("customer-sync: db unavailable");
  // Same circuit-breaker convention as listAppUsers (server/db.ts:527) — but
  // WITHOUT its catch-to-[] fallback, for the wipe reason above: a breaker-open
  // fast-fail must propagate as a throw, not masquerade as an empty base.
  const rows = await withCircuitBreaker(async () =>
    db
      .select(CUSTOMER_ROW_PROJECTION)
      .from(appUsers)
      // deletedAt IS NULL — the spec's row filter. listAppUsers() has no such
      // filter, so the snapshot query applies it directly.
      .where(isNull(appUsers.deletedAt))
      .orderBy(appUsers.createdAt)
  );
  return rows as CustomerSourceRow[];
}

/**
 * Replicates the billing-catalogue join loadBillingCatalogue() performs in
 * server/routers/appUsers.ts:320-366 (read for parity — that function is
 * private to the router and the router must not be edited). Degrades to an
 * empty catalogue on failure, exactly like the original: roles/access still
 * mirror even when plan detail is unavailable.
 */
async function loadCatalogueFromDb(): Promise<BillingCatalogue> {
  const byPriceId = new Map<number, CataloguePrice>();
  const byPlanSlug = new Map<string, CataloguePlan>();
  const { getDb } = await import("../db");
  const db = await getDb();
  if (!db) return { byPriceId, byPlanSlug };
  try {
    const rows = await db
      .select({
        priceId: planPrices.id,
        amountCents: planPrices.amountCents,
        currency: planPrices.currency,
        // Drizzle property is `interval`; the DB column is `billingInterval`.
        billingInterval: planPrices.interval,
        slug: subscriptionPlans.slug,
        name: subscriptionPlans.name,
        planType: subscriptionPlans.planType,
      })
      .from(planPrices)
      .innerJoin(
        subscriptionPlans,
        eq(subscriptionPlans.id, planPrices.planId)
      );
    for (const r of rows) {
      const plan: CataloguePlan = {
        slug: r.slug,
        name: r.name,
        planType: r.planType,
      };
      byPriceId.set(r.priceId, {
        amountCents: r.amountCents,
        currency: r.currency,
        billingInterval: r.billingInterval ?? null,
        plan,
      });
      if (!byPlanSlug.has(r.slug)) byPlanSlug.set(r.slug, plan);
    }
  } catch (err) {
    console.error(
      `[CustomerSync][catalogue][FAIL] ${(err as Error)?.message ?? String(err)}`
    );
  }
  return { byPriceId, byPlanSlug };
}

// ─── Sanitization ────────────────────────────────────────────────────────────

/** ms-timestamp or Date → ISO-8601 string; null/undefined/invalid → null. */
function toIso(value: number | Date | null | undefined): string | null {
  if (value == null) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * Explicit allow-list construction of the contract user object. NEVER spread
 * the row — that is the entire forbidden-fields guarantee.
 */
function sanitizeRow(
  row: CustomerSourceRow,
  catalogue: BillingCatalogue,
  now: number
): SnapshotUser {
  // Plan resolution parity (appUsers.ts:761-762): priceId identifies the exact
  // SKU; fall back to the plan slug for rows predating planPriceId.
  const price =
    row.planPriceId != null
      ? (catalogue.byPriceId.get(row.planPriceId) ?? null)
      : null;
  const plan =
    price?.plan ??
    (row.stripePlanId
      ? (catalogue.byPlanSlug.get(row.stripePlanId) ?? null)
      : null);

  // Entitlement parity (appUsers.ts:767): hasAccess is the master switch,
  // NULL expiry means lifetime, boundary is inclusive (now <= expiryDate).
  const entitled =
    Boolean(row.hasAccess) && (row.expiryDate == null || now <= row.expiryDate);

  return {
    id: row.id,
    email: row.email,
    username: row.username,
    role: row.role,
    hasAccess: Boolean(row.hasAccess),
    expiryDate: toIso(row.expiryDate),
    createdAt: toIso(row.createdAt),
    lastSignedIn: toIso(row.lastSignedIn),
    termsAccepted: Boolean(row.termsAccepted),
    termsAcceptedAt: toIso(row.termsAcceptedAt),
    discordId: row.discordId ?? null,
    discordUsername: row.discordUsername ?? null,
    discordConnectedAt: toIso(row.discordConnectedAt),
    manualDiscordId: row.manualDiscordId ?? null,
    entitled,
    pendingSetup: Boolean(row.pendingSetup),
    // accessSource parity (appUsers.ts:826): a Stripe customer exists = "stripe".
    accessSource: row.stripeCustomerId ? "stripe" : "manual",
    plan: plan
      ? {
          slug: plan.slug,
          name: plan.name,
          planType: plan.planType,
          billingInterval: price?.billingInterval ?? null,
          amountCents: price?.amountCents ?? null,
          currency: price?.currency ?? null,
          isLifetime: price ? price.billingInterval == null : null,
        }
      : null,
    stripeCustomerId: row.stripeCustomerId ?? null,
    stripeSubscriptionId: row.stripeSubscriptionId ?? null,
    stripeSubscriptionStatus: row.stripeSubscriptionStatus ?? null,
    cancelAtPeriodEnd: row.cancelAtPeriodEnd ?? null,
  };
}

// ─── Public API ──────────────────────────────────────────────────────────────

/** Build the sanitized contract-v1 snapshot of the live (non-deleted) customer base. */
export async function buildCustomerSnapshot(
  deps: SnapshotDeps = {}
): Promise<SnapshotV1> {
  const [rows, catalogue] = await Promise.all([
    (deps.loadRows ?? loadRowsFromDb)(),
    (deps.loadCatalogue ?? loadCatalogueFromDb)(),
  ]);
  const now = (deps.now ?? Date.now)();
  const users = rows
    // Enforced here as well as in the default query, so no row source —
    // injected or future — can leak a soft-deleted account.
    .filter(row => row.deletedAt == null)
    .map(row => sanitizeRow(row, catalogue, now));
  return {
    version: 1,
    source: "aisportsbettingmodels.com",
    generatedAt: new Date(now).toISOString(),
    users,
  };
}

/**
 * Phase 2 write-through: rebuild the sanitized contract-v1 user object for ONE
 * live (non-deleted) user — the response body of a confirmed remote mutation
 * (server/remoteAdmin/userMutation.ts). Same allow-list constructor, same
 * catalogue join, same injection seams as the full snapshot; null when the id
 * is unknown or soft-deleted.
 */
export async function buildSanitizedUserById(
  id: number,
  deps: SnapshotDeps = {}
): Promise<SnapshotUser | null> {
  const [rows, catalogue] = await Promise.all([
    deps.loadRows ? deps.loadRows() : loadRowByIdFromDb(id),
    (deps.loadCatalogue ?? loadCatalogueFromDb)(),
  ]);
  const row = rows.find(r => r.id === id && r.deletedAt == null);
  if (!row) return null;
  return sanitizeRow(row, catalogue, (deps.now ?? Date.now)());
}

/** Single-row variant of loadRowsFromDb — same projection, WHERE id = ?. */
async function loadRowByIdFromDb(id: number): Promise<CustomerSourceRow[]> {
  const [
    { getDb },
    { withCircuitBreaker },
    { and, eq: eqOp, isNull: isNullOp },
  ] = await Promise.all([
    import("../db"),
    import("../dbCircuitBreaker"),
    import("drizzle-orm"),
  ]);
  const db = await getDb();
  if (!db) throw new Error("customer-sync: db unavailable");
  const rows = await withCircuitBreaker(async () =>
    db
      .select(CUSTOMER_ROW_PROJECTION)
      .from(appUsers)
      .where(and(eqOp(appUsers.id, id), isNullOp(appUsers.deletedAt)))
      .limit(1)
  );
  return rows as CustomerSourceRow[];
}

/** `x-dime-signature` value: HMAC-SHA256 hex of the RAW request body. */
export function signSnapshot(rawBody: string, secret: string): string {
  return (
    "sha256=" +
    createHmac("sha256", secret).update(rawBody, "utf8").digest("hex")
  );
}

export type PushResult = {
  ok: boolean;
  skipped?: string;
  users?: number;
  status?: number;
  /** Payload size (Buffer.byteLength of the raw JSON body); runway telemetry. */
  bytes?: number;
  error?: string;
};

export interface PushDeps extends SnapshotDeps {
  fetchImpl?: typeof fetch;
}

/** Non-2xx or thrown fetch = failure result; 15s timeout; secret never logged. */
const PUSH_TIMEOUT_MS = 15_000;

/**
 * Build, sign, and POST the snapshot to TAILERED_SYNC_URL. When either env var
 * is unset this is an EXPLICIT no-op ({ok:true, skipped:"unconfigured"}) — the
 * route stays inert until Railway configures both, and never crashes.
 */
export async function pushCustomerSnapshot(
  deps: PushDeps = {}
): Promise<PushResult> {
  const url = process.env.TAILERED_SYNC_URL;
  const secret = process.env.TAILERED_SYNC_SECRET;
  if (!url || !secret) {
    return { ok: true, skipped: "unconfigured" };
  }

  let snapshot: SnapshotV1;
  try {
    snapshot = await buildCustomerSnapshot(deps);
  } catch (err) {
    // DB unavailable / circuit open / query failure. Surface as ok:false (the
    // cron route maps it to 502, reddening the workflow) — never push anything.
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[CustomerSync][push][FAIL] snapshot build: ${msg}`);
    return { ok: false, error: msg };
  }

  // A legitimately empty dime user base does not exist, so zero users always
  // means a fault upstream. Pushing it would wipe the downstream mirror
  // (tailered replaces its whole table with the snapshot) — refuse instead.
  if (snapshot.users.length === 0) {
    console.error("[CustomerSync][push][FAIL] empty snapshot refused");
    return { ok: false, error: "empty_snapshot_refused" };
  }

  const body = JSON.stringify(snapshot);
  const bytes = Buffer.byteLength(body);
  // Runway line: row count + payload size only, logged BEFORE the fetch so it
  // survives a hung/killed push. NEVER the body itself — it carries member PII.
  console.log(
    `[Cron:customer-sync] payload users=${snapshot.users.length} bytes=${bytes}`
  );
  const doFetch = deps.fetchImpl ?? fetch;

  let res: Response;
  try {
    res = await doFetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-dime-signature": signSnapshot(body, secret),
      },
      body,
      signal: AbortSignal.timeout(PUSH_TIMEOUT_MS),
    });
  } catch (err) {
    // Error message only — never the secret, never the payload (member PII).
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[CustomerSync][push][FAIL] fetch error: ${msg}`);
    return { ok: false, error: msg };
  }

  if (!res.ok) {
    // Surface the HTTP status — the cron route maps 409 (receiver correctly
    // rejected a superseded/stale snapshot) to a 200 skip; everything else 502.
    console.error(`[CustomerSync][push][FAIL] HTTP ${res.status}`);
    return { ok: false, status: res.status, bytes };
  }

  console.log(
    `[CustomerSync][push][OK] HTTP ${res.status} users=${snapshot.users.length}`
  );
  return { ok: true, users: snapshot.users.length, status: res.status, bytes };
}
