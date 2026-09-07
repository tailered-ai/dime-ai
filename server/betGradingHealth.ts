/**
 * betGradingHealth.ts — make grading failure loud instead of silent.
 *
 * THE FAILURE MODE THIS EXISTS FOR
 *
 * Every settle path is best-effort by design: `gradePendingRows` catches per-bet
 * errors and moves on, and an ungradeable bet simply stays PENDING. That is the
 * right behaviour — a feed hiccup must not corrupt a result — but it means the
 * system's response to "the MLB API changed shape" is indistinguishable from
 * "no games have finished yet". Bets quietly stop settling and nobody finds out
 * until a user asks why their ticket is still open.
 *
 * There was no alarm for this. `notifyOwner()` is a logged no-op (the legacy
 * gateway was decommissioned), so the only live transport is the Discord webhook
 * that billing already uses.
 *
 * WHAT IS ALERTED
 *
 *   STUCK_BETS      — bets still PENDING well after their game must have ended.
 *   GRADING_ERRORS  — a settle cycle raised per-bet exceptions.
 *   NO_MATCH        — the grader could not resolve a bet to a game, which is
 *                     how feed-vocabulary drift shows up before it becomes
 *                     stuck bets.
 *
 * The detection rules are pure functions so they can be tested without a
 * database or a webhook.
 */

const TAG = "[BetGradingHealth]";
const WEBHOOK_TIMEOUT_MS = 5_000;

/** One alert per kind per window — a broken feed must not become 500 messages. */
const RATE_LIMIT_MS = 60 * 60 * 1000;
const lastSentAt = new Map<string, number>();

export type GradingAlertKind = "STUCK_BETS" | "GRADING_ERRORS" | "NO_MATCH" | "FOOTBALL_INTEGRITY" | "FOOTBALL_STALE";

const EMBED_COLOR: Record<GradingAlertKind, number> = {
  STUCK_BETS: 0xed4245,     // red — user-visible money is unsettled
  GRADING_ERRORS: 0xed4245,
  NO_MATCH: 0xfaa61a,       // amber — early warning, not yet user-visible
  FOOTBALL_INTEGRITY: 0xed4245,
  FOOTBALL_STALE: 0xfaa61a,
};

export interface StuckBet {
  id: number;
  userId: number;
  sport: string;
  gameDate: string;
  awayTeam: string | null;
  homeTeam: string | null;
  hoursPending: number;
}

/**
 * How long after a game's date a still-PENDING bet counts as stuck.
 *
 * A slate's last game starts late evening local and runs ~3h, so a bet on a
 * given gameDate should settle within ~24h of that date beginning. 36h leaves
 * generous headroom for a late West-Coast finish plus a missed polling window,
 * while still catching a genuine outage the same day it starts.
 */
export const STUCK_THRESHOLD_HOURS = 36;

/**
 * Decide whether a set of still-pending bets warrants an alarm, and describe it.
 * Pure: takes already-measured ages, returns null when healthy.
 */
export function describeStuckBets(bets: StuckBet[]): string | null {
  const stuck = bets.filter(b => b.hoursPending >= STUCK_THRESHOLD_HOURS);
  if (stuck.length === 0) return null;

  const bySport = new Map<string, number>();
  for (const b of stuck) bySport.set(b.sport, (bySport.get(b.sport) ?? 0) + 1);
  const oldest = stuck.reduce((a, b) => (b.hoursPending > a.hoursPending ? b : a));
  const sports = Array.from(bySport.entries()).map(([s, n]) => `${n} ${s}`).join(", ");
  const sample = stuck.slice(0, 5)
    .map(b => `#${b.id} ${b.awayTeam ?? "?"}@${b.homeTeam ?? "?"} ${b.gameDate} (${Math.floor(b.hoursPending)}h)`)
    .join("\n");

  return (
    `${stuck.length} bet(s) still PENDING more than ${STUCK_THRESHOLD_HOURS}h after their game date ` +
    `(${sports}). Oldest: #${oldest.id} at ${Math.floor(oldest.hoursPending)}h.\n\n` +
    `Bets do not settle themselves — this usually means the score feed changed shape, ` +
    `went down, or the grader cannot resolve these games.\n\n${sample}`
  );
}

