/**
 * cronRoutes.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * GitHub-Actions-triggered cron endpoints for the critical data-freshness jobs.
 *
 * These replace the always-on in-process setInterval schedulers (gated off on
 * Railway via DISABLE_BACKGROUND_JOBS to cut credit burn). Instead of the app
 * burning CPU 24/7 on timers, GitHub Actions fires each endpoint on a schedule
 * and the work runs once, on demand.
 *
 * Auth:   shared secret (CRON_SECRET) — see cronAuth.ts for why the legacy
 *         heartbeat auth can't be reused off the legacy platform.
 * Path:   /api/cron/*  (deliberately distinct from the legacy /api/scheduled/*
 *         namespace so the two mechanisms never collide during the migration).
 * Shape:  respond 200 immediately, run work in the background under a run-lock.
 *
 * SCOPE — the ACTUAL mounted roster (corrected 2026-08-07, audit CRON-7; the
 * previous list said "first pass" and named only four of the eight, so a reader
 * checking whether a job was wired here got the wrong answer for half of them):
 *   - POST /api/cron/vsin-odds        → runVsinRefresh()      (NBA/NHL/MLB VSiN + AN odds)
 *   - POST /api/cron/scores           → refreshAllScoresNow() (live score refresh)
 *   - POST /api/cron/mlb-cycle        → runMlbCycleOnce()     (MLB lineups/K-props/backtest writes)
 *   - POST /api/cron/bet-grade        → bet auto-grading
 *   - POST /api/cron/bet-grade-sweep  → nightly bet-grade sweep
 *   - POST /api/cron/mlb-asg          → All-Star Game sync (hand-rolled, not mountJob)
 *   - POST /api/cron/stripe-reconcile → Stripe↔DB reconciliation (hand-rolled)
 *   - POST /api/cron/customer-sync    → tailered.ai customer-mirror push (hand-rolled)
 *   - GET  /api/cron/status           → run-lock state for all jobs (observability)
 *
 * SCOPE (second pass — MLB learning-loop ingestion, audit M-208). These three
 * closed the gap the line above used to describe: outcome ingestion, closing-line
 * capture and backtest enrollment previously ran ONLY inside the in-process
 * scheduler, so with DISABLE_BACKGROUND_JOBS set the model silently stopped
 * being graded.
 *   - POST /api/cron/mlb-outcomes?date=       → ingestMlbOutcomes()
 *       default window: last 2 PT dates (gameDate is a PT calendar date, and a
 *       late West Coast final must survive the UTC rollover)
 *   - POST /api/cron/mlb-closing-capture      → captureClosingLines()
 *       no date argument — it only ever scrapes the current slate
 *   - POST /api/cron/mlb-backtest?date=       → runMultiMarketBacktestForDate()
 *       SELF-HEAL only: onlyUnenrolled=true, runKProps=FALSE, default window the
 *       last 3 ET dates. runKProps must stay false until the K walk-forward
 *       re-fit lands — K_CALIBRATION_FACTOR_OVER/UNDER are still the pre-M-204
 *       literals, and enrolling against constants that are about to change
 *       pollutes the evaluation set the re-fit is judged on. For the same
 *       reason, hold `?date=` BULK BACKFILL runs until after the re-fit; the
 *       rolling default window is safe because it only fills genuine gaps.
 *
 * `?date=` is validated (YYYY-MM-DD) and rejected with 400 rather than silently
 * falling back to the default window.
 *
 * DELIBERATELY NOT wired here: MLB model sync. runMlbModelForDate() spawns
 * /usr/bin/python3 (400k Monte-Carlo sims) which fails on Railway with
 * `spawn /usr/bin/python3 ENOENT`. Curling a Railway endpoint for it would just
 * error. It needs Python-in-the-runner (run the model inside the Actions job with
 * DB write-back), which is a separate follow-up — not an HTTP curl.
 */

import type { Express, Request, Response } from "express";
import { requireCronSecret } from "./cronAuth";
import { resolveClientIdentity } from "../_core/clientIdentity";
import { CronJobRunner } from "./cronRunner";
import { runVsinRefresh, refreshAllScoresNow, runMlbCycleOnce } from "../vsinAutoRefresh";
import { runMlbAllStarGameSync } from "../mlbAllStarGameSync";
import { runBetGradeCycle, runBetGradeSweep } from "../betAutoGradeScheduler";
import { reconcileStripeSubscriptions, formatReconcileReport } from "../stripe/reconcile";
import { billingAlert } from "../_core/billingAlerts";
import { ingestMlbOutcomes } from "../mlbOutcomeIngestor";
import { captureClosingLines } from "../mlbScheduleHistoryService";
import { runMultiMarketBacktestForDate } from "../mlbMultiMarketBacktest";
import {
  makeBacktestWork,
  makeClosingCaptureWork,
  makeOutcomesWork,
} from "./mlbLoopJobs";
import { mountDateJob } from "./mountDateJob";
import { pushCustomerSnapshot } from "./customerSync";

