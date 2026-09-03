/**
 * betTrackerContract.test.ts — structural guarantees about the Bet Tracker.
 *
 * These read source text rather than call functions. They exist because the
 * properties they protect are invisible to a type checker and were each the
 * cause of a real defect:
 *
 *   - A procedure left on `handicapperProcedure` silently locks regular users
 *     out of their own bets (and skips the account-expiry check).
 *   - A second copy of the stats aggregation drifts from the first.
 *   - A second copy of the grading loop drifts from the first.
 *   - Invalidating the actor's stats cache instead of the bet OWNER's leaves the
 *     owner looking at stale numbers.
 *   - Grading with no cron path dies silently under DISABLE_BACKGROUND_JOBS.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(__dirname, "..");
const read = (p: string): string => readFileSync(join(ROOT, p), "utf8");

/**
 * Strip comments before asserting on code.
 *
 * These tests grep source text, and this file's own explanations quote the very
 * patterns they forbid ("it used to be `new Date(Date.now() - 30_000)`"). Left
 * unstripped, a correct fix fails its own test because the comment describing
 * it still contains the string.
 */
const code = (p: string): string =>
  read(p)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

const router = read("server/routers/betTracker.ts");
const scheduler = read("server/betAutoGradeScheduler.ts");
const cronRoutes = read("server/cron/cronRoutes.ts");
const clientPage = read("client/src/pages/BetTracker.tsx");

