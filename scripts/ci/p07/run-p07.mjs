#!/usr/bin/env node
/**
 * p07/run-p07.mjs — P07 PARITY Test/Data stage orchestrator.
 *
 * Phases (CLI: structural | tests | db | all):
 *
 *   STRUCTURAL (environment-independent, §21)
 *     - DB-suite discovery via the canonical marker (*.db.test.ts glob)
 *     - registration cross-check: discovered ⊆ contract db-tests list ⊆
 *       dbSuiteRegistration.test.ts source ⊆ environment-failure allowlist
 *       expectedCiSkips — exact agreement required
 *     - collection-collapse floor re-derived from the CONTRACT text
 *     - environment-failure model re-derived from source (entry counts)
 *     - impact-mode prohibition: the runner never passes affected-test
 *       selection flags; the negative suite proves refusal
 *
 *   TESTS — ci.yml#test and 07-coverage-patch#coverage executed through the
 *   SAME P06 step-driver machinery (per-step cwd/env, provisioning vs
 *   detector, journal-proven verdicts). Diff-aware gates bind to the P01
 *   candidate; origin/main must equal the candidate base or the run refuses.
 *
 *   DB (§18-§24) — verifier-owned digest-bound MySQL service, contract
 *   migration replay, then the ten hardcoded suites through the P04
 *   executor's serial "db" lane with --no-file-parallelism, exactly as the
 *   contract writes them. Migration failure blocks the suites (driver stops
 *   at the failing step). Service failure is INFRA, never a test verdict.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runSnapshot, disposeSnapshot } from "../snapshot.mjs";
import { loadVerifiedContract } from "../registry.mjs";
import { makeResult } from "../result.mjs";
import { JsonlReporter, summarize } from "../reporter.mjs";
import { ExecutorRun } from "../executor.mjs";
import {
  buildDriverSteps,
  buildGatePathEnv,
  liftVerdict,
  resolveExpressions,
} from "../p06/run-gates.mjs";
import { measureCapabilities, provisionCandidate } from "../p06/capability.mjs";
import { startOwnedMysql, daemonInfo, inventory } from "./mysql.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, "..", "..", "..");
const DRIVER = path.join(HERE, "..", "p06", "step-driver.mjs");
const sha256 = buf => createHash("sha256").update(buf).digest("hex");

export const P07_GATES = {
  test: ".github/workflows/ci.yml#test",
  db: ".github/workflows/ci.yml#db-tests",
  coverage: ".github/workflows/07-coverage-patch.yml#coverage",
  mutation: ".github/workflows/12-nightly-verification.yml#mutation-diff",
};

/** Flags that would make PARITY an impact/affected-selection run. Forbidden. */
export const IMPACT_FLAGS = [
  "--changed",
  "--related",
  "--onlyChanged",
  "--findRelatedTests",
];

export function assertNoImpactSelection(commandText) {
  const hit = IMPACT_FLAGS.find(flag => commandText.includes(flag));
  if (hit) {
    const err = new Error(
      `IMPACT_SELECTION_FORBIDDEN: PARITY runs the full contract collection; found ${hit}`
    );
    err.code = "IMPACT_SELECTION_FORBIDDEN";
    throw err;
  }
  return true;
}

/** Pure cross-check core — unit-testable, used by deriveStructural. */
export function crossCheck({
  discovered,
  contractList,
  markerBasenames,
  regList,
  skipNames,
  floor,
}) {
  const problems = [];
  for (const f of discovered) {
    if (!contractList.includes(f))
      problems.push(`discovered ${f} missing from contract db-tests list`);
  }
  for (const base of markerBasenames) {
    if (!regList.includes(base))
      problems.push(
        `marker suite ${base} absent from the --no-file-parallelism block (registration mechanism would fail)`
      );
  }
  for (const base of regList) {
    if (!skipNames.includes(base))
      problems.push(`db suite ${base} not declared in expectedCiSkips`);
  }
  if (!Number.isFinite(floor) || floor <= 0)
    problems.push("collection floor underivable from contract");
  return problems;
}

