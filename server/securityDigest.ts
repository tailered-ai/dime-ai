/**
 * securityDigest.ts
 *
 * Schedules a daily security digest that fires in a 10-minute window
 * starting at 08:00 EST (13:00 UTC).
 * On each tick it:
 *   1. Queries security_events for the prior 24-hour window, bucketed by
 *      (eventType, context) — not just eventType (Task 4.9 / A1)
 *   2. Classifies each event's IP against a known-source allowlist
 *      (witnessed CI/owner IPs, owner-configurable) and reports allowlisted
 *      activity separately, EXCLUDED from the threat level (Task 4.9 / A2).
 *      Cloudflare-range membership is NOT, on its own, treated as trusted
 *      automation — see CF_RANGE_ALLOWLIST_ENABLED's comment (2026-08-07
 *      review, Critical 1: an attacker routing through their own free
 *      Cloudflare zone can arrive from a genuine CF PoP IP, and production
 *      is verifiably running EDGE_MODE=log, not "on", so that bypass is
 *      reachable through every context this digest reports on)
 *   3. Labels every count as a deduped sample and states the dedup window
 *      (Task 4.9 / A3)
 *   4. Fires notifyOwner() with a structured summary — a permanent no-op
 *      (see server/_core/notification.ts), so its `false` return is no
 *      longer escalated (that guaranteed a false alarm every run; 2026-08-07
 *      review, Critical 2). A static line in the embed footer notes the
 *      in-app channel is disabled instead of a repeating alert.
 *   5. Posts a rich Discord embed to the 🗒️-𝗦𝗘𝗖𝗨𝗥𝗜𝗧𝗬-𝗘𝗩𝗘𝗡𝗧𝗦 channel — the
 *      ONLY confirmed delivery path. A failed post is retried once, then
 *      logged with a distinctive CRITICAL tag and carried forward as a
 *      note on the next successfully-delivered digest (never re-escalated
 *      via Discord itself — that would be circular; 2026-08-07 review,
 *      Critical 2)
 *   6. Prunes security_events older than 90 days (rolling retention)
 *   7. Persists a restart-safety marker (now also encoding this run's
 *      delivery outcome) so a container restart inside the fire window
 *      cannot cause the digest to be silently skipped for the day. A
 *      restart landing between delivery and this persist step DOES cause a
 *      duplicate fire on the next tick — accepted deliberately, see the B2
 *      note at persistDigestMarker() (Task 4.10 / B2; 2026-08-07 review,
 *      Important 1)
 *
 * Design constraints:
 *   - Fire-and-forget: errors never crash the server
 *   - Digest is skipped (not queued) if the previous run is still in progress
 *   - notifyOwner() is always called — even on clean days (daily confirmation)
 *   - Discord embed is always posted — even on clean days
 *   - All log lines are structured and machine-readable
 *   - Duplicate-over-skip: a missed persistence write must never cause a
 *     silently-skipped day; a duplicate delivery is the accepted trade-off
 *
 * ── Task 4.9 note on A4 (botDetected count) ─────────────────────────────────
 * The brief asks for the count of `botDetected=true` occurrences from
 * server/landingPrerender.ts's prerender check, so a regression to zero is
 * visible daily. That signal is NOT reachable from this digest's data
 * sources: landingPrerender.ts only console.logs `botDetected`, it never
 * calls insertSecurityEvent() or writes to any table this file can query,
 * and landingPrerender.ts is out of scope for this task (not in the allowed
 * file list). Adding a fabricated/always-zero field here would be worse
 * than omitting it — see this task's report for the full reasoning.
 */

import { EmbedBuilder, TextChannel } from "discord.js";
import {
  DIGEST_MARKER_DAILY_EVENT_TYPE,
  DIGEST_MARKER_WEEKLY_EVENT_TYPE,
  getSecurityEventCountsByBucket,
  getSecurityEvents,
  insertSecurityEvent,
  pruneSecurityEvents,
} from "./db";
import { notifyOwner } from "./_core/notification";
import { getDiscordClient } from "./discord/bot";
import { isCloudflareEdgeIp, CF_CIDR_SNAPSHOT_DATE } from "./_core/edgeProxy";
import { logSafe } from "./_core/logSafe";

// ─── Constants ────────────────────────────────────────────────────────────────
const TAG = "[SecurityDigest]";
const DIGEST_HOUR_UTC = 13; // 08:00 EST = 13:00 UTC (accounts for EST = UTC-5)
// B2: widened from a single minute (DIGEST_MINUTE_UTC=0 only) to a 10-minute
// band. A single-minute match plus an in-memory "already fired today" flag
// meant a container restart landing anywhere inside that one minute (live
// odds at ~25 deploys/day) silently skipped the whole day's digest — the
// in-memory flag reset to "" on restart, but by the time the next 60s poll
// ran, `minute` had already moved past 0. A wider window gives the poller
// more chances to catch the fire condition after a restart; the persisted
// marker (see loadLastDigestDate/persistDigestMarker below) is what
// actually prevents a *duplicate* fire within that window.
const DIGEST_WINDOW_START_MINUTE_UTC = 0;
const DIGEST_WINDOW_MINUTES = 10; // fires any tick where minute ∈ [0, 10)
const WINDOW_MS = 24 * 60 * 60 * 1000; // 24-hour lookback window
const PRUNE_RETENTION_DAYS = 90; // delete events older than 90 days
const TOP_IP_LIMIT = 5; // top N (non-allowlisted) IPs to surface in digest
const CHECK_INTERVAL_MS = 60 * 1000; // poll every 60 seconds
const RAW_EVENT_FETCH_LIMIT = 500; // getSecurityEvents() hard cap, see A3 note

/**
 * A3: fireRateLimitEvent() in server/_core/index.ts writes AT MOST ONE
 * security_events row per (ip, path, limitType) per this many seconds, so
 * every count in this digest is a DEDUPED SAMPLE — a lower bound of unknown
 * tightness, not a true request volume. The threat-level thresholds below
 * are computed on that deduped sample, same as before this fix; what
 * changes is that the digest now SAYS so instead of presenting it as a
 * volume. Kept in sync manually with server/_core/index.ts's
 * `RATE_LIMIT_DEDUP_MS` (60_000ms as of writing) — that constant isn't
 * exported and index.ts is out of scope for this task, so there is no way
 * to import it directly.
 */
const RATE_LIMIT_DEDUP_WINDOW_SEC = 60;

/** Target channel: 🗒️-𝗦𝗘𝗖𝗨𝗥𝗜𝗧𝗬-𝗘𝗩𝗘𝗡𝗧𝗦 */
const SECURITY_CHANNEL_ID = "1492280227567501403";

// ─── Threat level config ──────────────────────────────────────────────────────
const THREAT_LEVELS = [
  { label: "CLEAN", threshold: 0, color: 0x57f287, emoji: "✅" }, // Discord green
  { label: "LOW", threshold: 1, color: 0xfee75c, emoji: "🟡" }, // Discord yellow
  { label: "MODERATE", threshold: 10, color: 0xeb6c33, emoji: "🟠" }, // Orange
  { label: "HIGH", threshold: 50, color: 0xed4245, emoji: "🔴" }, // Discord red
  { label: "CRITICAL", threshold: 200, color: 0xf8312f, emoji: "🚨" }, // Bright red
] as const;

export type ThreatLevel = "CLEAN" | "LOW" | "MODERATE" | "HIGH" | "CRITICAL";

// ─── State ────────────────────────────────────────────────────────────────────
let lastDigestDateUTC = ""; // "YYYY-MM-DD" of last successful digest (in-memory fast path)
let digestRunning = false; // guard against overlapping runs

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Returns the current UTC hour and minute. */
function nowUTC(): { hour: number; minute: number } {
  const d = new Date();
  return { hour: d.getUTCHours(), minute: d.getUTCMinutes() };
}

/**
 * Aggregates the top N IPs by event count from a raw event list.
 * Returns an array of { ip, count } sorted descending.
 *
 * Callers should pass only the events they want RANKED as activity — as of
 * Task 4.9 / A2, runSecurityDigest() passes the allowlist-FILTERED event
 * list here, not the raw window, so CI/Cloudflare/owner IPs never occupy a
 * "Top IPs" slot in the digest.
 */
