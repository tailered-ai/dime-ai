import "dotenv/config";
import express from "express";
import { createServer } from "http";
import net from "net";
import compression from "compression";
import rateLimit from "express-rate-limit";
import {
  clientIpKey,
  createTrpcRateLimitDispatch,
  isReservedOrInternalIp,
  resolveClientIp,
  sendRateLimitResponse,
} from "./trpcRateLimitPolicy";
import { resolveClientIdentity, identitySource } from "./clientIdentity";
import {
  cfConnectingIp,
  edgeMode,
  edgeProofPasses,
  immediateUpstreamIp,
  isCloudflareEdgeIp,
} from "./edgeProxy";
import { originLock } from "./originLock";
import {
  currentSchemaVerdict,
  runBootSchemaProbe,
  shouldFailHealthForSchema,
  startSchemaProbeInterval,
} from "./schemaHealthGate";
import { isAnalyticsStore } from "../analytics/config";
import helmet from "helmet";
import { permissionsPolicy } from "./securityHeaders";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import { registerStorageProxy } from "./storageProxy";
import { registerDiscordAuthRoutes } from "../discordAuth";
import { registerDiscordLoginRoutes } from "../discordLogin";
import { registerDiscordInviteRoutes } from "../discordInvite";
import { appRouter } from "../routers";
import { createContext } from "./context";
import { serveStatic, setupVite } from "./vite";
import { startDailyPurgeSchedule } from "../dailyPurge";
import { startVsinAutoRefresh } from "../vsinAutoRefresh";
import { startNhlModelSyncScheduler } from "../nhlModelSync";
import { startNhlGoalieWatcher } from "../nhlGoalieWatcher";
import { startDiscordBot } from "../discord/bot";
import { startMlbPlayerSyncScheduler } from "../mlbPlayerSync";
import { insertSecurityEvent } from "../db";
import { startSecurityDigestScheduler } from "../securityDigest";
import { startWeeklySecurityDigestScheduler } from "../weeklySecurityDigest";
import {
  postSecurityAlert,
  SECURITY_CHANNEL_ID,
} from "../discord/discordSecurityAlert";
import { EmbedBuilder, TextChannel } from "discord.js";
import { startMlbScheduleHistoryScheduler } from "../mlbScheduleHistoryScheduler";
import { startNbaScheduleHistoryScheduler } from "../nbaScheduleHistoryScheduler";
import { startNhlScheduleHistoryScheduler } from "../nhlScheduleHistoryScheduler";
import { startMlbNightlyTrendsScheduler } from "../mlbNightlyTrendsRefresh";
import { prewarmSlateCache } from "../actionNetwork";
import { startBetAutoGradeScheduler } from "../betAutoGradeScheduler";
import { startMlbOutcomeAndDriftScheduler } from "../mlbOutcomeAndDriftScheduler";
import { startMlbModelSyncScheduler } from "../mlbModelRunner";
import { getCircuitStatus, getCacheStats } from "../dbCircuitBreaker";
import {
  getDb,
  listGames,
  getCacheHealthStats,
  getAvailableDates,
  forceInvalidateGamesCache,
} from "../db";
import { ensureDebugLogsTable } from "./debugLogger";
import { registerAnalyticsIngestRoute } from "../analytics/ingestRoute";
import { registerAnalyticsReadRoute } from "../analytics/readRoute";
import { registerStripeWebhookRoute, getWebhookLatencyStats } from "../stripeWebhook";
import { registerRemoteAdminRoute } from "../remoteAdmin/userMutation";
import { runSchemaGuardPreflight } from "./schemaGuard";
import { registerWc2026Heartbeats } from "../wc2026/wc2026Heartbeat";
import { registerCronRoutes } from "../cron/cronRoutes";
import { registerDimeChatRoute } from "../dime-chat.route";
import { startDimeChatTraceRetentionScheduler } from "../dimeChatTrace";
import { registerDimeWC2026Route } from "../dime-wc2026.route";
import { jwtVerify } from "jose";
import { parse as parseCookieHeader } from "cookie";
import { ENV } from "./env";
import { reportBillingAlertTransport } from "./billingAlerts";
import { getDiscordBotHealth, getDiscordClient } from "../discord/bot";
import { invalidateAppUserByIdCache, lookupAppUserByIdFresh } from "../db";
import { getCachedAppUserEntry, setCachedAppUser } from "../dbCircuitBreaker";
import { resolveOwnerIdentity } from "../ownerAuth";
import { readBuildCommit } from "./buildIdentity";
import { installFatalErrorHandler } from "./fatalErrorHandler";
import { logSafe } from "./logSafe";
import {
  formatDimeRuntimeReadinessLog,
  getDimeRuntimeReadiness,
} from "./dimeRuntimeReadiness";
import {
  formatDimePricingAttestationLog,
  getDimePricingAttestation,
} from "./dimePricingAttestation";

// ─── Owner-only app_session auth (Railway-native) ──────────────────────────────
// The legacy owner debug endpoints authenticated via the retired platform's SDK
// request-auth helper + an OWNER_OPEN_ID comparison against its OAuth server —
// permanently dead now. This mirrors ownerProcedure() in routers/appUsers.ts: verify the
// app_session JWT with ENV.cookieSecret, require type === "app_user", load the user
// row (DB-authoritative — NEVER trust payload.role, a JWT is signed at login and a
// later demotion must take effect immediately), enforce the tokenVersion check, then
// gate on DB role === "owner" (hasAccess/JWT role are NOT enough).
//
// DB-unavailability: these are debug endpoints (e.g. /api/db-status exists to report
// DB health), so a hard-down DB must not lock an owner out entirely. We reuse the
// same reviewed in-memory cache fallback as ownerProcedure (getCachedAppUser) — never
// a bespoke one. The cached row, not the JWT, still supplies the role. If there is no
// cache hit either, we fail closed (401) — a locked-out owner beats an open debug
// endpoint.
// Returns "unauthenticated" (→401) vs "forbidden" (→403) vs an authorized userId.
type OwnerAuthResult =
  | { ok: true; userId: number }
  | { ok: false; status: 401 | 403 };

async function authenticateOwnerRequest(
  req: express.Request
): Promise<OwnerAuthResult> {
  const cookies = parseCookieHeader(req.headers.cookie ?? "");
  const token = cookies["app_session"];
  if (!token) return { ok: false, status: 401 };
  try {
    const secret = new TextEncoder().encode(ENV.cookieSecret);
    const { payload } = await jwtVerify(token, secret);
    if (payload.type !== "app_user") return { ok: false, status: 401 };

    const userId = Number(payload.sub);
    const tv = payload.tv as number | null | undefined;

    const fallback = getCachedAppUserEntry(userId);
    invalidateAppUserByIdCache(userId);
    const lookup = await lookupAppUserByIdFresh(userId);
    if (lookup.status === "found") setCachedAppUser(lookup.user);
    const resolved = resolveOwnerIdentity({
      lookup,
      fallback,
      tokenVersion: tv,
    });
    if (!resolved.ok) {
      console.log(
        `[OwnerAuth] REJECTED — reason=${resolved.reason} userId=${userId}`
      );
      const status = resolved.reason.startsWith("token_version") ? 401 : 403;
      return { ok: false, status };
    }
    return { ok: true, userId };
  } catch {
    return { ok: false, status: 401 };
  }
}

// ─── Background-jobs kill switch ───────────────────────────────────────────────
// Treat both "1" and "true" (case-insensitive, whitespace-tolerant) as disabled.
// The previous exact-"1" check silently ignored DISABLE_BACKGROUND_JOBS=true.
function isBackgroundJobsDisabled(): boolean {
  const v = (process.env.DISABLE_BACKGROUND_JOBS ?? "").trim().toLowerCase();
  return v === "1" || v === "true";
}

// ─── www → apex redirect allowlist ───────────────────────────────────────────
// The `www.` → apex 308 redirect (mounted in startServer, below) used to derive
// its target as `host.slice(4)` with NO allowlist, so ANY Host beginning with
// "www." was echoed back as a redirect target: `Host: www.evil.com` produced
// `308 → https://evil.com/<path>`. Because that middleware is registered ahead
// of originLock, the origin answered those unallowlisted Hosts even under
// EDGE_MODE=on, and every Host-keyed cache entry or log line downstream
// inherited an attacker-controlled value.
//
// These two helpers replace the blind strip with a set derived from what the
// app already declares as its own origins — PUBLIC_ORIGIN (`ENV.publicOrigin`,
// the canonical production origin, also the basis of the tRPC CSRF origin set)
// plus ADDITIONAL_ALLOWED_ORIGINS (the operator-declared extra origins that
// same CSRF set already trusts). No new env var. Read from `process.env` at
// call time rather than closing over `ENV` so the behavior is a pure function
// of the environment.
//
// Deliberately NOT changed here: middleware ORDER. The `www` measurement gap
// recorded in docs/runbooks/edge-defense-cloudflare.md §7 stands on its own —
// allowlisted `www.<apex>` traffic still redirects ahead of the lock, so it is
// still uncounted. Non-allowlisted `www.*` Hosts now fall through to the lock.

/**
 * Apex hostnames this app will 308 a `www.` request to.
 *
 * Accepts either a full origin ("https://example.com") or a bare host
 * ("example.com"); an entry already carrying a `www.` prefix contributes its
 * apex. Unparseable entries are skipped rather than trusted.
 */
function canonicalApexHosts(): Set<string> {
  const hosts = new Set<string>();
  const add = (raw: string): void => {
    const trimmed = raw.trim();
    if (!trimmed) return;
    try {
      const url = new URL(
        trimmed.includes("://") ? trimmed : `https://${trimmed}`
      );
      const hostname = url.hostname.toLowerCase().replace(/^www\./, "");
      if (hostname) hosts.add(hostname);
    } catch {
      // A malformed origin must not widen the allowlist.
    }
  };
  add(process.env.PUBLIC_ORIGIN ?? "");
  for (const raw of (process.env.ADDITIONAL_ALLOWED_ORIGINS ?? "").split(",")) {
    add(raw);
  }
  return hosts;
}

/**
 * Given a request `Host` header, return the host to 308 to, or `null` when the
 * request must NOT be redirected (not a `www.` Host, or a `www.` Host whose
 * apex this app does not own).
 *
 * Any `:port` suffix rides along to the target unchanged (the allowlist is
 * compared on the hostname alone), preserving the previous behavior for
 * non-443 local/preview access.
 */
