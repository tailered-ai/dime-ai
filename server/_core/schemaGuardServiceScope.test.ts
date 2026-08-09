/**
 * SchemaGuard result states — the full matrix, driven through assertSchemaCurrent.
 *
 * WHY THE MODEL CHANGED (closeout, 2026-08-09). Reproduced against baseline
 * 23aafc55a before any edit, three distinct conditions collapsed onto the same
 * `{ ok: true, drift: [] }`, and one of them printed the PASS banner:
 *
 *   getDb() -> null      => { ok:true, drift:[] }   and logged "[VERIFY] PASS"
 *   execute() throws     => { ok:true, drift:[] }   (warn only)
 *   malformed row shape  => { ok:true, drift:[] }   (warn only)
 *   valid read, 0 tables => INCONCLUSIVE, non-fatal even with FATAL=1
 *
 * So a boot that never reached a database announced a verified schema, and a
 * product service pointed at an empty or WRONG database was waved through as
 * merely unknown. The result is now a discriminated union — pass / fail /
 * unavailable / not_applicable — and no empty array carries hidden meaning.
 *
 * SERVICE SCOPING (the original reason this file exists) is preserved below.
 * Both Railway services run the same build; the analytics store points
 * DATABASE_URL at a database that owns none of these tables, and used to log
 * "[VERIFY] FAIL ... login, checkout, fulfilment will break" on every boot. That
 * scoping is by ROLE, never by drift shape — see [SG-6].
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

type DbStub = { execute: (q: unknown) => Promise<unknown> } | null;
let dbStub: DbStub = null;
let getDbThrows: Error | null = null;
const getDb = vi.fn(async () => {
  if (getDbThrows) throw getDbThrows;
  return dbStub;
});
vi.mock("../db", () => ({ getDb: () => getDb() }));

import {
  assertSchemaCurrent,
  compareSchema,
  REQUIRED_COLUMNS,
} from "./schemaGuard";

const DB_NAME = "dime_product";
const allRows = () =>
  Object.entries(REQUIRED_COLUMNS).flatMap(([t, cols]) =>
    cols.map(c => ({ t, c }))
  );

/**
 * Answers the two probes inspectSchema makes, in order: SELECT DATABASE(), then
 * information_schema. `database: null` models a connection with no schema
 * selected; `schemaRows` may be any shape, including a malformed one.
 */
const db = (opts: {
  database?: string | null;
  schemaRows?: unknown;
}): DbStub => {
  // `"database" in opts` rather than `??` — an EXPLICIT null is the case under
  // test (a connection with no schema selected), and `null ?? DB_NAME` would
  // quietly hand back the default and make [SG-18] vacuous.
  const database = "database" in opts ? opts.database : DB_NAME;
  let call = 0;
  return {
    execute: async () => {
      call += 1;
      if (call === 1) return [[{ databaseName: database }], []] as unknown;
      return "schemaRows" in opts ? opts.schemaRows : [];
    },
  };
};
const throwingDb = (msg: string): DbStub => ({
  execute: async () => {
    throw new Error(msg);
  },
});

const ENV_KEYS = [
  "ANALYTICS_ROLE",
  "USER_ACTIVITY_BACKEND_URL",
  "SCHEMA_GUARD_FATAL",
] as const;
let saved: Record<string, string | undefined> = {};
let logs: string[];
let errs: string[];

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  dbStub = null;
  getDbThrows = null;
  getDb.mockClear();
  logs = [];
  errs = [];
  vi.spyOn(console, "log").mockImplementation(
    (...a: unknown[]) => void logs.push(String(a[0]))
  );
  vi.spyOn(console, "error").mockImplementation(
    (...a: unknown[]) => void errs.push(String(a[0]))
  );
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k]!;
  }
});

const allOutput = () => [...logs, ...errs].join("\n");