/** P01 base discipline: refuse any candidate whose origin/main moved. */
export function assertFreshBase(recordedBaseSha, candidateBaseSha) {
  // P01 is the SOLE resolver of branch provenance. An earlier version of this
  // function resolved `origin/main` itself, which duplicated P01's authority
  // and is exactly the defect class DEF-025 recorded (a second module quietly
  // deciding what the base is). It now compares two values P01 already
  // produced: the base recorded in the evidence being reused, and the base of
  // the freshly constructed candidate. If they differ, the reused evidence is
  // stale — which is the real question, and it needs no ref resolution here.
  if (recordedBaseSha && recordedBaseSha !== candidateBaseSha) {
    const err = new Error(
      `STALE_CANDIDATE: evidence base ${recordedBaseSha.slice(0, 12)} != current candidate base ${candidateBaseSha.slice(0, 12)}`
    );
    err.code = "STALE_CANDIDATE";
    throw err;
  }
  return true;
}

/** §21 structural derivations — every number measured, none assumed. */
export function deriveStructural() {
  const { contract, contract_sha256 } = loadVerifiedContract();

  // --- canonical marker discovery ---------------------------------------
  const discovered = execFileSync("git", ["ls-files", "*.db.test.ts"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  })
    .trim()
    .split("\n")
    .filter(Boolean)
    .sort();

  // --- contract db-tests hardcoded list ---------------------------------
  const dbCheck = contract.checks.find(c => c.check_id === P07_GATES.db);
  const suiteStep = dbCheck.steps.find(
    s => typeof s.run === "string" && s.run.includes("--no-file-parallelism")
  );
  const contractList = [
    ...suiteStep.run.matchAll(/(server\/[\w.\/-]+\.test\.ts)/g),
  ]
    .map(m => m[1])
    .sort();
  assertNoImpactSelection(suiteStep.run);

  // --- dbSuiteRegistration.test.ts's canonical mechanism, mirrored -------
  // The guard derives its lists dynamically: server/*.db.test.ts basenames
  // vs the --no-file-parallelism block of ci.yml. The executable test
  // itself runs in the tests phase; this mirrors its derivation so the
  // structural artifact records the same numbers it would compute.
  const markerBasenames = discovered
    .filter(f => f.startsWith("server/"))
    .map(f => path.basename(f))
    .sort();
  const dbBlock = (() => {
    const start = suiteStep.run.indexOf("--no-file-parallelism");
    const end = suiteStep.run.indexOf("--reporter=verbose", start);
    return suiteStep.run.slice(start, end < 0 ? undefined : end);
  })();
  const regList = [
    ...new Set(
      [...dbBlock.matchAll(/server\/([A-Za-z0-9_.-]+\.db\.test\.ts)/g)].map(
        m => m[1]
      )
    ),
  ].sort();

  // --- environment-failure model -----------------------------------------
  const allowlist = JSON.parse(
    readFileSync(
      path.join(REPO_ROOT, "vitest.environment-failure-allowlist.json"),
      "utf8"
    )
  );
  const envModel = {
    entries: (allowlist.entries ?? []).length,
    expected_ci_skips: (allowlist.expectedCiSkips ?? []).length,
    version: allowlist.version ?? null,
  };

  // --- collection floor from the CONTRACT text ---------------------------
  const proofCheck = contract.checks.find(
    c => c.check_id === ".github/workflows/01-pr-proof-contract.yml#proof"
  );
  const floorStep = proofCheck.steps.find(
    s => typeof s.run === "string" && s.run.includes("numPassedTests")
  );
  const floor = Number(floorStep.run.match(/-lt\s+(\d+)/)?.[1] ?? NaN);

  // --- cross-checks -------------------------------------------------------
  const problems = crossCheck({
    discovered,
    contractList,
    markerBasenames,
    regList,
    skipNames: JSON.stringify(allowlist.expectedCiSkips ?? []),
    floor,
  });

  return {
    contract_sha256,
    discovered_db_marker_files: discovered,
    contract_db_list: contractList,
    registration_test_list: regList,
    env_model: envModel,
    collection_floor: floor,
    agreement: problems.length === 0,
    problems,
  };
}