export function topIpsByCount(
  events: Array<{ ip: string | null }>,
  limit: number
): Array<{ ip: string; count: number }> {
  const map = new Map<string, number>();
  for (const e of events) {
    const ip = e.ip ?? "unknown";
    map.set(ip, (map.get(ip) ?? 0) + 1);
  }
  return Array.from(map.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([ip, count]) => ({ ip, count }));
}

/**
 * Determines the threat level based on total event count.
 * Returns the highest matching tier.
 *
 * As of Task 4.9 / A2, callers pass the NON-allowlisted total (see
 * computeDigestData()), not the raw window total, so this function's own
 * signature and thresholds are unchanged — only what gets passed in changed.
 */
export function computeThreatLevel(total: number): ThreatLevel {
  if (total === 0) return "CLEAN";
  if (total < 10) return "LOW";
  if (total < 50) return "MODERATE";
  if (total < 200) return "HIGH";
  return "CRITICAL";
}

/** Returns the color and emoji for a given threat level. */
function threatMeta(level: ThreatLevel): { color: number; emoji: string } {
  const found = THREAT_LEVELS.find(t => t.label === level);
  return { color: found?.color ?? 0x5865f2, emoji: found?.emoji ?? "🔵" };
}

/**
 * Formats an epoch-ms timestamp as a human-readable EST string.
 * Example: "Apr 10, 2026 · 08:00:00 EST"
 */
function formatEst(epochMs: number): string {
  return (
    new Date(epochMs).toLocaleString("en-US", {
      timeZone: "America/New_York",
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    }) + " EST"
  );
}

// ─── Known-source allowlist (Task 4.9 / A2) ────────────────────────────────
//
// Classifies an event's IP as either "expected automation" (excluded from
// the threat-level computation and reported in its own section) or
// unclassified (counted toward the threat level, eligible for "Top IPs").
//
// Reliability is NOT uniform across sources — read each note below before
// trusting a source blindly:
//
//   • Cloudflare edge — RELIABLE. Delegates entirely to
//     isCloudflareEdgeIp() in server/_core/edgeProxy.ts, the SAME pinned
//     CIDR snapshot the edge-defense code already uses as its own
//     second-factor check. This file does NOT hand-roll a second
//     Cloudflare IP list — that was an explicit instruction, and
//     maintaining two lists that can drift apart is exactly how a stale
//     allowlist silently stops matching.
//
//   • Railway edge ranges — NOT IMPLEMENTED. Railway does not publish a
//     stable, documented set of edge/egress CIDRs the way Cloudflare does,
//     and this app now sits fully behind the Cloudflare-fronted domain
//     (2026-08-06 edge activation — direct-origin hits 403 at the origin
//     lock). Legitimate end-user traffic reaching this digest's event
//     stream should already carry a Cloudflare-range IP; a hand-picked
//     guess at Railway's infrastructure ranges would add false confidence
//     without a verifiable source. If Railway later documents official
//     ranges, add a real check here — do not fabricate one now.
//
//   • Azure / GitHub Actions ranges — DELIBERATELY NOT IMPLEMENTED AS A
//     CIDR LIST. This is the one that looks easiest and is actually the
//     most dangerous to get wrong. GitHub-hosted Actions runners are
//     provisioned from Azure's GENERAL public IP pool — Microsoft does not
//     publish a "GitHub Actions" service tag, and GitHub's own docs say
//     runner IP ranges are not published because they change constantly
//     and are shared with every other Azure tenant. The four IPs from the
//     2026-08-06 incident (40.81.6.244, 172.182.201.162, 48.217.34.226,
//     20.49.13.182) all fall in Azure's public space, but that space is
//     enormous (tens of millions of addresses) and is also where plenty of
//     genuine attackers rent VPS/scanning infrastructure. Allowlisting
//     "Azure" as a CIDR range would silently exclude Azure-hosted attackers
//     from the threat level — a worse outcome than the bug this task is
//     fixing. Instead, the SPECIFIC witnessed IPs from that incident are
//     seeded into the known-automation list below as exact /32s, the same
//     mechanism as the owner's own IP. Exact IPs are honest about what they
//     are: a snapshot that WILL go stale as CI infrastructure rotates, not
//     a durable range. Expect to refresh this list — see
//     SECURITY_DIGEST_ALLOWLIST_IPS below for how, without a code change.
//
//   • Owner-configurable list — RELIABLE as an exact-match/CIDR mechanism;
//     accuracy depends entirely on the operator keeping it current. Read
//     from SECURITY_DIGEST_ALLOWLIST_IPS (comma-separated IPv4 addresses
//     and/or IPv4 CIDR ranges, e.g. "1.2.3.4,5.6.7.0/24"). Re-read at call
//     time (not cached at module load) so an env var change takes effect on
//     the next digest without a restart. IPv6 CIDR ranges are not
//     supported here (exact IPv6 addresses work fine) — see
//     matchesIpOrCidr() below.

export interface AllowlistEntry {
  value: string; // exact IPv4/IPv6 address, or "a.b.c.d/nn" IPv4 CIDR
  label: string;
}

export interface AllowlistMatch {
  matched: boolean;
  source: "cloudflare_edge" | "known_automation" | null;
  label: string | null;
}

/**
 * Witnessed CI/owner IPs from the 2026-08-06 production incident (the
 * verbatim digest quoted in this task's brief). Exact IPs, not ranges — see
 * the Azure/GitHub Actions note above for why. These WILL go stale as CI
 * runner infrastructure rotates; SECURITY_DIGEST_ALLOWLIST_IPS extends (not
 * replaces) this list for whoever is maintaining it after rotation.
 */
const DEFAULT_KNOWN_AUTOMATION_IPS: readonly AllowlistEntry[] = [
  {
    value: "47.152.160.175",
    label: "owner ISP IP (ua=curl/8.7.1, dime-ci-probe — 2026-08-06 incident)",
  },
  {
    value: "40.81.6.244",
    label:
      "Azure/GitHub Actions runner, witnessed 2026-08-06 — exact IP, not a range (see A2 note)",
  },
  {
    value: "172.182.201.162",
    label:
      "Azure/GitHub Actions runner, witnessed 2026-08-06 — exact IP, not a range (see A2 note)",
  },
  {
    value: "48.217.34.226",
    label:
      "Azure/GitHub Actions runner, witnessed 2026-08-06 — exact IP, not a range (see A2 note)",
  },
  {
    value: "20.49.13.182",
    label:
      "Azure/GitHub Actions runner, witnessed 2026-08-06 — exact IP, not a range (see A2 note)",
  },
];

/**
 * Reads the owner-configurable allowlist from SECURITY_DIGEST_ALLOWLIST_IPS
 * at call time. `env` is injectable for tests; defaults to `process.env`.
 */
export function getOwnerConfiguredAllowlist(
  env: Record<string, string | undefined> = process.env
): AllowlistEntry[] {
  const raw = (env.SECURITY_DIGEST_ALLOWLIST_IPS ?? "").trim();
  if (!raw) return [];
  return raw
    .split(",")
    .map(s => s.trim())
    .filter(Boolean)
    .map(value => ({
      value,
      label: "owner-configured (SECURITY_DIGEST_ALLOWLIST_IPS)",
    }));
}

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const o = Number(p);
    if (o > 255) return null;
    n = n * 256 + o;
  }
  return n >>> 0;
}

/**
 * Minimal, self-contained IPv4 CIDR match for owner-configured entries
 * only. Cloudflare matching NEVER uses this — it goes exclusively through
 * isCloudflareEdgeIp(). This is intentionally NOT a copy of that module's
 * private inCidrV4()/ipv4ToInt() helpers (which aren't exported and
 * server/_core/edgeProxy.ts is out of this task's edit scope) — it is
 * generic CIDR math for arbitrary owner-supplied ranges.
 */
function ipv4InCidr(ip: string, cidr: string): boolean {
  const [net, bitsStr] = cidr.split("/");
  const bits = Number(bitsStr);
  const ipN = ipv4ToInt(ip);
  const netN = ipv4ToInt(net);
  if (
    ipN === null ||
    netN === null ||
    Number.isNaN(bits) ||
    bits < 0 ||
    bits > 32
  ) {
    return false;
  }
  if (bits === 0) return true;
  const mask = bits === 32 ? 0xffffffff : (0xffffffff << (32 - bits)) >>> 0;
  return (ipN & mask) >>> 0 === (netN & mask) >>> 0;
}