describe("SchemaGuard — NOT_APPLICABLE (service scoping)", () => {
  it("[SG-1] the analytics store reports not_applicable and never touches the database", async () => {
    process.env.ANALYTICS_ROLE = "store";

    const r = await assertSchemaCurrent();

    expect(r.status).toBe("not_applicable");
    expect(r.drift).toEqual([]);
    expect(getDb).not.toHaveBeenCalled();
    expect(allOutput()).toContain("[VERIFY] N/A");
    expect(allOutput()).not.toContain("[VERIFY] PASS");
  });

  it("[SG-3] the FORWARDER — the real production app — is still fully guarded", async () => {
    process.env.USER_ACTIVITY_BACKEND_URL =
      "http://backend.railway.internal:8080";
    dbStub = db({ schemaRows: allRows() });

    const r = await assertSchemaCurrent();

    expect(r.status).toBe("pass");
    expect(getDb).toHaveBeenCalled();
  });

  it("[SG-4] the 'disabled' default is still guarded — only an EXPLICIT store opts out", async () => {
    dbStub = db({ schemaRows: allRows() });

    const r = await assertSchemaCurrent();

    expect(r.status).toBe("pass");
    expect(getDb).toHaveBeenCalled();
  });

  it("[SG-5] a lookalike role value does NOT open the escape hatch", async () => {
    process.env.ANALYTICS_ROLE = "storefront";
    dbStub = db({ schemaRows: allRows() });

    const r = await assertSchemaCurrent();

    expect(r.status).toBe("pass");
    expect(getDb).toHaveBeenCalled();
  });

  it("[SG-6] REGRESSION GUARD: a missing TABLE is still drift — the ledger miss stays loud", () => {
    // The tempting smaller fix was always "treat tableMissing as benign".
    // checkout_sessions and payment_events were MISSING ENTIRELY when their
    // migrations were skipped, and they swallow their own errors, so nothing
    // else would have said a word.
    const drift = compareSchema([], {
      checkout_sessions: ["id", "fulfillment"],
    });

    expect(drift).toHaveLength(1);
    expect(drift[0]).toMatchObject({
      table: "checkout_sessions",
      tableMissing: true,
    });
  });
});

describe("SchemaGuard — UNAVAILABLE (no trustworthy verdict)", () => {
  it("[SG-15] no database handle is UNAVAILABLE, never PASS", async () => {
    // The baseline defect in one line: this used to print the PASS banner.
    dbStub = null;

    const r = await assertSchemaCurrent();

    expect(r.status).toBe("unavailable");
    expect(r.status === "unavailable" && r.reason).toBe("no-database-handle");
    expect(allOutput()).toContain("[VERIFY] UNAVAILABLE");
    expect(allOutput()).not.toContain("[VERIFY] PASS");
  });

  it("[SG-16] getDb() throwing is UNAVAILABLE, never PASS", async () => {
    getDbThrows = new Error("pool exhausted");

    const r = await assertSchemaCurrent();

    expect(r.status).toBe("unavailable");
    expect(r.status === "unavailable" && r.reason).toBe("no-database-handle");
    expect(allOutput()).not.toContain("[VERIFY] PASS");
  });

  it("[SG-17] a failed inspection query is UNAVAILABLE, never PASS", async () => {
    dbStub = throwingDb("ECONNRESET");

    const r = await assertSchemaCurrent();

    expect(r.status).toBe("unavailable");
    expect(r.status === "unavailable" && r.reason).toBe("inspection-failed");
    expect(allOutput()).toContain("[VERIFY] UNAVAILABLE");
    expect(allOutput()).not.toContain("[VERIFY] PASS");
  });

  it("[SG-17b] a failure of the information_schema query specifically is UNAVAILABLE", async () => {
    // Distinct from [SG-17], and it exists because mutation M2 SURVIVED the
    // first draft of this suite. `throwingDb` throws on the FIRST probe
    // (SELECT DATABASE()), so the second catch — the one guarding the
    // information_schema read — had no coverage at all, and could have been
    // replaced with a fake complete schema without a single test noticing.
    let call = 0;
    dbStub = {
      execute: async () => {
        call += 1;
        if (call === 1) return [[{ databaseName: DB_NAME }], []] as unknown;
        throw new Error("information_schema denied");
      },
    };

    const r = await assertSchemaCurrent();

    expect(r.status).toBe("unavailable");
    expect(r.status === "unavailable" && r.reason).toBe("inspection-failed");
    expect(r.status === "unavailable" && r.detail).toContain(
      "information_schema denied"
    );
    expect(allOutput()).not.toContain("[VERIFY] PASS");
  });

  it("[SG-19b] an array of UNRECOGNIZED row objects is UNAVAILABLE, not zero rows", async () => {
    // The other coercion path. [SG-19] sends a non-array envelope, which is
    // rejected by the first shape guard; this sends a well-formed array whose
    // ROWS are unrecognized (raw information_schema casing), which reaches the
    // final guard. Coercing it to [] would read as total drift and, with the
    // flag armed, refuse to serve over nothing.
    dbStub = db({
      schemaRows: [{ TABLE_NAME: "app_users", COLUMN_NAME: "id" }],
    });

    const r = await assertSchemaCurrent();

    expect(r.status).toBe("unavailable");
    expect(r.status === "unavailable" && r.reason).toBe(
      "unrecognized-driver-result"
    );
    expect(allOutput()).not.toContain("[VERIFY] FAIL");
  });

  it("[SG-18] no selected schema context is UNAVAILABLE — this is what 'wrong place' looks like", async () => {
    dbStub = db({ database: null, schemaRows: [] });

    const r = await assertSchemaCurrent();

    expect(r.status).toBe("unavailable");
    expect(r.status === "unavailable" && r.reason).toBe("no-database-context");
    expect(allOutput()).not.toContain("[VERIFY] PASS");
  });

  it("[SG-19] an unrecognized driver envelope is UNAVAILABLE, not silently zero rows", async () => {
    // A COMPLETE, CORRECT schema in an envelope we do not recognize. The old
    // code coerced this to [] and would have called it total drift; coercing the
    // other way would call it PASS. Both are guesses. Refuse instead.
    dbStub = db({ schemaRows: { rows: allRows() } });

    const r = await assertSchemaCurrent();

    expect(r.status).toBe("unavailable");
    expect(r.status === "unavailable" && r.reason).toBe(
      "unrecognized-driver-result"
    );
    expect(allOutput()).not.toContain("[VERIFY] PASS");
  });
});