/** Decide whether a completed grading cycle should raise an error alarm. */
export function describeGradingErrors(summary: {
  date: string;
  total: number;
  graded: number;
  errors: number;
  details?: Array<{ betId: number; result: string; reason: string }>;
}): string | null {
  if (summary.errors === 0) return null;
  const reasons = (summary.details ?? [])
    .filter(d => d.result === "ERROR")
    .slice(0, 5)
    .map(d => `#${d.betId}: ${d.reason}`)
    .join("\n");
  return (
    `${summary.errors} of ${summary.total} bet(s) raised an exception while grading ` +
    `${summary.date} (${summary.graded} settled successfully).\n\n${reasons}`
  );
}

/**
 * Decide whether unresolved games warrant an early-warning alarm.
 *
 * A grader that cannot find the game returns PENDING with a reason. One is
 * noise (a postponed fixture, a typo); a cluster means the feed's team
 * vocabulary has drifted and every affected bet is on its way to being stuck.
 */
export function describeNoMatch(
  details: Array<{ betId: number; result: string; reason: string }>,
  threshold = 3,
): string | null {
  const noMatch = details.filter(d => /not found in .* scores|AMBIGUOUS/i.test(d.reason));
  if (noMatch.length < threshold) return null;
  return (
    `${noMatch.length} bet(s) could not be matched to a game in this cycle. ` +
    `This is how score-feed vocabulary drift presents before it becomes stuck bets — ` +
    `check ABBREV_ALIASES in scoreGrader.ts.\n\n` +
    noMatch.slice(0, 5).map(d => `#${d.betId}: ${d.reason}`).join("\n")
  );
}

/** True when this kind may send now (and records the send). Exported for tests. */
export function takeRateLimitSlot(kind: GradingAlertKind, now = Date.now(), scope = ""): boolean {
  const key = scope ? `${kind}:${scope}` : kind;
  const last = lastSentAt.get(key);
  if (last !== undefined && now - last < RATE_LIMIT_MS) return false;
  lastSentAt.set(key, now);
  return true;
}

/** Test-only. */
export function __resetGradingAlertRateLimit(): void {
  lastSentAt.clear();
}

function webhookUrl(): string | null {
  return (
    process.env.BILLING_ALERT_DISCORD_WEBHOOK_URL ||
    process.env.DISCORD_BILLING_WEBHOOK_URL ||
    null
  );
}

/**
 * Raise a grading alert. Always logs; delivery is best-effort and never throws,
 * because an alerting failure must not break the thing it is watching.
 */
export async function gradingAlert(kind: GradingAlertKind, description: string, scope = ""): Promise<void> {
  console.warn(`${TAG}[${kind}] ${description.split("\n")[0]}`);

  if (!takeRateLimitSlot(kind, Date.now(), scope)) {
    console.log(`${TAG}[${kind}] [TRANSPORT] suppressed by rate limit (${RATE_LIMIT_MS / 60000}m window)`);
    return;
  }
  const url = webhookUrl();
  if (!url) {
    console.warn(`${TAG}[${kind}] [TRANSPORT] no webhook configured — console only`);
    return;
  }
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        embeds: [{
          title: `${kind.startsWith("FOOTBALL_") ? "FOOTBALL FEED" : "🎯 BET GRADING"} — ${kind}`,
          description: description.slice(0, 3900),
          color: EMBED_COLOR[kind],
          footer: { text: `Dime AI · Bet Grading Monitor · ${kind}` },
          timestamp: new Date().toISOString(),
        }],
      }),
      signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
    });
    if (!res.ok) {
      console.warn(`${TAG}[${kind}] [TRANSPORT] webhook returned ${res.status}`);
      return;
    }
    console.log(`${TAG}[${kind}] [TRANSPORT] delivered ✓`);
  } catch (err) {
    console.warn(`${TAG}[${kind}] [TRANSPORT] POST failed: ${(err as Error).message}`);
  }
}