function matchesIpOrCidr(ip: string, pattern: string): boolean {
  if (pattern.includes("/")) {
    // IPv4 CIDR only — see the allowlist note above for why. An IPv6
    // pattern with a "/" simply never matches (fails safe: falls through
    // to "not allowlisted", never silently matches the wrong address).
    if (ip.includes(":")) return false;
    return ipv4InCidr(ip, pattern);
  }
  return ip === pattern;
}

/**
 * RATE_LIMIT `context` (limitType) values whose recorded `ip` is NEVER
 * resolveClientIdentity()'s secret-vetted value, structurally, regardless
 * of EDGE_MODE or any future infra hardening — it is the raw, un-vetted
 * immediate-hop IP instead. Read server/_core/index.ts's `originLock`
 * onEvent callback and its `/api/trpc` edge-aware canary before touching
 * this set; both fire this exact context string:
 *
 *   - "edge_deny" (the only originLock branch that actually 403s the
 *     request): `ip = immediateUpstreamIp(req) || resolveClientIp(req)`.
 *   - the `/api/trpc` canary (observe-only, never blocks): `ip = upstream
 *     || ip` where `upstream = immediateUpstreamIp(req)`.
 *
 * Neither goes through resolveClientIdentity(), so neither is gated on the
 * shared `x-dime-edge-secret` BY CONSTRUCTION — this is true independent of
 * EDGE_MODE, independent of whether Authenticated Origin Pulls is ever
 * added at the infra layer, independent of everything except these two
 * call sites' own code. An event on this context exists BECAUSE the
 * load-bearing secret check already failed (edge_deny) or was never
 * consulted at all (the canary), so a genuine Cloudflare PoP IP on this
 * context is the PRECISE shape of the self-allowlisting bypass
 * server/_core/edgeProxy.ts's design law #2 describes ("Any party can
 * route the origin through their OWN free Cloudflare zone and arrive from
 * a genuine CF PoP IP"). classifyIp() refuses the cloudflare_edge branch
 * outright for this context — unconditionally, regardless of the global
 * CF_RANGE_ALLOWLIST_ENABLED flag below, and regardless of blocked/
 * observed outcome (outcome isn't even persisted to this column, see
 * fireRateLimitEvent()'s own comment). This is a PERMANENT rule, not tied
 * to today's deploy config — kept as an explicit second layer on top of
 * CF_RANGE_ALLOWLIST_ENABLED so that if that flag is ever safely
 * re-enabled in the future, this one context still can't slip through.
 * (2026-08-07 review, Critical 1.)
 */
const UNVETTED_IP_RATE_LIMIT_CONTEXTS: ReadonlySet<string> = new Set([
  "edge_origin_ingress_anomaly",
]);

/**
 * Whether classifyIp() may EVER treat Cloudflare-range membership, on its
 * own, as evidence of trusted automation for contexts OTHER than the
 * permanently-excluded set above. Hard-disabled — do not flip this to
 * `true` without re-reading the whole comment below; "EDGE_MODE is on
 * right now" is not sufficient justification (see why).
 *
 * CORRECTED 2026-08-07 (mid-review): an earlier version of this rule
 * assumed EDGE_MODE=on (origin lock actively 403ing every secret-less
 * request) was the live production state, and scoped the cloudflare_edge
 * refusal to ONLY "edge_origin_ingress_anomaly" on that assumption. That
 * assumption was FALSE, and the scope was too narrow as a result.
 * Production is verifiably running EDGE_MODE=log as of deployment
 * abe24797-f46c-4033-a95f-cb1958bd8488 (2026-08-07T09:05:24Z) — proven
 * behaviorally, not assumed:
 *   - a direct probe to the raw origin's GET /login returned HTTP 200 (an
 *     armed origin lock in "on" mode 403s this request instead);
 *   - that same request fired a RATE_LIMIT/edge_origin_ingress_anomaly
 *     event at 09:09:28Z, and originLock returns next() BEFORE onEvent
 *     fires when mode is "off" — so an event firing at all proves mode is
 *     "log", not "off" either;
 *   - both "on"-mode escape hatches are independently ruled out: no
 *     "CRITICAL ... no EDGE_ORIGIN_SECRET" anti-lockout line exists in
 *     that window, and the circuit breaker needs 3 consecutive 60s windows
 *     of >=200 requests with zero verified-Cloudflare to trip — actual
 *     traffic in that window was ~6 requests, several CF-verified, nowhere
 *     near that threshold.
 *
 * Under "log" (and "off"), originLock does NOT 403 a secret-less request —
 * it calls next() and serves it. That request then reaches EVERY handler
 * that calls resolveClientIdentity(): the global/auth/trpc_auth/
 * stripe_checkout/waitlist_submit/public_feed rate limiters, the CSRF
 * origin check, and the login AUTH_FAIL path — i.e. every context this
 * digest reports on, not only the edge one. resolveClientIdentity() only
 * returns `cf-connecting-ip` after edgeProofPasses() validates the shared
 * secret; without a valid secret it falls back to the leftmost
 * X-Forwarded-For token. For an attacker proxying through their OWN free
 * Cloudflare zone, that leftmost token IS a genuine Cloudflare-range PoP
 * IP — indistinguishable, from a stored security_events row alone, from
 * traffic that happened to pass through OUR real Cloudflare zone during a
 * period the secret wasn't validating. So today, in the live deployment,
 * the self-allowlisting bypass this task exists to close is reachable
 * through ANY rate-limit context (and CSRF_BLOCK/AUTH_FAIL), not only
 * edge_origin_ingress_anomaly — a context allowlist/denylist alone is
 * insufficient, because "which contexts are reachable without the secret"
 * is a property of EDGE_MODE, which this file does not control and must
 * not assume. Hence one flag covering every context, defaulted to the safe
 * (never-trust) state, rather than trying to enumerate "safe" contexts
 * that would silently become wrong on the next mode change.
 *
 * Re-enabling this would need one of:
 *   (a) Cloudflare Authenticated Origin Pulls / mTLS or a Cloudflare
 *       Tunnel enforced at the infra layer (edgeProxy.ts's own design law
 *       #2 names this as the actual fix) so a non-Cloudflare-signed
 *       connection cannot reach Railway at all, regardless of EDGE_MODE —
 *       at that point every persisted IP that isn't known-automation is
 *       moot, because only Cloudflare can ever connect; or
 *   (b) persisting, per security_events row, whether edgeProofPasses()
 *       actually validated for that specific request — needs a schema
 *       change (drizzle/, rides db-push.yml) and a server/_core/index.ts
 *       change, both out of this task's edit scope.
 * Neither is true today. Re-derive current EDGE_MODE from behavior (as
 * above) before ever touching this flag — do not trust a comment, a memory
 * note, or an env var read at a different time than the decision.
 */
const CF_RANGE_ALLOWLIST_ENABLED = false;

/**
 * Classifies a single IP against the known-source allowlist. Checks
 * Cloudflare first — gated by CF_RANGE_ALLOWLIST_ENABLED (currently
 * `false`, see its comment) and, even if that flag is ever re-enabled,
 * permanently excluded for the contexts in UNVETTED_IP_RATE_LIMIT_CONTEXTS
 * — then the known-automation list (defaults + owner-configured, in that
 * order). Returns the first match.
 *
 * `context` is the event's (eventType, context) bucket key — i.e. the
 * RATE_LIMIT `limitType` slug, or null/absent for CSRF_BLOCK/AUTH_FAIL
 * events.
 */
export function classifyIp(
  ip: string | null,
  extraAllowlist?: AllowlistEntry[],
  context?: string | null
): AllowlistMatch {
  if (!ip) return { matched: false, source: null, label: null };

  const contextPermanentlyExcluded = Boolean(
    context && UNVETTED_IP_RATE_LIMIT_CONTEXTS.has(context)
  );
  if (
    CF_RANGE_ALLOWLIST_ENABLED &&
    !contextPermanentlyExcluded &&
    isCloudflareEdgeIp(ip)
  ) {
    return {
      matched: true,
      source: "cloudflare_edge",
      label: `Cloudflare edge PoP (CIDR snapshot ${CF_CIDR_SNAPSHOT_DATE})`,
    };
  }

  const entries = [
    ...DEFAULT_KNOWN_AUTOMATION_IPS,
    ...(extraAllowlist ?? getOwnerConfiguredAllowlist()),
  ];
  for (const entry of entries) {
    if (matchesIpOrCidr(ip, entry.value)) {
      return { matched: true, source: "known_automation", label: entry.label };
    }
  }

  return { matched: false, source: null, label: null };
}