// One runner per job — module-level so the run-lock survives across requests.
const vsinRunner = new CronJobRunner("vsin-odds", async () => {
  await runVsinRefresh();
});

const scoresRunner = new CronJobRunner("scores", async () => {
  await refreshAllScoresNow();
});

// MLB cycle — writes mlb_lineups, mlb_strikeout_props, mlb_game_backtest. Previously
// only reachable via the in-process 10-min interval; with DISABLE_BACKGROUND_JOBS set
// on Railway that interval never runs, so this endpoint is the only trigger. The
// run-lock below preserves the single-flight/overlap protection the interval relied on.
const mlbCycleRunner = new CronJobRunner("mlb-cycle", async () => {
  await runMlbCycleOnce();
});

// Bet grading — settles PENDING tracked bets for today + yesterday.
//
// Why this exists: grading lived ONLY inside the in-process scheduler, which
// sits behind the DISABLE_BACKGROUND_JOBS kill switch. Flipping that flag to cut
// Railway credits would have stopped bet settlement entirely, silently — no
// error, bets simply never leave PENDING. This endpoint gives grading the same
// cron-triggered path the other data-freshness jobs already have, under the same
// single-flight run-lock.
const betGradeRunner = new CronJobRunner("bet-grade", async () => {
  await runBetGradeCycle("cron_bet_grade");
});

// Nightly catch-all — every PENDING bet across every date, not just today and
// yesterday. Picks up anything the incremental cycle missed (late finals,
// upstream feed outages, bets logged for older dates).
const betGradeSweepRunner = new CronJobRunner("bet-grade-sweep", async () => {
  await runBetGradeSweep("cron_bet_grade_sweep");
});

// ── MLB learning loop (audit M-208) ──────────────────────────────────────────
//
// Outcome ingestion, closing-line capture and backtest enrollment previously
// existed ONLY inside the in-process scheduler, which sits behind
// DISABLE_BACKGROUND_JOBS. With that flag set on Railway the learning loop
// simply never runs — no error, the model just stops being graded. These three
// endpoints give it the same cron-triggered path the other jobs already have,
// under the same single-flight run-lock.

/** Date stash for the date-aware jobs; set by mountDateJob before trigger(). */
let mlbOutcomesDate: string | null = null;
let mlbBacktestDate: string | null = null;

// Outcome ingestion — writes actual scores + the five Brier columns.
// Default window is the last 2 PT dates so a late-night final is still picked up
// on the next morning's run. gameDate is a PT calendar date (schema), so the
// zone here must be PT, not UTC.
const mlbOutcomesRunner = new CronJobRunner(
  "mlb-outcomes",
  makeOutcomesWork(() => mlbOutcomesDate, d => ingestMlbOutcomes(d))
);

// Closing-line capture — locks the closing odds snapshot for today's slate.
// Takes no date argument: it only ever scrapes the current slate.
const mlbClosingCaptureRunner = new CronJobRunner(
  "mlb-closing-capture",
  makeClosingCaptureWork(() => captureClosingLines())
);

// Backtest SELF-HEAL — enrolls FINAL games that have no mlb_game_backtest rows.
//
// runKProps is deliberately FALSE. The K-props backtest is date-scoped, so
// looping N unenrolled games with true would re-run the whole date N times; the
// mlb-cycle cron already runs it once per cycle. It also decouples this endpoint
// from K_CALIBRATION_FACTOR_OVER/UNDER, which are still the pre-M-204 literals
// awaiting a walk-forward re-fit — enrolling against constants that are about to
// change would pollute the very evaluation set the re-fit is judged on.
//
// The default is a 3-day ET rolling window: self-heal, not backfill. A `?date=`
// bulk backfill should wait until after the K re-fit for the same reason.
const mlbBacktestRunner = new CronJobRunner(
  "mlb-backtest",
  makeBacktestWork(
    () => mlbBacktestDate,
    d => runMultiMarketBacktestForDate(d, { onlyUnenrolled: true, runKProps: false })
  )
);

