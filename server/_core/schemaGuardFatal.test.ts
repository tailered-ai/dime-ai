/**
 * SCHEMA_GUARD_FATAL — the branch that decides whether a bad deploy serves.
 *
 * Armed on the product service since 2026-08-08. A confirmed-stale schema now
 * exits the process, so the Railway healthcheck fails and the previous healthy
 * deployment keeps serving — which is what #370 (40 minutes of auth down) cost
 * when nothing did this.
 *
 * These are unit-level assertions on the DECISION. The terminal proof that the
 * operating-system process actually dies with a nonzero code lives in
 * `schemaGuardFatalExit.test.ts`, which spawns a real child process. A spy can
 * only ever prove the function was called; it cannot prove the process ended.
 *
 * TRAP, recorded so it is not rediscovered: `process.exit` is called INSIDE
 * assertSchemaCurrent, and the surrounding code path returns a value afterwards.
 * A stub that THROWS is therefore not a faithful model — assert on the spy.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

type DbStub = { execute: (q: unknown) => Promise<unknown> } | null;
let dbStub: DbStub = null;
const getDb = vi.fn(async () => dbStub);
vi.mock("../db", () => ({ getDb: () => getDb() }));

import { assertSchemaCurrent, REQUIRED_COLUMNS } from "./schemaGuard";

const DB_NAME = "dime_product";
const allRows = () =>
  Object.entries(REQUIRED_COLUMNS).flatMap(([t, cols]) =>
    cols.map(c => ({ t, c }))
  );
const db = (schemaRows: unknown, database: string | null = DB_NAME): DbStub => {
  let call = 0;
  return {
    execute: async () => {
      call += 1;
      if (call === 1) return [[{ databaseName: database }], []] as unknown;
      return schemaRows;
    },
  };
};

let savedFatal: string | undefined;
let exitSpy: ReturnType<typeof vi.spyOn>;
let errors: string[];

beforeEach(() => {
  savedFatal = process.env.SCHEMA_GUARD_FATAL;
  delete process.env.SCHEMA_GUARD_FATAL;
  delete process.env.ANALYTICS_ROLE;
  dbStub = null;
  getDb.mockClear();
  errors = [];
  vi.spyOn(console, "error").mockImplementation(
    (...a: unknown[]) => void errors.push(String(a[0]))
  );
  vi.spyOn(console, "log").mockImplementation(() => {});
  exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {}) as never);
});
afterEach(() => {
  vi.restoreAllMocks();
  if (savedFatal === undefined) delete process.env.SCHEMA_GUARD_FATAL;
  else process.env.SCHEMA_GUARD_FATAL = savedFatal;
});

describe("SCHEMA_GUARD_FATAL", () => {
  it("[SG-10] FATAL=1 + confirmed drift refuses to serve", async () => {
    process.env.SCHEMA_GUARD_FATAL = "1";
    dbStub = db(allRows().filter(r => r.t !== "payment_events"));

    await assertSchemaCurrent();

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errors.join("\n")).toContain(
      "refusing to serve with a stale schema"
    );
  });

  it("[SG-11] without FATAL, the same drift reports and keeps serving", async () => {
    dbStub = db(allRows().filter(r => r.t !== "payment_events"));

    const r = await assertSchemaCurrent();

    expect(r.status).toBe("fail");
    expect(exitSpy).not.toHaveBeenCalled();
    expect(errors.join("\n")).toContain("[VERIFY] FAIL");
  });

  it("[SG-12] an UNAVAILABLE verdict is never fatal, even with FATAL=1", async () => {
    // Fail-open. An unverifiable check must not decide that a healthy
    // deployment cannot serve — that would be a self-inflicted outage.
    process.env.SCHEMA_GUARD_FATAL = "1";
    dbStub = null;

    const r = await assertSchemaCurrent();

    expect(exitSpy).not.toHaveBeenCalled();
    expect(r.status).toBe("unavailable");
    expect(errors.join("\n")).toContain("[VERIFY] UNAVAILABLE");
    expect(errors.join("\n")).toContain("NOT a pass");
  });

  it("[SG-13] a valid read of an empty database IS fatal under FATAL=1", async () => {
    // Changed by the closeout. This used to be INCONCLUSIVE and non-fatal, so a
    // product service pointed at the wrong database served happily.
    process.env.SCHEMA_GUARD_FATAL = "1";
    dbStub = db([]);

    await assertSchemaCurrent();

    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("[SG-22] a malformed driver result is never fatal", async () => {
    process.env.SCHEMA_GUARD_FATAL = "1";
    dbStub = db({ rows: allRows() });

    const r = await assertSchemaCurrent();

    expect(exitSpy).not.toHaveBeenCalled();
    expect(r.status).toBe("unavailable");
  });

  it("[SG-14] the analytics store never exits, whatever FATAL says", async () => {
    process.env.SCHEMA_GUARD_FATAL = "1";
    process.env.ANALYTICS_ROLE = "store";
    dbStub = db([]);

    const r = await assertSchemaCurrent();

    expect(exitSpy).not.toHaveBeenCalled();
    expect(r.status).toBe("not_applicable");
    expect(getDb).not.toHaveBeenCalled();
  });

  it("[SG-23] a complete schema never exits", async () => {
    process.env.SCHEMA_GUARD_FATAL = "1";
    dbStub = db(allRows());

    const r = await assertSchemaCurrent();

    expect(exitSpy).not.toHaveBeenCalled();
    expect(r.status).toBe("pass");
  });
});