describe("SchemaGuard — FAIL (inspection succeeded, drift confirmed)", () => {
  it("[SG-7] a missing ledger table FAILS and names it", async () => {
    dbStub = db({
      schemaRows: allRows().filter(r => r.t !== "payment_events"),
    });

    const r = await assertSchemaCurrent();

    expect(r.status).toBe("fail");
    expect(r.drift).toContainEqual(
      expect.objectContaining({ table: "payment_events", tableMissing: true })
    );
    expect(allOutput()).toContain("[VERIFY] FAIL");
    expect(allOutput()).toContain("payment_events");
  });

  it("[SG-8] a missing COLUMN fails — the 2026-07-31 outage shape", async () => {
    dbStub = db({ schemaRows: allRows().filter(r => r.c !== "planPriceId") });

    const r = await assertSchemaCurrent();

    expect(r.status).toBe("fail");
    expect(r.drift).toContainEqual(
      expect.objectContaining({
        table: "app_users",
        tableMissing: false,
        missingColumns: ["planPriceId"],
      })
    );
  });

  it("[SG-20] a VALID read of an empty/wrong database is FAIL, not inconclusive", async () => {
    // The retired heuristic's blind spot. The schema context is proven non-null,
    // the query succeeded, and nothing is there: the product service is pointed
    // somewhere it must not serve from.
    dbStub = db({ schemaRows: [] });

    const r = await assertSchemaCurrent();

    expect(r.status).toBe("fail");
    expect(r.drift).toHaveLength(Object.keys(REQUIRED_COLUMNS).length);
    expect(allOutput()).toContain("[VERIFY] FAIL");
    expect(allOutput()).not.toContain("INCONCLUSIVE");
  });
});

describe("SchemaGuard — PASS (and only for a real pass)", () => {
  it("[SG-9] a complete schema passes, names the database, and is not N/A", async () => {
    dbStub = db({ schemaRows: allRows() });

    const r = await assertSchemaCurrent();

    expect(r.status).toBe("pass");
    expect(r.drift).toEqual([]);
    expect(r.status === "pass" && r.database).toBe(DB_NAME);
    expect(allOutput()).toContain("[VERIFY] PASS");
    expect(allOutput()).not.toContain("N/A");
    expect(allOutput()).not.toContain("UNAVAILABLE");
  });

  it("[SG-21] extra columns beyond the required set do not break PASS", async () => {
    dbStub = db({
      schemaRows: [...allRows(), { t: "app_users", c: "someNewColumn" }],
    });

    const r = await assertSchemaCurrent();

    expect(r.status).toBe("pass");
  });
});