function sanitizeForLog(value: string): string {
  return value.replace(/[\r\n]/g, "");
}

/** Wire a POST endpoint that auth-guards, triggers the runner, responds 200. */
function mountJob(app: Express, path: string, label: string, runner: CronJobRunner): void {
  app.post(path, (req: Request, res: Response) => {
    if (!requireCronSecret(req, res, label)) return;

    const reqAt = new Date().toISOString();
    const clientIpForLog = sanitizeForLog(resolveClientIdentity(req) || "?");
    // Cosmetic log line on an internal, secret-authed path — migrated for
    // consistency with the single client-identity surface (2026-08-06 audit).
    console.log(
      `[Cron:${label}] [INPUT] POST ${path} at ${reqAt} ip=${clientIpForLog}`
    );

    const outcome = runner.trigger();

    console.log(
      `[Cron:${label}] [OUTPUT] started=${outcome.started} skipped=${outcome.skipped} ` +
      `lastRunAt=${outcome.lastRunAt ?? "never"}`
    );

    res.status(200).json({
      ok: true,
      job: label,
      startedAt: reqAt,
      started: outcome.started,
      skipped: outcome.skipped,
      lastResult: outcome.lastResult,
    });
  });
  console.log(`[Cron] [OUTPUT] Registered POST ${path} (job=${label})`);
}