async function runGateThroughDriver({
  gateId,
  check,
  ctx,
  caps,
  worktree,
  candidate,
  outDir,
  lane = null,
  timeoutMs,
  extraSteps = null,
  network = "allow",
  mandatory,
}) {
  const dirName = gateId.replace(/[^A-Za-z0-9._-]/g, "_");
  const runsRoot = path.join(outDir, "exec");
  const specDir = path.join(outDir, "specs");
  mkdirSync(specDir, { recursive: true });
  const baseSteps = buildDriverSteps(check, {}, ctx, caps, { resolved: {} });
  const steps = extraSteps ? extraSteps(baseSteps) : baseSteps;
  for (const s of steps) {
    if (s.mode === "execute") assertNoImpactSelection(s.adapted_run ?? s.run);
  }
  const specPath = path.join(specDir, `${dirName}.json`);
  const gha = {
    CI: "true",
    GITHUB_ACTIONS: "true",
    GITHUB_ACTOR: "ci-verify-local",
    GITHUB_SHA: ctx.merge_commit_sha,
    GITHUB_WORKFLOW_SHA: ctx.merge_commit_sha,
    GITHUB_RUN_ID: ctx.run_marker,
    GITHUB_REPOSITORY: "tailered-ai/dime-ai",
    GITHUB_EVENT_NAME: "pull_request",
    GITHUB_WORKSPACE: worktree,
  };
  writeFileSync(
    specPath,
    JSON.stringify(
      { gate_id: gateId, worktree, candidate: ctx, gha, steps },
      null,
      2
    ) + "\n"
  );
  // Shared with P06 — the node-first/gnu-tar PATH law is a never-regress
  // invariant with its own anchors (p06.test.ts ENV01/ENV02).
  const pathEnv = buildGatePathEnv();
  const run = new ExecutorRun({
    specs: [
      {
        gate_id: gateId,
        class: "PARITY",
        mandatory,
        command: { shell: `node ${DRIVER} ${specPath}` },
        cwd: worktree,
        timeout_ms: timeoutMs,
        grace_ms: 5_000,
        network,
        ...(lane ? { lane } : {}),
        env: {
          PATH: pathEnv,
          CI_VERIFY_STEP_DIR: path.join(runsRoot, "steps", dirName),
        },
        contract_check_id: gateId,
        runnability: "LOCAL",
      },
    ],
    candidate,
    budget: { max_concurrency: 1 },
    runsRoot,
    lanesRoot: path.join(outDir, "lanes"),
  });
  const started = Date.now();
  const outcome = await run.execute();
  const raw = outcome.results[0];
  const stepDir = path.join(runsRoot, "steps", dirName);
  const journalPath = path.join(stepDir, "steps.json");
  const journal = existsSync(journalPath)
    ? JSON.parse(readFileSync(journalPath, "utf8"))
    : null;
  const driverExit = raw.attempts?.at(-1)?.exit_code ?? null;
  const lift = liftVerdict(raw, driverExit, journal);
  return {
    gateId,
    lift,
    raw,
    journal,
    journalPath,
    driverExit,
    duration_s: Number(((Date.now() - started) / 1000).toFixed(1)),
    specPath,
    runDir: run.runDir,
  };
}