/**
 * Splits a raw event list into non-allowlisted ("flagged" — counts toward
 * the threat level and is eligible for "Top IPs") and allowlisted
 * ("expected automation" — reported separately, excluded from the threat
 * level).
 */
export function splitEventsByAllowlist<
  T extends { ip: string | null; context?: string | null },
>(
  events: T[],
  extraAllowlist?: AllowlistEntry[]
): {
  flagged: T[];
  allowlisted: Array<
    T & {
      allowlistSource: "cloudflare_edge" | "known_automation";
      allowlistLabel: string;
    }
  >;
} {
  // Resolve the owner-configured allowlist ONCE (not per-event) — same
  // result either way, but avoids re-reading/re-parsing an env var up to
  // RAW_EVENT_FETCH_LIMIT times per digest run.
  const resolvedExtra = extraAllowlist ?? getOwnerConfiguredAllowlist();
  const flagged: T[] = [];
  const allowlisted: Array<
    T & {
      allowlistSource: "cloudflare_edge" | "known_automation";
      allowlistLabel: string;
    }
  > = [];
  for (const e of events) {
    const match = classifyIp(e.ip, resolvedExtra, e.context ?? null);
    if (match.matched && match.source) {
      allowlisted.push({
        ...e,
        allowlistSource: match.source,
        allowlistLabel: match.label ?? "",
      });
    } else {
      flagged.push(e);
    }
  }
  return { flagged, allowlisted };
}

/**
 * getSecurityEvents() (unlike the two aggregate functions in db.ts) has no
 * eventType exclusion of its own — it's a general-purpose raw query used
 * elsewhere (e.g. server/routers/security.ts's owner dashboard list), and
 * that file is out of this task's edit scope. A digest's own marker row
 * from a PRIOR run routinely falls inside its lookback window (the daily
 * window is 24h, the marker fires once/day; the weekly window is 7 days
 * and can contain up to 7 daily markers plus 1 weekly marker) — without
 * this filter, `ip: "system"` would show up as a phantom "Top IP" entry.
 * It does NOT affect any numeric total: those come from
 * getSecurityEventCountsByBucket(), which already excludes marker rows at
 * the SQL layer.
 */
export function filterDigestMarkers<T extends { eventType: string }>(
  events: T[]
): T[] {
  return events.filter(
    e =>
      e.eventType !== DIGEST_MARKER_DAILY_EVENT_TYPE &&
      e.eventType !== DIGEST_MARKER_WEEKLY_EVENT_TYPE
  );
}

// ─── (eventType, context) bucket helpers (Task 4.9 / A1) ─────────────────────

export interface BucketCount {
  eventType: string;
  context: string | null;
  count: number;
}

function sumByEventType(buckets: BucketCount[], eventType: string): number {
  return buckets
    .filter(b => b.eventType === eventType)
    .reduce((s, b) => s + b.count, 0);
}

/** Renders the per-context breakdown for one eventType, sorted by volume. */
function formatBucketBreakdown(
  buckets: BucketCount[],
  eventType: string
): string {
  const rows = buckets
    .filter(b => b.eventType === eventType)
    .sort((a, b) => b.count - a.count);
  if (rows.length === 0) return "  (none)";
  return rows
    .map(b => `  ${b.context ?? "(no context)"}: ${b.count}`)
    .join("\n");
}

// ─── Core digest computation (pure — Task 4.9 A1/A2/A3) ───────────────────────

export interface DigestComputation {
  bucketCounts: BucketCount[];
  /** Accurate (unlimited, SQL-aggregated) total across all buckets. */
  totalAll: number;
  eventTypeTotals: {
    CSRF_BLOCK: number;
    RATE_LIMIT: number;
    AUTH_FAIL: number;
  };
  /** Non-allowlisted events from the raw sample — ranked for "Top IPs". */
  flagged: Array<{ ip: string | null }>;
  /** Allowlisted events from the raw sample — "expected automation". */
  allowlisted: Array<{
    ip: string | null;
    allowlistSource: "cloudflare_edge" | "known_automation";
    allowlistLabel: string;
  }>;
  /** totalAll minus the allowlisted count observed in the raw sample, floored at 0. */
  threatTotal: number;
  threatLevel: ThreatLevel;
  topIps: Array<{ ip: string; count: number }>;
  /** True when the raw-event sample hit its fetch cap — see A3 note. */
  sampleCapped: boolean;
}

/**
 * Builds every number the digest reports from two independent queries:
 *   - `bucketCounts`  — accurate, UNLIMITED per-(eventType,context) totals
 *     from getSecurityEventCountsByBucket() (SQL GROUP BY, not capped).
 *   - `rawEvents`     — up to RAW_EVENT_FETCH_LIMIT most recent rows from
 *     getSecurityEvents(), the only way to classify by IP (allowlist
 *     matching needs the actual IP; SQL-side CIDR matching against
 *     Cloudflare/owner ranges was not implemented — see the allowlist note
 *     above).
 *
 * Known limitation, stated honestly rather than silently: if the window
 * contains MORE than RAW_EVENT_FETCH_LIMIT events, the allowlist split is
 * computed over the most recent sample only. `threatTotal` is then
 * `totalAll - allowlisted.length`, which UNDER-subtracts (because some
 * older, un-sampled events may also have been allowlisted) — meaning a
 * capped sample can only ever make `threatTotal` too HIGH, never too LOW.
 * That is the safe direction to be wrong in: it can trigger extra review of
 * a clean day, never mask a real attack. `sampleCapped` on the result flags
 * exactly when this applies; in the observed production incident (111
 * total events) the sample was never remotely close to the cap.
 */
export function computeDigestData(
  bucketCounts: BucketCount[],
  rawEvents: Array<{ ip: string | null; context?: string | null }>,
  opts?: { rawFetchLimit?: number; extraAllowlist?: AllowlistEntry[] }
): DigestComputation {
  const rawFetchLimit = opts?.rawFetchLimit ?? RAW_EVENT_FETCH_LIMIT;
  const totalAll = bucketCounts.reduce((s, b) => s + b.count, 0);
  const eventTypeTotals = {
    CSRF_BLOCK: sumByEventType(bucketCounts, "CSRF_BLOCK"),
    RATE_LIMIT: sumByEventType(bucketCounts, "RATE_LIMIT"),
    AUTH_FAIL: sumByEventType(bucketCounts, "AUTH_FAIL"),
  };

  const { flagged, allowlisted } = splitEventsByAllowlist(
    rawEvents,
    opts?.extraAllowlist
  );
  const threatTotal = Math.max(0, totalAll - allowlisted.length);
  const threatLevel = computeThreatLevel(threatTotal);
  const topIps = topIpsByCount(flagged, TOP_IP_LIMIT);
  const sampleCapped = rawEvents.length >= rawFetchLimit;

  return {
    bucketCounts,
    totalAll,
    eventTypeTotals,
    flagged,
    allowlisted,
    threatTotal,
    threatLevel,
    topIps,
    sampleCapped,
  };
}

/** Summarizes allowlisted events by source for the "expected automation" section. */
function summarizeAllowlistedBySource(
  allowlisted: DigestComputation["allowlisted"]
): Array<{ source: string; count: number }> {
  const map = new Map<string, number>();
  for (const e of allowlisted) {
    const key =
      e.allowlistSource === "cloudflare_edge"
        ? "Cloudflare edge"
        : "Known automation (CI/owner)";
    map.set(key, (map.get(key) ?? 0) + 1);
  }
  return Array.from(map.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([source, count]) => ({ source, count }));
}

// ─── Digest marker persistence (Task 4.10 / B2) ───────────────────────────────

/**
 * The marker's `context` column historically held just the fired date
 * ("2026-08-07"). It now ALSO carries this run's Discord delivery outcome,
 * so the NEXT run can carry a "previous digest failed to deliver" notice
 * forward (Critical 2, 2026-08-07 review — see the module header's step 5
 * and postDigestToDiscord()'s comment for why this can't be escalated via
 * Discord itself). Encoding stays inside ONE existing marker row rather
 * than adding a new eventType specifically because
 * getSecurityEventCountsByBucket() (server/db.ts, out of this task's edit
 * scope) already excludes DIGEST_MARKER_DAILY/WEEKLY from its SQL-side
 * totals — a NEW eventType would silently inflate `totalAll` on every
 * digest that ever recorded a delivery failure, since that exclusion list
 * lives in a file this task cannot touch.
 */