export function registerCronRoutes(app: Express): void {
  mountJob(app, "/api/cron/vsin-odds", "vsin-odds", vsinRunner);
  mountJob(app, "/api/cron/scores", "scores", scoresRunner);
  mountJob(app, "/api/cron/mlb-cycle", "mlb-cycle", mlbCycleRunner);
  mountJob(app, "/api/cron/bet-grade", "bet-grade", betGradeRunner);
  mountJob(app, "/api/cron/bet-grade-sweep", "bet-grade-sweep", betGradeSweepRunner);

  // MLB learning loop (M-208).
  mountDateJob(app, "/api/cron/mlb-outcomes", "mlb-outcomes", mlbOutcomesRunner, d => {
    mlbOutcomesDate = d;
  });
  mountJob(app, "/api/cron/mlb-closing-capture", "mlb-closing-capture", mlbClosingCaptureRunner);
  mountDateJob(app, "/api/cron/mlb-backtest", "mlb-backtest", mlbBacktestRunner, d => {
    mlbBacktestDate = d;
  });

  // MLB All-Star Game (AL vs NL) seed/refresh. Unlike the fire-and-forget jobs
  // above, this runs synchronously and returns the book-vs-model tail + audit so
  // the mlb-asg.yml workflow can print/verify the result. `dryRun` scrapes +
  // computes without writing (pre-publish preview from the deployed server).
  app.post("/api/cron/mlb-asg", async (req: Request, res: Response) => {
    if (!requireCronSecret(req, res, "mlb-asg")) return;
    const dryRun =
      req.body?.dryRun === true || req.body?.dryRun === "true" || req.query?.dryRun === "true";
    console.log(`[Cron:mlb-asg] [INPUT] POST /api/cron/mlb-asg dryRun=${dryRun} at ${new Date().toISOString()}`);
    try {
      const result = await runMlbAllStarGameSync({ dryRun });
      console.log(`[Cron:mlb-asg] [OUTPUT] wrote=${result.wrote} auditPass=${result.audit.pass}\n${result.tail}`);
      res.status(result.audit.pass ? 200 : 500).json({ ok: result.audit.pass, ...result });
    } catch (err) {
      console.error(`[Cron:mlb-asg] [ERROR]`, err);
      res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });
  console.log(`[Cron] [OUTPUT] Registered POST /api/cron/mlb-asg (job=mlb-asg)`);

  // Stripe ↔ database drift detector (audit OPS-001).
  //
  // Webhook delivery is at-least-once but not guaranteed-once-forever: a revoke
  // lost during an outage, or an endpoint misconfiguration, leaves the database
  // silently disagreeing with Stripe — and nothing else in this system would
  // ever notice. This job is the safety net. It is strictly READ-ONLY: it lists
  // Stripe subscriptions, diffs them against app_users, and reports. It never
  // writes an entitlement, because auto-healing a drift you do not understand is
  // how one bad assumption becomes a mass revoke.
  //
  // Runs synchronously (like mlb-asg) so the workflow can print the drift table,
  // and returns 200 even when drift is found — drift is a finding to action, not
  // a failed job. Only an execution error is a non-2xx.
  app.post("/api/cron/stripe-reconcile", async (req: Request, res: Response) => {
    if (!requireCronSecret(req, res, "stripe-reconcile")) return;
    const maxPagesRaw = req.body?.maxPages ?? req.query?.maxPages;
    const maxPages = Number.isFinite(Number(maxPagesRaw)) && Number(maxPagesRaw) > 0
      ? Math.min(Number(maxPagesRaw), 50)
      : undefined;
    console.log(`[Cron:stripe-reconcile] [INPUT] POST /api/cron/stripe-reconcile maxPages=${maxPages ?? "default"} at ${new Date().toISOString()}`);
    try {
      const report = await reconcileStripeSubscriptions(maxPages ? { maxPages } : undefined);
      const summary = formatReconcileReport(report);
      console.log(`[Cron:stripe-reconcile] [OUTPUT]\n${summary}`);

      if (report.drift.length > 0) {
        void billingAlert("RECONCILE_DRIFT", {
          driftCount: report.drift.length,
          checkedStripeSubscriptions: report.checkedStripeSubscriptions,
          checkedDbUsers: report.checkedDbUsers,
          truncated: report.truncated,
          // Bounded sample only — the full report is in the job log.
          sample: report.drift.slice(0, 10).map((d) => ({ kind: d.kind, userId: d.userId, detail: d.detail })),
        });
      }

      console.log(`[Cron:stripe-reconcile] [VERIFY] ${report.drift.length === 0 ? "PASS — no drift" : `DRIFT — ${report.drift.length} row(s)`}`);
      res.status(200).json({ ok: true, ...report, summary });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[Cron:stripe-reconcile] [ERROR] ${msg}`);
      void billingAlert("RECONCILE_DRIFT", { failed: true, detail: msg });
      res.status(500).json({ ok: false, error: msg });
    }
  });
  console.log(`[Cron] [OUTPUT] Registered POST /api/cron/stripe-reconcile (job=stripe-reconcile)`);

  // Tailered customer-mirror push (Phase 1, additive — spec:
  // docs/superpowers/specs/2026-08-26-dime-customer-mirror-design.md in the
  // tailered-os repo). Builds a sanitized snapshot of the live customer base
  // and POSTs it HMAC-signed to tailered.ai. Runs synchronously (like
  // stripe-reconcile) so the workflow log carries the outcome. When
  // TAILERED_SYNC_URL or TAILERED_SYNC_SECRET is unset the push is an explicit
  // no-op — 200 {ok:true, skipped:"unconfigured"} — so merging this route is
  // inert until Railway configures both. A failed push is 502 (the workflow
  // must go red, not silently "succeed"); only an unexpected throw is 500.
  app.post("/api/cron/customer-sync", async (req: Request, res: Response) => {
    if (!requireCronSecret(req, res, "customer-sync")) return;
    console.log(`[Cron:customer-sync] [INPUT] POST /api/cron/customer-sync at ${new Date().toISOString()}`);
    try {
      const result = await pushCustomerSnapshot();
      console.log(
        `[Cron:customer-sync] [OUTPUT] ok=${result.ok} skipped=${result.skipped ?? "-"} ` +
        `users=${result.users ?? "-"} status=${result.status ?? "-"}`
      );
      res.status(result.ok ? 200 : 502).json(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[Cron:customer-sync] [ERROR] ${msg}`);
      res.status(500).json({ ok: false, error: msg });
    }
  });
  console.log(`[Cron] [OUTPUT] Registered POST /api/cron/customer-sync (job=customer-sync)`);

  // Observability: read-only run-lock state for all jobs (still secret-guarded so
  // it can't be scraped anonymously). Handy for the CI perf harness and debugging.
  app.get("/api/cron/status", (req: Request, res: Response) => {
    if (!requireCronSecret(req, res, "status")) return;
    res.status(200).json({
      ok: true,
      jobs: {
        "vsin-odds": vsinRunner.state,
        scores: scoresRunner.state,
        "mlb-cycle": mlbCycleRunner.state,
        "bet-grade": betGradeRunner.state,
        "bet-grade-sweep": betGradeSweepRunner.state,
        "mlb-outcomes": mlbOutcomesRunner.state,
        "mlb-closing-capture": mlbClosingCaptureRunner.state,
        "mlb-backtest": mlbBacktestRunner.state,
      },
    });
  });
  console.log(`[Cron] [OUTPUT] Registered GET /api/cron/status`);
}
