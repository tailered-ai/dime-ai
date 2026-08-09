/**
 * The startup-order contract: the authoritative schema verdict resolves BEFORE
 * the server accepts traffic.
 *
 * WHAT WENT WRONG BEFORE. Until this closeout, `assertSchemaCurrent()` was
 * invoked fire-and-forget from the `listening` handler:
 *
 *     server.once("listening", () => onListening());   // -> assertSchemaCurrent().catch(...)
 *     server.listen(port);
 *
 * With SCHEMA_GUARD_FATAL=1 that means a confirmed-stale deployment starts
 * accepting requests and then exits underneath them. Railway may still fail the
 * healthcheck and roll back, but in the window between listen and exit the
 * broken build is serving. The narrow app_users probe already ran pre-listen;
 * the nine-table guard now has the same standing.
 *
 * WHAT THESE TESTS PROVE, precisely:
 *  - the behavioural half: runSchemaGuardPreflight resolves to a real verdict,
 *    and its timeout degrades to `unavailable` rather than to a pass;
 *  - the ordering half: index.ts awaits the preflight before server.listen, and
 *    no longer runs the guard from the listening handler.
 *
 * WHAT THEY DO NOT PROVE: that a booted container ordered its syscalls this way.
 * The ordering assertion is structural — but because both statements live in one
 * async function and the preflight is `await`ed, source order IS execution order
 * there. Mutation 6 in the closeout PR moves the call after listen and shows
 * [SO-3] going red.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

type DbStub = { execute: (q: unknown) => Promise<unknown> } | null;
let dbStub: DbStub = null;
const getDb = vi.fn(async () => dbStub);
vi.mock("../db", () => ({ getDb: () => getDb() }));

import { runSchemaGuardPreflight, REQUIRED_COLUMNS } from "./schemaGuard";

const allRows = () =>
  Object.entries(REQUIRED_COLUMNS).flatMap(([t, cols]) =>
    cols.map(c => ({ t, c }))
  );
const db = (rows: unknown): DbStub => {
  let call = 0;
  return {
    execute: async () => {
      call += 1;
      if (call === 1)
        return [[{ databaseName: "dime_product" }], []] as unknown;
      return rows;
    },
  };
};

const INDEX = readFileSync(resolve(__dirname, "index.ts"), "utf8");

beforeEach(() => {
  dbStub = null;
  getDb.mockClear();
  delete process.env.ANALYTICS_ROLE;
  delete process.env.SCHEMA_GUARD_FATAL;
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("runSchemaGuardPreflight — behaviour", () => {
  it("[SO-1] resolves to the real verdict rather than firing and forgetting", async () => {
    dbStub = db(allRows());

    const r = await runSchemaGuardPreflight();

    expect(r.status).toBe("pass");
  });

  it("[SO-2] a timeout degrades to UNAVAILABLE, never to a pass", async () => {
    // A cold TiDB must not wedge boot, and must not be mistaken for verified.
    dbStub = {
      execute: () => new Promise(() => {}), // never settles
    };

    const r = await runSchemaGuardPreflight(30);

    expect(r.status).toBe("unavailable");
    expect(r.status === "unavailable" && r.reason).toBe("inspection-failed");
    expect(r.status === "unavailable" && r.detail).toContain("exceeded 30ms");
  });

  it("[SO-2b] the analytics store resolves without touching the database", async () => {
    process.env.ANALYTICS_ROLE = "store";

    const r = await runSchemaGuardPreflight();

    expect(r.status).toBe("not_applicable");
    expect(getDb).not.toHaveBeenCalled();
  });
});

describe("startup ordering contract (server/_core/index.ts)", () => {
  it("[SO-3] the preflight is awaited BEFORE server.listen", () => {
    const preflight = INDEX.indexOf("await runSchemaGuardPreflight()");
    const listen = INDEX.indexOf("server.listen(port)");

    expect(preflight).toBeGreaterThan(-1);
    expect(listen).toBeGreaterThan(-1);
    expect(preflight).toBeLessThan(listen);
  });

  it("[SO-4] the guard is no longer invoked from the listening handler", () => {
    // The exact regression this closeout removes. onListening must not run the
    // schema guard at all.
    //
    // Comments are stripped first: this asserts on CODE. The handler carries a
    // note explaining where the guard moved to, and matching that prose would
    // be a false positive — the first draft of this test did exactly that.
    const onListening = INDEX.slice(
      INDEX.indexOf("const onListening = () =>"),
      INDEX.indexOf("reportBillingAlertTransport()")
    )
      .split("\n")
      .filter(line => !line.trim().startsWith("//"))
      .join("\n");

    expect(onListening).not.toContain("assertSchemaCurrent(");
    expect(onListening).not.toContain("runSchemaGuardPreflight(");
  });

  it("[SO-5] the narrow app_users probe still runs pre-listen too", () => {
    // Both controls are pre-listen; neither replaced the other.
    const boot = INDEX.indexOf("await runBootSchemaProbe()");
    const listen = INDEX.indexOf("server.listen(port)");

    expect(boot).toBeGreaterThan(-1);
    expect(boot).toBeLessThan(listen);
  });
});