const DIGEST_MARKER_FAILURE_SEP = "|discord_failed:";

// Exported so weeklySecurityDigest.ts's own marker (separate eventType, same
// encoding scheme) can reuse this instead of re-implementing it.
export function encodeDigestMarkerContext(
  dateStr: string,
  failureReason: string | null
): string {
  if (!failureReason) return dateStr;
  // Keep it short and single-line — this still rides the same text column
  // as everything else, and needs to render cleanly inside a Discord embed
  // field on the next run.
  const safeReason = failureReason.slice(0, 300).replace(/[\r\n]+/g, " ");
  return `${dateStr}${DIGEST_MARKER_FAILURE_SEP}${safeReason}`;
}

export function decodeDigestMarkerContext(
  context: string | null | undefined
): { date: string; failureReason: string | null } | null {
  if (!context) return null;
  const idx = context.indexOf(DIGEST_MARKER_FAILURE_SEP);
  if (idx === -1) return { date: context, failureReason: null };
  return {
    date: context.slice(0, idx),
    failureReason: context.slice(idx + DIGEST_MARKER_FAILURE_SEP.length),
  };
}

/**
 * Writes the restart-safety sentinel row (see DIGEST_MARKER_* constants in
 * db.ts). Best-effort — a failure here is logged, never thrown; the
 * in-memory `lastDigestDateUTC` still prevents a double-fire for the rest
 * of THIS process's lifetime even if persistence fails, same as before this
 * fix. What persistence adds is surviving a RESTART inside the fire window.
 *
 * `failureReason` (null when this run's Discord post succeeded, or was
 * skipped because Discord isn't configured in this environment) is encoded
 * into `context` alongside the date — see encodeDigestMarkerContext().
 *
 * IMPORTANT (B2 / Important 1, 2026-08-07 review): this call happens LAST
 * — after notifyOwner and the Discord post have both already completed
 * (see runSecurityDigest()'s Steps 4/5 vs 7). That ordering is deliberate,
 * not an oversight: writing the marker FIRST would let a process kill
 * between the write and the actual delivery attempts produce a genuinely
 * missed day that nothing detects (the marker says "done" when it isn't).
 * Writing it LAST means the only failure mode is the opposite one — a kill
 * between "delivery completed" and "this line running" causes the NEXT
 * tick (same 10-minute window, restart-safe path in maybeFireDigest()) to
 * fire again, producing a duplicate delivery. Duplicate-over-skip is the
 * accepted trade-off: a duplicate Discord post is a mild annoyance, a
 * silently skipped day is a real gap in the only working delivery channel.
 * Do not invert this ordering to "fix" the duplicate — that trades a safe
 * failure mode for an unsafe one. See
 * server/securityDigest.test.ts's "B2 — marker write ordering" tests,
 * which assert this call happens after notifyOwner/channel.send and fail
 * if that ordering regresses.
 */
async function persistDigestMarker(
  dateStr: string,
  failureReason: string | null = null
): Promise<void> {
  await insertSecurityEvent({
    eventType: DIGEST_MARKER_DAILY_EVENT_TYPE,
    ip: "system",
    blockedOrigin: null,
    trpcPath: null,
    httpMethod: null,
    userAgent: "security-digest-scheduler",
    context: encodeDigestMarkerContext(dateStr, failureReason),
    occurredAt: Date.now(),
  });
}

/**
 * Reads back the most recently persisted "last fired" date for the daily
 * digest. Returns null if unavailable (DB down, no marker yet) — callers
 * MUST treat null as "unknown, not proven fired" and let the normal
 * in-memory guard + digestRunning lock be the backstop, never block firing
 * on a failed read. Strips any encoded delivery-failure suffix (see
 * encodeDigestMarkerContext()) so B2's exact-date comparison in
 * maybeFireDigest() is unaffected by that encoding.
 */
export async function loadLastDigestDate(): Promise<string | null> {
  const rows = await getSecurityEvents({
    eventType: DIGEST_MARKER_DAILY_EVENT_TYPE,
    limit: 1,
    existenceProbe: true,
  });
  return decodeDigestMarkerContext(rows[0]?.context)?.date ?? null;
}

/**
 * Reads back whether the MOST RECENTLY persisted daily-marker row recorded
 * a Discord delivery failure (Critical 2, 2026-08-07 review). Called near
 * the top of a run, before this run's OWN marker overwrites it — so it
 * reports the outcome of the run before this one, which is exactly what a
 * "previous digest failed to deliver" carry-forward notice needs. Returns
 * null on no marker / no recorded failure / a failed read (best-effort,
 * same philosophy as loadLastDigestDate()).
 */
export async function loadLastDigestDeliveryFailure(): Promise<{
  date: string;
  reason: string;
} | null> {
  const rows = await getSecurityEvents({
    eventType: DIGEST_MARKER_DAILY_EVENT_TYPE,
    limit: 1,
    existenceProbe: true,
  });
  const decoded = decodeDigestMarkerContext(rows[0]?.context);
  if (!decoded || !decoded.failureReason) return null;
  return { date: decoded.date, reason: decoded.failureReason };
}

// ─── Discord digest embed builder ─────────────────────────────────────────────
/**
 * Builds the daily digest embed for the 🗒️-𝗦𝗘𝗖𝗨𝗥𝗜𝗧𝗬-𝗘𝗩𝗘𝗡𝗧𝗦 channel.
 *
 * Written in plain English so @prez can read it at a glance without needing
 * to decode technical jargon. Each section explains what happened, how many
 * times, and what (if anything) to do about it.
 */
