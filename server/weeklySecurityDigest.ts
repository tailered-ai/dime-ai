/**
 * weeklySecurityDigest.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Schedules a weekly security threat trend digest that fires every Sunday
 * in a 10-minute window starting at 08:00 EST (13:00 UTC).
 *
 * On each tick it:
 *   1. Queries security_events for the prior 7-day window (Sunday → Sunday)
 *   2. Breaks the 7 days into per-day buckets (Mon → Sun) with event counts,
 *      counting only NON-allowlisted events (Task 4.9 / A2 — see below)
 *   3. Renders an ASCII bar chart showing the daily threat trend
 *   4. Computes the weekly threat level from an accurate, unlimited
 *      (eventType, context)-bucketed total minus allowlisted activity
 *      (Task 4.9 / A1 + A2)
 *   5. Identifies the peak day and peak event type
 *   6. Posts a rich Discord embed to the 🗒️-𝗦𝗘𝗖𝗨𝗥𝗜𝗧𝗬-𝗘𝗩𝗘𝗡𝗧𝗦 channel
 *   7. Fires notifyOwner() with a structured plain-text summary; escalates
 *      to the Discord security channel if that delivery fails (Task 4.10 / B1)
 *   8. Persists a restart-safety marker, same mechanism and same reasoning
 *      as the daily digest (Task 4.10 / B2 — the single-minute-window /
 *      in-memory-only-state bug is identical here, just less frequently
 *      observed since this scheduler only fires once a week)
 *
 * Design constraints:
 *   - Fire-and-forget: errors never crash the server
 *   - Digest is skipped (not queued) if the previous run is still in progress
 *   - Always posts — even on clean weeks (weekly confirmation)
 *   - All log lines are structured and machine-readable
 *   - Plain-English copy throughout — written so @prez can read it without
 *     needing to decode technical jargon
 *
 * A1/A2/A3/B1 share their implementation with securityDigest.ts — see that
 * file's header and inline comments for the full reasoning (allowlist
 * reliability per source, dedup-window semantics, escalation design). This
 * file imports the pure/reusable pieces (classifyIp, splitEventsByAllowlist,
 * topIpsByCount, computeThreatLevel-style helpers, filterDigestMarkers)
 * rather than re-implementing them. Note: escalateDeliveryFailure() was
 * removed in the 2026-08-07 review (Critical 2) — notifyOwner() is a
 * permanent no-op, so escalating its `false` fired a guaranteed false alarm
 * on every run. See the Step 7 comment below.
 */

import { EmbedBuilder, TextChannel } from "discord.js";
import {
  DIGEST_MARKER_WEEKLY_EVENT_TYPE,
  getSecurityEventCountsByBucket,
  getSecurityEvents,
  insertSecurityEvent,
} from "./db";
import { notifyOwner } from "./_core/notification";
import { logSafe } from "./_core/logSafe";
import { getDiscordClient } from "./discord/bot";
import {
  topIpsByCount,
  splitEventsByAllowlist,
  filterDigestMarkers,
  encodeDigestMarkerContext,
  decodeDigestMarkerContext,
  type BucketCount,
  type DigestDeliveryResult,
} from "./securityDigest";

// ─── Constants ────────────────────────────────────────────────────────────────
const TAG = "[WeeklySecurityDigest]";
const DIGEST_DAY_UTC = 0; // 0 = Sunday
const DIGEST_HOUR_UTC = 13; // 08:00 EST = 13:00 UTC
// B2: same widened-window + persisted-marker fix as securityDigest.ts —
// see that file's DIGEST_WINDOW_MINUTES comment for the full reasoning.
const DIGEST_WINDOW_START_MINUTE_UTC = 0;
const DIGEST_WINDOW_MINUTES = 10;
const WINDOW_MS = 7 * 24 * 60 * 60 * 1000; // 7-day lookback window
const TOP_IP_LIMIT = 5;
const CHECK_INTERVAL_MS = 60 * 1000; // poll every 60 seconds
const RAW_EVENT_FETCH_LIMIT = 2000;

/** Target channel: 🗒️-𝗦𝗘𝗖𝗨𝗥𝗜𝗧𝗬-𝗘𝗩𝗘𝗡𝗧𝗦 */
const SECURITY_CHANNEL_ID = "1492280227567501403";

// ─── Threat level thresholds (weekly scale — higher than daily) ───────────────
type ThreatLevel = "CLEAN" | "LOW" | "MODERATE" | "HIGH" | "CRITICAL";

