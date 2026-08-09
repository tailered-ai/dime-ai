/**
 * Child-process fixture for the SchemaGuard fatal proof. Spawned by
 * `schemaGuardFatalExit.test.ts`; never imported by production code.
 *
 * Its whole reason to exist is that `process.exit` cannot be proven by a spy.
 * A spy shows the function was CALLED. Only a real process can show that the
 * operating system reaped it with a nonzero status — which is the property
 * Railway's healthcheck actually depends on.
 *
 * The database is injected through assertSchemaCurrent's inspector seam, so no
 * real connection is opened and nothing here can touch production.
 *
 * Scenario is chosen by SCHEMA_GUARD_TEST_SCENARIO.
 */
import {
  assertSchemaCurrent,
  runSchemaGuardPreflight,
  REQUIRED_COLUMNS,
  type inspectSchema,
} from "../schemaGuard";

const DB_NAME = "dime_product_fixture";
const allRows = () =>
  Object.entries(REQUIRED_COLUMNS).flatMap(([t, cols]) =>
    cols.map(c => ({ t, c }))
  );

type Inspector = typeof inspectSchema;

const scenarios: Record<string, Inspector> = {
  // Confirmed drift: one guarded ledger table absent, inspection healthy.
  drift: async () => ({
    status: "ok",
    database: DB_NAME,
    rows: allRows().filter(r => r.t !== "payment_events"),
  }),
  // Verified clean.
  clean: async () => ({
    status: "ok",
    database: DB_NAME,
    rows: allRows(),
  }),
  // No trustworthy verdict.
  unavailable: async () => ({
    status: "unavailable",
    reason: "no-database-handle",
  }),
  // Valid read of an empty/wrong database — confirmed, so fatal.
  empty: async () => ({ status: "ok", database: DB_NAME, rows: [] }),
  // Confirmed drift that arrives AFTER the preflight timeout. Used with
  // SCHEMA_GUARD_MODE=preflight to prove the loser of the race cannot kill the
  // process — the defect found reviewing 0a0c43621.
  "slow-drift": async () => {
    await new Promise(r => setTimeout(r, 400));
    return {
      status: "ok",
      database: DB_NAME,
      rows: allRows().filter(r => r.t !== "payment_events"),
    };
  },
};

async function main(): Promise<void> {
  const name = process.env.SCHEMA_GUARD_TEST_SCENARIO ?? "clean";
  const inspector = scenarios[name];
  if (!inspector) {
    console.error(`unknown scenario: ${name}`);
    process.exit(64);
  }

  // `preflight` exercises the bounded boot path; anything else the unbounded one.
  const result =
    process.env.SCHEMA_GUARD_MODE === "preflight"
      ? await runSchemaGuardPreflight(
          Number(process.env.SCHEMA_GUARD_TEST_TIMEOUT_MS ?? 50),
          inspector
        )
      : await assertSchemaCurrent(inspector);

  // Stay alive past the losing inspection so a delayed exit would be observed
  // rather than raced against process teardown.
  if (process.env.SCHEMA_GUARD_MODE === "preflight") {
    await new Promise(r => setTimeout(r, 600));
    console.log("CHILD_SURVIVED_PAST_LOSER=1");
  }

  // Only reached when the guard did NOT exit. Printing the status lets the test
  // distinguish "continued because unavailable" from "continued because pass".
  console.log(`CHILD_RESULT_STATUS=${result.status}`);
  console.log("CHILD_REACHED_END=1");
}

void main();