function buildDigestEmbed(
  data: DigestComputation,
  windowStartMs: number,
  windowEndMs: number,
  previousDeliveryFailure: { date: string; reason: string } | null = null
): EmbedBuilder {
  const { color, emoji } = threatMeta(data.threatLevel);
  const dateLabel = new Date(windowEndMs).toLocaleDateString("en-US", {
    timeZone: "America/New_York",
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });

  const threatDescriptions: Record<ThreatLevel, string> = {
    CLEAN:
      "No unclassified security events in the last 24 hours (after excluding known automation). Everything looks normal.",
    LOW: "A small number of unclassified security events were recorded. This is within normal range and likely just routine noise. No action needed unless you see a pattern.",
    MODERATE:
      "A moderate number of unclassified security events were recorded. Worth reviewing the top IPs below to see if anything looks suspicious. No immediate action required.",
    HIGH: "A high number of unclassified security events were recorded. Someone may be actively probing or attacking the site. Review the top IPs and consider blocking them at the firewall if the pattern continues.",
    CRITICAL:
      "A critical number of unclassified security events were recorded. The site is likely under active attack. Immediate review is strongly recommended — check the top IPs and consider emergency firewall rules.",
  };

  const csrfDesc =
    data.eventTypeTotals.CSRF_BLOCK === 0
      ? "0 — No cross-site request attempts detected."
      : `${data.eventTypeTotals.CSRF_BLOCK} — Someone tried to make requests to the site from an unauthorized external website. Each block means the attack was stopped before it could do anything.`;

  const rateLimitBreakdown = formatBucketBreakdown(
    data.bucketCounts,
    "RATE_LIMIT"
  );
  const rateLimitDesc =
    data.eventTypeTotals.RATE_LIMIT === 0
      ? "0 — No rate limit triggers."
      : `${data.eventTypeTotals.RATE_LIMIT} total, by type:\n\`\`\`\n${rateLimitBreakdown}\n\`\`\`` +
        `Broken down by trigger type — known CI/owner automation (exact-IP matches) is excluded from ` +
        `the "expected automation" total below and doesn't count toward the threat level.`;

  const authFailDesc =
    data.eventTypeTotals.AUTH_FAIL === 0
      ? "0 — No failed login attempts. All login traffic was clean."
      : `${data.eventTypeTotals.AUTH_FAIL} — Someone tried to log in with incorrect credentials. Multiple failures from the same IP usually indicate a password-guessing attack.`;

  const topIpValue =
    data.topIps.length > 0
      ? data.topIps
          .map(
            ({ ip, count }, i) =>
              `\`${i + 1}.\` \`${ip}\` — **${count}** event${count !== 1 ? "s" : ""}`
          )
          .join("\n")
      : "_No unclassified events recorded — nothing to report._";

  const allowlistSummary = summarizeAllowlistedBySource(data.allowlisted);
  const allowlistValue =
    allowlistSummary.length > 0
      ? allowlistSummary
          .map(({ source, count }) => `• **${source}**: ${count}`)
          .join("\n") + `\n_Excluded from the threat level above._`
      : "_None detected in the sampled window._";

  const windowValue =
    `From: \`${formatEst(windowStartMs)}\`\n` +
    `To:   \`${formatEst(windowEndMs)}\`\n` +
    `_Counts are a DEDUPED SAMPLE — at most 1 row per (IP, path, type) per ` +
    `${RATE_LIMIT_DEDUP_WINDOW_SEC}s, so this is a lower bound, not a request volume.` +
    (data.sampleCapped
      ? ` The allowlist split hit its ${RAW_EVENT_FETCH_LIMIT}-event sample cap — see the digest's own report for what that means for the threat total._`
      : "_");

  // Critical 2 (2026-08-07 review): a one-time-per-occurrence note carried
  // forward from a previous run whose Discord post failed (see
  // loadLastDigestDeliveryFailure()/postDigestToDiscord()). Only present
  // when there's something to say — this is NOT the static footer line
  // below, which is unconditional.
  const previousFailureFields = previousDeliveryFailure
    ? [
        {
          name: "⚠️ Previous Digest Delivery Failed",
          value:
            `The digest for **${previousDeliveryFailure.date}** could not be posted to this channel ` +
            `(reason: ${previousDeliveryFailure.reason}). This is that missed notice, delivered now that ` +
            `the channel is reachable again. Search Railway logs around that date for ` +
            `\`[CRITICAL] [DIGEST_DELIVERY_FAILED]\` for the full detail.`,
          inline: false,
        },
      ]
    : [];

  return new EmbedBuilder()
    .setColor(color)
    .setTitle(`${emoji} Daily Security Digest — ${dateLabel}`)
    .setDescription(
      `**Threat Level: ${data.threatLevel}**\n\n${threatDescriptions[data.threatLevel]}`
    )
    .addFields(
      ...previousFailureFields,
      {
        name: "🚫 CSRF Blocks (Cross-Site Attack Attempts)",
        value: csrfDesc,
        inline: false,
      },
      {
        name: "⚡ Rate Limit Triggers (Too Many Requests) — by type",
        value: rateLimitDesc,
        inline: false,
      },
      {
        name: "🔐 Auth Failures (Failed Login Attempts)",
        value: authFailDesc,
        inline: false,
      },
      {
        name: `📊 Total Events in 24 Hours (deduped sample)`,
        value: `**${data.totalAll}** total · **${data.threatTotal}** unclassified (used for threat level)`,
        inline: true,
      },
      {
        name: "🗑️ Retention",
        value: `Events older than **${PRUNE_RETENTION_DAYS} days** are automatically deleted after each digest.`,
        inline: true,
      },
      {
        name: `🖥️ Top ${TOP_IP_LIMIT} Most Active Unclassified IPs`,
        value: topIpValue,
        inline: false,
      },
      {
        name: "🤖 Expected Automation (excluded from threat level)",
        value: allowlistValue,
        inline: false,
      },
      {
        name: "🕐 Reporting Window",
        value: windowValue,
        inline: false,
      }
    )
    .setFooter({
      // Static line (Critical 2, 2026-08-07 review): notifyOwner() is a
      // permanent no-op (server/_core/notification.ts) — this says so once,
      // unconditionally, on every embed, instead of firing a separate
      // Discord alert every time that guaranteed-false result comes back.
      text: "AI Sports Betting · Daily Security Digest · Fires ~08:00 EST · In-app notifications (notifyOwner) are disabled — this Discord channel is the confirmed delivery path",
    })
    .setTimestamp(windowEndMs);
}

// ─── Discord digest poster ────────────────────────────────────────────────────

/**
 * Outcome of a Discord post attempt.
 *   - "sent": delivered.
 *   - "skipped_not_configured": no Discord client in THIS environment at
 *     all (dev/test, or a deployment without DISCORD_BOT_TOKEN) — this is
 *     the module's own long-standing, intentional behavior, NOT a failure,
 *     and must never be escalated or carried forward.
 *   - "failed": Discord IS configured but delivery broke — bot not ready,
 *     channel fetch/type mismatch, or channel.send() throwing after a
 *     retry. THIS is the "total zero-notification day" gap (Critical 2,
 *     2026-08-07 review).
 */
export type DigestDeliveryResult =
  | { status: "sent" }
  | { status: "skipped_not_configured" }
  | { status: "failed"; reason: string };

/**
 * Posts the daily digest embed to the 🗒️-𝗦𝗘𝗖𝗨𝗥𝗜𝗧𝗬-𝗘𝗩𝗘𝗡𝗧𝗦 channel.
 * Fire-and-forget — never throws, always resolves a DigestDeliveryResult.
 *
 * Critical 2 (2026-08-07 review) design: the module's own header says this
 * channel "is the only confirmed-working delivery path right now" — so a
 * failed post here is a genuine total zero-notification day, and nothing
 * previously observed it beyond a console.error nobody reads unless
 * already tailing Railway logs. You cannot reliably escalate a FAILED
 * Discord post BY POSTING TO THE SAME DISCORD CHANNEL — that's circular by
 * construction (if it's broken, the escalation attempt breaks too). So
 * this uses three independent, non-circular layers instead:
 *   1. One immediate retry on `channel.send()` — cheap insurance against a
 *      single transient API hiccup. No artificial delay: this path is
 *      fire-and-forget and must not block the digest run loop.
 *   2. A distinctively-tagged CRITICAL log line
 *      (`[CRITICAL] [DIGEST_DELIVERY_FAILED]`) on final failure — greppable
 *      by any OUT-OF-BAND log-based alerting (Railway logs), independent
 *      of Discord entirely.
 *   3. The outcome is persisted into the SAME restart-safety marker row
 *      the caller already writes (see persistDigestMarker()), so the NEXT
 *      successful post carries a "previous digest failed to deliver" note
 *      forward (see buildDigestEmbed()'s previousDeliveryFailure param) —
 *      this is what finally gets a human-visible signal onto the ONE
 *      channel that works, once it works again.
 */
async function postDigestToDiscord(
  data: DigestComputation,
  windowStartMs: number,
  windowEndMs: number,
  previousDeliveryFailure: { date: string; reason: string } | null = null
): Promise<DigestDeliveryResult> {
  const client = getDiscordClient();
  if (!client) {
    console.log(
      `${TAG} [Discord] Bot client not available — skipping Discord digest embed`
    );
    return { status: "skipped_not_configured" };
  }
  if (!client.isReady()) {
    console.error(
      `${TAG} [CRITICAL] [DIGEST_DELIVERY_FAILED] Discord bot not ready — cannot post digest embed. ` +
        `This channel is the only confirmed-working delivery path (see module header) — a failed post here is a total zero-notification day.`
    );
    return { status: "failed", reason: "Discord bot not ready" };
  }

  console.log(
    `${TAG} [Discord] Fetching security channel ${SECURITY_CHANNEL_ID}...`
  );
  let channel: TextChannel;
  try {
    const raw = await client.channels.fetch(SECURITY_CHANNEL_ID);
    if (!raw || !(raw instanceof TextChannel)) {
      console.error(
        `${TAG} [CRITICAL] [DIGEST_DELIVERY_FAILED] Channel ${SECURITY_CHANNEL_ID} is not a TextChannel or could not be fetched`
      );
      return {
        status: "failed",
        reason: `Channel ${SECURITY_CHANNEL_ID} is not a TextChannel or could not be fetched`,
      };
    }
    channel = raw;
    console.log(
      `${TAG} [Discord] Channel resolved: #${logSafe(channel.name)} in ${logSafe(channel.guild?.name ?? "unknown")}`
    );
  } catch (err: unknown) {
    const msg = logSafe(err);
    console.error(
      `${TAG} [CRITICAL] [DIGEST_DELIVERY_FAILED] Failed to fetch channel: ${msg}`
    );
    return { status: "failed", reason: `Channel fetch threw: ${msg}` };
  }

  const embed = buildDigestEmbed(
    data,
    windowStartMs,
    windowEndMs,
    previousDeliveryFailure
  );

  let lastErrMsg = "";
  const MAX_SEND_ATTEMPTS = 2;
  for (let attempt = 1; attempt <= MAX_SEND_ATTEMPTS; attempt++) {
    try {
      await channel.send({ embeds: [embed] });
      console.log(
        `${TAG} [Discord] [OUTPUT] Daily digest embed posted successfully` +
          (attempt > 1
            ? ` (attempt ${attempt}/${MAX_SEND_ATTEMPTS}, after retry)`
            : "") +
          ` | channel=#${logSafe(channel.name)}` +
          ` | threatLevel=${data.threatLevel}` +
          ` | threatTotal=${data.threatTotal}` +
          ` | totalAll=${data.totalAll}`
      );
      return { status: "sent" };
    } catch (err: unknown) {
      lastErrMsg = logSafe(err);
      console.error(
        `${TAG} [Discord] Attempt ${attempt}/${MAX_SEND_ATTEMPTS} failed to send digest embed: ${lastErrMsg}`
      );
    }
  }
  console.error(
    `${TAG} [CRITICAL] [DIGEST_DELIVERY_FAILED] Discord post failed after ${MAX_SEND_ATTEMPTS} attempts — reason="${lastErrMsg}". ` +
      `This is a total zero-notification day; carried forward as a note on the next successfully-delivered digest.`
  );
  return {
    status: "failed",
    reason: `channel.send() failed ${MAX_SEND_ATTEMPTS}x: ${lastErrMsg}`,
  };
}