const THREAT_LEVELS: Array<{
  label: ThreatLevel;
  threshold: number;
  color: number;
  emoji: string;
}> = [
  { label: "CLEAN", threshold: 0, color: 0x57f287, emoji: "✅" },
  { label: "LOW", threshold: 1, color: 0xfee75c, emoji: "🟡" },
  { label: "MODERATE", threshold: 50, color: 0xeb6c33, emoji: "🟠" },
  { label: "HIGH", threshold: 200, color: 0xed4245, emoji: "🔴" },
  { label: "CRITICAL", threshold: 1000, color: 0xf8312f, emoji: "🚨" },
];

// ─── State ────────────────────────────────────────────────────────────────────
let lastWeeklyDigestDateUTC = ""; // "YYYY-MM-DD" of last successful weekly digest (in-memory fast path)
let weeklyDigestRunning = false;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function nowUTC(): { day: number; hour: number; minute: number } {
  const d = new Date();
  return {
    day: d.getUTCDay(),
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
  };
}

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

function weeklyThreatMeta(level: ThreatLevel): {
  color: number;
  emoji: string;
} {
  const found = THREAT_LEVELS.find(t => t.label === level);
  return { color: found?.color ?? 0x5865f2, emoji: found?.emoji ?? "🔵" };
}

/**
 * Computes weekly threat level based on the NON-allowlisted 7-day event
 * count (Task 4.9 / A2). Uses a higher scale than the daily digest since
 * 7x more events are expected.
 */
function computeWeeklyThreatLevel(total: number): ThreatLevel {
  if (total === 0) return "CLEAN";
  if (total < 50) return "LOW";
  if (total < 200) return "MODERATE";
  if (total < 1000) return "HIGH";
  return "CRITICAL";
}

function sumByEventType(buckets: BucketCount[], eventType: string): number {
  return buckets
    .filter(b => b.eventType === eventType)
    .reduce((s, b) => s + b.count, 0);
}

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

