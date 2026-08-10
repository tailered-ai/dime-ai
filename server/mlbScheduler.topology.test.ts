import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

/**
 * §4 — MLB scheduler ownership, concurrency, and timezone.
 *
 * BEFORE (verified against production, Railway deployment ff472662, service
 * a46ea921, 2026-08-09):
 *
 *   server/_core/index.ts
 *     ├─ startVsinAutoRefresh()        → setInterval 300s → runMlbCycleOnce()
 *     │                                   └─ Step 6: runMlbModelForDate(PT today)
 *     │                                              runMlbModelForDate(PT tomorrow)
 *     └─ startMlbModelSyncScheduler()  → setInterval 300s → runMlbModelSyncCycle()
 *                                         └─ runMlbModelForDate(ET today)
 *                                            runMlbModelForDate(ET tomorrow)
 *
 *   Two schedulers, one workload, the same 300s cadence, two module-local
 *   in-flight booleans that could not see each other, and one CPU-bound Monte
 *   Carlo subprocess spawned per path. Production logged the pairs seconds
 *   apart: "[MLBModelRunner][2026-08-10] Spawning Python engine for 6 games..."
 *   at 19:05:44.322Z and 19:05:52.290Z; "…for 10 games…" at 23:50:42.493Z and
 *   23:50:52.290Z.
 *
 *   On top of that, the already-modelled guard compared
 *   `new Date(modelRunAt).toISOString().slice(0, 10)` — a UTC calendar date —
 *   against `games.gameDate`, which mlbScheduleSync derives in Eastern and
 *   documents as "NEVER the UTC calendar date". The two agree only while UTC
 *   and Eastern share a day, so the guard inverted every night from 00:00 UTC
 *   (20:00 EDT) to midnight Eastern.
 *
 * AFTER:
 *
 *   server/_core/index.ts
 *     ├─ startVsinAutoRefresh()        → setInterval 300s → runMlbCycleOnce()
 *     │                                   (re-entrancy guard + 20-min watchdog)
 *     │                                   └─ Step 6: runMlbModelSyncJob()
 *     │                                              (single-flight)
 *     │                                              └─ runMlbModelForDate(ET today)
 *     │                                                 runMlbModelForDate(ET tomorrow)
 *     │                                                 └─ runWithMlbEngineSlot
 *     │                                                    (1 subprocess, queue ≤ 8)
 *     └─ startMlbModelSyncScheduler()  → RETIRED no-op, registers no timer
 */

const __dirname_ = path.dirname(fileURLToPath(import.meta.url));
const readSource = (f: string) =>
  fs.readFileSync(path.join(__dirname_, f), "utf-8");

/** Extract the body of a top-level `async function <name>(` by brace matching. */
function functionBody(source: string, declaration: string): string {
  const start = source.indexOf(declaration);
  if (start === -1) throw new Error(`declaration not found: ${declaration}`);
  // The body's `{` is the first one at paren depth 0 — anything inside the
  // parameter list (e.g. an inline object type) sits at depth ≥ 1.
  let parens = 0;
  let open = -1;
  for (let i = start; i < source.length; i++) {
    const ch = source[i];
    if (ch === "(") parens++;
    else if (ch === ")") parens--;
    else if (ch === "{" && parens === 0) {
      open = i;
      break;
    }
  }
  if (open === -1) throw new Error(`no body for: ${declaration}`);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") {
      depth--;
      if (depth === 0) return source.slice(open, i + 1);
    }
  }
  throw new Error(`unbalanced body for: ${declaration}`);
}

const countOccurrences = (haystack: string, needle: string) =>
  haystack.split(needle).length - 1;

// ─────────────────────────────────────────────────────────────────────────────
// 1. OWNERSHIP — exactly one scheduler owns the MLB model workload
// ─────────────────────────────────────────────────────────────────────────────

