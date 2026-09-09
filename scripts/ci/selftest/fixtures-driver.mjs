#!/usr/bin/env node
/**
 * fixtures-driver.mjs — P05.NEG07 driver: runs ONE real poison cycle in a
 * child process so the suite can interrupt it mid-flight and prove that an
 * incomplete cycle emits no proof and leaks no poison.
 *
 * Signal handling is P01's (`wireSignals`) and P04's (the executor's teardown
 * registry) — this driver adds none of its own.
 *
 * Usage: node fixtures-driver.mjs <fixture-id> <out-dir>
 * stdout protocol: {"marker":"CYCLE_STARTED"} then, only on completion,
 * {"marker":"DONE", verdict}.
 */
import path from "node:path";
import { wireSignals } from "../snapshot.mjs";
import {
  makeContext,
  runFixtureCycle,
  loadFixture,
  SEED_FIXTURES_ROOT,
  buildAssuranceArtifact,
  writeAssurance,
} from "./assurance.mjs";

const [fixtureId, outDir] = process.argv.slice(2);
if (!fixtureId || !outDir) {
  console.error("usage: fixtures-driver.mjs <fixture-id> <out-dir>");
  process.exit(2);
}

wireSignals((signal, failures) => {
  console.error(
    `[driver] ${signal}: teardown ${failures.length ? `FAILED ${failures.join("; ")}` : "complete"}`
  );
});

const ctx = makeContext();
const fixture = loadFixture(path.join(SEED_FIXTURES_ROOT, fixtureId));
console.log(JSON.stringify({ marker: "CYCLE_STARTED", fixture: fixture.id }));

const record = await runFixtureCycle(fixture, ctx);

// Emission is tied to CYCLE COMPLETION. An interrupted run never reaches
// here, so no artifact can exist for it (the DEF-014 lesson, reapplied).
const artifact = buildAssuranceArtifact({
  candidate: record.candidate ?? {},
  contract_sha256: ctx.contract_sha256,
  registry: ctx.registry,
  executor_sha256: ctx.executor_sha256,
  records: [record],
  coverage: null,
  execution_mode: "host",
  hermeticity: "HERMETIC:UNENFORCED",
  cleanup_state: "clean",
});
writeAssurance(outDir, artifact);
console.log(JSON.stringify({ marker: "DONE", verdict: record.verdict }));