describe("access model", () => {
  it("every betTracker procedure runs on appUserProcedure", () => {
    const procedures = router.match(/^ {2}(\w+): (\w+Procedure)$/gm) ?? [];
    expect(procedures.length).toBeGreaterThan(8);
    const wrong = procedures.filter(p => !p.includes("appUserProcedure"));
    expect(
      wrong,
      `procedures not on appUserProcedure: ${wrong.join(", ")}`
    ).toEqual([]);
  });

  it("no procedure imports handicapperProcedure any more", () => {
    expect(router).not.toMatch(/import\s+\{[^}]*handicapperProcedure/);
  });

  it("visibility is resolved in exactly one place", () => {
    // Any hand-rolled `role !== "owner" && role !== "admin"` check is a second
    // implementation of the rule and can drift from resolveViewUserId.
    expect(router).not.toMatch(/role !== "owner" && role !== "admin"/);
    expect(router).toMatch(/function resolveScope/);
  });

  it("every read that accepts targetUserId resolves scope AND proves the target exists", () => {
    const targetUserIdReads = (
      router.match(/targetUserId: z\.number\(\)/g) ?? []
    ).length;
    const checked = (router.match(/resolveScopeChecked\(ctx, input/g) ?? [])
      .length;
    expect(checked).toBeGreaterThanOrEqual(targetUserIdReads);
  });

  it("owner/admin-only procedures assert privileged access", () => {
    for (const proc of [
      "listHandicappers",
      "getLogs",
      "reviewEditRequest",
      "autoGradeAll",
    ]) {
      const idx = router.indexOf(`  ${proc}: appUserProcedure`);
      expect(idx, `${proc} missing`).toBeGreaterThan(-1);
      const body = router.slice(idx, idx + 2000);
      expect(body, `${proc} must gate on decidePrivilegedAccess`).toMatch(
        /decidePrivilegedAccess/
      );
    }
  });
});

describe("single implementation", () => {
  it("the dead duplicate read procedures are gone", () => {
    for (const dead of ["  list: ", "  getStats: ", "  listWithStats: "]) {
      expect(router.includes(dead), `${dead.trim()} should be deleted`).toBe(
        false
      );
    }
  });

  it("the router contains no aggregation of its own", () => {
    // Breakdown assembly belongs to betTrackerCore.aggregateStats alone.
    expect(router).not.toMatch(/const byTypeMap\b/);
    expect(router).not.toMatch(/finalizeBreakdown/);
    expect(router).toMatch(/aggregateStats\(/);
  });

  it("the router contains no grading loop of its own", () => {
    expect(router).not.toMatch(/gradeTrackedBet\(/);
    expect(router).toMatch(/gradePendingForUser|gradeAllPendingForDate/);
  });

  it("the stats query is projected, not SELECT *", () => {
    expect(router).toMatch(/STAT_COLUMNS/);
    expect(router).toMatch(/db\.select\(STAT_COLUMNS\)/);
  });
});

describe("cache invalidation targets the bet owner", () => {
  for (const proc of ["update", "delete"]) {
    it(`${proc} invalidates existing.userId, not the actor`, () => {
      const idx = router.indexOf(`  ${proc}: appUserProcedure`);
      const end = router.indexOf("\n  /**", idx);
      const body = router.slice(idx, end === -1 ? router.length : end);
      expect(body, `${proc} must invalidate the bet owner's cache`).toMatch(
        /invalidateStatsCacheForUser\(existing\.userId\)/
      );
    });
  }

  it("the cache key is built from the resolved user id", () => {
    expect(router).toMatch(/buildStatsCacheKey\(userId,/);
  });
});

describe("admin reach and result integrity", () => {
  it("the account picker is driven by bet ownership, not by role", () => {
    // Filtering to owner/admin/handicapper left four role=user accounts holding
    // 17 bets unreachable — admins could see 39% of tracked bets and none
    // belonging to a real user.
    const idx = router.indexOf("listHandicappers: appUserProcedure");
    const body = router.slice(idx, idx + 1400);
    expect(body).toMatch(/innerJoin\(trackedBets/);
    expect(body).not.toMatch(/inArray\(appUsers\.role/);
  });

  it("a result change is gated and logged", () => {
    const idx = router.indexOf("  update: appUserProcedure");
    const end = router.indexOf("\n  /**", idx);
    const body = router.slice(idx, end === -1 ? router.length : end);
    expect(body).toMatch(/decideResultOverride/);
    expect(body).toMatch(/RESULT_OVERRIDE/);
    // Only a genuine change is an override — resending the same value is not.
    expect(body).toMatch(/input\.result !== existing\.result/);
  });
});

describe("grading concurrency", () => {
  it("both cron entry points hold the same process mutex as the pollers", () => {
    // runBetGradeCycle used to call gradeAllPendingForDate directly while
    // CronJobRunner held only its own lock, so a GitHub-triggered grade and the
    // 5-minute in-process poll could grade the same rows concurrently.
    expect(scheduler).toMatch(/function withGradingLock/);
    expect(scheduler).toMatch(/withGradingLock\("runBetGradeCycle"/);
    expect(scheduler).toMatch(/withGradingLock\("runBetGradeSweep"/);
    expect(cronRoutes).toMatch(/runBetGradeSweep\(/);
    expect(cronRoutes).not.toMatch(/gradeAllPendingAllDates\(/);
  });

  it("the nightly in-process sweep does NOT double-take the lock", () => {
    // It sets isGrading itself before calling gradeAllPendingAllDates; routing
    // it through withGradingLock as well would make it skip itself every night.
    const idx = scheduler.indexOf("async function runNightlySweep");
    const body = scheduler.slice(idx, idx + 1200);
    expect(body).toMatch(/gradeAllPendingAllDates\(/);
    expect(body).not.toMatch(/withGradingLock/);
  });
});

describe("indexes for the hot paths", () => {
  const schema = read("drizzle/schema.ts");

  it("covers the grader's all-users pending-by-date query", () => {
    // WHERE result='PENDING' AND gameDate=? runs on every polling cycle and
    // every cron firing. Every other composite leads with userId, which this
    // query does not filter on, so TiDB read every PENDING row each cycle.
    expect(schema).toMatch(
      /idx_tb_result_date"\)\.on\(t\.result, t\.gameDate\)/
    );
  });

  it("covers the create-path idempotency guard", () => {
    // The guard matches (userId, anGameId, gameNumber, market, pickSide, odds);
    // leading with userId+anGameId collapses a whole-history scan to one game.
    expect(schema).toMatch(
      /idx_tb_user_game"\)\.on\(t\.userId, t\.anGameId, t\.gameNumber\)/
    );
  });

  it("ships as a migration, not just a schema edit", () => {
    // A schema.ts change with no migration is invisible to the database. This
    // is the pairing db-push exists to enforce, and could not be relied on
    // until the generate pipeline was repaired.
    const { readdirSync } = require("node:fs") as typeof import("node:fs");
    const sql = readdirSync(join(ROOT, "drizzle")).filter(f =>
      f.endsWith(".sql")
    );
    const carries = sql.some(f =>
      readFileSync(join(ROOT, "drizzle", f), "utf8").includes(
        "idx_tb_result_date"
      )
    );
    expect(carries, "no migration file creates idx_tb_result_date").toBe(true);
  });
});

describe("safety hardening", () => {
  it("the idempotency window is computed by the database, not by Node", () => {
    // `new Date(Date.now() - 30_000)` is serialised in the Node process's local
    // timezone and compared against a column in the DB's timezone. Both are
    // SYSTEM, so the 30s guard was correct only while they agreed — measured at
    // SEVEN HOURS on a PDT host against the UTC production DB.
    const routerCode = code("server/routers/betTracker.ts");
    expect(routerCode).toMatch(/UTC_TIMESTAMP\(\) - INTERVAL 30 SECOND/);
    expect(routerCode).not.toMatch(/thirtySecondsAgo/);
    expect(routerCode).not.toMatch(/new Date\(Date\.now\(\) - 30_000\)/);
  });

  it("cross-user reads prove the target account exists", () => {
    // resolveViewUserId answers "may you read this id", not "is it real". An
    // owner/admin could query any integer and get a confident empty tracker.
    expect(router).toMatch(/async function resolveScopeChecked/);
    const crossUser = (router.match(/resolveScopeChecked\(ctx, input/g) ?? [])
      .length;
    expect(crossUser).toBeGreaterThanOrEqual(2);
    expect(code("server/routers/betTracker.ts")).not.toMatch(
      /const userId = resolveScope\(ctx, input/
    );
  });

  it("the container clock is pinned so nothing can depend on ambient TZ", () => {
    expect(read("Dockerfile")).toMatch(/^ENV TZ=UTC$/m);
  });

  it("grading failure raises an alarm instead of staying silent", () => {
    expect(scheduler).toMatch(/gradingAlert\("GRADING_ERRORS"/);
    expect(scheduler).toMatch(/gradingAlert\("NO_MATCH"/);
    expect(scheduler).toMatch(/checkStuckBets/);
    // notifyOwner is a no-op; the alarm must not be routed through it.
    expect(code("server/betGradingHealth.ts")).not.toMatch(/notifyOwner/);
  });
});

describe("stats cache is replica-safe", () => {
  it("every cache read is validated against a row fingerprint", () => {
    // Cache and invalidation are both per-process. With numReplicas > 1 a write
    // on replica A leaves B's entry intact and B serves stale W/L until TTL.
    expect(router).toMatch(/buildStatsFingerprint\(/);
    expect(router).toMatch(
      /getStatsCache<BetStats>\(statsCacheKey, fingerprint\)/
    );
    expect(router).not.toMatch(/getStatsCache<BetStats>\(statsCacheKey\)/);
  });

  it("the fingerprint covers inserts, updates AND same-second churn", () => {
    const cache = read("server/betTrackerStatsCache.ts");
    expect(cache).toMatch(/rowCount/);
    expect(cache).toMatch(/maxUpdated/);
    expect(cache).toMatch(/idChecksum/);
  });

  it("a fingerprint mismatch evicts rather than returning stale data", () => {
    const cache = read("server/betTrackerStatsCache.ts");
    const idx = cache.indexOf("entry.fingerprint !== fingerprint");
    expect(idx).toBeGreaterThan(-1);
    expect(cache.slice(idx, idx + 160)).toMatch(/statsCache\.delete\(key\)/);
  });
});

describe("soft delete is real, not decorative", () => {
  const db = read("server/db.ts");

  it("EVERY account-resolution path excludes retired accounts", () => {
    // A deletedAt column that auth ignores is decoration. All four lookups must
    // filter it, or a "deleted" account still logs in.
    const guarded = (db.match(/isNull\(appUsers\.deletedAt\)/g) ?? []).length;
    expect(
      guarded,
      "expected id, fresh-id, email and username lookups all guarded"
    ).toBeGreaterThanOrEqual(4);
  });

  it("retiring is the default; hard delete is opt-in", () => {
    const router = read("server/routers/appUsers.ts");
    expect(router).toMatch(/hard: z\.boolean\(\)/);
    expect(router).toMatch(/await softDeleteAppUser\(input\.id\)/);
  });

  it("hard delete still refuses to strand data", () => {
    // Soft delete does not remove the guard — it removes the reason the guard
    // felt obstructive, because "retire instead" now preserves the history.
    expect(db).toMatch(/AppUserHasDataError/);
    expect(db).toMatch(/describeDeletionBlock/);
  });

  it("a retired account can be restored", () => {
    expect(db).toMatch(/export async function restoreAppUser/);
  });

  it("ships as a migration, not just a schema edit", () => {
    const sql = readdirSync(join(ROOT, "drizzle")).filter(f =>
      f.endsWith(".sql")
    );
    const carries = sql.some(f =>
      readFileSync(join(ROOT, "drizzle", f), "utf8").includes("ADD `deletedAt`")
    );
    expect(carries, "no migration adds app_users.deletedAt").toBe(true);
  });
});

describe("stats fingerprint is timezone-independent", () => {
  it("REGRESSION: uses an epoch integer, not a driver Date", () => {
    // mysql2 returns DATETIME as a JS Date; String(Date) renders the process
    // locale and offset ("… GMT-0700 (Pacific Daylight Time)"). Two replicas in
    // different zones would compute different fingerprints for identical rows —
    // every read a miss, defeating the cache in the exact multi-replica case it
    // exists for. Found validating #330 against production.
    expect(router).toMatch(/UNIX_TIMESTAMP\(MAX\(/);
    expect(router).not.toMatch(/maxUpdated: sql<string \| null>`MAX\(/);
  });

  it("has a covering index so it is actually cheap", () => {
    // #330 claimed "a narrow indexed aggregate"; EXPLAIN showed
    // IndexRangeScan + TableRowIDScan — it read the same rows as the scan it
    // avoids. userId+updatedAt+id makes it index-only.
    expect(read("drizzle/schema.ts")).toMatch(
      /idx_tb_user_fingerprint"\)\.on\(t\.userId, t\.updatedAt, t\.id\)/
    );
  });
});

describe("grading has a cron path", () => {
  it("bet-grade endpoints are mounted", () => {
    expect(cronRoutes).toMatch(/\/api\/cron\/bet-grade["']/);
    expect(cronRoutes).toMatch(/\/api\/cron\/bet-grade-sweep["']/);
  });

  it("they run under the single-flight run-lock like every other cron job", () => {
    expect(cronRoutes).toMatch(/new CronJobRunner\("bet-grade"/);
    expect(cronRoutes).toMatch(/new CronJobRunner\("bet-grade-sweep"/);
  });

  it("a workflow exists to fire them", () => {
    const wf = join(ROOT, ".github/workflows/cron-bet-grade.yml");
    expect(existsSync(wf)).toBe(true);
    const body = readFileSync(wf, "utf8");
    expect(body).toMatch(/api\/cron\/bet-grade/);
    expect(body).toMatch(/CRON_SECRET/);
  });

  it("the nightly sweep window is wide enough to survive a busy mutex", () => {
    // A 3-minute window with a 1-minute tick meant one slow polling run could
    // consume every attempt and the night's sweep was lost silently.
    expect(scheduler).toMatch(/export function nightlySweepTarget/);
    expect(scheduler).toMatch(/lastSweptNight/);
  });
});

describe("client", () => {
  it("renders NCAAF before MLB and selects it by default", () => {
    expect(clientPage).toMatch(
      /const SPORTS = \["NCAAF", "MLB", "NHL", "NBA", "NCAAM"\]/
    );
    expect(clientPage).toMatch(/useState<SportOrAll>\("NCAAF"\)/);
    expect(clientPage).toMatch(
      /activeSport === "ALL" \? "NCAAF" : activeSport/
    );
  });

  it("loads NCAAF slates from Action Network through the tracker router", () => {
    expect(router).toMatch(
      /z\.enum\(\["NCAAF", "MLB", "NBA", "NHL", "NCAAM"\]\)/
    );
    expect(read("server/actionNetwork.ts")).toMatch(/NCAAF: "ncaaf"/);
  });

  it("the tracker is open to every authenticated user, not owner-only", () => {
    expect(clientPage).toMatch(/const canAccess = !!appUser;/);
    expect(clientPage).not.toMatch(/const canAccess = role === "owner"/);
  });

  it("invalidation refreshes the calendar alongside the bet list", () => {
    const idx = clientPage.indexOf("const invalidate = useCallback");
    const body = clientPage.slice(idx, idx + 600);
    expect(body).toMatch(/listWithStatsPaginated\.invalidate/);
    expect(body).toMatch(/getCalendarData\.invalidate/);
  });

  it("no client code references the deleted procedures", () => {
    for (const dead of [
      "betTracker.listWithStats.",
      "betTracker.getStats",
      "betTracker.list.",
    ]) {
      expect(clientPage.includes(dead), `${dead} should be gone`).toBe(false);
    }
  });

  it("the auto-grade poll does not run while viewing another user's tracker", () => {
    // autoGrade is self-scoped server-side, so firing it here graded the
    // viewer's own bets while showing progress over someone else's rows.
    expect(clientPage).toMatch(/if \(isViewingOtherUser\) return;/);
  });

  it("REGRESSION: edit/delete route by the handicapper rule, not by owner/admin", () => {
    // Opening the page to subscribers without changing these two gates swept
    // every regular user into the handicapper edit-request queue — a queue only
    // owner/admin can see. Production proof (2026-08-03): perky (role=user)
    // filed DELETE request 120001, it sat unanswerable, and the user worked
    // around it by hand-marking bet 390003 PUSH.
    expect(clientPage).toMatch(
      /const mustRequestChanges = role === "handicapper";/
    );
    expect(clientPage).toMatch(/setDeleteIsRequest\(mustRequestChanges\)/);
    expect(clientPage).toMatch(/setEditIsRequest\(mustRequestChanges\)/);
    expect(clientPage).not.toMatch(/setDeleteIsRequest\(!isOwnerOrAdmin\)/);
    expect(clientPage).not.toMatch(/setEditIsRequest\(!isOwnerOrAdmin\)/);
  });

  it("the direct-edit map uses the same predicate as the dialogs", () => {
    // One rule, one name — the previous split let the card affordance and the
    // dialog disagree about the same bet.
    const idx = clientPage.indexOf("const canDirectEditMap");
    const body = clientPage.slice(idx, idx + 700);
    expect(body).toMatch(/mustRequestChanges/);
    expect(body).not.toMatch(/role === "handicapper"/);
  });

  it("the dead mobile bet tracker screen is gone", () => {
    expect(
      existsSync(
        join(ROOT, "client/src/features/mobileNav/screens/MobileBetTracker.tsx")
      )
    ).toBe(false);
    expect(read("client/src/features/mobileNav/index.ts")).not.toMatch(
      /MobileBetTracker/
    );
  });
});