describe("MLB model workload ownership", () => {
  it("startMlbModelSyncScheduler registers no recurring timer and no watchdog", async () => {
    const { startMlbModelSyncScheduler } = await import("./mlbModelRunner");
    const intervalSpy = vi.spyOn(global, "setInterval");
    const timeoutSpy = vi.spyOn(global, "setTimeout");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      startMlbModelSyncScheduler();
      // The whole point: the second scheduler is gone. It used to register a
      // 300s work interval AND a 120s watchdog interval that re-entered the
      // same workload.
      expect(intervalSpy).not.toHaveBeenCalled();
      expect(timeoutSpy).not.toHaveBeenCalled();
      expect(
        logSpy.mock.calls.some(c =>
          String(c[0]).includes("[MlbModelSync] RETIRED")
        )
      ).toBe(true);
    } finally {
      intervalSpy.mockRestore();
      timeoutSpy.mockRestore();
      logSpy.mockRestore();
    }
  });

  it("mlbModelRunner registers no recurring timer at all", () => {
    const src = readSource("mlbModelRunner.ts");
    // A positive discriminator rather than an absence claim: the file DOES
    // contain setTimeout (the withDbRetry backoff sleep), so a zero here is a
    // real signal about setInterval specifically, not a broken search.
    expect(countOccurrences(src, "setTimeout(")).toBeGreaterThan(0);
    expect(countOccurrences(src, "setInterval(")).toBe(0);
  });

  it("the MLB cycle acquires the model through exactly one path", () => {
    const src = readSource("vsinAutoRefresh.ts");
    const body = functionBody(src, "async function runMlbCycleWork(");
    // Sanity: we really did extract the cycle body, not an empty string.
    expect(body).toContain("[MLBCycle] ✅ DONE");
    // Exactly one acquisition of the model workload…
    expect(countOccurrences(body, "runMlbModelSyncJob()")).toBe(1);
    // …and no direct per-date call that would re-create the duplicate.
    // `runMlbModelForDate(` appears only inside comments describing the old
    // shape, so match the call form with an argument that is not a comment.
    const callSites = body
      .split("\n")
      .filter(line => !line.trim().startsWith("//"))
      .filter(line => line.includes("runMlbModelForDate("));
    expect(callSites).toEqual([]);
  });

  it("the model job is invoked from the cycle, which owns the re-entrancy guard", () => {
    const src = readSource("vsinAutoRefresh.ts");
    // runMlbCycleOnce is the guarded entry point; runMlbCycleWork is the body
    // it wraps. If the job were called from anywhere else in this module it
    // would bypass the guard.
    expect(countOccurrences(src, "runMlbModelSyncJob")).toBe(2); // import + call
    expect(src).toContain("if (mlbCycleInFlight) {");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. TIMEZONE — one canonical basis (UTC instant), converted at one boundary
// ─────────────────────────────────────────────────────────────────────────────

describe("easternCalendarDate — the single instant→calendar-day boundary", () => {
  it("matches mlbScheduleSync's gameDate formatter exactly", async () => {
    const { easternCalendarDate } = await import("./mlbModelRunner");
    const { todayEasternDate } = await import("./mlbScheduleSync");
    expect(easternCalendarDate(Date.now())).toBe(todayEasternDate());
  });

  it("keeps a late-evening Eastern instant on its own Eastern day", async () => {
    const { easternCalendarDate } = await import("./mlbModelRunner");
    // 2026-08-10T00:30Z is 2026-08-09 20:30 EDT.
    expect(easternCalendarDate(Date.parse("2026-08-10T00:30:00Z"))).toBe(
      "2026-08-09"
    );
    expect(easternCalendarDate(Date.parse("2026-08-10T03:59:59Z"))).toBe(
      "2026-08-09"
    );
    // …and rolls at Eastern midnight, not UTC midnight.
    expect(easternCalendarDate(Date.parse("2026-08-10T04:00:00Z"))).toBe(
      "2026-08-10"
    );
  });

  it("is not the UTC calendar date (the defect it replaces)", async () => {
    const { easternCalendarDate } = await import("./mlbModelRunner");
    const instant = Date.parse("2026-08-10T00:30:00Z");
    const utcDate = new Date(instant).toISOString().slice(0, 10);
    expect(utcDate).toBe("2026-08-10");
    expect(easternCalendarDate(instant)).toBe("2026-08-09");
    expect(easternCalendarDate(instant)).not.toBe(utcDate);
  });

  it("handles the spring-forward day (23h Eastern day)", async () => {
    const { easternCalendarDate } = await import("./mlbModelRunner");
    // 2026-03-08: EST→EDT at 02:00 local. The Eastern day runs
    // 2026-03-08T05:00Z … 2026-03-09T03:59:59Z.
    expect(easternCalendarDate(Date.parse("2026-03-08T04:59:59Z"))).toBe(
      "2026-03-07"
    );
    expect(easternCalendarDate(Date.parse("2026-03-08T05:00:00Z"))).toBe(
      "2026-03-08"
    );
    expect(easternCalendarDate(Date.parse("2026-03-09T03:59:59Z"))).toBe(
      "2026-03-08"
    );
    expect(easternCalendarDate(Date.parse("2026-03-09T04:00:00Z"))).toBe(
      "2026-03-09"
    );
  });

  it("handles the fall-back day (25h Eastern day)", async () => {
    const { easternCalendarDate } = await import("./mlbModelRunner");
    // 2026-11-01: EDT→EST at 02:00 local. The Eastern day runs
    // 2026-11-01T04:00Z … 2026-11-02T04:59:59Z.
    expect(easternCalendarDate(Date.parse("2026-11-01T03:59:59Z"))).toBe(
      "2026-10-31"
    );
    expect(easternCalendarDate(Date.parse("2026-11-01T04:00:00Z"))).toBe(
      "2026-11-01"
    );
    expect(easternCalendarDate(Date.parse("2026-11-02T04:59:59Z"))).toBe(
      "2026-11-01"
    );
    expect(easternCalendarDate(Date.parse("2026-11-02T05:00:00Z"))).toBe(
      "2026-11-02"
    );
  });
});

describe("mlbSlateDate — the job's today/tomorrow", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("is Eastern, not UTC, at 00:30 UTC", async () => {
    const { mlbSlateDate, mlbModelSyncDates } =
      await import("./mlbModelRunner");
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-10T00:30:00Z"));
    expect(mlbSlateDate(0)).toBe("2026-08-09");
    expect(mlbSlateDate(1)).toBe("2026-08-10");
    expect(mlbModelSyncDates()).toEqual({
      today: "2026-08-09",
      tomorrow: "2026-08-10",
    });
  });

  it("rolls at Eastern midnight", async () => {
    const { mlbModelSyncDates } = await import("./mlbModelRunner");
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-10T03:59:00Z"));
    expect(mlbModelSyncDates().today).toBe("2026-08-09");
    vi.setSystemTime(new Date("2026-08-10T04:00:00Z"));
    expect(mlbModelSyncDates().today).toBe("2026-08-10");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. THE INVERTED GUARD — the 7-hour nightly window must be gone
// ─────────────────────────────────────────────────────────────────────────────

describe("isModelRunFreshForGameDate", () => {
  it("is fresh for every minute of the game's own Eastern day — no inverted window", async () => {
    const { isModelRunFreshForGameDate } = await import("./mlbModelRunner");
    // 2026-08-09 Eastern runs 2026-08-09T04:00Z … 2026-08-10T03:59Z.
    const dayStart = Date.parse("2026-08-09T04:00:00Z");
    const stale: string[] = [];
    for (let minute = 0; minute < 24 * 60; minute++) {
      const instant = dayStart + minute * 60_000;
      if (!isModelRunFreshForGameDate(instant, "2026-08-09")) {
        stale.push(new Date(instant).toISOString());
      }
    }
    expect(stale).toEqual([]);
  });

  it("the OLD UTC formula inverts for exactly the last 7 hours of that same day", async () => {
    // Positive discriminator: this reproduces the historical defect in-line so
    // the test above is proved to be measuring something real. Under the UTC
    // formula, 20:00–23:59 EDT (00:00–03:59 UTC) reads as a different day.
    const dayStart = Date.parse("2026-08-09T04:00:00Z");
    let invertedMinutes = 0;
    for (let minute = 0; minute < 24 * 60; minute++) {
      const instant = dayStart + minute * 60_000;
      const utcDate = new Date(instant).toISOString().slice(0, 10);
      if (utcDate !== "2026-08-09") invertedMinutes++;
    }
    expect(invertedMinutes).toBe(4 * 60); // 00:00–03:59 UTC of the next UTC day
    // The Pacific-dated caller saw the full 7 hours: the cycle passed a Pacific
    // today (17:00 PDT = 00:00 UTC), so its inverted window ran 17:00–23:59 PDT.
    const pacificDayStart = Date.parse("2026-08-09T07:00:00Z");
    let pacificInverted = 0;
    for (let minute = 0; minute < 24 * 60; minute++) {
      const instant = pacificDayStart + minute * 60_000;
      if (new Date(instant).toISOString().slice(0, 10) !== "2026-08-09")
        pacificInverted++;
    }
    expect(pacificInverted).toBe(7 * 60);
  });

  it("is stale when the run happened on a different Eastern day", async () => {
    const { isModelRunFreshForGameDate } = await import("./mlbModelRunner");
    // Modelled 2026-08-08 23:00 EDT for a 2026-08-09 game → stale, re-model.
    expect(
      isModelRunFreshForGameDate(
        Date.parse("2026-08-09T03:00:00Z"),
        "2026-08-09"
      )
    ).toBe(false);
    // Modelled 2026-08-10 00:30 EDT for a 2026-08-09 game → stale.
    expect(
      isModelRunFreshForGameDate(
        Date.parse("2026-08-10T04:30:00Z"),
        "2026-08-09"
      )
    ).toBe(false);
  });

  it("treats a non-finite modelRunAt as stale, never as fresh", async () => {
    const { isModelRunFreshForGameDate } = await import("./mlbModelRunner");
    expect(isModelRunFreshForGameDate(Number.NaN, "2026-08-09")).toBe(false);
    expect(isModelRunFreshForGameDate(Number(undefined), "2026-08-09")).toBe(
      false
    );
  });

  it("holds at the exact Eastern midnight boundaries", async () => {
    const { isModelRunFreshForGameDate } = await import("./mlbModelRunner");
    expect(
      isModelRunFreshForGameDate(
        Date.parse("2026-08-09T04:00:00Z"),
        "2026-08-09"
      )
    ).toBe(true);
    expect(
      isModelRunFreshForGameDate(
        Date.parse("2026-08-09T03:59:59Z"),
        "2026-08-09"
      )
    ).toBe(false);
    expect(
      isModelRunFreshForGameDate(
        Date.parse("2026-08-10T03:59:59Z"),
        "2026-08-09"
      )
    ).toBe(true);
    expect(
      isModelRunFreshForGameDate(
        Date.parse("2026-08-10T04:00:00Z"),
        "2026-08-09"
      )
    ).toBe(false);
  });

  it("holds across a DST transition inside the slate day", async () => {
    const { isModelRunFreshForGameDate } = await import("./mlbModelRunner");
    // Spring forward: 01:59 EST and 03:00 EDT are the same Eastern day.
    expect(
      isModelRunFreshForGameDate(
        Date.parse("2026-03-08T06:59:00Z"),
        "2026-03-08"
      )
    ).toBe(true);
    expect(
      isModelRunFreshForGameDate(
        Date.parse("2026-03-08T07:00:00Z"),
        "2026-03-08"
      )
    ).toBe(true);
    // Fall back: the repeated 01:30 local hour stays on the same Eastern day.
    expect(
      isModelRunFreshForGameDate(
        Date.parse("2026-11-01T05:30:00Z"),
        "2026-11-01"
      )
    ).toBe(true);
    expect(
      isModelRunFreshForGameDate(
        Date.parse("2026-11-01T06:30:00Z"),
        "2026-11-01"
      )
    ).toBe(true);
  });

  it("the shipped guard in runMlbModelForDate uses it (no second copy of the rule)", () => {
    const src = readSource("mlbModelRunner.ts");
    const body = functionBody(src, "export async function runMlbModelForDate(");
    expect(body).toContain("isModelRunFreshForGameDate(modelRunAtMs, dateStr)");
    // The replaced formula must not survive anywhere in the module.
    expect(countOccurrences(src, "toISOString()\n        .slice(0, 10)")).toBe(
      0
    );
    expect(countOccurrences(src, ".toISOString().slice(0, 10)")).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. SINGLE-FLIGHT — one job at a time, released on success and on failure
// ─────────────────────────────────────────────────────────────────────────────

describe("runMlbModelSyncJob single-flight", () => {
  afterEach(async () => {
    const { __setMlbModelSyncWorkForTest } = await import("./mlbModelRunner");
    __setMlbModelSyncWorkForTest(null);
  });

  it("a second concurrent call is skipped, not run", async () => {
    const { __setMlbModelSyncWorkForTest, runMlbModelSyncJob } =
      await import("./mlbModelRunner");
    let running = 0;
    let maxConcurrent = 0;
    let invocations = 0;
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      __setMlbModelSyncWorkForTest(async () => {
        invocations += 1;
        running += 1;
        maxConcurrent = Math.max(maxConcurrent, running);
        await new Promise(r => setTimeout(r, 40));
        running -= 1;
        return [];
      });

      const results = await Promise.all([
        runMlbModelSyncJob(),
        runMlbModelSyncJob(),
        runMlbModelSyncJob(),
      ]);

      expect(maxConcurrent).toBe(1);
      expect(invocations).toBe(1);
      expect(results.filter(r => r.ran)).toHaveLength(1);
      expect(results.filter(r => !r.ran)).toHaveLength(2);
    } finally {
      logSpy.mockRestore();
    }
  });

  it("a long-running job blocks the next tick rather than doubling the work", async () => {
    const { __setMlbModelSyncWorkForTest, runMlbModelSyncJob } =
      await import("./mlbModelRunner");
    let invocations = 0;
    let release!: () => void;
    const gate = new Promise<void>(r => {
      release = r;
    });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      __setMlbModelSyncWorkForTest(async () => {
        invocations += 1;
        await gate;
        return [];
      });
      const first = runMlbModelSyncJob();
      // Simulates the next 5-minute tick arriving while the slate is still
      // being modelled — the historical condition that produced overlapping
      // cycles in production.
      const second = await runMlbModelSyncJob();
      expect(second.ran).toBe(false);
      expect(invocations).toBe(1);
      release();
      expect((await first).ran).toBe(true);
      // …and once it settles, the following tick runs normally.
      const third = await runMlbModelSyncJob();
      expect(third.ran).toBe(true);
      expect(invocations).toBe(2);
    } finally {
      logSpy.mockRestore();
    }
  });

  it("releases the guard after the job throws", async () => {
    const { __setMlbModelSyncWorkForTest, runMlbModelSyncJob } =
      await import("./mlbModelRunner");
    let invocations = 0;
    __setMlbModelSyncWorkForTest(async () => {
      invocations += 1;
      throw new Error("db pool exhausted");
    });
    await expect(runMlbModelSyncJob()).rejects.toThrow("db pool exhausted");
    await expect(runMlbModelSyncJob()).rejects.toThrow("db pool exhausted");
    // The second call must reach the work — a wedged guard would have
    // short-circuited it to { ran: false } and stopped MLB modelling forever.
    expect(invocations).toBe(2);
  });

  it("releases the guard after the job succeeds", async () => {
    const { __setMlbModelSyncWorkForTest, runMlbModelSyncJob } =
      await import("./mlbModelRunner");
    let invocations = 0;
    __setMlbModelSyncWorkForTest(async () => {
      invocations += 1;
      return [];
    });
    expect((await runMlbModelSyncJob()).ran).toBe(true);
    expect((await runMlbModelSyncJob()).ran).toBe(true);
    expect(invocations).toBe(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. BOUNDED CPU CONCURRENCY — one engine subprocess, bounded queue
// ─────────────────────────────────────────────────────────────────────────────

describe("runWithMlbEngineSlot — CPU bound", () => {
  beforeEach(async () => {
    const { getMlbEngineQueueDepth } = await import("./mlbModelRunner");
    expect(getMlbEngineQueueDepth()).toBe(0);
  });

  it("runs at most one engine batch at a time", async () => {
    const { runWithMlbEngineSlot } = await import("./mlbModelRunner");
    let running = 0;
    let maxConcurrent = 0;
    await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        runWithMlbEngineSlot(`batch-${i}`, async () => {
          running += 1;
          maxConcurrent = Math.max(maxConcurrent, running);
          await new Promise(r => setTimeout(r, 5));
          running -= 1;
        })
      )
    );
    expect(maxConcurrent).toBe(1);
  });

  it("preserves FIFO order", async () => {
    const { runWithMlbEngineSlot } = await import("./mlbModelRunner");
    const order: number[] = [];
    await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        runWithMlbEngineSlot(`batch-${i}`, async () => {
          order.push(i);
          await new Promise(r => setTimeout(r, 1));
        })
      )
    );
    expect(order).toEqual([0, 1, 2, 3, 4]);
  });

  it("releases the slot when a batch throws", async () => {
    const { runWithMlbEngineSlot, getMlbEngineQueueDepth } =
      await import("./mlbModelRunner");
    await expect(
      runWithMlbEngineSlot("boom", async () => {
        throw new Error("python engine exited with code 1");
      })
    ).rejects.toThrow("python engine exited with code 1");
    expect(getMlbEngineQueueDepth()).toBe(0);
    let ran = false;
    await runWithMlbEngineSlot("after-boom", async () => {
      ran = true;
    });
    expect(ran).toBe(true);
  });

  it("rejects work past the queue bound instead of growing without limit", async () => {
    const {
      runWithMlbEngineSlot,
      MLB_ENGINE_MAX_QUEUE,
      getMlbEngineQueueDepth,
    } = await import("./mlbModelRunner");
    let release!: () => void;
    const gate = new Promise<void>(r => {
      release = r;
    });
    const held = Array.from({ length: MLB_ENGINE_MAX_QUEUE }, (_, i) =>
      runWithMlbEngineSlot(`held-${i}`, async () => {
        await gate;
      })
    );
    expect(getMlbEngineQueueDepth()).toBe(MLB_ENGINE_MAX_QUEUE);
    await expect(
      runWithMlbEngineSlot("overflow", async () => {})
    ).rejects.toThrow(/engine queue full/);
    release();
    await Promise.all(held);
    expect(getMlbEngineQueueDepth()).toBe(0);
    // The bound is a bound, not a latch: work is accepted again once drained.
    let ran = false;
    await runWithMlbEngineSlot("after-drain", async () => {
      ran = true;
    });
    expect(ran).toBe(true);
  });
});