// ─── notifyOwner content builder ──────────────────────────────────────────────

function buildNotifyOwnerContent(
  data: DigestComputation,
  dateLabel: string,
  windowStartISO: string,
  windowEndISO: string
): string {
  const topIpLines =
    data.topIps.length > 0
      ? data.topIps
          .map(
            ({ ip, count }, i) =>
              `  ${i + 1}. ${ip} — ${count} event${count !== 1 ? "s" : ""}`
          )
          .join("\n")
      : "  No unclassified events recorded.";

  const allowlistSummary = summarizeAllowlistedBySource(data.allowlisted);
  const allowlistLines =
    allowlistSummary.length > 0
      ? allowlistSummary
          .map(({ source, count }) => `  ${source}: ${count}`)
          .join("\n")
      : "  None detected in the sampled window.";

  const rateLimitBreakdown = formatBucketBreakdown(
    data.bucketCounts,
    "RATE_LIMIT"
  );

  return [
    `Daily Security Digest — ${dateLabel}`,
    `Threat Level: ${data.threatLevel}`,
    "",
    "Event Counts (Last 24 Hours, deduped sample):",
    `  CSRF Block:   ${data.eventTypeTotals.CSRF_BLOCK}`,
    `  Rate Limit:   ${data.eventTypeTotals.RATE_LIMIT}`,
    `  Auth Failure: ${data.eventTypeTotals.AUTH_FAIL}`,
    `  Total:        ${data.totalAll}`,
    `  Unclassified (used for threat level): ${data.threatTotal}`,
    "",
    "Rate Limit Triggers by type:",
    rateLimitBreakdown,
    "",
    `Top ${TOP_IP_LIMIT} Unclassified IPs by Event Count:`,
    topIpLines,
    "",
    "Expected Automation (excluded from threat level):",
    allowlistLines,
    "",
    `Window: ${windowStartISO} → ${windowEndISO}`,
    `Counts above are a deduped sample: at most 1 row per (IP, path, type) per ${RATE_LIMIT_DEDUP_WINDOW_SEC}s.`,
    `Retention: events older than ${PRUNE_RETENTION_DAYS} days pruned after this digest.`,
  ].join("\n");
}

// ─── Core digest runner ───────────────────────────────────────────────────────

async function runSecurityDigest(): Promise<void> {
  if (digestRunning) {
    console.warn(
      `${TAG} [SKIP] Previous digest still running — skipping this tick`
    );
    return;
  }
  digestRunning = true;
  const runStart = Date.now();
  const windowStart = runStart - WINDOW_MS;
  const windowStartISO = new Date(windowStart).toISOString();
  const windowEndISO = new Date(runStart).toISOString();

  console.log(`${TAG} ► START | window=${windowStartISO} → ${windowEndISO}`);

  try {
    // ── Step 1: Accurate (eventType, context) bucket counts ────────────────
    console.log(
      `${TAG} [STEP] Querying (eventType, context) bucket counts for the last 24 hours...`
    );
    const bucketCounts = await getSecurityEventCountsByBucket(windowStart);
    console.log(
      `${TAG} [STATE] Buckets | ${bucketCounts.map(b => `${logSafe(b.eventType)}/${logSafe(b.context ?? "-")}(${b.count})`).join(", ") || "none"}`
    );

    // ── Step 2: Raw event sample for IP classification + top IPs ───────────
    console.log(
      `${TAG} [STEP] Fetching raw events for allowlist classification + top-IP analysis (limit=${RAW_EVENT_FETCH_LIMIT})...`
    );
    const rawEvents = filterDigestMarkers(
      await getSecurityEvents({
        sinceMs: windowStart,
        limit: RAW_EVENT_FETCH_LIMIT,
      })
    );

    // ── Step 3: Compute the digest (bucketing, allowlist split, threat level) ─
    const data = computeDigestData(bucketCounts, rawEvents);
    console.log(
      `${TAG} [STATE] totalAll=${data.totalAll} threatTotal=${data.threatTotal}` +
        ` allowlisted=${data.allowlisted.length} sampleCapped=${data.sampleCapped}`
    );
    console.log(
      `${TAG} [STATE] Top unclassified IPs by event count | ` +
        (data.topIps.length > 0
          ? data.topIps.map(({ ip, count }) => `${ip}(${count})`).join(", ")
          : "none")
    );
    console.log(
      `${TAG} [STATE] Threat level: ${data.threatLevel} | threatTotal=${data.threatTotal} in last 24h (deduped sample)`
    );

    // ── Step 4: Build + fire notifyOwner ────────────────────────────────────
    const dateLabel = new Date().toLocaleDateString("en-US", {
      timeZone: "America/New_York",
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
    });
    const content = buildNotifyOwnerContent(
      data,
      dateLabel,
      windowStartISO,
      windowEndISO
    );

    console.log(`${TAG} [STEP] Firing notifyOwner (in-app notification)...`);
    const notified = await notifyOwner({
      title: `[${data.threatLevel}] Security Digest — ${data.threatTotal} unclassified event${data.threatTotal !== 1 ? "s" : ""} in 24h`,
      content,
    }).catch((err: unknown) => {
      console.error(`${TAG} [ERROR] notifyOwner threw: ${logSafe(err)}`);
      return false;
    });
    if (notified) {
      console.log(
        `${TAG} [OUTPUT] In-app notification sent | threat=${data.threatLevel} threatTotal=${data.threatTotal}`
      );
    } else {
      // notifyOwner() is a PERMANENT no-op (server/_core/notification.ts's
      // own docblock) — it always returns false. Escalating a guaranteed
      // false-return to a CRITICAL Discord alert fired on every single run,
      // forever: a guaranteed false alarm (2026-08-07 review, Critical 2).
      // Still called (cheap, forward-compatible if a real gateway is ever
      // wired back to this exact signature), but `false` is no longer
      // escalatable. The one thing worth telling a human is static and
      // already true on every run — it lives as one line in the embed's
      // footer (buildDigestEmbed) instead of a repeating alert.
      console.log(
        `${TAG} [INFO] notifyOwner did not deliver (in-app channel is a documented permanent no-op) — not escalating, see Critical 2 note above persistDigestMarker()`
      );
    }

    // ── Step 5: Post Discord digest embed ───────────────────────────────────
    // Load any undelivered PREVIOUS run's failure before building/posting
    // this run's embed, so it can carry the notice forward (see
    // postDigestToDiscord()'s own comment for the full Critical 2 design).
    const previousFailure = await loadLastDigestDeliveryFailure().catch(
      (err: unknown) => {
        console.error(
          `${TAG} [WARN] Failed to read previous delivery-failure marker (best-effort, proceeding without a carry-forward note): ${logSafe(err)}`
        );
        return null;
      }
    );
    if (previousFailure) {
      console.warn(
        `${TAG} [STATE] Previous digest (${previousFailure.date}) failed to deliver to Discord — carrying a notice into today's embed | reason="${previousFailure.reason}"`
      );
    }

    console.log(
      `${TAG} [STEP] Posting daily digest embed to Discord security channel...`
    );
    const deliveryResult: DigestDeliveryResult = await postDigestToDiscord(
      data,
      windowStart,
      runStart,
      previousFailure
    ).catch((err: unknown) => {
      const msg = logSafe(err);
      console.error(
        `${TAG} [CRITICAL] [DIGEST_DELIVERY_FAILED] Discord digest post threw unexpectedly: ${msg}`
      );
      return {
        status: "failed",
        reason: `threw unexpectedly: ${msg}`,
      } as const;
    });
    const deliveryFailureReason =
      deliveryResult.status === "failed" ? deliveryResult.reason : null;

    // ── Step 6: Prune old events ─────────────────────────────────────────────
    console.log(
      `${TAG} [STEP] Pruning events older than ${PRUNE_RETENTION_DAYS} days...`
    );
    const pruned = await pruneSecurityEvents(PRUNE_RETENTION_DAYS);
    console.log(
      `${TAG} [OUTPUT] Pruned ${pruned} old event${pruned !== 1 ? "s" : ""} from security_events table`
    );

    // ── Step 7: Mark digest complete (in-memory + persisted marker) ─────────
    // Deliberately LAST — see persistDigestMarker()'s own comment for the
    // full B2 / Important 1 duplicate-over-skip reasoning (2026-08-07
    // review). This call must stay the final step of the try block.
    const todayStr = new Date().toISOString().slice(0, 10);
    lastDigestDateUTC = todayStr;
    await persistDigestMarker(todayStr, deliveryFailureReason).catch(
      (err: unknown) => {
        console.error(
          `${TAG} [ERROR] Failed to persist digest marker (in-memory guard still holds for this process): ${logSafe(err)}`
        );
      }
    );

    const elapsed = Date.now() - runStart;
    console.log(
      `${TAG} ✓ COMPLETE | elapsed=${elapsed}ms` +
        ` | notified=${notified} | discordDelivery=${deliveryResult.status} | pruned=${pruned}` +
        ` | lastDigestDate=${lastDigestDateUTC}`
    );
    console.log(`${TAG} [VERIFY] PASS — digest complete`);
  } catch (err: unknown) {
    const msg = logSafe(err);
    console.error(`${TAG} [ERROR] Digest failed: ${msg}`);
    console.error(`${TAG} [VERIFY] FAIL — digest did not complete`);
  } finally {
    digestRunning = false;
  }
}