function wwwRedirectTarget(host: string): string | null {
  const raw = host.trim().toLowerCase();
  if (!raw.startsWith("www.")) return null;
  const stripped = raw.slice(4); // "example.com" or "example.com:8080"

  // Validate the ENTIRE value, never a prefix of it. Checking
  // `stripped.split(":")[0]` against the allowlist and then returning the
  // unvalidated `stripped` is an open redirect: `Host: www.apex.com:@evil.com`
  // strips to `apex.com:@evil.com`, whose split(":")[0] is the allowlisted
  // apex — but the string itself parses as userinfo `apex.com:` against host
  // `evil.com`, so the 308 sends the client to evil.com. Same class for `/`,
  // `\`, `?` and `#`, which all terminate the authority in a URL.
  //
  // This regex admits ONLY hostname[:port] with a numeric port, so every
  // authority-delimiting character is rejected outright rather than enumerated.
  const m = /^([a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*)(?::(\d{1,5}))?$/.exec(
    stripped
  );
  if (!m) return null;
  const hostname = m[1];
  const port = m[5];
  if (port !== undefined && Number(port) > 65535) return null;
  return canonicalApexHosts().has(hostname) ? stripped : null;
}

/**
 * Record a direct-origin `www` hit that the canonical redirect is about to
 * answer, so it is COUNTED even though it never reaches the origin lock.
 *
 * THE GAP THIS CLOSES. The www→apex 308 is registered ahead of the origin-lock
 * mount (deliberately — see the redirect's own comment), so a request arriving
 * at the raw origin with a `www` Host is answered by the redirect and never
 * observed by the lock. Every `edge_origin_ingress_anomaly` count was therefore
 * a LOWER BOUND, understated by exactly the direct-origin-plus-www class. The
 * arming decision on 2026-08-06 was made against that understated number.
 *
 * WHY INSTRUMENTATION AND NOT REORDERING. Moving the lock ahead of the redirect
 * would change request flow for every www visitor and put a 403 in front of a
 * path that currently always succeeds — a materially larger blast radius than
 * the measurement problem justifies. This records the observation and changes
 * nothing about what the client receives: same 308, same Location, same body
 * preservation.
 *
 * The outcome is "observed", never "blocked": this request IS being served.
 * Passing the default would recreate the exact lying-alert defect that the
 * 2026-08-07 review removed.
 *
 * Silent when the feature is dormant (`EDGE_MODE=off`), when the request is
 * `/health` (mirroring originLock's own exemption, so Railway's probe never
 * generates security events), and when the request is genuinely edge-verified
 * — a www visitor arriving through Cloudflare is not an anomaly and must not
 * be counted as one.
 *
 * It can never throw into the redirect path. A telemetry failure must not cost
 * a user their redirect.
 *
 * Returns a diagnostic fragment for the redirect's own log line, so that line
 * states on its face whether this request was counted and why. A reader of the
 * logs should never have to infer from an absence.
 */
function observeWwwRedirectIngress(req: express.Request): string {
  try {
    const mode = edgeMode();
    // Dormant. The fields still appear, with "-" meaning NOT EVALUATED, so a
    // log parser never has to distinguish an absent field from a false one.
    if (mode === "off") return "edgeMode=off edgeVerified=- counted=false";

    const verified = edgeProofPasses(req);
    const upstream = immediateUpstreamIp(req);
    const base = `edgeMode=${mode} edgeVerified=${verified} upstream=${logSafe(upstream || "none")}`;

    // Railway's probe is lock-exempt; counting it would manufacture anomalies.
    if (req.path === "/health") return `${base} counted=false reason=health`;
    // Arrived through Cloudflare — not an anomaly, nothing to count.
    if (verified) return `${base} counted=false reason=edge-verified`;

    fireRateLimitEvent(
      upstream || resolveClientIp(req),
      req.path,
      req.method,
      "edge_origin_ingress_anomaly",
      (req.headers["user-agent"] as string | undefined) ?? null,
      "observed"
    );
    return `${base} counted=true reason=direct-origin`;
  } catch (err) {
    console.warn(
      `[edge][origin-lock] www ingress observation failed (non-fatal, redirect unaffected): ${logSafe(err)}`
    );
    return "counted=false reason=observation-error";
  }
}

// ─── Rate limit event helper ─────────────────────────────────────────────────
// Fire-and-forget: writes a RATE_LIMIT row to security_events.
// Never awaited — the 429 response is always sent synchronously first.
// In-memory dedup: at most 1 DB write per IP per 60s to prevent DB flooding
// when a single attacker hammers the endpoint repeatedly.
const rateLimitLastPersisted = new Map<string, number>();
const RATE_LIMIT_DEDUP_MS = 60_000; // 1 minute

// ─── Origin-lock "no secret configured" escalation guard ────────────────────
// edge_no_secret is a single site-wide CRITICAL condition (EDGE_MODE=on but
// unprotected), not a per-IP event, and it fires on EVERY request while the
// misconfiguration persists — so it gets its own single module-level
// timestamp rather than the per-key dedup map above. At most one escalation
// per minute.
const EDGE_NO_SECRET_ESCALATION_MS = 60_000; // 1 minute
let edgeNoSecretLastEscalatedAt = 0;

// ─── edge_no_secret out-of-band Discord alert (Task 4.3 fix, 2026-08-07) ─────
// edge_no_secret means the origin lock is INERT: EDGE_MODE=on but no
// EDGE_ORIGIN_SECRET is configured, so every request — attacker or not —
// passes straight through unlocked. The section comment above calls this
// "the loudest condition in the system"; a console.error into Railway logs
// nobody watches is a net downgrade from that.
//
// Deliberately NOT routed through fireRateLimitEvent()/postSecurityAlert():
// postSecurityAlert() is typed to SecurityEventType ("CSRF_BLOCK" |
// "RATE_LIMIT" | "AUTH_FAIL"). As of the 2026-08-07 fix, the RATE_LIMIT
// embed (buildRateLimitEmbed in discordSecurityAlert.ts) no longer
// hardcodes a 429/blocked claim — it renders the TRUE per-alert
// blocked/observed outcome threaded through fireRateLimitEvent()'s
// `outcome` parameter. edge_no_secret still doesn't fit either value
// though: it is a site-wide misconfiguration (every request just passes
// through unlocked — not a per-request "blocked" OR "observed" rate-limit/
// edge-lock outcome), so routing it through fireRateLimitEvent() would
// still misrepresent it. Extending SecurityEventType with a fourth member
// is task 4.4's job, not this one.
//
// Shape chosen: a direct getDiscordClient() + channel send, NOT a new
// webhook module mirroring billingAlerts.ts. billingAlerts.ts's own header
// explains its webhook choice as staying dependency-light so the raw-body
// Stripe webhook handler doesn't have to import discord.js — that rationale
// doesn't apply here: index.ts already imports discord.js transitively
// (startDiscordBot, postSecurityAlert) and already has a live, connected
// bot client. Reusing it needs no new env var / webhook to provision in
// Railway, so it is the simpler and equally honest option for this case.
//
// Posts to the same 🗒️-𝗦𝗘𝗖𝗨𝗥𝗜𝗧𝗬-𝗘𝗩𝗘𝗡𝗧𝗦 channel postSecurityAlert() uses.
// server/discord/discordSecurityAlert.ts's SECURITY_CHANNEL_ID is now
// exported (Task 4.8, once that file was back in scope) and imported above
// instead of duplicating the literal channel ID here.

/**
 * Fire-and-forget: never awaited at the call site, never throws, and every
 * async path ends in `.catch()` so it can never produce an unhandled
 * rejection — same discipline as fireRateLimitEvent()/postSecurityAlert()
 * below. Gated by the SAME edgeNoSecretLastEscalatedAt /
 * EDGE_NO_SECRET_ESCALATION_MS once-per-minute guard as the console.error
 * CRITICAL log at its one call site; this function adds no guard of its own
 * and must only be invoked from inside that guard.
 */
function fireEdgeNoSecretAlert(): void {
  const tag = "[edge][origin-lock][edge_no_secret]";
  const client = getDiscordClient();
  if (!client) {
    console.warn(
      `${tag} Discord bot not ready — CRITICAL alert not posted (console log only)`
    );
    return;
  }

  client.channels
    .fetch(SECURITY_CHANNEL_ID)
    .then(rawChannel => {
      if (!rawChannel || !(rawChannel instanceof TextChannel)) {
        console.error(
          `${tag} security channel is not a TextChannel or could not be fetched — alert not posted`
        );
        return;
      }
      const embed = new EmbedBuilder()
        .setColor(0xf8312f) // bright red — most severe tier (matches billingAlerts.ts / discordSecurityAlert.ts)
        .setTitle("🚨 ORIGIN LOCK INERT — Site Is UNPROTECTED")
        .setDescription(
          "**EDGE_MODE=on but no `EDGE_ORIGIN_SECRET` is configured.** " +
            "The origin-lock middleware is running in name only — this is an " +
            "anti-lockout downgrade, not enforcement. Every request that " +
            "reaches the origin is passed straight through.\n\n" +
            "**Nothing has been blocked or rate-limited — this is not a " +
            "429/attack alert.** It is a notice that a protection is " +
            "currently absent.\n\n" +
            "**Action required:** set `EDGE_ORIGIN_SECRET` in Railway to " +
            "restore protection. This condition persists — and this alert " +
            "repeats at most once per minute — until that variable is set " +
            "correctly."
        )
        .setFooter({ text: "Dime AI · Origin Lock Monitor · edge_no_secret" })
        .setTimestamp();
      return rawChannel.send({ embeds: [embed] });
    })
    .then(sent => {
      if (sent) {
        console.log(`${tag} CRITICAL alert posted to security channel`);
      }
    })
    .catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`${tag} failed to post CRITICAL alert: ${msg}`);
    });
}

function fireRateLimitEvent(
  ip: string,
  path: string,
  method: string,
  limitType:
    | "global"
    | "auth"
    | "trpc_auth"
    | "stripe_checkout"
    | "waitlist_submit"
    | "public_feed"
    | "xff_canary"
    | "edge_origin_ingress_anomaly",
  ua: string | null,
  // Explicit per-call-site indicator of whether THIS firing actually
  // blocked the request, or merely observed it (2026-08-07 review, Critical
  // 2 / Importants 1&2). Confirmed live 2026-08-07: this function logged
  // "BLOCKED" unconditionally for every one of its eight call sites, even
  // though only six of them are express-rate-limit `handler` callbacks that
  // are exclusively invoked once a request has ALREADY been rejected with
  // 429 — a request the HTTP log recorded as httpStatus:200 also logged
  // "BLOCKED" here, and after the RATE_LIMIT embed fix the two disagreed
  // with each other, which is worse for an investigator than the old
  // uniformly-wrong state.
  //
  // Defaults to "blocked" so the six real limiter call sites below — each
  // asserted VERBATIM by server/_core/clientIdentityCallSites.test.ts as
  // `fireRateLimitEvent(ip, req.path, req.method, "<type>", ua);` with
  // nothing after `ua` — stay textually unchanged and still get the
  // correct value for free: they can only ever be invoked from a `handler`
  // that express-rate-limit calls exclusively on an actual block, so
  // "blocked" is unconditionally true there regardless of whether it's
  // passed explicitly. The three call sites where "blocked" is NOT always
  // true — edge_deny (multi-line call, "blocked" passed explicitly for
  // clarity though it matches the default), xff_canary, and the /api/trpc
  // edge_origin_ingress_anomaly canary (both "observed", overriding the
  // default) — pass this argument explicitly.
  outcome: "blocked" | "observed" = "blocked"
) {
  const now = Date.now();
  const dedupKey = `${ip}:${path}:${limitType}`;
  const lastSent = rateLimitLastPersisted.get(dedupKey) ?? 0;

  // Prune stale entries to prevent unbounded map growth
  if (rateLimitLastPersisted.size > 5000) {
    const cutoff = now - RATE_LIMIT_DEDUP_MS;
    Array.from(rateLimitLastPersisted.entries()).forEach(([k, v]) => {
      if (v < cutoff) rateLimitLastPersisted.delete(k);
    });
  }

  const tag = `[RateLimit][${limitType.toUpperCase()}]`;
  console.warn(
    `${tag} ${outcome === "blocked" ? "BLOCKED" : "OBSERVED (not blocked)"} | IP=${logSafe(ip)} path=${logSafe(path)} method=${logSafe(method)}` +
      ` ua="${logSafe(ua?.substring(0, 60) ?? "none")}"` +
      (now - lastSent < RATE_LIMIT_DEDUP_MS ? " [DB_DEDUP_SKIP]" : "")
  );

  if (now - lastSent < RATE_LIMIT_DEDUP_MS) return; // deduplicated
  rateLimitLastPersisted.set(dedupKey, now);

  // NOT persisted to security_events (no new column) — see this task's
  // report for why: adding one needs a migration via db-push.yml before
  // dependent code deploys, and the existing `context` (limitType) column
  // already lets a reader correlate with Railway logs at this timestamp.
  // The Discord embed is the surface that needed the true per-alert value,
  // and it gets it via SecurityAlertPayload.limiterOutcome below.
  insertSecurityEvent({
    eventType: "RATE_LIMIT",
    ip,
    blockedOrigin: null,
    trpcPath: path,
    httpMethod: method,
    userAgent: ua,
    context: limitType,
    occurredAt: now,
  }).catch(err =>
    console.error(`${tag} DB insert failed: ${(err as Error).message}`)
  );
  // [STEP] Post structured embed to 🗒️-𝗦𝗘𝗖𝗨𝗥𝗜𝗧𝗬-𝗘𝗩𝗘𝗡𝗧𝗦 Discord channel (async, non-blocking)
  postSecurityAlert({
    eventType: "RATE_LIMIT",
    ip,
    path,
    method,
    userAgent: ua,
    context: limitType,
    limiterOutcome: outcome,
    occurredAt: now,
  }).catch(err =>
    console.error(`${tag} Discord alert failed: ${(err as Error).message}`)
  );
}

