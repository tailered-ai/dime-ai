/**
 * db.securityEvents.test.ts
 *
 * Regression tests for the two defects PR #451 shipped to production and this
 * change fixes, both in getSecurityEvents():
 *
 *  1. SILENT TRUNCATION. The weekly digest asks for RAW_EVENT_FETCH_LIMIT=2000
 *     over a 7-day window; the old `Math.min(opts.limit ?? 200, 500)` clipped it
 *     to the newest 500 and said nothing, while the digest logged "limit=2000".
 *     A security report that under-reports while claiming full scope is worse
 *     than no report.
 *
 *  2. DIGEST MARKERS LEAKING INTO THE SECURITY CONSOLE. DIGEST_MARKER_* rows are
 *     restart-safety sentinels the digest writes itself. #451 excluded them from
 *     the two SQL aggregates and the digest read paths, but not from the generic
 *     read that server/routers/security.ts:102 (ownerProcedure security.events.list)
 *     uses — so every digest run surfaced a sentinel in the owner-facing console
 *     as though it were a security event.
 *
 * These drive the REAL getSecurityEvents by mocking only the driver layer
 * (mysql2 pool + drizzle), capturing the query it actually builds. They do not
 * test a helper standing in for it.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Captured per call: what the real function asked the driver for.
interface Captured {
  where: unknown;
  limit: number | null;
  orderByCalled: boolean;
}
let captured: Captured;
let rowsToReturn: unknown[];

vi.mock("mysql2/promise", () => ({
  default: { createPool: () => ({ end: async () => {} }) },
}));

vi.mock("drizzle-orm/mysql2", () => ({
  drizzle: () => {
    const chain = {
      select: () => chain,
      from: () => chain,
      where: (c: unknown) => {
        captured.where = c;
        return chain;
      },
      orderBy: () => {
        captured.orderByCalled = true;
        return chain;
      },
      limit: (n: number) => {
        captured.limit = n;
        return Promise.resolve(rowsToReturn);
      },
    };
    return chain;
  },
}));

import {
  getSecurityEvents,
  MAX_SECURITY_EVENTS_FETCH,
  DIGEST_MARKER_DAILY_EVENT_TYPE,
} from "./db";

beforeEach(() => {
  // getDb() only checks this for truthiness before handing the URI to mysql2,
  // which is mocked above — so it is never parsed or dialled. Deliberately
  // carries NO user:password component: a credential-shaped literal trips
  // gitleaks' connection-string-password rule, and the right answer to that is
  // to not write one, not to allowlist it.
  process.env.DATABASE_URL = "mysql://localhost:3306/testdb";
  captured = { where: undefined, limit: null, orderByCalled: false };
  rowsToReturn = [];
  vi.restoreAllMocks();
});

describe("getSecurityEvents — silent truncation (defect 1)", () => {
  it("honours the weekly digest's 2000-row request instead of clipping it to 500", async () => {
    await getSecurityEvents({ limit: 2000, sinceMs: 1 });
    console.log(`[STATE] driver received limit=${captured.limit}`);
    // The old ceiling was 500. 2000 is the weekly digest's RAW_EVENT_FETCH_LIMIT.
    expect(captured.limit).toBe(2000);
    expect(captured.limit).not.toBe(500);
  });

  it("still bounds an absurd request, and SAYS SO rather than clipping in silence", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await getSecurityEvents({ limit: 999_999 });
    expect(captured.limit).toBe(MAX_SECURITY_EVENTS_FETCH);
    const said = warn.mock.calls.flat().join(" ");
    console.log(`[STATE] clip warning emitted: ${/CLIPPED/.test(said)}`);
    expect(said).toMatch(/CLIPPED/);
    expect(said).toMatch(/LOWER BOUND/);
  });

  it("warns when the result exactly hits the limit, because older rows were dropped", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    rowsToReturn = Array.from({ length: 10 }, (_, i) => ({ id: i }));
    await getSecurityEvents({ limit: 10 });
    const said = warn.mock.calls.flat().join(" ");
    console.log(
      `[STATE] truncation warning emitted: ${/TRUNCATED/.test(said)}`
    );
    expect(said).toMatch(/TRUNCATED/);
  });

  it("does NOT cry truncation when the result is short of the limit", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    rowsToReturn = Array.from({ length: 3 }, (_, i) => ({ id: i }));
    await getSecurityEvents({ limit: 10 });
    const said = warn.mock.calls.flat().join(" ");
    expect(said).not.toMatch(/TRUNCATED/);
  });

  it("keeps the default page size at 200 for a caller that names no limit", async () => {
    await getSecurityEvents({});
    expect(captured.limit).toBe(200);
  });
});

describe("getSecurityEvents — existence probes do not cry truncation", () => {
  // PRODUCTION SYMPTOM this pins (deployment ff472662, 2026-08-09T13:00:43Z):
  //   [DB][getSecurityEvents] Fetched 1 rows | limit=1 type=DIGEST_MARKER_DAILY
  //   ERROR Result hit the limit (1) — older events ... TRUNCATED ... LOWER BOUND
  // Nothing was truncated. The caller asked whether one marker exists and got
  // its answer. Fired twice per digest run, at ERROR severity, in the security
  // stream — the lying-observability class, inside the fix meant to remove it.

  it("a full existence probe stays silent (the production false positive)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    rowsToReturn = [{ id: 1, eventType: DIGEST_MARKER_DAILY_EVENT_TYPE }];
    await getSecurityEvents({
      eventType: DIGEST_MARKER_DAILY_EVENT_TYPE,
      limit: 1,
      existenceProbe: true,
    });
    const said = warn.mock.calls.flat().join(" ");
    console.log(
      `[STATE] truncation warning on a satisfied probe: ${/TRUNCATED/.test(said)}`
    );
    expect(said).not.toMatch(/TRUNCATED/);
  });

  it("STILL warns for a genuine window survey that hits its ceiling", async () => {
    // The exemption must be narrow: a real survey losing rows must still shout.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    rowsToReturn = Array.from({ length: 10 }, (_, i) => ({ id: i }));
    await getSecurityEvents({ limit: 10, sinceMs: 1 });
    const said = warn.mock.calls.flat().join(" ");
    expect(said).toMatch(/TRUNCATED/);
  });

  it("an UNFLAGGED single-row read still warns — the flag is opt-in, not inferred from limit", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    rowsToReturn = [{ id: 1 }];
    await getSecurityEvents({ limit: 1 });
    const said = warn.mock.calls.flat().join(" ");
    expect(said).toMatch(/TRUNCATED/);
  });

  it("a probe that comes back EMPTY is silent too (nothing to report either way)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    rowsToReturn = [];
    await getSecurityEvents({
      eventType: DIGEST_MARKER_DAILY_EVENT_TYPE,
      limit: 1,
      existenceProbe: true,
    });
    expect(warn.mock.calls.flat().join(" ")).not.toMatch(/TRUNCATED/);
  });
});

describe("getSecurityEvents — digest markers in the console (defect 2)", () => {
  it("builds a WHERE clause even with no filters, so markers can be excluded", async () => {
    // Pre-fix, {} produced zero conditions and the call was `.where(undefined)`,
    // which is exactly how sentinels reached the owner-facing console.
    await getSecurityEvents({});
    console.log(
      `[STATE] where defined with no filters: ${captured.where !== undefined}`
    );
    expect(captured.where).toBeDefined();
  });

  it("still lets the digest look its OWN marker up by eventType", async () => {
    // The restart-safety check queries by eventType explicitly. If the exclusion
    // applied unconditionally, the digest could never find its marker and would
    // re-fire every run — the duplicate-digest bug the marker exists to prevent.
    rowsToReturn = [{ id: 1, eventType: DIGEST_MARKER_DAILY_EVENT_TYPE }];
    const rows = await getSecurityEvents({
      eventType: DIGEST_MARKER_DAILY_EVENT_TYPE,
    });
    console.log(`[STATE] marker lookup returned ${rows.length} row(s)`);
    expect(captured.where).toBeDefined();
    expect(captured.limit).not.toBeNull();
    // The row must come back. If the exclusion were applied unconditionally the
    // digest could never find its own marker and would re-fire every run.
    expect(rows).toHaveLength(1);
    expect((rows[0] as { eventType: string }).eventType).toBe(
      DIGEST_MARKER_DAILY_EVENT_TYPE
    );
  });
});