// ─── Scheduler ────────────────────────────────────────────────────────────────

/**
 * Checks whether the digest should fire on this tick and, if so, fires it.
 * Exported only for the scheduler below to call — not part of the public API.
 *
 * B2 idempotency: the in-memory `lastDigestDateUTC` is a fast path that
 * avoids a DB round-trip on most ticks. It resets to "" on restart, so
 * inside the fire window we ALSO check the persisted marker
 * (loadLastDigestDate()) before firing — that's what actually prevents a
 * restart from producing a duplicate digest for the same day. A failed
 * marker read is treated as "unknown" and does not block firing (fire-and-
 * forget philosophy — see module header); the `digestRunning` lock in
 * runSecurityDigest() is the last line of defense against true concurrency.
 */
async function maybeFireDigest(): Promise<void> {
  const { hour, minute } = nowUTC();
  const today = new Date().toISOString().slice(0, 10);

  const inWindow =
    hour === DIGEST_HOUR_UTC &&
    minute >= DIGEST_WINDOW_START_MINUTE_UTC &&
    minute < DIGEST_WINDOW_START_MINUTE_UTC + DIGEST_WINDOW_MINUTES;
  if (!inWindow) return;

  if (lastDigestDateUTC === today) return; // already fired this process's lifetime

  const persistedDate = await loadLastDigestDate().catch((err: unknown) => {
    console.error(
      `${TAG} [WARN] Failed to read persisted digest marker — proceeding as not-yet-fired (best-effort): ${logSafe(err)}`
    );
    return null;
  });
  if (persistedDate === today) {
    lastDigestDateUTC = today; // resync in-memory cache to the persisted truth
    console.log(
      `${TAG} [SKIP] Persisted marker shows today's digest already fired — restart-safe skip (no duplicate)`
    );
    return;
  }

  console.log(
    `${TAG} [STEP] Digest window detected | UTC=${hour}:${String(minute).padStart(2, "0")}` +
      ` | lastDigestDate=${lastDigestDateUTC || "(none)"} | persistedDate=${persistedDate ?? "(none)"} | today=${today}`
  );
  void runSecurityDigest();
}

/**
 * Starts the daily security digest scheduler.
 *
 * Polls every 60 seconds. Fires once inside the [13:00, 13:10) UTC window
 * (08:00 EST) per day, restart-safe via the persisted marker in
 * maybeFireDigest(). This approach avoids drift from setInterval(24h) and
 * handles server restarts gracefully — if the server was down at 08:00 EST,
 * the digest fires on the next tick after startup as long as it's still
 * inside the window.
 */
export function startSecurityDigestScheduler(): void {
  console.log(
    `${TAG} Scheduler started | fires daily in UTC ${DIGEST_HOUR_UTC}:${String(DIGEST_WINDOW_START_MINUTE_UTC).padStart(2, "0")}–` +
      `${DIGEST_HOUR_UTC}:${String(DIGEST_WINDOW_START_MINUTE_UTC + DIGEST_WINDOW_MINUTES).padStart(2, "0")}` +
      ` (08:00 EST window) | poll interval=${CHECK_INTERVAL_MS / 1000}s`
  );

  // Immediate check on startup — covers "server started mid-window".
  void maybeFireDigest();

  // Recurring poll.
  setInterval(() => {
    void maybeFireDigest();
  }, CHECK_INTERVAL_MS);
}

// ─── Manual trigger (for testing / owner-initiated digest) ───────────────────
/**
 * Manually triggers the security digest outside of the scheduled window.
 * Used by the test tRPC procedure and owner-initiated digests.
 * Returns the threat level and counts so callers can verify the output.
 *
 * Return shape kept backward-compatible with server/routers/security.ts
 * (threatLevel, counts.{CSRF_BLOCK,RATE_LIMIT,AUTH_FAIL,total}, topIps) —
 * that router is out of this task's edit scope. `counts.total` here is
 * `threatTotal` (non-allowlisted) so the owner-triggered manual digest
 * reflects the same fix as the scheduled one.
 */
export async function triggerSecurityDigestNow(): Promise<{
  threatLevel: ThreatLevel;
  counts: {
    CSRF_BLOCK: number;
    RATE_LIMIT: number;
    AUTH_FAIL: number;
    total: number;
  };
  topIps: Array<{ ip: string; count: number }>;
}> {
  const runStart = Date.now();
  const windowStart = runStart - WINDOW_MS;

  console.log(
    `${TAG} [MANUAL] Manual digest triggered | window=${new Date(windowStart).toISOString()} → ${new Date(runStart).toISOString()}`
  );

  const bucketCounts = await getSecurityEventCountsByBucket(windowStart);
  const rawEvents = filterDigestMarkers(
    await getSecurityEvents({
      sinceMs: windowStart,
      limit: RAW_EVENT_FETCH_LIMIT,
    })
  );
  const data = computeDigestData(bucketCounts, rawEvents);

  console.log(
    `${TAG} [MANUAL] Results | threatLevel=${data.threatLevel}` +
      ` CSRF_BLOCK=${data.eventTypeTotals.CSRF_BLOCK} RATE_LIMIT=${data.eventTypeTotals.RATE_LIMIT} AUTH_FAIL=${data.eventTypeTotals.AUTH_FAIL}` +
      ` totalAll=${data.totalAll} threatTotal=${data.threatTotal}`
  );

  await postDigestToDiscord(data, windowStart, runStart).catch(
    (err: unknown) => {
      console.error(`${TAG} [MANUAL] Discord post failed: ${logSafe(err)}`);
    }
  );

  return {
    threatLevel: data.threatLevel,
    counts: {
      CSRF_BLOCK: data.eventTypeTotals.CSRF_BLOCK,
      RATE_LIMIT: data.eventTypeTotals.RATE_LIMIT,
      AUTH_FAIL: data.eventTypeTotals.AUTH_FAIL,
      total: data.threatTotal,
    },
    topIps: data.topIps,
  };
}