function summarizeAllowlistedBySource(
  allowlisted: Array<{
    allowlistSource: "cloudflare_edge" | "known_automation";
  }>
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

// ─── Per-day bucketing ────────────────────────────────────────────────────────

interface DayBucket {
  /** Day label: "Mon Apr 7", "Tue Apr 8", etc. */
  label: string;
  /** Epoch ms of the start of this day (midnight EST) */
  startMs: number;
  /** Epoch ms of the end of this day (23:59:59.999 EST) */
  endMs: number;
  CSRF_BLOCK: number;
  RATE_LIMIT: number;
  AUTH_FAIL: number;
  total: number;
}

/**
 * Builds 7 per-day buckets for the window [windowStartMs, windowEndMs).
 * Each bucket covers one calendar day in EST (midnight → midnight).
 *
 * Task 4.9 / A2: `events` here is expected to be the ALLOWLIST-FILTERED
 * ("flagged") event list, not the raw window — a day dominated by CI/CF
 * automation should not show as a tall bar in the trend chart any more
 * than it should count toward the weekly threat level. See
 * runWeeklySecurityDigest() where this is called.
 */
function buildDayBuckets(
  events: Array<{ occurredAt: number; eventType: string }>,
  windowEndMs: number
): DayBucket[] {
  const DAY_MS = 24 * 60 * 60 * 1000;
  const buckets: DayBucket[] = [];

  for (let i = 6; i >= 0; i--) {
    const dayEndMs = windowEndMs - i * DAY_MS;
    const dayStartMs = dayEndMs - DAY_MS;

    const label = new Date(dayStartMs).toLocaleDateString("en-US", {
      timeZone: "America/New_York",
      weekday: "short",
      month: "short",
      day: "numeric",
    });

    buckets.push({
      label,
      startMs: dayStartMs,
      endMs: dayEndMs,
      CSRF_BLOCK: 0,
      RATE_LIMIT: 0,
      AUTH_FAIL: 0,
      total: 0,
    });
  }

  for (const event of events) {
    for (const bucket of buckets) {
      if (
        event.occurredAt >= bucket.startMs &&
        event.occurredAt < bucket.endMs
      ) {
        const type = event.eventType as
          "CSRF_BLOCK" | "RATE_LIMIT" | "AUTH_FAIL";
        if (
          type === "CSRF_BLOCK" ||
          type === "RATE_LIMIT" ||
          type === "AUTH_FAIL"
        ) {
          bucket[type]++;
          bucket.total++;
        }
        break;
      }
    }
  }

  return buckets;
}

/**
 * Renders a compact ASCII bar chart for the 7-day trend.
 *
 * Example output (inside a Discord code block):
 *   Mon Apr 7  ████░░░░░░  12
 *   Tue Apr 8  ██████████  34
 *   Wed Apr 9  ░░░░░░░░░░   0
 *   ...
 *
 * The bar is 10 characters wide. Each filled block (█) represents
 * 10% of the peak day's count. Empty blocks (░) fill the rest.
 * This gives @prez an instant visual of which days were busiest.
 */
function renderAsciiBarChart(buckets: DayBucket[]): string {
  const BAR_WIDTH = 10;
  const peak = Math.max(...buckets.map(b => b.total), 1); // avoid div-by-zero

  const lines = buckets.map(bucket => {
    const filled = Math.round((bucket.total / peak) * BAR_WIDTH);
    const bar = "█".repeat(filled) + "░".repeat(BAR_WIDTH - filled);
    const countStr = String(bucket.total).padStart(4, " ");
    return `${bucket.label.padEnd(12)} ${bar} ${countStr}`;
  });

  return lines.join("\n");
}

// ─── Digest marker persistence (Task 4.10 / B2) ───────────────────────────────
//
// Same encoding scheme as securityDigest.ts's daily marker (shared
// encode/decode helpers, separate DIGEST_MARKER_WEEKLY_EVENT_TYPE row) —
// see that file's persistDigestMarker()/loadLastDigestDeliveryFailure() for
// the full Critical 2 (delivery-failure carry-forward) and Important 1 (B2
// duplicate-over-skip ordering) reasoning. Ordering here is identical and
// equally deliberate: this call is the LAST step of runWeeklySecurityDigest
// (Step 9), after notifyOwner and the Discord post have both already run.

async function persistWeeklyDigestMarker(
  dateStr: string,
  failureReason: string | null = null
): Promise<void> {
  await insertSecurityEvent({
    eventType: DIGEST_MARKER_WEEKLY_EVENT_TYPE,
    ip: "system",
    blockedOrigin: null,
    trpcPath: null,
    httpMethod: null,
    userAgent: "weekly-security-digest-scheduler",
    context: encodeDigestMarkerContext(dateStr, failureReason),
    occurredAt: Date.now(),
  });
}

async function loadLastWeeklyDigestDate(): Promise<string | null> {
  const rows = await getSecurityEvents({
    eventType: DIGEST_MARKER_WEEKLY_EVENT_TYPE,
    limit: 1,
    existenceProbe: true,
  });
  return decodeDigestMarkerContext(rows[0]?.context)?.date ?? null;
}

async function loadLastWeeklyDigestDeliveryFailure(): Promise<{
  date: string;
  reason: string;
} | null> {
  const rows = await getSecurityEvents({
    eventType: DIGEST_MARKER_WEEKLY_EVENT_TYPE,
    limit: 1,
    existenceProbe: true,
  });
  const decoded = decodeDigestMarkerContext(rows[0]?.context);
  if (!decoded || !decoded.failureReason) return null;
  return { date: decoded.date, reason: decoded.failureReason };
}

// ─── Discord weekly digest embed builder ──────────────────────────────────────

function buildWeeklyDigestEmbed(
  buckets: DayBucket[],
  topIps: Array<{ ip: string; count: number }>,
  threatLevel: ThreatLevel,
  totalAll: number,
  threatTotal: number,
  bucketCounts: BucketCount[],
  allowlisted: Array<{
    allowlistSource: "cloudflare_edge" | "known_automation";
  }>,
  windowStartMs: number,
  windowEndMs: number
): EmbedBuilder {
  const { color, emoji } = weeklyThreatMeta(threatLevel);

  const weekLabel = new Date(windowEndMs).toLocaleDateString("en-US", {
    timeZone: "America/New_York",
    month: "long",
    day: "numeric",
    year: "numeric",
  });

  const threatDescriptions: Record<ThreatLevel, string> = {
    CLEAN:
      "No unclassified security events in the past 7 days (after excluding Cloudflare and known automation). The site was completely clean this week.",
    LOW:
      "A small number of unclassified security events were recorded this week. This is within normal range " +
      "and is likely just routine background noise from the internet. No action needed.",
    MODERATE:
      "A moderate number of unclassified security events were recorded this week. Worth reviewing the daily " +
      "trend and top IPs below to see if any day or source stands out. No immediate action required.",
    HIGH:
      "A high number of unclassified security events were recorded this week. Someone may be actively probing " +
      "or targeting the site. Review the peak day and top IPs — consider blocking persistent sources " +
      "at the firewall if the pattern continues into next week.",
    CRITICAL:
      "A critical number of unclassified security events were recorded this week. The site is likely under " +
      "sustained attack. Immediate review is strongly recommended — check the top IPs and the " +
      "daily trend to identify when the attack started and which endpoints are being targeted.",
  };

  const peakBucket = buckets.reduce(
    (a, b) => (b.total > a.total ? b : a),
    buckets[0]
  );
  const peakDayValue =
    peakBucket.total === 0
      ? "No unclassified events recorded on any day this week."
      : `**${peakBucket.label}** — ${peakBucket.total} event${peakBucket.total !== 1 ? "s" : ""} ` +
        `(CSRF: ${peakBucket.CSRF_BLOCK} · Rate: ${peakBucket.RATE_LIMIT} · Auth: ${peakBucket.AUTH_FAIL})`;

  const csrfTotal = sumByEventType(bucketCounts, "CSRF_BLOCK");
  const rateLimitTotal = sumByEventType(bucketCounts, "RATE_LIMIT");
  const authFailTotal = sumByEventType(bucketCounts, "AUTH_FAIL");

  const typeEntries: Array<[string, number]> = [
    ["CSRF Blocks", csrfTotal],
    ["Rate Limit Triggers", rateLimitTotal],
    ["Auth Failures", authFailTotal],
  ];
  const dominantType = typeEntries.reduce(
    (a, b) => (b[1] > a[1] ? b : a),
    typeEntries[0]
  );
  const dominantTypeValue =
    totalAll === 0
      ? "No events this week."
      : `**${dominantType[0]}** — ${dominantType[1]} out of ${totalAll} total events ` +
        `(${Math.round((dominantType[1] / totalAll) * 100)}% of all activity)`;

  const barChart = renderAsciiBarChart(buckets);

  const topIpValue =
    topIps.length > 0
      ? topIps
          .map(
            ({ ip, count }, i) =>
              `\`${i + 1}.\` \`${ip}\` — **${count}** event${count !== 1 ? "s" : ""}`
          )
          .join("\n")
      : "_No unclassified events recorded — nothing to report._";

  const allowlistSummary = summarizeAllowlistedBySource(allowlisted);
  const allowlistValue =
    allowlistSummary.length > 0
      ? allowlistSummary
          .map(({ source, count }) => `• **${source}**: ${count}`)
          .join("\n") + `\n_Excluded from the threat level above._`
      : "_None detected in the sampled window._";

  const windowValue =
    `From: \`${formatEst(windowStartMs)}\`\n` +
    `To:   \`${formatEst(windowEndMs)}\`\n` +
    `_Counts are a DEDUPED SAMPLE — at most 1 row per (IP, path, type) per 60s, so this is a lower bound, not a request volume._`;

  const breakdownValue =
    `🚫 CSRF Blocks:          **${csrfTotal}**\n` +
    `⚡ Rate Limit Triggers:  **${rateLimitTotal}** (by type below)\n` +
    `🔐 Auth Failures:        **${authFailTotal}**\n` +
    `📊 Total (deduped sample): **${totalAll}** · Unclassified (threat level): **${threatTotal}**`;

  const rateLimitBreakdown = formatBucketBreakdown(bucketCounts, "RATE_LIMIT");

  return new EmbedBuilder()
    .setColor(color)
    .setTitle(
      `${emoji} Weekly Security Threat Report — Week Ending ${weekLabel}`
    )
    .setDescription(
      `**Threat Level: ${threatLevel}**\n\n${threatDescriptions[threatLevel]}`
    )
    .addFields(
      {
        name: "📈 7-Day Event Trend (Daily Breakdown, unclassified only)",
        value:
          "Each bar shows how many UNCLASSIFIED security events occurred on that day (Cloudflare and " +
          "known automation excluded). A longer bar = more activity. Bars are scaled relative to the busiest day.\n" +
          "```\n" +
          barChart +
          "\n```",
        inline: false,
      },
      {
        name: "📋 Weekly Event Type Breakdown",
        value: breakdownValue,
        inline: false,
      },
      {
        name: "⚡ Rate Limit Triggers by type",
        value: "```\n" + rateLimitBreakdown + "\n```",
        inline: false,
      },
      {
        name: "📅 Peak Day This Week",
        value: peakDayValue,
        inline: false,
      },
      {
        name: "⚠️ Most Common Threat Type",
        value: dominantTypeValue,
        inline: false,
      },
      {
        name: `🖥️ Top ${TOP_IP_LIMIT} Most Active Unclassified IPs This Week`,
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
      // documented permanent no-op, so its failure is never escalated. That
      // fact is true on every run, so it is stated once here rather than
      // fired as a repeating CRITICAL alert.
      text: "AI Sports Betting · Weekly Security Report · Fires every Sunday ~08:00 EST · In-app notifications (notifyOwner) are disabled — this Discord channel is the confirmed delivery path",
    })
    .setTimestamp(windowEndMs);
}

// ─── Discord weekly digest poster ─────────────────────────────────────────────

async function postWeeklyDigestToDiscord(
  buckets: DayBucket[],
  topIps: Array<{ ip: string; count: number }>,
  threatLevel: ThreatLevel,
  totalAll: number,
  threatTotal: number,
  bucketCounts: BucketCount[],
  allowlisted: Array<{
    allowlistSource: "cloudflare_edge" | "known_automation";
  }>,
  windowStartMs: number,
  windowEndMs: number
): Promise<void> {
  const client = getDiscordClient();
  if (!client) {
    console.log(
      `${TAG} [Discord] Bot client not available — skipping weekly digest embed`
    );
    return;
  }
  if (!client.isReady()) {
    console.log(
      `${TAG} [Discord] Bot client not ready — skipping weekly digest embed`
    );
    return;
  }

  console.log(
    `${TAG} [Discord] Fetching security channel ${SECURITY_CHANNEL_ID}...`
  );
  let channel: TextChannel;
  try {
    const raw = await client.channels.fetch(SECURITY_CHANNEL_ID);
    if (!raw || !(raw instanceof TextChannel)) {
      console.error(
        `${TAG} [Discord] Channel ${SECURITY_CHANNEL_ID} is not a TextChannel or could not be fetched`
      );
      return;
    }
    channel = raw;
    console.log(
      `${TAG} [Discord] Channel resolved: #${logSafe(channel.name)} in ${logSafe(channel.guild?.name ?? "unknown")}`
    );
  } catch (err: unknown) {
    const msg = logSafe(err);
    console.error(`${TAG} [Discord] Failed to fetch channel: ${msg}`);
    return;
  }

  const embed = buildWeeklyDigestEmbed(
    buckets,
    topIps,
    threatLevel,
    totalAll,
    threatTotal,
    bucketCounts,
    allowlisted,
    windowStartMs,
    windowEndMs
  );
  try {
    await channel.send({ embeds: [embed] });
    console.log(
      `${TAG} [Discord] [OUTPUT] Weekly digest embed posted successfully` +
        ` | channel=#${logSafe(channel.name)}` +
        ` | threatLevel=${threatLevel}` +
        ` | threatTotal=${threatTotal}`
    );
  } catch (err: unknown) {
    const msg = logSafe(err);
    console.error(
      `${TAG} [Discord] Failed to send weekly digest embed: ${msg}`
    );
  }
}

// ─── Core weekly digest runner ────────────────────────────────────────────────

async function runWeeklySecurityDigest(): Promise<void> {
  if (weeklyDigestRunning) {
    console.warn(
      `${TAG} [SKIP] Previous weekly digest still running — skipping this tick`
    );
    return;
  }
  weeklyDigestRunning = true;
  const runStart = Date.now();
  const windowStart = runStart - WINDOW_MS;
  const windowStartISO = new Date(windowStart).toISOString();
  const windowEndISO = new Date(runStart).toISOString();

  console.log(
    `${TAG} ► START | window=${windowStartISO} → ${windowEndISO} (7 days)`
  );

  try {
    // ── Step 1: Accurate (eventType, context) bucket counts (A1) ───────────
    console.log(
      `${TAG} [STEP] Querying (eventType, context) bucket counts for the last 7 days...`
    );
    const bucketCounts = await getSecurityEventCountsByBucket(windowStart);
    const totalAll = bucketCounts.reduce((s, b) => s + b.count, 0);
    console.log(
      `${TAG} [STATE] ${bucketCounts.length} buckets | totalAll=${totalAll}`
    );

    // ── Step 2: Raw events for day-bucketing + allowlist + top IPs ─────────
    console.log(
      `${TAG} [STEP] Fetching all security events for the last 7 days (limit=${RAW_EVENT_FETCH_LIMIT})...`
    );
    const rawEvents = filterDigestMarkers(
      await getSecurityEvents({
        sinceMs: windowStart,
        limit: RAW_EVENT_FETCH_LIMIT,
      })
    );
    console.log(
      `${TAG} [STATE] Fetched ${rawEvents.length} raw events (markers filtered)`
    );

    // ── Step 3: Allowlist split (A2) ────────────────────────────────────────
    const { flagged, allowlisted } = splitEventsByAllowlist(rawEvents);
    const threatTotal = Math.max(0, totalAll - allowlisted.length);
    const threatLevel = computeWeeklyThreatLevel(threatTotal);
    const sampleCapped = rawEvents.length >= RAW_EVENT_FETCH_LIMIT;
    console.log(
      `${TAG} [STATE] totalAll=${totalAll} threatTotal=${threatTotal} allowlisted=${allowlisted.length} sampleCapped=${sampleCapped}`
    );

    // ── Step 4: Build per-day buckets for the bar chart (unclassified only) ─
    console.log(
      `${TAG} [STEP] Building 7-day per-day buckets for trend analysis (unclassified only)...`
    );
    const buckets = buildDayBuckets(flagged, runStart);
    buckets.forEach((b, i) => {
      console.log(
        `${TAG} [STATE] Day ${i + 1}: ${b.label} | total=${b.total} (CSRF=${b.CSRF_BLOCK} RATE=${b.RATE_LIMIT} AUTH=${b.AUTH_FAIL})`
      );
    });

    // ── Step 5: Top IPs (unclassified only) ─────────────────────────────────
    const topIps = topIpsByCount(flagged, TOP_IP_LIMIT);
    console.log(
      `${TAG} [STATE] Top unclassified IPs | ` +
        (topIps.length > 0
          ? topIps.map(({ ip, count }) => `${ip}(${count})`).join(", ")
          : "none")
    );
    console.log(
      `${TAG} [STATE] Weekly threat level: ${threatLevel} | threatTotal=${threatTotal} in last 7 days (deduped sample)`
    );

    // ── Step 6: Build notifyOwner content ───────────────────────────────────
    const weekEndLabel = new Date(runStart).toLocaleDateString("en-US", {
      timeZone: "America/New_York",
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
    });
    const barChart = renderAsciiBarChart(buckets);
    const topIpLines =
      topIps.length > 0
        ? topIps
            .map(
              ({ ip, count }, i) =>
                `  ${i + 1}. ${ip} — ${count} event${count !== 1 ? "s" : ""}`
            )
            .join("\n")
        : "  No unclassified events recorded.";
    const allowlistSummary = summarizeAllowlistedBySource(allowlisted);
    const allowlistLines =
      allowlistSummary.length > 0
        ? allowlistSummary
            .map(({ source, count }) => `  ${source}: ${count}`)
            .join("\n")
        : "  None detected in the sampled window.";
    const csrfTotal = sumByEventType(bucketCounts, "CSRF_BLOCK");
    const rateLimitTotal = sumByEventType(bucketCounts, "RATE_LIMIT");
    const authFailTotal = sumByEventType(bucketCounts, "AUTH_FAIL");
    const rateLimitBreakdown = formatBucketBreakdown(
      bucketCounts,
      "RATE_LIMIT"
    );

    const content = [
      `Weekly Security Threat Report — Week Ending ${weekEndLabel}`,
      `Threat Level: ${threatLevel}`,
      "",
      "7-Day Event Trend (unclassified only):",
      barChart,
      "",
      "Weekly Event Type Breakdown (deduped sample):",
      `  CSRF Blocks:         ${csrfTotal}`,
      `  Rate Limit Triggers: ${rateLimitTotal}`,
      `  Auth Failures:       ${authFailTotal}`,
      `  Total:               ${totalAll}`,
      `  Unclassified (used for threat level): ${threatTotal}`,
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
      "Counts above are a deduped sample: at most 1 row per (IP, path, type) per 60s.",
    ].join("\n");

    // ── Step 7: Fire notifyOwner (never escalated — see below) ──────────────
    console.log(`${TAG} [STEP] Firing notifyOwner (in-app notification)...`);
    const notified = await notifyOwner({
      title: `[${threatLevel}] Weekly Security Report — ${threatTotal} unclassified event${threatTotal !== 1 ? "s" : ""} in 7 days`,
      content,
    }).catch((err: unknown) => {
      console.error(`${TAG} [ERROR] notifyOwner threw: ${logSafe(err)}`);
      return false;
    });
    if (notified) {
      console.log(
        `${TAG} [OUTPUT] In-app notification sent | threat=${threatLevel} threatTotal=${threatTotal}`
      );
    } else {
      // Mirrors the daily digest's Critical 2 fix (2026-08-07 review).
      // notifyOwner() is a PERMANENT no-op (server/_core/notification.ts's
      // own docblock) — it always returns false. Escalating a guaranteed
      // false-return to a CRITICAL Discord alert fired on every single run,
      // forever: a guaranteed false alarm, which is the exact defect class
      // this digest work exists to remove. Still called (cheap, and
      // forward-compatible if a real gateway is ever wired back to this
      // signature), but `false` is no longer escalatable. The one durable
      // fact worth telling a human is static and true on every run, so it
      // lives as one line in the embed footer rather than a repeating alert.
      console.log(
        `${TAG} [INFO] notifyOwner did not deliver (in-app channel is a documented permanent no-op) — not escalating`
      );
    }

    // ── Step 8: Post Discord weekly digest embed ────────────────────────────
    console.log(
      `${TAG} [STEP] Posting weekly digest embed to Discord security channel...`
    );
    await postWeeklyDigestToDiscord(
      buckets,
      topIps,
      threatLevel,
      totalAll,
      threatTotal,
      bucketCounts,
      allowlisted,
      windowStart,
      runStart
    ).catch((err: unknown) => {
      console.error(
        `${TAG} [ERROR] Discord weekly digest post failed (non-critical): ${logSafe(err)}`
      );
    });

    // ── Step 9: Mark digest complete (in-memory + persisted marker) ─────────
    const todayStr = new Date().toISOString().slice(0, 10);
    lastWeeklyDigestDateUTC = todayStr;
    await persistWeeklyDigestMarker(todayStr).catch((err: unknown) => {
      console.error(
        `${TAG} [ERROR] Failed to persist weekly digest marker (in-memory guard still holds for this process): ${logSafe(err)}`
      );
    });

    const elapsed = Date.now() - runStart;
    console.log(
      `${TAG} ✓ COMPLETE | elapsed=${elapsed}ms` +
        ` | notified=${notified}` +
        ` | lastWeeklyDigestDate=${lastWeeklyDigestDateUTC}`
    );
    console.log(`${TAG} [VERIFY] PASS — weekly digest complete`);
  } catch (err: unknown) {
    const msg = logSafe(err);
    console.error(`${TAG} [ERROR] Weekly digest failed: ${msg}`);
    console.error(`${TAG} [VERIFY] FAIL — weekly digest did not complete`);
  } finally {
    weeklyDigestRunning = false;
  }
}

// ─── Scheduler ────────────────────────────────────────────────────────────────

/**
 * Checks whether the weekly digest should fire on this tick and, if so,
 * fires it. Same restart-safety design as securityDigest.ts's
 * maybeFireDigest() — see that file for the full B2 reasoning.
 */
async function maybeFireWeeklyDigest(): Promise<void> {
  const { day, hour, minute } = nowUTC();
  const today = new Date().toISOString().slice(0, 10);

  const inWindow =
    day === DIGEST_DAY_UTC &&
    hour === DIGEST_HOUR_UTC &&
    minute >= DIGEST_WINDOW_START_MINUTE_UTC &&
    minute < DIGEST_WINDOW_START_MINUTE_UTC + DIGEST_WINDOW_MINUTES;
  if (!inWindow) return;

  if (lastWeeklyDigestDateUTC === today) return;

  const persistedDate = await loadLastWeeklyDigestDate().catch(
    (err: unknown) => {
      console.error(
        `${TAG} [WARN] Failed to read persisted weekly digest marker — proceeding as not-yet-fired (best-effort): ${logSafe(err)}`
      );
      return null;
    }
  );
  if (persistedDate === today) {
    lastWeeklyDigestDateUTC = today;
    console.log(
      `${TAG} [SKIP] Persisted marker shows this week's digest already fired — restart-safe skip (no duplicate)`
    );
    return;
  }

  console.log(
    `${TAG} [STEP] Weekly digest window detected | UTC day=${day} ${hour}:${String(minute).padStart(2, "0")}` +
      ` | lastWeeklyDigestDate=${lastWeeklyDigestDateUTC || "(none)"} | persistedDate=${persistedDate ?? "(none)"} | today=${today}`
  );
  void runWeeklySecurityDigest();
}

/**
 * Starts the weekly security digest scheduler.
 *
 * Polls every 60 seconds. Fires once inside the Sunday [13:00, 13:10) UTC
 * window (08:00 EST) per week, restart-safe via the persisted marker in
 * maybeFireWeeklyDigest().
 */
export function startWeeklySecurityDigestScheduler(): void {
  console.log(
    `${TAG} Scheduler started | fires every Sunday in UTC ${DIGEST_HOUR_UTC}:${String(DIGEST_WINDOW_START_MINUTE_UTC).padStart(2, "0")}–` +
      `${DIGEST_HOUR_UTC}:${String(DIGEST_WINDOW_START_MINUTE_UTC + DIGEST_WINDOW_MINUTES).padStart(2, "0")}` +
      ` (08:00 EST window) | poll interval=${CHECK_INTERVAL_MS / 1000}s`
  );

  void maybeFireWeeklyDigest();

  setInterval(() => {
    void maybeFireWeeklyDigest();
  }, CHECK_INTERVAL_MS);
}

// ─── Manual trigger (for testing / owner-initiated weekly digest) ─────────────

/**
 * Manually triggers the weekly security digest outside of the scheduled window.
 * Used by the test tRPC procedure and owner-initiated digests.
 */
export async function triggerWeeklySecurityDigestNow(): Promise<{
  threatLevel: string;
  weeklyTotals: {
    CSRF_BLOCK: number;
    RATE_LIMIT: number;
    AUTH_FAIL: number;
    total: number;
  };
  topIps: Array<{ ip: string; count: number }>;
  buckets: Array<{
    label: string;
    total: number;
    CSRF_BLOCK: number;
    RATE_LIMIT: number;
    AUTH_FAIL: number;
  }>;
}> {
  const runStart = Date.now();
  const windowStart = runStart - WINDOW_MS;

  console.log(
    `${TAG} [MANUAL] Manual weekly digest triggered | window=${new Date(windowStart).toISOString()} → ${new Date(runStart).toISOString()}`
  );

  const bucketCounts = await getSecurityEventCountsByBucket(windowStart);
  const totalAll = bucketCounts.reduce((s, b) => s + b.count, 0);
  const rawEvents = filterDigestMarkers(
    await getSecurityEvents({
      sinceMs: windowStart,
      limit: RAW_EVENT_FETCH_LIMIT,
    })
  );
  const { flagged, allowlisted } = splitEventsByAllowlist(rawEvents);
  const threatTotal = Math.max(0, totalAll - allowlisted.length);

  const buckets = buildDayBuckets(flagged, runStart);
  const topIps = topIpsByCount(flagged, TOP_IP_LIMIT);
  const threatLevel = computeWeeklyThreatLevel(threatTotal);

  console.log(
    `${TAG} [MANUAL] Results | threatLevel=${threatLevel}` +
      ` totalAll=${totalAll} threatTotal=${threatTotal} allowlisted=${allowlisted.length}`
  );

  await postWeeklyDigestToDiscord(
    buckets,
    topIps,
    threatLevel,
    totalAll,
    threatTotal,
    bucketCounts,
    allowlisted,
    windowStart,
    runStart
  ).catch((err: unknown) => {
    console.error(`${TAG} [MANUAL] Discord post failed: ${logSafe(err)}`);
  });

  return {
    threatLevel,
    weeklyTotals: {
      CSRF_BLOCK: sumByEventType(bucketCounts, "CSRF_BLOCK"),
      RATE_LIMIT: sumByEventType(bucketCounts, "RATE_LIMIT"),
      AUTH_FAIL: sumByEventType(bucketCounts, "AUTH_FAIL"),
      total: threatTotal,
    },
    topIps,
    buckets: buckets.map(b => ({
      label: b.label,
      total: b.total,
      CSRF_BLOCK: b.CSRF_BLOCK,
      RATE_LIMIT: b.RATE_LIMIT,
      AUTH_FAIL: b.AUTH_FAIL,
    })),
  };
}