// ─── Global crash protection ─────────────────────────────────────────────────
// Prevent unhandled promise rejections and uncaught exceptions from killing the
// process. Log them instead so the server stays alive and serves requests.
process.on("unhandledRejection", (reason, promise) => {
  console.error(
    "[CRASH GUARD] Unhandled promise rejection:",
    reason,
    "at:",
    promise
  );
});

// ─── Rate limiters ────────────────────────────────────────────────────────────
// Global limiter: 200 requests per minute per IP across all API routes.
// Generous enough for legitimate use; blocks automated scraping/flooding.
const globalApiLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute window
  max: 200, // max 200 requests per window per IP
  standardHeaders: "draft-7", // Return rate limit info in RateLimit-* headers
  legacyHeaders: false,
  message: { error: "Too many requests. Please slow down." },
  skip: req => req.path === "/health", // never throttle health probes
  // Key on the true client IP (leftmost sanitized XFF), NOT req.ip: under
  // Railway's edge + trust proxy=1, req.ip is the rotating edge node, so the
  // default keyGenerator both multiplied per-client budgets and shared budgets
  // across unrelated clients. See clientIpKey.
  keyGenerator: req => `global:${clientIpKey(req)}`,
  handler: (req, res, _next) => {
    // Reuse the SAME identity the keyGenerator used. Re-deriving from raw XFF
    // wrote the Cloudflare PoP into security_events and every Discord alert
    // while the limiter itself was correctly keyed (2026-08-06 audit).
    const ip = resolveClientIdentity(req) || "unknown";
    const ua = (req.headers["user-agent"] as string | undefined) ?? null;
    fireRateLimitEvent(ip, req.path, req.method, "global", ua);
    sendRateLimitResponse(req, res, "Too many requests. Please slow down.");
  },
});

// Auth limiter: max 5 login/auth attempts per 15 minutes per IP.
// Prevents brute-force credential stuffing on login and OAuth routes.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15-minute window
  max: 5, // max 5 attempts per window per IP
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: {
    error:
      "Too many authentication attempts. Please wait 15 minutes before trying again.",
  },
  keyGenerator: req => `auth:${clientIpKey(req)}`,
  handler: (req, res, _next) => {
    // Reuse the SAME identity the keyGenerator used. Re-deriving from raw XFF
    // wrote the Cloudflare PoP into security_events and every Discord alert
    // while the limiter itself was correctly keyed (2026-08-06 audit).
    const ip = resolveClientIdentity(req) || "unknown";
    const ua = (req.headers["user-agent"] as string | undefined) ?? null;
    fireRateLimitEvent(ip, req.path, req.method, "auth", ua);
    sendRateLimitResponse(
      req,
      res,
      "Too many authentication attempts. Please wait 15 minutes before trying again."
    );
  },
});

// tRPC auth procedure limiter: 5 login mutations per 15 minutes per IP.
// Applied specifically to /api/trpc/appUsers.login and /api/trpc/auth.* paths.
const trpcAuthLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "Too many login attempts. Please wait 15 minutes." },
  keyGenerator: req => {
    // Class-stable key, NOT path-derived: this limiter is fed by the /api/trpc
    // procedure-aware dispatch, where req.path is the full comma-separated
    // batch — keying on it would let an attacker mint a fresh budget per batch
    // composition (login,me vs login,foo). clientIpKey resolves the true client
    // (leftmost sanitized XFF), not the rotating Railway edge node. All login
    // attempts from one client share one budget.
    return `${clientIpKey(req)}:trpc_auth`;
  },
  handler: (req, res, _next) => {
    // Reuse the SAME identity the keyGenerator used. Re-deriving from raw XFF
    // wrote the Cloudflare PoP into security_events and every Discord alert
    // while the limiter itself was correctly keyed (2026-08-06 audit).
    const ip = resolveClientIdentity(req) || "unknown";
    const ua = (req.headers["user-agent"] as string | undefined) ?? null;
    fireRateLimitEvent(ip, req.path, req.method, "trpc_auth", ua);
    sendRateLimitResponse(
      req,
      res,
      "Too many login attempts. Please wait 15 minutes."
    );
  },
});

function isPortAvailable(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const server = net.createServer();
    server.listen(port, () => {
      server.close(() => resolve(true));
    });
    server.on("error", () => resolve(false));
  });
}

async function findAvailablePort(startPort: number = 3000): Promise<number> {
  console.log(
    `[PORT_CHECK] Scanning for available port starting at ${startPort}`
  );
  for (let port = startPort; port < startPort + 20; port++) {
    console.log(`[PORT_CHECK] Testing port ${port}...`);
    const available = await isPortAvailable(port);
    if (available) {
      console.log(`[PORT_CHECK] Port ${port} is available ✓`);
      return port;
    }
    console.log(`[PORT_CHECK] Port ${port} is in use, trying next`);
  }
  throw new Error(`No available port found starting from ${startPort}`);
}