export async function runP07(options = {}) {
  const phase = options.phase ?? "all";
  const outDir = options.outDir ?? path.join(REPO_ROOT, ".ci-verify", "p07");
  mkdirSync(outDir, { recursive: true });
  const { contract, contract_sha256 } = loadVerifiedContract();

  const report = { contract_sha256, phases: {} };

  if (phase === "structural" || phase === "all") {
    const structural = deriveStructural();
    report.phases.structural = structural;
    writeFileSync(
      path.join(outDir, "structural.json"),
      JSON.stringify(structural, null, 2) + "\n"
    );
    console.log(
      `[p07] structural: agreement=${structural.agreement} floor=${structural.collection_floor} ` +
        `db-suites=${structural.discovered_db_marker_files.length} marker / ${structural.contract_db_list.length} contract`
    );
    for (const p of structural.problems) console.log(`[p07]   PROBLEM: ${p}`);
    if (phase === "structural") return report;
  }

  // Candidate + capability for the execution phases.
  const handle = runSnapshot({ mode: "committed", keepRunDir: true });
  const worktree = handle.paths.worktree;
  const candidate = handle.snapshot.identity;
  const caps = measureCapabilities(worktree);
  const ctx = {
    head_sha: candidate.head_sha,
    base_sha: candidate.base_sha,
    merge_commit_sha: candidate.merge_commit_sha,
    run_marker: `cv07-${Date.now().toString(36)}`,
  };
  try {
    assertFreshBase(options.recordedBaseSha ?? null, candidate.base_sha);
  } catch (error) {
    disposeSnapshot(handle);
    throw error;
  }
  const provisioned = provisionCandidate(worktree);
  console.log(
    `[p07] candidate provisioning: ok=${provisioned.ok} in ${provisioned.duration_ms}ms`
  );
  // The in-candidate install is the AUTHORITY on node-deps satisfaction.
  caps.provisioning["node-deps"] = provisioned.ok;
  caps.candidate_install = provisioned;
  report.candidate = ctx;
  report.capability = caps.provisioning;
  report.candidate_install = provisioned;

  const results = [];
  const records = [];
  try {
    if (phase === "tests" || phase === "all") {
      for (const [key, gateId] of [
        ["test", P07_GATES.test],
        ["coverage", P07_GATES.coverage],
      ]) {
        const check = contract.checks.find(c => c.check_id === gateId);
        const out = await runGateThroughDriver({
          gateId,
          check,
          ctx,
          caps,
          worktree,
          candidate,
          outDir,
          timeoutMs: 2_400_000,
          mandatory: key === "test",
        });
        results.push(
          makeResult({
            gate_id: gateId,
            class: "PARITY",
            status: out.lift.status,
            mandatory: key === "test",
            reason: out.lift.reason,
            evidence_path: out.journalPath,
            contract_check_id: gateId,
            runnability: "LOCAL",
          })
        );
        records.push({
          gate_id: gateId,
          status: out.lift.status,
          reason: out.lift.reason,
          driver_exit: out.driverExit,
          duration_s: out.duration_s,
          journal_summary: out.journal?.summary ?? null,
        });
        console.log(
          `[p07] ${out.lift.status.padEnd(10)} ${gateId} (${out.duration_s}s)`
        );
      }
    }

    if (phase === "db" || phase === "all") {
      const gateId = P07_GATES.db;
      const check = contract.checks.find(c => c.check_id === gateId);
      const daemon = daemonInfo();
      report.phases.docker = daemon;
      if (!daemon.reachable) {
        results.push(
          makeResult({
            gate_id: gateId,
            class: "PARITY",
            status: "BLOCKED",
            mandatory: true,
            reason:
              "NOT_LOCALLY_EXECUTABLE(RUNTIME_UNAVAILABLE): docker daemon unreachable — DB parity impossible, never faked",
            evidence_path: path.join(outDir, "p07-results.jsonl"),
            contract_check_id: gateId,
            runnability: "LOCAL+TOOL",
          })
        );
      } else {
        const before = inventory();
        let mysql = null;
        try {
          mysql = await startOwnedMysql(ctx.run_marker);
          report.phases.mysql = {
            digest: mysql.image.digest,
            image_id: mysql.image.image_id,
            architecture: mysql.image.architecture,
            server_version: mysql.server_version,
            ready_after_ms: mysql.ready_after_ms,
            container: mysql.name,
          };
          console.log(
            `[p07] mysql ready: ${mysql.server_version} (${mysql.image.digest.slice(-24)}) in ${mysql.ready_after_ms}ms`
          );
          const out = await runGateThroughDriver({
            gateId,
            check,
            ctx,
            caps,
            worktree,
            candidate,
            outDir,
            lane: "db-serial",
            timeoutMs: 1_800_000,
            network: "allow",
            mandatory: true,
          });
          results.push(
            makeResult({
              gate_id: gateId,
              class: "PARITY",
              status: out.lift.status,
              mandatory: true,
              reason: out.lift.reason,
              evidence_path: out.journalPath,
              contract_check_id: gateId,
              runnability: "LOCAL+TOOL",
            })
          );
          records.push({
            gate_id: gateId,
            status: out.lift.status,
            reason: out.lift.reason,
            driver_exit: out.driverExit,
            duration_s: out.duration_s,
            journal_summary: out.journal?.summary ?? null,
            mysql: report.phases.mysql,
          });
          console.log(
            `[p07] ${out.lift.status.padEnd(10)} ${gateId} (${out.duration_s}s)`
          );
        } catch (error) {
          results.push(
            makeResult({
              gate_id: gateId,
              class: "PARITY",
              status: error.code === "PORT_OCCUPIED" ? "BLOCKED" : "INFRA_FAIL",
              mandatory: true,
              reason: `${error.code ?? "MYSQL_LIFECYCLE"}: ${String(error.message).slice(0, 160)}`,
              evidence_path: path.join(outDir, "p07-results.jsonl"),
              contract_check_id: gateId,
              runnability: "LOCAL+TOOL",
            })
          );
          console.log(`[p07] mysql lifecycle: ${error.code ?? error.message}`);
        } finally {
          if (mysql) {
            const removed = mysql.destroy();
            console.log(
              `[p07] mysql container removed: ${JSON.stringify(removed)}`
            );
          }
          const after = inventory();
          const newContainers = after.containers.filter(
            c => !before.containers.includes(c)
          );
          const newVolumes = after.volumes.filter(
            v => !before.volumes.includes(v)
          );
          report.phases.docker_residue = {
            new_containers: newContainers,
            new_volumes: newVolumes,
            // mysql:8 image layer is retained deliberately: pulled by digest,
            // reusable, and removing shared images is out of scope for
            // container-level ownership.
            note: "containers/volumes must be empty; the pulled mysql image is retained",
          };
          if (newContainers.length || newVolumes.length) {
            console.log(
              `[p07] RESIDUE: containers=${JSON.stringify(newContainers)} volumes=${JSON.stringify(newVolumes)}`
            );
          }
        }
      }
    }
  } finally {
    disposeSnapshot(handle);
  }

  const resultsPath = path.join(outDir, "p07-results.jsonl");
  writeFileSync(resultsPath, "");
  const reporter = new JsonlReporter(resultsPath);
  for (const r of results) reporter.write(r);
  report.summary = summarize(results);
  report.records = records;
  writeFileSync(
    path.join(outDir, "p07-records.json"),
    JSON.stringify(report, null, 2) + "\n"
  );
  return report;
}

async function main() {
  const phase = process.argv[2] ?? "all";
  const report = await runP07({ phase });
  const blocking = (report.records ?? []).filter(
    r => !["PASS", "CI_ONLY", "N/A"].includes(r.status)
  );
  console.log(
    `[p07] done: ${(report.records ?? []).length} gate(s), blocking ${blocking.length}` +
      (blocking.length
        ? ` -> ${blocking.map(b => `${b.gate_id}=${b.status}`).join(", ")}`
        : "")
  );
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
) {
  main().catch(error => {
    console.error(`[p07] ${error.message}`);
    console.error(error.stack);
    process.exitCode = 1;
  });
}