async function startServer() {
  console.log(
    `[SERVER_STARTUP] startServer() invoked — NODE_ENV=${process.env.NODE_ENV} PORT_ENV=${process.env.PORT ?? "(unset)"} pid=${process.pid}`
  );

  const app = express();
  console.log(`[SERVER_STARTUP] Express app created`);

  const server = createServer(app);
  installFatalErrorHandler({ server });
  console.log(`[SERVER_STARTUP] HTTP server created`);

  // ─── Server-level error handlers ─────────────────────────────────────────
  // Catch binding errors (EADDRINUSE, EACCES) and connection-level errors
  // that would otherwise surface silently or crash the process.
  server.on("error", (err: NodeJS.ErrnoException) => {
    console.error(
      `[ERROR] HTTP server error event: code=${err.code} message=${err.message}`,
      err
    );
  });
  server.on("clientError", (err: NodeJS.ErrnoException, socket) => {
    console.error(
      `[ERROR] HTTP client error: code=${err.code} message=${err.message}`
    );
    socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
  });
  server.on("connection", socket => {
    console.log(
      `[SERVER_STARTUP] New TCP connection from ${socket.remoteAddress}:${socket.remotePort}`
    );
  });

  // ─── Top-level request logger ────────────────────────────────────────────
  // Installed FIRST so every request — including those rejected by later
  // middleware — is captured. Logs method, path, key headers, and final status.
  //
  // Sampling: only 10% of normal requests are logged to stay well under
  // Railway's 500 logs/sec rate limit. Errors (5xx) and slow requests
  // (>1000ms) are ALWAYS logged regardless of the sample decision so that
  // production visibility into problems is fully preserved.
  console.log(
    `[SERVER_STARTUP] Registering top-level request logging middleware`
  );
  app.use((req, res, next) => {
    const start = Date.now();
    const ts = new Date().toISOString();
    // The audit found cf-connecting-ip — the ONLY place the true visitor
    // appears behind Cloudflare — was never logged anywhere. resolveClientIdentity
    // resolves the true client; identitySource records which branch produced
    // it (cf-connecting-ip / xff-leftmost / req.ip) so it's visible in Railway
    // logs (2026-08-06 audit).
    const ip = resolveClientIdentity(req) || "unknown";
    const ipSrc = identitySource(req);
    // Decide at request-time whether this request falls in the 10% sample.
    // The same flag is reused on the response so both log lines are emitted
    // together or suppressed together for normal requests.
    const sampled = Math.random() < 0.1;
    if (sampled) {
      console.log(
        `[HTTP_REQUEST] → ${req.method} ${logSafe(req.originalUrl)} | ts=${ts} ip=${logSafe(ip)} ipSrc=${ipSrc}` +
          ` host=${logSafe(req.headers["host"] ?? "-")}` +
          ` x-forwarded-for=${logSafe(req.headers["x-forwarded-for"] ?? "-")}` +
          ` x-forwarded-proto=${logSafe(req.headers["x-forwarded-proto"] ?? "-")}` +
          ` user-agent=${logSafe((req.headers["user-agent"] ?? "-").toString().substring(0, 80))}`
      );
    }
    res.on("finish", () => {
      const ms = Date.now() - start;
      const isError = res.statusCode >= 500;
      const isSlow = ms > 1000;
      if (sampled || isError || isSlow) {
        console.log(
          `[HTTP_REQUEST] ← ${req.method} ${logSafe(req.originalUrl)} | status=${res.statusCode} duration=${ms}ms ip=${logSafe(ip)}` +
            (isError ? " [ERROR]" : "") +
            (isSlow ? " [SLOW]" : "")
        );
      }
    });
    next();
  });

  // ─── www → non-www canonical redirect (308) ─────────────────────────────
  // The edge proxy www redirect uses 301 (which converts POST→GET per HTTP spec),
  // silently dropping the request body. This middleware intercepts www requests
  // at the Express level first and issues a 308 Permanent Redirect, which
  // preserves the HTTP method and body. This fixes login and all API mutations
  // when users access www.aisportsbettingmodels.com.
  //
  // The target is ALLOWLISTED (see canonicalApexHosts / wwwRedirectTarget
  // above): only a `www.` Host whose apex this app declares as its own is
  // redirected. Any other `www.*` Host falls through to next() so the origin
  // lock and normal routing handle it — it is NOT echoed back as a redirect
  // target. Still a 308 (never 301): preserving the POST body is the entire
  // reason this middleware exists.
  app.use((req, res, next) => {
    const host = req.headers.host ?? "";
    const canonical = wwwRedirectTarget(host);
    if (canonical) {
      const redirectUrl = `${req.protocol}://${canonical}${req.originalUrl}`;
      // Count it before answering. This middleware sits AHEAD of the origin
      // lock, so without this the direct-origin www class is served and never
      // measured — the understatement in every historical anomaly total. The
      // returned fragment makes the log line state whether it was counted.
      const observation = observeWwwRedirectIngress(req);
      console.log(
        `[www→canonical] 308 redirect: ${logSafe(host)}${logSafe(req.originalUrl)} → ${logSafe(redirectUrl)} | ${observation}`
      );
      return res.redirect(308, redirectUrl);
    }
    next();
  });

  // ─── Gzip/Brotli response compression ───────────────────────────────────────
  // Compresses all JSON/HTML responses. tRPC payloads (often 50-200KB for large
  // bet lists) shrink 70-85% — dramatically reducing network transfer time.
  // threshold=512: skip compression for tiny responses where overhead > benefit.
  console.log(`[SERVER_STARTUP] Registering compression middleware`);
  app.use(compression({ threshold: 512 }));

  // Trust the first proxy (Railway edge) so req.protocol reflects
  // the original HTTPS scheme and cookies are set correctly (sameSite+secure).
  // Also required for express-rate-limit to read the real client IP from
  // X-Forwarded-For rather than the proxy IP.
  app.set("trust proxy", 1);

  // ─── Origin lock (Phase 4 edge defense) ───────────────────────────────────
  // When EDGE_MODE is "on", a direct hit on the public *.up.railway.app origin
  // that lacks the Cloudflare-injected x-dime-edge-secret (and a CF-range
  // upstream) is 403'd — rendering the origin useless to a scraper who
  // discovers its URL. "/health" stays reachable for Railway's probe. With
  // EDGE_MODE unset/"off" this is a pure pass-through (byte-identical to today,
  // inert on merge). Mounted BEFORE helmet/body-parsers/limiters so a denied
  // request touches nothing. onEvent routes ONLY the actual 403 ("edge_deny")
  // to the same loud, deduped alerting the rate limiters use — the other four
  // OriginLockEvent kinds never block a request, so alerting on them was a
  // false-positive generator (2026-08-07 audit: a log-mode "would-deny" and a
  // breaker "recovered" both posted the identical "IP Blocked ... 429" Discord
  // embed as a real 403, and in the breaker-open state that fired on EVERY
  // request). See server/_core/originLock.ts.
  app.use(
    originLock((kind, req) => {
      const ip = immediateUpstreamIp(req) || resolveClientIp(req);
      const ua = (req.headers["user-agent"] as string | undefined) ?? null;

      switch (kind) {
        case "edge_deny":
          // The ONLY kind that actually 403'd the request. Alert.
          // outcome="blocked" passed explicitly (2026-08-07 review, Critical
          // 2 / Importants 1&2) — matches the helper's own default, but
          // stated here so this call site's truth is not implicit.
          fireRateLimitEvent(
            ip,
            req.path,
            req.method,
            "edge_origin_ingress_anomaly",
            ua,
            "blocked"
          );
          break;
        case "edge_would_deny":
          // Log-mode observation, or breaker-open self-heal — the request was
          // SERVED (200), not blocked. Log only: alerting here would claim a
          // 429-and-blocked outcome for a request that went through, and in
          // the breaker-open state it would fire on EVERY request.
          console.warn(
            `[edge][origin-lock] would-deny (observe-only, request served) ip=${logSafe(ip)} path=${logSafe(req.path)}`
          );
          break;
        case "edge_no_secret":
          // Anti-lockout: EDGE_MODE=on but no secret configured — the site is
          // UNPROTECTED and this fires on every request while it persists.
          // Escalate at most once per minute so the CRITICAL itself can't
          // flood. Both the console.error AND the out-of-band Discord alert
          // below share this ONE guard — no second guard.
          if (
            Date.now() - edgeNoSecretLastEscalatedAt >=
            EDGE_NO_SECRET_ESCALATION_MS
          ) {
            edgeNoSecretLastEscalatedAt = Date.now();
            console.error(
              "[edge][origin-lock] CRITICAL EDGE_MODE=on but no EDGE_ORIGIN_SECRET configured — anti-lockout downgrade to observe-only (site NOT protected)"
            );
            fireEdgeNoSecretAlert();
          }
          break;
        case "edge_breaker_tripped":
          // Enforcement auto-suspended (breaker judged Cloudflare absent).
          // Not an attack signal, but loud because the site is unprotected.
          console.error(
            "[edge][origin-lock] CRITICAL circuit breaker TRIPPED — EDGE_MODE=on but ~no verified Cloudflare ingress over the sample window; enforcement auto-downgraded to observe-only to prevent a 403 outage. Cloudflare is likely NOT fronting the origin (DNS/secret). Site falls back to Phase 3 gating + rate limits. Investigate the edge path."
          );
          break;
        case "edge_breaker_recovered":
          // GOOD NEWS: verified Cloudflare ingress returned, enforcement
          // resumed. Must not read like an attack — console.log, not warn/error.
          console.log(
            "[edge][origin-lock] circuit breaker RECOVERED — verified Cloudflare ingress returned; origin-lock enforcement resumed."
          );
          break;
        case "edge_partial_bypass_suspected":
          // Cloudflare IS up (verified traffic is flowing) but a large share of
          // ingress arrived unverified — real users are likely reaching the
          // origin directly and getting 403'd. Enforcement is UNCHANGED: this
          // is the detection-only path, because a fraction rule must never be
          // allowed to drop the lock (an attacker controls the numerator).
          // This is the 7-hour blind period from 2026-08-06 made visible.
          console.error(
            "[edge][origin-lock] CRITICAL partial bypass suspected — verified Cloudflare ingress is present, but a sustained majority of requests arrived UNVERIFIED. Real users may be reaching the origin directly and receiving 403s. Enforcement unchanged (this signal never downgrades the lock). Check DNS orange-cloud coverage, the www/apex split, and any client pinned to the raw origin host."
          );
          break;
        case "edge_partial_bypass_cleared":
          console.log(
            "[edge][origin-lock] partial bypass cleared — unverified share back below the alert threshold."
          );
          break;
        default:
          // An OriginLockEvent kind this handler doesn't know about yet.
          // Log loudly rather than silently dropping it.
          console.error(
            `[edge][origin-lock] UNRECOGNISED origin-lock event kind: ${String(kind)} — onEvent handler needs updating`
          );
      }
    })
  );

  // ─── Security headers (helmet) ────────────────────────────────────────────
  // Sets X-Content-Type-Options, X-Frame-Options, X-XSS-Protection,
  // Strict-Transport-Security, Referrer-Policy, and a Content-Security-Policy
  // that allows our own origin + CDN assets. Vite HMR websocket is allowed in dev.
  console.log(
    `[SERVER_STARTUP] Registering helmet security headers middleware`
  );
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          // Stripe Embedded Checkout (/checkout, MUST stay on-domain — owner
          // directive): Stripe.js loads from js.stripe.com and mounts an iframe.
          // Without these CSP allowances the browser blocks the script and the
          // page shows "Failed to load Stripe.js" (observed live 2026-07-10).
          // Per https://docs.stripe.com/security/guide#content-security-policy
          scriptSrc: [
            "'self'",
            "'unsafe-inline'",
            "https://js.stripe.com",
            "https://*.js.stripe.com",
            ...(process.env.NODE_ENV !== "production" ? ["'unsafe-eval'"] : []), // unsafe-eval only in dev (Vite HMR)
          ],
          styleSrc: [
            "'self'",
            "'unsafe-inline'",
            "https://fonts.googleapis.com",
          ],
          // d2xsxph8kpxj0f.cloudfront.net serves Discord's "GG Sans" woff2 files.
          // Owner-approved exception (2026-07-24) so Discord-affiliated controls
          // can carry Discord's own typeface — see dime-ai/THREE-COLOR-LAW.md
          // §"Discord platform exception". Scoped to fonts only.
          fontSrc: [
            "'self'",
            "https://fonts.gstatic.com",
            "https://d2xsxph8kpxj0f.cloudfront.net",
            "data:",
          ],
          imgSrc: ["'self'", "data:", "blob:", "https:", "http:"],
          connectSrc: ["'self'", "wss:", "ws:", "https:"],
          frameSrc: [
            "'self'", // same-origin iframes
            "https://js.stripe.com",
            "https://*.js.stripe.com",
            "https://checkout.stripe.com", // Embedded Checkout session iframe
            "https://hooks.stripe.com", // 3DS / bank-redirect auth frames
          ],
          objectSrc: ["'none'"],
          upgradeInsecureRequests:
            process.env.NODE_ENV === "production" ? [] : null,
        },
      },
      crossOriginEmbedderPolicy: false, // Allow embedding external resources (logos, CDN)
    })
  );

  // Permissions-Policy: helmet no longer emits this (dropped in v5+), so we set
  // it explicitly — denies every unused device/sensor capability (camera, mic,
  // geolocation, USB/serial/BT/HID, MIDI, motion sensors) so a successful XSS
  // still can't reach them, delegates `payment` to Stripe's Embedded Checkout
  // origins (mirrors the CSP frame-src), and opts out of FLoC/Topics tracking.
  console.log(`[SERVER_STARTUP] Registering Permissions-Policy header`);
  app.use(permissionsPolicy());

  // ─── Stripe webhook — MUST be registered BEFORE express.json() ────────────
  // Uses express.raw() to preserve the raw buffer for HMAC-SHA256 signature
  // verification. Placed here so it intercepts /api/stripe/webhook before the
  // JSON body parser consumes and discards the raw body.
  console.log(`[SERVER_STARTUP] Registering Stripe webhook route`);
  registerStripeWebhookRoute(app);

  // ─── Tailered write-through (Phase 2) — raw body for HMAC, same reason ────
  // POST /api/admin/remote/user-mutation: HMAC-verified whitelisted user
  // mutations from the tailered.ai admin console. Fails closed (uniform 404)
  // until TAILERED_SYNC_SECRET is provisioned. See server/remoteAdmin/.
  console.log(`[SERVER_STARTUP] Registering tailered remote-admin route`);
  registerRemoteAdminRoute(app, globalApiLimiter);

  // ─── Body parser with tight size limits ──────────────────────────────────
  // 10kb for JSON API calls (tRPC procedures never need more than a few KB).
  // 1mb for URL-encoded forms. The previous 50mb limit was a DoS vector.
  // Note: file upload procedures use base64 strings — if needed, raise to 2mb max.
  console.log(`[SERVER_STARTUP] Registering JSON + URL-encoded body parsers`);
  app.use(express.json({ limit: "2mb" }));
  app.use(express.urlencoded({ limit: "1mb", extended: true }));

  // ─── Health check endpoint ────────────────────────────────────────────────
  // Lightweight endpoint for load balancer health probes and uptime monitoring.
  // Returns 200 immediately without hitting the DB so it never times out.
  console.log(`[SERVER_STARTUP] Registering /health endpoint`);
  app.get("/health", (req, res) => {
    const circuit = getCircuitStatus();
    const dbOk = circuit.state === "CLOSED";
    // Schema/code-agreement gate (Phase 1½): a live app_users schema behind the
    // code fails health, so Railway keeps the previous healthy deploy instead of
    // cutting over to a code-ahead-of-migration deploy that would silently break
    // auth (#370). Only a CONFIRMED mismatch fails; "unknown" never does.
    const schemaMismatch = shouldFailHealthForSchema();
    const healthy = dbOk && !schemaMismatch;
    // See the top-level request logger above: resolveClientIdentity resolves
    // the true client; identitySource records which branch produced it
    // (2026-08-06 audit).
    const ip = resolveClientIdentity(req) || "unknown";
    const ipSrc = identitySource(req);
    console.log(
      `[HEALTH_CHECK] GET /health | ip=${logSafe(ip)} ipSrc=${ipSrc} db.state=${circuit.state} dbOk=${dbOk} schema=${currentSchemaVerdict()}`
    );
    // Integration state is REPORTED but deliberately does NOT drive the status
    // code. Railway probes this endpoint: returning 503 because Discord's
    // gateway is reconnecting would restart the container, killing the very
    // supervisor that recovers it — an outage manufactured by its own monitor.
    // Only the database, which the app genuinely cannot serve without, decides
    // 200 vs 503.
    const bot = getDiscordBotHealth();
    res.status(healthy ? 200 : 503).json({
      status: healthy ? "ok" : schemaMismatch ? "schema_mismatch" : "degraded",
      ts: Date.now(),
      // Which commit is answering. Incident 64: a deploy silently never
      // happened, and `deploy-smoke` passed because a healthy origin serving
      // the PREVIOUS build is indistinguishable from a successful deploy when
      // nothing in the response names the build. `null` when unknown — never a
      // placeholder, so a smoke test cannot assert equality against "no idea".
      commit: readBuildCommit(),
      db: {
        state: circuit.state,
        consecutiveFailures: circuit.consecutiveFailures,
      },
      // Phase 1½ schema/code-agreement verdict (ok | schema_mismatch | unknown).
      schema: currentSchemaVerdict(),
      integrations: {
        // Answers "is the bot up?" in one request instead of inferring it from
        // the absence of a log line — the exact question that was unanswerable
        // when a schedule backfill flooded the boot window.
        discord: {
          supervising: bot.supervising,
          connected: bot.connected,
          consecutiveFailures: bot.consecutiveFailures,
          totalConnects: bot.totalConnects,
          totalReconnects: bot.totalReconnects,
          lastReadyAt: bot.lastReadyAt,
          lastFailureAt: bot.lastFailureAt,
          // Bounded: a Stripe/Discord error string is not a secret, but it is
          // attacker-visible on a public probe, so cap it rather than echo it.
          lastFailureReason: bot.lastFailureReason ? String(bot.lastFailureReason).slice(0, 120) : null,
          retryQueued: bot.retryQueued,
          uptimeMs: bot.connected && bot.lastReadyAt ? Date.now() - bot.lastReadyAt : null,
        },
        billingAlerts: {
          // "Can a failed renewal actually reach a human?" Boolean only — the
          // webhook URL itself is a secret and must never appear here.
          configured: Boolean(
            process.env.BILLING_ALERT_DISCORD_WEBHOOK_URL ?? process.env.DISCORD_BILLING_WEBHOOK_URL
          ),
        },
        // Webhook-path latency (avenue #11). Reported, never a status-code
        // input — a slow webhook is an alert condition, not a reason for
        // Railway to restart the container. In-memory since last boot.
        stripeWebhook: getWebhookLatencyStats(),
      },
    });
  });

  // ─── DB status endpoint (owner-only, rate-limited) ─────────────────────────────
  // BE-006: Protected behind globalApiLimiter + owner auth.
  app.get("/api/db-status", globalApiLimiter, async (req, res) => {
    const auth = await authenticateOwnerRequest(req);
    if (!auth.ok) {
      return res
        .status(auth.status)
        .json({ error: auth.status === 401 ? "unauthorized" : "owner-only" });
    }
    const circuit = getCircuitStatus();
    const cache = getCacheStats();
    res.json({
      ts: Date.now(),
      circuit,
      userCache: cache,
    });
  });
  // ─── Performance health endpoint (owner-only, rate-limited) ────────────────────────
  // BE-006: Protected behind globalApiLimiter + owner auth.
  app.get("/api/perf", globalApiLimiter, async (req, res) => {
    const auth = await authenticateOwnerRequest(req);
    if (!auth.ok) {
      return res
        .status(auth.status)
        .json({ error: auth.status === 401 ? "unauthorized" : "owner-only" });
    }
    const cacheHealth = getCacheHealthStats();
    const circuit = getCircuitStatus();
    const uptime = process.uptime();
    const mem = process.memoryUsage();
    res.json({
      ts: Date.now(),
      uptime: `${Math.round(uptime)}s`,
      memory: {
        heapUsedMB: (mem.heapUsed / 1024 / 1024).toFixed(1),
        heapTotalMB: (mem.heapTotal / 1024 / 1024).toFixed(1),
        rssMB: (mem.rss / 1024 / 1024).toFixed(1),
      },
      cache: cacheHealth,
      db: {
        state: circuit.state,
        consecutiveFailures: circuit.consecutiveFailures,
      },
    });
  });

  // ─── Debug logs endpoint (owner-only, rate-limited) ────────────────────────
  // Returns recent background job logs from the debug_logs table.
  // Supports ?source=ANApiOdds&level=warn&limit=100 query params.
  // Replaces stdout log inspection for background job debugging.
  app.get("/api/debug-logs", globalApiLimiter, async (req, res) => {
    const auth = await authenticateOwnerRequest(req);
    if (!auth.ok) {
      return res
        .status(auth.status)
        .json({ error: auth.status === 401 ? "unauthorized" : "owner-only" });
    }

    const db = await getDb();
    if (!db) return res.status(503).json({ error: "db-unavailable" });

    try {
      const source =
        typeof req.query.source === "string" ? req.query.source : null;
      const level =
        typeof req.query.level === "string" ? req.query.level : null;
      const limit = Math.min(
        parseInt(String(req.query.limit ?? "200"), 10) || 200,
        1000
      );

      // Build WHERE clause dynamically
      let whereClause = "WHERE 1=1";
      const params: (string | number)[] = [];
      if (source) {
        whereClause += " AND source = ?";
        params.push(source);
      }
      if (level) {
        whereClause += " AND level = ?";
        params.push(level);
      }
      params.push(limit);

      const [rows] = await db.execute(
        `SELECT id, source, level, message, context, created_at FROM debug_logs ${whereClause} ORDER BY created_at DESC LIMIT ?`,
        params
      );

      res.json({
        ts: Date.now(),
        count: (rows as unknown[]).length,
        filters: { source, level, limit },
        logs: rows,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Table may not exist yet — return helpful error
      if (
        msg.includes("doesn't exist") ||
        msg.includes("Table") ||
        msg.includes("ER_NO_SUCH_TABLE")
      ) {
        return res.status(404).json({
          error:
            "debug_logs table not found — restart server to auto-create it",
        });
      }
      console.error("[DebugLogs] Query failed:", err);
      res.status(500).json({ error: "query-failed", message: msg });
    }
  });

  // ─── XFF-sanitization canary ──────────────────────────────────────────────
  // All limiter keying trusts that Railway's edge sanitizes inbound
  // X-Forwarded-For and appends its (public) hop, so the resolved client is
  // always a PUBLIC IP. If a /api/trpc request ever resolves to a private/
  // reserved/carrier-internal address, that assumption has broken (hop
  // structure changed) — fire a loud, deduped security alert so it can never
  // fail silently. This is the runtime half of the guarantee; the deploy half
  // is the spoof self-check in scripts/smoke-deploy.mjs. Observe-only; never
  // blocks. See trpcRateLimitPolicy.isReservedOrInternalIp.
  app.use("/api/trpc", (req, _res, next) => {
    const ip = resolveClientIp(req);
    if (ip && isReservedOrInternalIp(ip)) {
      // Observe-only by construction — see this block's own header comment
      // ("Observe-only; never blocks"). outcome="observed" passed explicitly
      // (2026-08-07 review, Importants 1&2): the default is "blocked", which
      // would be WRONG here.
      fireRateLimitEvent(
        ip,
        req.path,
        req.method,
        "xff_canary",
        (req.headers["user-agent"] as string | undefined) ?? null,
        "observed"
      );
    }
    // Edge-aware anomaly (Phase 4): the private-range canary above is
    // structurally blind to a WRONG-BUT-PUBLIC client (e.g. a CF PoP egress IP
    // when resolution silently breaks, or a direct-origin bypass). When edge
    // mode is armed, a /api/trpc request that is NOT a verified Cloudflare
    // ingress (missing cf-connecting-ip or a non-CF upstream) is the signal the
    // regex can't catch — fire it observe-only. In "on" mode a genuine bypass
    // is already 403'd by originLock upstream, so this mostly surfaces during
    // the "log" soak (proof that Cloudflare is actually fronting every request).
    if (edgeMode() !== "off") {
      const upstream = immediateUpstreamIp(req);
      if (!cfConnectingIp(req) || !isCloudflareEdgeIp(upstream)) {
        // This canary ALWAYS calls next() below — it never blocks the
        // request, even though it shares the "edge_origin_ingress_anomaly"
        // limitType slug with the genuinely-blocking edge_deny case above.
        // outcome="observed" passed explicitly (2026-08-07 review, Critical
        // 2 / Importants 1&2) so the two call sites for this one slug can
        // no longer be conflated in the resulting alert — this is the fix
        // for the live case: production runs EDGE_MODE=log, where 100% of
        // currently-firing alerts for this slug come from THIS call site,
        // and the old code asserted a 403 that never happened for every one
        // of them.
        fireRateLimitEvent(
          upstream || ip,
          req.path,
          req.method,
          "edge_origin_ingress_anomaly",
          (req.headers["user-agent"] as string | undefined) ?? null,
          "observed"
        );
      }
    }
    next();
  });

  // ─── Global API rate limiter ──────────────────────────────────────────────
  // Applied to all /api/* routes. Skips /health (handled above).
  console.log(`[SERVER_STARTUP] Registering global API rate limiter on /api`);
  app.use("/api", globalApiLimiter);

  // ─── Auth-specific rate limiters ─────────────────────────────────────────
  // Discord OAuth routes — 5 attempts per 15 min per IP
  app.use("/api/discord-auth", authLimiter);
  app.use("/api/auth/discord-invite", authLimiter);
  app.use("/api/auth/discord-login", authLimiter);
  app.use("/api/auth/discord", authLimiter);

  // tRPC login mutation limiting moved to the procedure-aware dispatch below
  // (SEC: the old path-prefix mounts here were batch-evadable — a comma-batched
  // /api/trpc/appUsers.login,appUsers.me never matched the prefix, so appending
  // any second procedure skipped the 5/15min brute-force limiter entirely).

  // ─── Stripe checkout rate limiter ────────────────────────────────────────
  // Dedicated limiter for the unauthenticated publicCreateCheckoutSession endpoint.
  // Forensic analysis (2026-05-24) confirmed 3 coordinated automated probes from
  // Google Cloud Run (AS15169) targeting this exact procedure within 8.6 hours.
  // Each probe used a unique *.run.app subdomain and IPv6 address — classic
  // rotating-origin evasion to bypass per-IP CSRF dedup guards.
  // Limit: 10 checkout attempts per 15 minutes per IP — generous for any real user
  // (who clicks once), but stops automated probers that rotate IPs.
  const stripeCheckoutLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    message: {
      error:
        "Too many checkout requests. Please wait 15 minutes before trying again.",
    },
    keyGenerator: req => {
      // Class-stable key (see trpcAuthLimiter note): req.path under the
      // /api/trpc dispatch is the full batch list — path-derived keys would
      // reopen per-composition budget minting for the rotating-origin probers
      // this limiter exists to stop. clientIpKey resolves the true client, not
      // the rotating Railway edge node.
      return `${clientIpKey(req)}:stripe_checkout`;
    },
    handler: (req, res, _next) => {
      // Reuse the SAME identity the keyGenerator used. Re-deriving from raw
      // XFF wrote the Cloudflare PoP into security_events and every Discord
      // alert while the limiter itself was correctly keyed (2026-08-06 audit).
      const ip = resolveClientIdentity(req) || "unknown";
      const ua = (req.headers["user-agent"] as string | undefined) ?? null;
      console.warn(
        `[STRIPE_CHECKOUT_RATE_LIMIT] IP=${logSafe(ip)} path=${logSafe(req.path)} ua=${logSafe(ua ?? "none")}`
      );
      fireRateLimitEvent(ip, req.path, req.method, "stripe_checkout", ua);
      sendRateLimitResponse(
        req,
        res,
        "Too many checkout requests. Please wait 15 minutes before trying again."
      );
    },
  });
  // Stripe procedure limiting now flows through the consolidated
  // procedure-aware dispatch mounted after the waitlist limiter below
  // (AUTH-004 generalized — see server/_core/trpcRateLimitPolicy.ts).

  // ─── Waitlist submit rate limiter (DB-006 remediation) ────────────────────
  // Public form endpoint — 5 submissions per 15 minutes per IP.
  // Prevents automated spam/enumeration on the waitlist join endpoint.
  const waitlistSubmitLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 5,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    message: {
      error:
        "Too many waitlist submissions. Please wait 15 minutes before trying again.",
    },
    keyGenerator: req => {
      return `waitlist:${clientIpKey(req)}`;
    },
    handler: (req, res, _next) => {
      // Reuse the SAME identity the keyGenerator used. Re-deriving from raw
      // XFF wrote the Cloudflare PoP into security_events and every Discord
      // alert while the limiter itself was correctly keyed (2026-08-06 audit).
      const ip = resolveClientIdentity(req) || "unknown";
      const ua = (req.headers["user-agent"] as string | undefined) ?? null;
      console.warn(
        `[WAITLIST_RATE_LIMIT] IP=${logSafe(ip)} path=${logSafe(req.path)} ua=${logSafe(ua ?? "none")}`
      );
      fireRateLimitEvent(ip, req.path, req.method, "waitlist_submit", ua);
      sendRateLimitResponse(
        req,
        res,
        "Too many waitlist submissions. Please wait 15 minutes before trying again."
      );
    },
  });

  // ─── Public feed read limiter ─────────────────────────────────────────────
  // The scraper hot path: every model-bearing feed read in the "public_feed"
  // class of TRPC_PROCEDURE_CLASSES (games.list + feed meta, wc2026 match/odds
  // feeds, MLB strikeout/HR prop feeds) — see trpcRateLimitPolicy.ts for the
  // authoritative list. httpBatchLink coalesces a whole feed page into ONE
  // request (one token), so a real logged-in user sends ~1-3 req/min incl.
  // navigation; 60/min/IP is ~20x headroom while capping a scraper at 1 req/s.
  // FAIL OPEN (feed is the
  // product — a limiter fault must not become an outage; enforced in the
  // dispatch's public_feed branch). Env knobs: FEED_RATE_LIMIT_MAX (default 60),
  // FEED_RATE_LIMIT_DISABLED=1 kill-switch (feed class only; never auth/checkout).
  const feedRateLimitMax = Number(process.env.FEED_RATE_LIMIT_MAX ?? "60") || 60;
  const feedRateLimitDisabled =
    (process.env.FEED_RATE_LIMIT_DISABLED ?? "").trim() === "1";
  const feedProcedureLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: feedRateLimitMax,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    skip: () => feedRateLimitDisabled,
    // Fail OPEN natively: on a store error, allow the request rather than 500.
    // Inert with the in-process MemoryStore (cannot error), but load-bearing if
    // this class ever moves to a shared/Redis store — the feed must never go
    // down because its limiter's backing store did.
    passOnStoreError: true,
    keyGenerator: req => `${clientIpKey(req)}:public_feed`,
    handler: (req, res, _next) => {
      // Reuse the SAME identity the keyGenerator used. Re-deriving from raw
      // XFF wrote the Cloudflare PoP into security_events and every Discord
      // alert while the limiter itself was correctly keyed (2026-08-06 audit).
      const ip = resolveClientIdentity(req) || "unknown";
      const ua = (req.headers["user-agent"] as string | undefined) ?? null;
      fireRateLimitEvent(ip, req.path, req.method, "public_feed", ua);
      sendRateLimitResponse(
        req,
        res,
        "Too many feed requests. Please slow down and try again shortly."
      );
    },
  });

  // ─── Procedure-aware tRPC rate-limit dispatch (AUTH-004 generalized) ─────
  // ONE classifier for every procedure-scoped limiter. Path-prefix mounts on
  // /api/trpc/<procedure> are batch-evadable (httpBatchLink sends comma lists:
  // /api/trpc/a.b,c.d — the comma breaks Express prefix matching), which
  // previously left appUsers.login/auth.login and waitlist.submit unprotected
  // against batched calls. The dispatch parses every batch segment and hands
  // the request to the strictest matching class limiter.
  app.use(
    "/api/trpc",
    createTrpcRateLimitDispatch({
      auth: trpcAuthLimiter,
      stripe_checkout: stripeCheckoutLimiter,
      waitlist: waitlistSubmitLimiter,
      public_feed: feedProcedureLimiter,
    })
  );

  // ─── Request timeout middleware ───────────────────────────────────────────
  // Kill requests that take > 25s to prevent hanging connections from exhausting
  // the server's connection pool under load.
  //
  // CRITICAL: For tRPC batch requests (/api/trpc/*), return a tRPC-formatted
  // error envelope (HTTP 200 + error JSON array) so the client can parse it as
  // a proper TRPCClientError. Returning a raw 503 with {error:".."} causes the
  // tRPC client to throw a JSON parse error, which the frontend maps to the
  // generic "Server temporarily unavailable" toast instead of a specific message.
  app.use((req, res, next) => {
    const timeout = setTimeout(() => {
      if (!res.headersSent) {
        const isTrpc = req.path.startsWith("/api/trpc");
        console.error(
          `[TIMEOUT] Request timed out: ${req.method} ${logSafe(req.path)} isTrpc=${isTrpc}`
        );
        if (isTrpc) {
          // tRPC batch envelope: HTTP 200 with error in the result array
          // The client will receive a TRPCClientError with code INTERNAL_SERVER_ERROR
          res.status(200).json([
            {
              error: {
                json: {
                  message: "Request timed out. Please try again in a moment.",
                  code: -32603,
                  data: {
                    code: "INTERNAL_SERVER_ERROR",
                    httpStatus: 503,
                    path: req.path.replace("/api/trpc/", ""),
                  },
                },
              },
            },
          ]);
        } else {
          res.status(503).json({ error: "Request timeout" });
        }
      }
    }, 60_000); // 60s: accommodates TiDB cold-start + retryOnce
    // Worst case with cold-start retry:
    //   Attempt 1: read(8s) + parallel_check(8s) + bcrypt(0.11s) + write(8s) = 24.11s [transient fail]
    //   retryOnce delay: 3s
    //   Attempt 2: read(8s) + parallel_check(8s) + bcrypt(0.11s) + write(8s) = 24.11s [success - TiDB warm]
    //   Total: 51.22s << 60s timeout
    // Normal case (TiDB warm): 24.11s << 60s timeout
    // The keep-alive ping (every 4 min) prevents cold starts in practice;
    // this 60s timeout is the last-resort safety net for edge cases.
    res.on("finish", () => clearTimeout(timeout));
    res.on("close", () => clearTimeout(timeout));
    next();
  });

  // Storage proxy — serves /dime-storage/* asset paths (local-first)
  console.log(`[SERVER_STARTUP] Registering storage proxy routes`);
  registerStorageProxy(app);
  // Discord account linking routes
  console.log(`[SERVER_STARTUP] Registering Discord auth/login/invite routes`);
  registerDiscordAuthRoutes(app);
  registerDiscordLoginRoutes(app);
  registerDiscordInviteRoutes(app);

  // User Activity analytics ingestion — private, secret-gated, served ONLY on
  // the back office (store role); returns 404 on the web instance. Inert until
  // ANALYTICS_ROLE=store + ANALYTICS_INGEST_SECRET are set. See server/analytics.
  registerAnalyticsIngestRoute(app);
  registerAnalyticsReadRoute(app);

  // ─── WC2026 Heartbeats ───────────────────────────────────────────────────
  // POST /api/scheduled/wc2026-odds    — every 30 min (5 min near kickoff)
  // POST /api/scheduled/wc2026-splits  — every 10 min
  // POST /api/scheduled/wc2026-lineups — every 10 min
  console.log(`[SERVER_STARTUP] Registering WC2026 heartbeat routes`);
  registerWc2026Heartbeats(app);

  // ─── GitHub Actions cron endpoints (data freshness) ──────────────────────
  // POST /api/cron/vsin-odds · /api/cron/scores — fired by GitHub Actions on a
  // timer, shared-secret authed (CRON_SECRET). These replace the always-on
  // in-process schedulers gated off via DISABLE_BACKGROUND_JOBS on Railway.
  console.log(`[SERVER_STARTUP] Registering GitHub Actions cron routes`);
  registerCronRoutes(app);

  // ─── Dime AI Chat — SSE streaming endpoint ──────────────────────────────
  // POST /api/dime/chat — Claude Fable 5 streaming chat for the Chat tab.
  // Plain Express SSE route (not tRPC) for optimal streaming performance.
  console.log(`[SERVER_STARTUP] Registering Dime AI chat SSE route`);
  registerDimeChatRoute(app);
  console.log(formatDimeRuntimeReadinessLog(getDimeRuntimeReadiness()));
  console.log(formatDimePricingAttestationLog(getDimePricingAttestation()));

  // ─── Dime WC2026 Intelligence — Tier 4 authenticated, credit-gated, source-grounded
  // POST /api/dime/wc2026 — 14-step enforcement, 22-path validated
  console.log(`[SERVER_STARTUP] Registering Dime WC2026 intelligence route`);
  registerDimeWC2026Route(app);

  // tRPC API
  console.log(`[SERVER_STARTUP] Registering tRPC middleware on /api/trpc`);
  app.use(
    "/api/trpc",
    createExpressMiddleware({
      router: appRouter,
      createContext,
      onError: ({ error, path }) => {
        // Log server-side errors (not client errors like UNAUTHORIZED/NOT_FOUND)
        if (error.code === "INTERNAL_SERVER_ERROR") {
          console.error(`[tRPC ERROR] ${path}:`, error);
        }
      },
    })
  );

  // ─── Legacy slug eradication — permanent redirects (308) ────────────────
  // [NAV RECONSTRUCTION 2026-07-11] The pre-Dime navigation slugs (/feed with
  // its ?tab=… query hooks, the public /splits page, /projections, /dashboard)
  // are permanently routed to the canonical surfaces:
  //   /feed/model/{mlb|wc}-MM-DD-YYYY  (AI Model Projections)
  //   /betting-splits/NCAAF            (Betting Splits)
  // Client-side <Redirect>s in App.tsx cover SPA navigations; this middleware
  // covers full-page loads (bookmarks, Discord links, crawlers) with a real
  // HTTP 308 so the legacy URLs drop out of caches and search indexes.
  // 308 (method-preserving) mirrors the www→canonical middleware above.
  // Matches are EXACT paths — /feed/model/* never enters this handler.
  const feedSlugDate = (): string => {
    // Mirrors client CalendarPicker todayUTC(): the feed advances at
    // 07:00 UTC (00:01 PT) — NOT tRPC getCurrentDate's 11:00 cutoff — so the
    // redirect lands on the same slate DimeModelFeed defaults to.
    const FEED_CUTOFF_UTC_HOUR = 7;
    const now = new Date();
    const ms =
      now.getUTCHours() < FEED_CUTOFF_UTC_HOUR
        ? now.getTime() - 24 * 60 * 60 * 1000
        : now.getTime();
    const d = new Date(ms);
    const mo = String(d.getUTCMonth() + 1).padStart(2, "0");
    const da = String(d.getUTCDate()).padStart(2, "0");
    return `${mo}-${da}-${d.getUTCFullYear()}`;
  };
  console.log(
    `[SERVER_STARTUP] Registering legacy slug 308 redirects (/feed, /splits, /projections, /dashboard)`
  );
  const firstQueryValue = (v: unknown): string =>
    typeof v === "string"
      ? v
      : Array.isArray(v) && typeof v[0] === "string"
        ? v[0]
        : "";
  app.get(["/feed", "/splits", "/projections", "/dashboard"], (req, res) => {
    const tab = firstQueryValue(req.query.tab);
    let target: string;
    if (req.path === "/splits" || tab === "splits") {
      target = "/betting-splits/NCAAF";
    } else {
      const sport =
        firstQueryValue(req.query.sport).toUpperCase() === "WC" ? "wc" : "mlb";
      const legacyDate = firstQueryValue(req.query.date);
      const slugDate = /^\d{4}-\d{2}-\d{2}$/.test(legacyDate)
        ? `${legacyDate.slice(5, 7)}-${legacyDate.slice(8, 10)}-${legacyDate.slice(0, 4)}`
        : feedSlugDate();
      target = `/feed/model/${sport}-${slugDate}`;
    }
    // Forward every query param the redirect itself doesn't consume — e.g.
    // discord_linked / discord_error state from OAuth callbacks must survive
    // the hop instead of being silently stripped.
    const passthrough = new URLSearchParams();
    for (const [key, value] of Object.entries(req.query)) {
      if (key === "tab" || key === "sport" || key === "date") continue;
      const v = firstQueryValue(value);
      if (v !== "" || value === "") passthrough.set(key, v);
    }
    const qs = passthrough.toString();
    if (qs) target += `?${qs}`;
    // The /feed target varies with the 07:00 UTC rollover — a cached 308
    // would pin repeat visitors to a stale date, so forbid caching.
    res.set("Cache-Control", "no-store");
    console.log(
      `[legacy→canonical] 308 redirect: ${logSafe(req.originalUrl)} → ${logSafe(target)}`
    );
    res.redirect(308, target);
  });

  // development mode uses Vite, production mode uses static files
  if (process.env.NODE_ENV === "development") {
    console.log(`[SERVER_STARTUP] Setting up Vite dev middleware`);
    await setupVite(app, server);
    console.log(`[SERVER_STARTUP] Vite dev middleware ready`);
  } else {
    console.log(
      `[SERVER_STARTUP] Registering static file serving (production)`
    );
    serveStatic(app);
  }

  const preferredPort = parseInt(process.env.PORT || "3000");
  console.log(
    `[SERVER_STARTUP] Preferred port from env: ${preferredPort} (PORT="${process.env.PORT ?? "(unset)"}")`
  );
  const port = await findAvailablePort(preferredPort);

  if (port !== preferredPort) {
    console.log(
      `[SERVER_STARTUP] Port ${preferredPort} is busy, using port ${port} instead`
    );
  }

  // Registered via server.once("listening") — NOT as a listen() callback — so it
  // runs exactly once (a listen(cb) callback stays armed across re-listens and
  // would double-start every scheduler below).
  const onListening = () => {
    const addr = server.address();
    console.log(
      `[SERVER_STARTUP] ✓ Server listening — bound=${JSON.stringify(addr)} url=http://localhost:${port}/`
    );
    console.log(`Server running on http://localhost:${port}/`);
    // SchemaGuard no longer runs here. It ran fire-and-forget from this handler
    // until the 2026-08-09 closeout, which meant that with SCHEMA_GUARD_FATAL=1 a
    // confirmed-stale deployment started accepting requests and then exited
    // underneath them. The authoritative verdict now resolves in
    // runSchemaGuardPreflight() BEFORE server.listen — see startServer below.
    // Say at boot whether billing alerts can actually reach a human, rather
    // than discovering it the first time something goes wrong.
    reportBillingAlertTransport();
    // Ensure debug_logs table exists — idempotent, non-fatal
    ensureDebugLogsTable().catch((err: unknown) =>
      console.warn(
        "[Startup] [DebugLogger] Table creation failed (non-fatal):",
        err
      )
    );
    // ── Recurring background jobs (metered-host credit control) ──────────────
    // Every job below is an in-process 24/7 loop (VSiN scrapers, model runs,
    // schedule-history refreshes, bet auto-grading, security digests). On a
    // metered host like Railway these loops dominate CPU cost and log volume.
    // Set DISABLE_BACKGROUND_JOBS=1 to run this instance web-only: it still
    // serves pages, DB reads/writes, checkout and Dime Chat — it just stops
    // refreshing odds/lineups/scores/models (and the Discord bot) until the
    // flag is removed or the jobs are moved to a dedicated worker service.
    // Unset (the default) preserves current behavior — every job runs.
    if (isBackgroundJobsDisabled()) {
      console.log(
        "[SCHEDULERS] DISABLE_BACKGROUND_JOBS set — web-only mode: recurring background jobs skipped"
      );
    } else {
      // Start daily 6am EST game purge (removes previous day's games)
      startDailyPurgeSchedule();
      // Auto-refresh VSiN book odds every 30 minutes (6am–midnight PST)
      startVsinAutoRefresh();
      // NHL model sync — runs every 30 min (9AM–9PM PST), models unmodeled NHL games
      startNhlModelSyncScheduler();
      // NHL goalie watcher — checks RotoWire every 10 min for goalie changes, re-runs model on scratch
      startNhlGoalieWatcher();
      // Discord bot — gateway client for role sync, password-reset DMs, security alerts
      startDiscordBot();
      // MLB player sync — nightly at 08:00 UTC, updates active rosters from MLB Stats API
      startMlbPlayerSyncScheduler();
      // MLB schedule history — startup 7-day backfill + refresh every 4h (6AM–midnight EST)
      startMlbScheduleHistoryScheduler();
      // MLB TRENDS nightly refresh — fires at 2:59 AM EST (11:59 PM PST) every night
      // Re-ingests yesterday + today, runs 30-team cross-validation, notifies owner
      startMlbNightlyTrendsScheduler();
      // NBA schedule history — startup 7-day backfill + refresh every 4h (6AM–midnight EST)
      startNbaScheduleHistoryScheduler();
      // NHL schedule history — startup 7-day backfill + refresh every 4h (6AM–midnight EST)
      startNhlScheduleHistoryScheduler();
      // Pre-warm Action Network slate cache for today — eliminates cold-start latency on first BetTracker load
      prewarmSlateCache().catch(err =>
        console.error("[AN][PREWARM] Failed:", err)
      );
      // Automated bet grading — 15-min polling during game hours + nightly 11:30 PM EST sweep
      startBetAutoGradeScheduler();
      // MLB outcome ingestion + f5_share drift detection + auto-recalibration
      // Nightly at 12:30 AM PST: ingest final game outcomes → compute Brier scores → check f5_share drift
      // Monthly on 1st at 3:00 AM PST: full recalibration regardless of drift
      startMlbOutcomeAndDriftScheduler();
      // MLB model sync — standalone 5-min heartbeat for today+tomorrow, 24/7, no time gates
      // Catch-all safety net: models any game with pitchers+lines but modelRunAt=null
      // Idempotent: modelRunAt IS NULL guard prevents re-running already-modeled games
      startMlbModelSyncScheduler();
      // Security digest — daily at 08:00 EST (13:00 UTC), sends 24h threat summary via notifyOwner()
      startSecurityDigestScheduler();
      // Dime Trace v1 — daily purge of restricted raw/context payloads after
      // their 90-day deadline. User-visible chat history is not removed here.
      startDimeChatTraceRetentionScheduler();
      // Weekly security threat trend digest — every Sunday at 08:00 EST, 7-day bar chart + top IPs
      startWeeklySecurityDigestScheduler();

      // ── Startup DB backfills (MOVED inside the guard) ──
      // These write to the DB / scrape an upstream feed on a timer. Previously they
      // ran outside the DISABLE_BACKGROUND_JOBS guard, so every web replica executed
      // them — double-writing the backfills and duplicating the 30-min scrape. They
      // are background jobs and belong behind the kill switch.
      // OddsHistory lineSource backfill — sets lineSource on historical rows where it is NULL
      // Uses game.oddsSource as ground truth. Runs once at startup, no-ops if all rows already set.
      import("../db")
        .then(({ backfillOddsHistoryLineSource }) => {
          backfillOddsHistoryLineSource().catch((err: unknown) =>
            console.warn(
              "[Startup] [OddsHistory][BACKFILL] lineSource backfill failed (non-fatal):",
              err
            )
          );
        })
        .catch((err: unknown) =>
          console.warn(
            "[Startup] [OddsHistory][BACKFILL] Import failed (non-fatal):",
            err
          )
        );

      // K-Props MLBAM ID startup backfill — resolves all historical rows missing pitcher headshot IDs
      // Runs once on server start, non-fatal, no-ops if all rows already resolved
      import("../mlbKPropsModelService")
        .then(({ backfillAllKPropsMlbamIds }) => {
          backfillAllKPropsMlbamIds()
            .then(
              (r: {
                resolved: number;
                alreadyHad: number;
                unresolved: number;
                errors: number;
              }) =>
                console.log(
                  `[Startup] [MLBAM_BACKFILL] K-Props: resolved=${r.resolved} alreadyHad=${r.alreadyHad} unresolved=${r.unresolved} errors=${r.errors}`
                )
            )
            .catch((err: unknown) =>
              console.warn(
                "[Startup] [MLBAM_BACKFILL] K-Props startup backfill failed (non-fatal):",
                err
              )
            );
        })
        .catch((err: unknown) =>
          console.warn(
            "[Startup] [MLBAM_BACKFILL] Import failed (non-fatal):",
            err
          )
        );
    } // ── end recurring background jobs (DISABLE_BACKGROUND_JOBS guard) ──
    // ── DB keep-alive ping ──────────────────────────────────────────────────
    // TiDB Serverless drops idle connections after ~5 minutes. Without a
    // recurring keep-alive, the second password update (or any mutation that
    // comes minutes after the last DB activity) hits a cold TiDB and the
    // connection establishment takes 5-30s — exceeding the circuit breaker
    // timeout and surfacing as "Server temporarily unavailable".
    //
    // Fix: fire SELECT 1 immediately on startup AND every 4 minutes thereafter.
    // This keeps the connection pool warm at all times, eliminating cold-start
    // latency for all UserManagement mutations.
    const runDbKeepAlive = () => {
      getDb()
        .then(db => db!.execute("SELECT 1 AS keepalive"))
        .then(() =>
          console.log("[DB_KEEPALIVE] TiDB connection pool kept warm ✓")
        )
        .catch((err: unknown) =>
          console.warn("[DB_KEEPALIVE] Ping failed (non-fatal):", err)
        );
    };
    // Initial warm-up: 500ms after startup
    setTimeout(runDbKeepAlive, 500);
    // Recurring keep-alive: every 4 minutes (240s) — well under TiDB's 5-min idle timeout
    // unref() prevents this interval from keeping the process alive during tests
    const keepAliveInterval = setInterval(runDbKeepAlive, 4 * 60 * 1000);
    keepAliveInterval.unref();
    console.log(
      "[DB_KEEPALIVE] Recurring TiDB keep-alive scheduled (every 4 min)"
    );

    // ── Checkout reconciliation ────────────────────────────────────────────
    // The webhook is a PUSH channel and cannot report its own silence: an
    // unsubscribed event, an undelivered retry, or a deploy window all leave
    // the ledger stale with nothing to signal it. This pull sweep is the
    // backstop, and it is what makes abandonment measurable WITHOUT depending
    // on `checkout.session.expired` being ticked in the Dashboard.
    //
    // Read-only against Stripe; the only writes are to our own ledger. Runs
    // unref'd so it never holds the process open, and every failure is
    // swallowed — a reconcile outage must not take the server with it.
    const runCheckoutReconcile = async () => {
      // Skip on the analytics-store instance — its DB has no checkout_sessions
      // table (it owns analytics_events, not the app schema), so a sweep there
      // only logs ER_NO_SUCH_TABLE noise. See server/analytics/config.ts.
      if (isAnalyticsStore()) return;
      try {
        const { reconcileCheckoutSessions } = await import("../stripe/checkoutReconcile");
        await reconcileCheckoutSessions();
      } catch (err) {
        console.error(
          `[CheckoutReconcile] [FAIL] sweep failed: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    };
    // First sweep 60s after boot — late enough that the DB pool is warm, early
    // enough that a deploy which missed webhooks self-corrects within a minute.
    setTimeout(runCheckoutReconcile, 60_000).unref();
    const checkoutReconcileInterval = setInterval(runCheckoutReconcile, 30 * 60 * 1000);
    checkoutReconcileInterval.unref();
    console.log("[CheckoutReconcile] Recurring checkout reconcile scheduled (every 30 min)");

    // ── Games list cache pre-warm ─────────────────────────────────────────────
    // Pre-warm the games.list cache for all active sports at startup.
    // Without this, the first user after a deploy pays the full DB cost (~150ms).
    // With this, the cache is hot before any user hits the server.
    // Non-fatal: if DB is unavailable, the first user request will populate the cache.
    setTimeout(() => {
      // Skip on the analytics-store instance — its DB has no `games` table, so
      // pre-warming the feed cache there only logs ER_NO_SUCH_TABLE noise and
      // warms nothing a client will read (the store serves no feed traffic).
      if (isAnalyticsStore()) return;
      // Compute the effective feed date using the same isBeforeCutoff logic as the client (todayUTC()).
      // The client sends { sport, gameDate: todayUTC() } — we MUST pre-warm THAT exact cache key.
      // Without this, the startup pre-warm populates MLB:ROLLING but the client requests MLB:2026-05-16,
      // which is a different cache key → first user always pays full DB cost → loading delay + potential
      // empty result if the DB is slow or temporarily unavailable.
      const FEED_CUTOFF_UTC_HOUR = 11;
      const nowMs = Date.now();
      const nowUtc = new Date(nowMs);
      const isBeforeCutoff = nowUtc.getUTCHours() < FEED_CUTOFF_UTC_HOUR;
      const effectiveMs = isBeforeCutoff ? nowMs - 24 * 60 * 60 * 1000 : nowMs;
      const effectiveDate = new Date(effectiveMs);
      const todayStr = [
        effectiveDate.getUTCFullYear(),
        String(effectiveDate.getUTCMonth() + 1).padStart(2, "0"),
        String(effectiveDate.getUTCDate()).padStart(2, "0"),
      ].join("-");
      // Also pre-warm yesterday and tomorrow to cover the 11:00 UTC boundary window.
      const yesterdayStr = new Date(effectiveMs - 24 * 60 * 60 * 1000)
        .toISOString()
        .slice(0, 10);
      const tomorrowStr = new Date(effectiveMs + 24 * 60 * 60 * 1000)
        .toISOString()
        .slice(0, 10);
      console.log(
        `[Startup] [GAMES_CACHE] Effective date=${todayStr} (utcHour=${nowUtc.getUTCHours()}, beforeCutoff=${isBeforeCutoff}) — pre-warming MLB:${yesterdayStr}, MLB:${todayStr}, MLB:${tomorrowStr}`
      );
      Promise.all([
        // MLB: pre-warm today + yesterday + tomorrow (covers the 11:00 UTC boundary window)
        listGames({ sport: "MLB", gameDate: todayStr }).then(r =>
          console.log(
            `[Startup] [GAMES_CACHE] MLB:${todayStr} pre-warmed: ${r.length} games`
          )
        ),
        listGames({ sport: "MLB", gameDate: yesterdayStr }).then(r =>
          console.log(
            `[Startup] [GAMES_CACHE] MLB:${yesterdayStr} pre-warmed: ${r.length} games`
          )
        ),
        listGames({ sport: "MLB", gameDate: tomorrowStr }).then(r =>
          console.log(
            `[Startup] [GAMES_CACHE] MLB:${tomorrowStr} pre-warmed: ${r.length} games`
          )
        ),
        // Non-MLB: no gameDate filter (VSiN-driven, small dataset, rolling window is correct)
        listGames({ sport: "NHL" }).then(r =>
          console.log(
            `[Startup] [GAMES_CACHE] NHL pre-warmed: ${r.length} games`
          )
        ),
        listGames({ sport: "NBA" }).then(r =>
          console.log(
            `[Startup] [GAMES_CACHE] NBA pre-warmed: ${r.length} games`
          )
        ),
        listGames({ sport: "NCAAM" }).then(r =>
          console.log(
            `[Startup] [GAMES_CACHE] NCAAM pre-warmed: ${r.length} games`
          )
        ),
      ]).catch((err: unknown) =>
        console.warn(
          "[Startup] [GAMES_CACHE] Pre-warm failed (non-fatal):",
          err
        )
      );
    }, 1000); // 1s after startup — before lineup pre-warm, after DB keep-alive
    console.log(
      "[Startup] [GAMES_CACHE] Games list cache pre-warm scheduled (1s after startup)"
    );

    // ── 11:00 UTC boundary cache invalidation ─────────────────────────────────
    // The feed rolls over to the new day's slate at 11:00 UTC. The games cache
    // and availableDates cache must be invalidated at this exact moment so that
    // clients immediately see the new day's games without waiting for the 60s TTL.
    // We schedule a one-shot invalidation to fire at the next 11:00 UTC boundary.
    const scheduleNextCutoffInvalidation = () => {
      // Skip on the analytics-store instance — it has no `games` table and
      // serves no feed, so the boundary re-warm would only log ER_NO_SUCH_TABLE.
      if (isAnalyticsStore()) return;
      const nowMs = Date.now();
      const nowUtc = new Date(nowMs);
      const CUTOFF_HOUR = 11;
      // Compute ms until next 11:00:00 UTC
      let nextCutoffMs: number;
      if (nowUtc.getUTCHours() < CUTOFF_HOUR) {
        // Before cutoff today — fire at 11:00 UTC today (+5s buffer)
        nextCutoffMs =
          Date.UTC(
            nowUtc.getUTCFullYear(),
            nowUtc.getUTCMonth(),
            nowUtc.getUTCDate(),
            CUTOFF_HOUR,
            0,
            5
          ) - nowMs;
      } else {
        // After cutoff today — fire at 11:00 UTC tomorrow (+5s buffer)
        const tomorrow = new Date(nowMs + 24 * 60 * 60 * 1000);
        nextCutoffMs =
          Date.UTC(
            tomorrow.getUTCFullYear(),
            tomorrow.getUTCMonth(),
            tomorrow.getUTCDate(),
            CUTOFF_HOUR,
            0,
            5
          ) - nowMs;
      }
      const nextCutoffDate = new Date(nowMs + nextCutoffMs).toISOString();
      console.log(
        `[Startup] [CUTOFF_INVALIDATION] Next 11:00 UTC boundary invalidation scheduled in ${Math.round(nextCutoffMs / 60000)}min (at ${nextCutoffDate})`
      );
      const cutoffTimer = setTimeout(() => {
        console.log(
          "[Scheduler] [CUTOFF_INVALIDATION] 11:00 UTC boundary reached — force-invalidating all caches"
        );
        forceInvalidateGamesCache();
        // Re-warm the cache immediately after invalidation with the new effective date
        const newNowMs = Date.now();
        const newNowUtc = new Date(newNowMs);
        const newIsBeforeCutoff = newNowUtc.getUTCHours() < CUTOFF_HOUR;
        const newEffectiveMs = newIsBeforeCutoff
          ? newNowMs - 24 * 60 * 60 * 1000
          : newNowMs;
        const newTodayStr = new Date(newEffectiveMs).toISOString().slice(0, 10);
        const newYesterdayStr = new Date(newEffectiveMs - 24 * 60 * 60 * 1000)
          .toISOString()
          .slice(0, 10);
        const newTomorrowStr = new Date(newEffectiveMs + 24 * 60 * 60 * 1000)
          .toISOString()
          .slice(0, 10);
        console.log(
          `[Scheduler] [CUTOFF_INVALIDATION] Re-warming cache for effectiveDate=${newTodayStr}`
        );
        Promise.all([
          listGames({ sport: "MLB", gameDate: newTodayStr }).then(r =>
            console.log(
              `[Scheduler] [CUTOFF_INVALIDATION] MLB:${newTodayStr} re-warmed: ${r.length} games`
            )
          ),
          listGames({ sport: "MLB", gameDate: newYesterdayStr }).then(r =>
            console.log(
              `[Scheduler] [CUTOFF_INVALIDATION] MLB:${newYesterdayStr} re-warmed: ${r.length} games`
            )
          ),
          listGames({ sport: "MLB", gameDate: newTomorrowStr }).then(r =>
            console.log(
              `[Scheduler] [CUTOFF_INVALIDATION] MLB:${newTomorrowStr} re-warmed: ${r.length} games`
            )
          ),
          getAvailableDates("MLB").then(r =>
            console.log(
              `[Scheduler] [CUTOFF_INVALIDATION] MLB availableDates re-warmed: ${r.length} dates`
            )
          ),
        ]).catch((err: unknown) =>
          console.warn(
            "[Scheduler] [CUTOFF_INVALIDATION] Re-warm failed (non-fatal):",
            err
          )
        );
        // Schedule the next day's boundary invalidation
        scheduleNextCutoffInvalidation();
      }, nextCutoffMs);
      cutoffTimer.unref();
    };
    scheduleNextCutoffInvalidation();
  };

  // Host omitted → Node binds dual-stack "::" (IPv6 + IPv4-mapped) when IPv6
  // exists and natively falls back to "0.0.0.0" on any IPv6 handle failure.
  // Railway's edge proxy dials the container over IPv6, so the previous explicit
  // IPv4-only "0.0.0.0" bind made every request 502 at the edge ("connection dial
  // timeout") before it ever reached Express. Fail fast on a bind error so the
  // platform restarts the container instead of leaving a zombie that serves nothing.
  const onBindError = (err: NodeJS.ErrnoException) => {
    console.error(
      `[SERVER_STARTUP] ✗ Could not bind port ${port} (${err.code ?? "?"}) — exiting so the platform restarts`
    );
    process.exit(1);
  };
  server.once("error", onBindError);
  server.once("listening", () => {
    server.removeListener("error", onBindError);
    onListening();
  });
  // Schema/code-agreement gate (Phase 1½): probe the live app_users schema
  // against the code's column set BEFORE we accept Railway health probes, so a
  // code-ahead-of-migration deploy fails its healthcheck (→ Railway keeps the
  // previous healthy deploy) instead of silently breaking auth (#370). Bounded
  // so a slow/unreachable DB never blocks startup; a periodic re-probe catches a
  // mismatch that appears later or a boot probe that timed out.
  //
  // Skip on the analytics-store instance: it does not own app_users (its DB has
  // analytics_events), so the probe there is meaningless and would re-log
  // ER_NO_SUCH_TABLE every interval. With the probe skipped the verdict stays
  // "unknown", so /health stays 200 — the gate only guards the app-owning
  // instances (forwarder/disabled), which is exactly its intended scope.
  if (!isAnalyticsStore()) {
    await runBootSchemaProbe();
    startSchemaProbeInterval();
  }

  // The authoritative nine-table guard, awaited BEFORE listen.
  //
  // Two controls, deliberately different and deliberately both:
  //   runBootSchemaProbe  — narrow (app_users columns only), decides /health
  //                         503 so Railway keeps the previous deploy; periodic.
  //   runSchemaGuardPreflight — broad (every guarded product/billing/ledger
  //                         table), and the only one that can refuse to serve.
  //
  // It self-scopes: on the analytics store it returns not_applicable without
  // touching the product tables, so the call is unconditional. A confirmed FAIL
  // with SCHEMA_GUARD_FATAL=1 exits from inside, before this returns and before
  // any request is accepted. An unavailable verdict is fail-open by design.
  await runSchemaGuardPreflight();

  console.log(
    `[SERVER_STARTUP] Calling server.listen(${port}) — host omitted for dual-stack bind with IPv4 fallback ...`
  );
  server.listen(port);
}

startServer().catch(console.error);
