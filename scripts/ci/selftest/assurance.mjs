#!/usr/bin/env node
/**
 * assurance.mjs — P05.T03 (canonical ASSURANCE runner), P05.T04 (exact
 * expected-gate enforcement), P05.T05 (exact expected-reason enforcement),
 * P05.T07 (assurance.json + sha256).
 *
 * The runner is a THIN ORCHESTRATION over the accepted control plane:
 *   - P01 `runSnapshot`/`disposeSnapshot` own candidates and worktrees;
 *   - P02's frozen contract owns every command that executes;
 *   - P03 owns statuses, results, and summaries;
 *   - P04 `ExecutorRun` owns execution, environment, timeouts, teardown.
 * It adds NO snapshot machinery, NO YAML parsing, NO taxonomy, NO executor.
 *
 * A fixture proof is valid ONLY when the whole chain holds:
 *   pristine control state -> poison applied EXACTLY as declared -> the ONE
 *   intended gate executed through P04 -> it rejected with the declared
 *   status -> the declared reason signature matched -> restoration proven
 *   byte-for-byte -> the SAME gate returned to its declared healthy state ->
 *   zero owned residue. Anything less is BROKEN_GATE(<subcode>), which
 *   reduces to VERIFIER_BROKEN through the frozen P03 semantics.
 */
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { runSnapshot, disposeSnapshot } from "../snapshot.mjs";
import { loadVerifiedContract, buildParityRegistry } from "../registry.mjs";
import { makeResult } from "../result.mjs";
import { ExecutorRun } from "../executor.mjs";
import { safeRemoveOwned } from "../teardown.mjs";
import {
  loadFixture,
  validateAgainstRegistry,
  discoverFixtures,
} from "./fixture.mjs";
import { validateFixtureStorage } from "./placement.mjs";

export const ASSURANCE_SCHEMA_VERSION = "1.0.0";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, "..", "..", "..");
export const SEED_FIXTURES_ROOT = path.join(HERE, "fixtures");

/**
 * The closed subcode vocabulary for BROKEN_GATE assurance verdicts (§26:
 * structured reasons BENEATH the canonical status, never a second taxonomy).
 */
export const BROKEN_SUBCODES = [
  "WRONG_TARGET", // poison did not trip the intended gate
  "WRONG_REASON", // gate went red, but not via the intended detector
  "NOT_A_DETECTOR_RESULT", // BLOCKED/TIMEOUT/INFRA_FAIL/INCONCLUSIVE/... noise
  "NON_RESTORING", // candidate did not return to byte-identical control
  "CONTROL_RED", // bytes restored but the control run stayed red
  "CONTROL_FLAKY", // control produced FLAKY — assurance cannot rest on it
  "PATCH_MISMATCH", // poison did not land exactly as declared
  "LIVE_POISON_FIXTURE", // placement law violated (verifier-safety failure)
  "INVALID_FIXTURE", // structural/contract validation failed
  "UNPROVEN", // mandatory gate lacking a valid proof (coverage law)
  "INCOMPLETE_CYCLE", // interrupted/partial cycle can never prove anything
];

export class AssuranceError extends Error {
  constructor(reason, detail = {}) {
    super(reason);
    this.name = "AssuranceError";
    this.reason = reason;
    Object.assign(this, detail);
  }
}

const sha256 = buf => createHash("sha256").update(buf).digest("hex");

function git(worktree, args) {
  return execFileSync("git", ["-C", worktree, ...args], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
}

/** Tracked-state porcelain, split into sorted path lists. */
function worktreeState(worktree) {
  const lines = git(worktree, ["status", "--porcelain=v1"])
    .split("\n")
    .filter(Boolean);
  const tracked = [];
  const untracked = [];
  for (const line of lines) {
    const p = line.slice(3);
    if (line.startsWith("??")) untracked.push(p);
    else tracked.push(p);
  }
  return { tracked: tracked.sort(), untracked: untracked.sort() };
}

function hashPaths(worktree, paths) {
  const out = {};
  for (const rel of paths) {
    const abs = path.join(worktree, rel);
    out[rel] = existsSync(abs) ? sha256(readFileSync(abs)) : null;
  }
  return out;
}

/**
 * P05.T05 — reason-signature matching over the STRUCTURED evidence P04
 * produced: the P03 result reason, the separate stdout/stderr captures, and
 * (for gates that write reports) a declared worktree artifact.
 */
export function matchReasons(reasons, sources) {
  const outcomes = reasons.map(pattern => {
    const regex = new RegExp(pattern.regex, pattern.flags ?? "");
    let text;
    if (pattern.source === "stdout") text = sources.stdout;
    else if (pattern.source === "stderr") text = sources.stderr;
    else if (pattern.source === "result_reason") text = sources.result_reason;
    else {
      const abs = path.join(sources.worktree, pattern.artifact_path);
      text = existsSync(abs) ? readFileSync(abs, "utf8") : "";
    }
    return {
      source: pattern.source,
      artifact_path: pattern.artifact_path ?? null,
      regex: pattern.regex,
      matched: regex.test(text ?? ""),
    };
  });
  return { matched: outcomes.every(o => o.matched), outcomes };
}

/**
 * Execute exactly ONE contract gate inside the candidate worktree, through
 * the canonical P04 pathway. The command text is the CONTRACT'S OWN step
 * text, executed under the GHA-default shell.
 */
async function executeGate(binding, fixture, worktree, ctx, leg) {
  const gateEnv = {
    // The candidate worktree carries no node_modules; the repository's
    // installed toolchain resolves via PATH. Recorded in the env profile.
    PATH: `${path.join(REPO_ROOT, "node_modules", ".bin")}:${process.env.PATH}`,
    // Contract-owned step env (e.g. the typecheck step's NODE_OPTIONS)
    // travels with the contract command, never invented by the fixture.
    ...binding.step_env,
    ...(fixture.expect.env ?? {}),
  };
  const run = new ExecutorRun({
    specs: [
      {
        gate_id: fixture.expect.expected_gate,
        class: fixture.expect.target_class,
        mandatory: true,
        command: { shell: binding.command },
        cwd: worktree,
        timeout_ms: fixture.expect.timeout_ms ?? 300_000,
        grace_ms: 2_000,
        env: gateEnv,
        node_options: fixture.expect.node_options ?? null,
        contract_check_id: fixture.expect.target_contract_id,
        runnability: binding.entry.runnability,
      },
    ],
    candidate: ctx.candidate,
    budget: { max_concurrency: 1 },
    runsRoot: path.join(ctx.scratchRoot, "exec", fixture.id, leg),
    lanesRoot: path.join(ctx.scratchRoot, "lanes"),
  });
  const outcome = await run.execute();
  const result = outcome.results[0];
  const gateDirName = fixture.expect.expected_gate.replace(
    /[^A-Za-z0-9._-]/g,
    "_"
  );
  const read = name => {
    const file = path.join(run.gatesDir, gateDirName, name);
    return existsSync(file) ? readFileSync(file, "utf8") : "";
  };
  return {
    result,
    stdout: read("attempt-1.stdout"),
    stderr: read("attempt-1.stderr"),
    run_dir: run.runDir,
    manifest: outcome.manifest,
  };
}

function broken(fixture, subcode, detail, extra = {}) {
  return {
    fixture_id: fixture.id,
    expected_gate: fixture.expect.expected_gate,
    verdict: "BROKEN_GATE",
    subcode,
    detail,
    ...extra,
  };
}

/**
 * P05.T03 — one full poison/control cycle for one fixture. Returns a
 * structured proof record; NEVER throws for an assurance failure (those are
 * verdicts); throws only for caller-contract violations.
 */
export async function runFixtureCycle(fixture, ctx) {
  // 0. Placement law FIRST — before any candidate exists (P05.T02/NEG04).
  try {
    validateFixtureStorage(fixture.dir, { repoRoot: ctx.repoRoot });
  } catch (error) {
    return broken(fixture, "LIVE_POISON_FIXTURE", error.reason, {
      placement: { ...error },
    });
  }
  // Contract binding (P05.T04 precondition: exact, unambiguous target).
  let binding;
  try {
    binding = validateAgainstRegistry(fixture, ctx.registry, ctx.contract);
  } catch (error) {
    return broken(fixture, "INVALID_FIXTURE", error.reason, {
      validation: { ...error },
    });
  }

  // 1-2. Fresh disposable candidate via the P01-owned machinery.
  // fetch:false — self-test cycles verify FIXTURE machinery against a
  // hermetic snapshot; base freshness is P01/issuance business. With the
  // default fetch, parallel suite files fetch concurrently and collide on
  // git's lock (INFRA-FAIL(BASE_FETCH_FAILED) inside P05.TEST04 — DEF-066).
  const handle = runSnapshot({
    mode: "committed",
    keepRunDir: true,
    fetch: false,
  });
  const worktree = handle.paths.worktree;
  // Every gate execution in this cycle binds to THIS cycle's candidate.
  ctx = { ...ctx, candidate: handle.snapshot.identity };
  const record = {
    fixture_id: fixture.id,
    expected_gate: fixture.expect.expected_gate,
    expected_status: fixture.expect.expected_status,
    applicability: fixture.expect.applicability,
    patch_sha256: fixture.patch_sha256,
    candidate: handle.snapshot.identity,
    worktree_disposed: false,
  };
  try {
    // 3. Pristine control state.
    const pristine = worktreeState(worktree);
    if (pristine.tracked.length || pristine.untracked.length) {
      return broken(fixture, "INVALID_FIXTURE", "candidate not pristine", {
        pristine,
      });
    }
    // 5. Pre-poison hashes of the declared paths.
    record.pre_poison_hashes = hashPaths(worktree, fixture.changed_paths);

    // 6-7. Apply poison INSIDE the candidate only; prove it landed exactly.
    try {
      execFileSync(
        "git",
        ["-C", worktree, "apply", "--whitespace=nowarn", fixture.patch_path],
        { encoding: "utf8" }
      );
    } catch (error) {
      return broken(fixture, "PATCH_MISMATCH", "poison patch did not apply", {
        stderr: String(error.stderr ?? error.message).slice(0, 2000),
      });
    }
    const poisoned = worktreeState(worktree);
    const actualChanged = [...poisoned.tracked, ...poisoned.untracked].sort();
    if (
      JSON.stringify(actualChanged) !== JSON.stringify(fixture.changed_paths)
    ) {
      return broken(
        fixture,
        "PATCH_MISMATCH",
        "changed-path set differs from the declaration",
        { expected: fixture.changed_paths, actual: actualChanged }
      );
    }
    record.post_poison_hashes = hashPaths(worktree, fixture.changed_paths);
    if (
      JSON.stringify(record.pre_poison_hashes) ===
      JSON.stringify(record.post_poison_hashes)
    ) {
      return broken(fixture, "PATCH_MISMATCH", "poison changed zero bytes");
    }

    // 8-9. Run ONLY the intended gate through P04.
    const poisonRun = await executeGate(
      binding,
      fixture,
      worktree,
      ctx,
      "poison"
    );
    record.poison = {
      status: poisonRun.result.status,
      reason: poisonRun.result.reason,
      exit_code: poisonRun.result.attempts.at(-1)?.exit_code ?? null,
      run_dir: poisonRun.run_dir,
      stdout_sha256: sha256(poisonRun.stdout),
      stderr_sha256: sha256(poisonRun.stderr),
    };

    // 10-13. Exact-gate and exact-reason enforcement.
    if (poisonRun.result.gate_id !== fixture.expect.expected_gate) {
      return broken(
        fixture,
        "WRONG_TARGET",
        "structured gate identity mismatch",
        {
          actual_gate: poisonRun.result.gate_id,
        }
      );
    }
    // A `finding` fixture documents a gate that CANNOT reject: the expected
    // observation is that the gate stays green while its own detector saw the
    // poison. Only the assertions that remain meaningful are applied, and the
    // verdict can never be PROVEN.
    const nonDetector =
      fixture.expect.applicability === "finding"
        ? ["BLOCKED", "TIMEOUT", "INFRA_FAIL", "INCONCLUSIVE", "BROKEN_GATE"]
        : [
            "BLOCKED",
            "TIMEOUT",
            "INFRA_FAIL",
            "INCONCLUSIVE",
            "CI_ONLY",
            "N/A",
            "SKIPPED_DECLARED",
            "BROKEN_GATE",
          ];
    if (nonDetector.includes(poisonRun.result.status)) {
      return broken(
        fixture,
        "NOT_A_DETECTOR_RESULT",
        `poison leg produced ${poisonRun.result.status}, which is infrastructure/non-execution noise, not a detector verdict`,
        { poison: record.poison }
      );
    }
    if (poisonRun.result.status !== fixture.expect.expected_status) {
      // The intended gate executed and did NOT behave as declared.
      return broken(
        fixture,
        poisonRun.result.status === "PASS" ? "WRONG_TARGET" : "WRONG_REASON",
        `poison leg status ${poisonRun.result.status}; fixture declares ${fixture.expect.expected_status}`,
        { poison: record.poison }
      );
    }
    const reasonMatch = matchReasons(fixture.reasons, {
      stdout: poisonRun.stdout,
      stderr: poisonRun.stderr,
      result_reason: poisonRun.result.reason ?? "",
      worktree,
    });
    record.reason_match = reasonMatch.outcomes;
    if (!reasonMatch.matched) {
      return broken(
        fixture,
        "WRONG_REASON",
        "gate rejected, but the declared detector signature did not match",
        {
          poison: record.poison,
          stdout_tail: poisonRun.stdout.slice(-1500),
          stderr_tail: poisonRun.stderr.slice(-1500),
        }
      );
    }

    // 14-15. Restore; prove byte-for-byte return to control.
    try {
      execFileSync(
        "git",
        [
          "-C",
          worktree,
          "apply",
          "-R",
          "--whitespace=nowarn",
          fixture.patch_path,
        ],
        { encoding: "utf8" }
      );
    } catch (error) {
      return broken(fixture, "NON_RESTORING", "reverse-apply failed", {
        stderr: String(error.stderr ?? error.message).slice(0, 2000),
      });
    }
    // Execution artifacts (reports the gate itself wrote) are declared and
    // removed through the P04 ownership primitive; anything undeclared is a
    // restoration failure.
    const allowed = new Set(fixture.expect.allowed_execution_artifacts ?? []);
    const afterRevert = worktreeState(worktree);
    for (const artifact of afterRevert.untracked) {
      if (allowed.has(artifact)) {
        safeRemoveOwned(path.join(worktree, artifact), worktree);
      }
    }
    const restored = worktreeState(worktree);
    if (restored.tracked.length || restored.untracked.length) {
      return broken(
        fixture,
        "NON_RESTORING",
        "candidate is not byte-identical to control after restoration",
        { residue: restored, poison: record.poison }
      );
    }
    record.restored_hashes = hashPaths(worktree, fixture.changed_paths);
    if (
      JSON.stringify(record.restored_hashes) !==
      JSON.stringify(record.pre_poison_hashes)
    ) {
      return broken(
        fixture,
        "NON_RESTORING",
        "content hash drift after restore",
        {
          pre: record.pre_poison_hashes,
          post: record.restored_hashes,
        }
      );
    }

    // 16-17. Control leg: the SAME gate, the SAME pathway.
    const controlRun = await executeGate(
      binding,
      fixture,
      worktree,
      ctx,
      "control"
    );
    record.control = {
      status: controlRun.result.status,
      reason: controlRun.result.reason,
      exit_code: controlRun.result.attempts.at(-1)?.exit_code ?? null,
      run_dir: controlRun.run_dir,
    };
    if (controlRun.result.status === "FLAKY") {
      return broken(fixture, "CONTROL_FLAKY", "control leg produced FLAKY", {
        control: record.control,
      });
    }
    if (
      controlRun.result.status !== fixture.expect.control_expectation.status
    ) {
      // Bytes were PROVEN restored above, so a red control is a red baseline
      // (the gate fails before/without poison), not a restoration failure.
      return broken(
        fixture,
        "CONTROL_RED",
        `control leg ${controlRun.result.status}; fixture declares ${fixture.expect.control_expectation.status}`,
        {
          control: record.control,
          poison: record.poison,
          reason_match: record.reason_match,
        }
      );
    }

    // A `finding` cycle completed exactly as declared — which CONFIRMS the
    // weakness. It is never proof of rejection capability.
    record.verdict =
      fixture.expect.applicability === "finding"
        ? "FINDING_CONFIRMED"
        : "PROVEN";
    return record;
  } finally {
    // 19-20. Disposal through the owning machinery, always.
    disposeSnapshot(handle);
    record.worktree_disposed = !existsSync(worktree);
  }
}

/** Coerce a proof record into the canonical P03 result (class ASSURANCE). */
export function proofToResult(record) {
  if (record.verdict === "PROVEN") {
    return makeResult({
      gate_id: `assurance:${record.fixture_id}`,
      class: "ASSURANCE",
      status: "PASS",
      exit_code: 0,
      evidence_path: record.poison?.run_dir ?? record.fixture_id,
      contract_check_id: record.expected_gate,
    });
  }
  return makeResult({
    gate_id: `assurance:${record.fixture_id}`,
    class: "ASSURANCE",
    status: "BROKEN_GATE",
    reason: `${record.subcode}: ${record.detail}`,
    evidence_path: record.poison?.run_dir ?? record.fixture_id ?? null,
    contract_check_id: record.expected_gate ?? null,
  });
}

/**
 * P05.T07 — the assurance artifact. `logical` is deterministic with respect
 * to stable inputs (sorted, no wall-clock, no run ids); `observational`
 * carries the rest. The sha256 sidecar makes hand-editing self-defeating.
 */
export function buildAssuranceArtifact(input) {
  const {
    candidate,
    contract_sha256,
    registry,
    executor_sha256,
    records,
    coverage,
    execution_mode,
    hermeticity,
    cleanup_state,
  } = input;
  const logicalRecords = [...records]
    .sort((a, b) => a.fixture_id.localeCompare(b.fixture_id))
    .map(r => ({
      fixture_id: r.fixture_id,
      expected_gate: r.expected_gate,
      expected_status: r.expected_status ?? null,
      patch_sha256: r.patch_sha256 ?? null,
      verdict: r.verdict,
      subcode: r.subcode ?? null,
      poison_status: r.poison?.status ?? null,
      poison_stdout_sha256: r.poison?.stdout_sha256 ?? null,
      control_status: r.control?.status ?? null,
      reason_match: (r.reason_match ?? []).map(m => ({
        source: m.source,
        regex: m.regex,
        matched: m.matched,
      })),
    }));
  const proven = logicalRecords.filter(r => r.verdict === "PROVEN");
  const logical = {
    assurance_schema_version: ASSURANCE_SCHEMA_VERSION,
    candidate: {
      head_sha: candidate.head_sha,
      base_sha: candidate.base_sha,
      merge_tree_sha: candidate.merge_tree_sha,
      merge_commit_sha: candidate.merge_commit_sha,
    },
    contract_sha256,
    registry_identity: {
      parity_entries: registry.entries.length,
      contract_sha256: registry.contract_sha256,
    },
    executor_sha256,
    fixture_schema_version: "1.0.0",
    fixtures_discovered: records.length,
    fixtures_proven: proven.length,
    fixtures_broken: logicalRecords.length - proven.length,
    records: logicalRecords,
    coverage: coverage ?? null,
    execution_mode,
    hermeticity,
    final_status:
      logicalRecords.length > 0 &&
      logicalRecords.every(r => r.verdict === "PROVEN")
        ? "ASSURANCE_GREEN"
        : "ASSURANCE_BROKEN",
  };
  return {
    logical,
    logical_sha256: sha256(JSON.stringify(logical)),
    observational: {
      generated_at: new Date().toISOString(),
      cleanup_state,
      run_dirs: records.map(r => r.poison?.run_dir ?? null),
    },
  };
}

export function writeAssurance(outDir, artifact) {
  mkdirSync(outDir, { recursive: true });
  const artifactPath = path.join(outDir, "assurance.json");
  const bytes = JSON.stringify(artifact, null, 2);
  writeFileSync(artifactPath, bytes);
  const digest = sha256(Buffer.from(bytes));
  writeFileSync(`${artifactPath}.sha256`, `${digest}  assurance.json\n`);
  return { artifactPath, sha256: digest };
}

export function verifyAssurance(artifactPath) {
  const bytes = readFileSync(artifactPath);
  const pinned = readFileSync(`${artifactPath}.sha256`, "utf8")
    .trim()
    .split(/\s+/)[0];
  const actual = sha256(bytes);
  if (pinned !== actual) {
    throw new AssuranceError("ASSURANCE_TAMPERED", { pinned, actual });
  }
  const artifact = JSON.parse(bytes.toString("utf8"));
  const logicalSha = sha256(JSON.stringify(artifact.logical));
  if (logicalSha !== artifact.logical_sha256) {
    throw new AssuranceError("ASSURANCE_TAMPERED", {
      detail: "logical section does not match its embedded hash",
    });
  }
  return artifact;
}

/**
 * Recovery sweep for orphaned candidate directories (DEF-026).
 *
 * An interrupt can preempt in-process teardown: P01 and P04 each wire their
 * own signal handler, and whichever calls `process.exit` first cuts the other
 * short — so a run directory can survive with its git worktree already
 * unregistered. That is the same honest boundary P04 drew for SIGKILL:
 * in-process teardown is best-effort, and NEXT-INVOCATION DISCOVERY is the
 * recovery mechanism.
 *
 * Ownership is proven twice before anything is removed: the path must resolve
 * inside the owned runs root, and the directory must NOT be a registered git
 * worktree (a live run from any session always is, so a concurrent run can
 * never be swept out from under itself).
 */
export function sweepStaleRunDirs(runsRoot) {
  const swept = [];
  const skipped = [];
  if (!existsSync(runsRoot)) return { swept, skipped };
  const registered = new Set(
    execFileSync("git", ["-C", REPO_ROOT, "worktree", "list", "--porcelain"], {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    })
      .split("\n")
      .filter(line => line.startsWith("worktree "))
      .map(line => line.slice("worktree ".length))
  );
  for (const name of readdirSync(runsRoot).sort()) {
    const dir = path.join(runsRoot, name);
    if (!statSync(dir).isDirectory()) continue;
    const worktree = path.join(dir, "worktree");
    if (registered.has(worktree) || registered.has(realpathSync(dir))) {
      skipped.push({ dir: name, reason: "registered git worktree — live" });
      continue;
    }
    try {
      safeRemoveOwned(dir, runsRoot); // realpath containment proof
      swept.push(name);
    } catch (error) {
      skipped.push({ dir: name, reason: error.reason ?? error.message });
    }
  }
  return { swept, skipped };
}

/** Convenience: load contract+registry once for a run context. */
export function makeContext(options = {}) {
  const { contract, contract_sha256 } = loadVerifiedContract();
  const registry = buildParityRegistry({ contract, contract_sha256 });
  return {
    repoRoot: options.repoRoot ?? REPO_ROOT,
    scratchRoot:
      options.scratchRoot ??
      path.join(REPO_ROOT, ".ci-verify", "assurance-scratch"),
    contract,
    contract_sha256,
    registry,
    candidate: options.candidate ?? null,
    executor_sha256: sha256(
      readFileSync(path.join(REPO_ROOT, "scripts", "ci", "executor.mjs"))
    ),
  };
}

export { discoverFixtures, loadFixture };

// ---------------------------------------------------------------------------
// CLI — run every seed fixture and emit the assurance artifact.
// ---------------------------------------------------------------------------
async function main() {
  const { buildCoverage, loadGraduated } = await import("./coverage.mjs");
  const outDir = process.argv[2];
  if (!outDir) throw new AssuranceError("OUT_DIR_REQUIRED", {});
  const ctx = makeContext();
  // DEF-026: recover orphaned candidates from any previously interrupted run
  // BEFORE starting. In-process teardown is best-effort (two signal handlers
  // can race each other's exit), so next-invocation discovery is what makes
  // "zero residue" a standing property rather than a per-run hope. Live runs
  // are registered git worktrees and are never touched.
  const sweep = sweepStaleRunDirs(path.join(REPO_ROOT, ".ci-verify", "runs"));
  if (sweep.swept.length) {
    console.log(
      `[assurance] recovered ${sweep.swept.length} orphaned candidate(s): ${sweep.swept.join(", ")}`
    );
  }
  const records = [];
  const invalidFixtures = [];
  const fixtures = [];
  for (const dir of discoverFixtures(SEED_FIXTURES_ROOT)) {
    let fixture;
    try {
      fixture = loadFixture(dir);
    } catch (error) {
      invalidFixtures.push({
        fixture_id: path.basename(dir),
        expected_gate: null,
        reason: error.reason,
      });
      console.error(
        `[assurance] INVALID ${path.basename(dir)}: ${error.reason}`
      );
      continue;
    }
    fixtures.push(fixture);
    const record = await runFixtureCycle(fixture, ctx);
    records.push(record);
    console.log(
      `[assurance] ${record.fixture_id}: ${record.verdict}${record.subcode ? `(${record.subcode})` : ""}` +
        ` poison=${record.poison?.status ?? "-"} control=${record.control?.status ?? "-"}`
    );
  }
  const coverage = buildCoverage({
    registry: ctx.registry,
    fixtures,
    records,
    invalidFixtures,
    graduated: loadGraduated(),
  });
  const artifact = buildAssuranceArtifact({
    candidate: records[0]?.candidate ?? {},
    contract_sha256: ctx.contract_sha256,
    registry: ctx.registry,
    executor_sha256: ctx.executor_sha256,
    records,
    coverage: {
      counts: coverage.counts,
      blocking: coverage.blocking,
      cannot_reject: coverage.rows
        .filter(r => r.cannot_reject)
        .map(r => r.gate_id),
      rows: coverage.rows,
    },
    execution_mode: "host",
    hermeticity: "HERMETIC:UNENFORCED",
    cleanup_state: records.every(r => r.worktree_disposed !== false)
      ? "clean"
      : "residue",
  });
  const written = writeAssurance(outDir, artifact);
  console.log(
    `[assurance] wrote ${written.artifactPath} sha256=${written.sha256}`
  );
  console.log(
    `[assurance] proven=${artifact.logical.fixtures_proven} ` +
      `discovered=${artifact.logical.fixtures_discovered} ` +
      `status=${artifact.logical.final_status}`
  );
  const broken = records.filter(
    r => r.verdict !== "PROVEN" && r.verdict !== "FINDING_CONFIRMED"
  );
  if (broken.length) process.exitCode = 1;
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
) {
  main().catch(error => {
    console.error(`[assurance] ${error.reason ?? error.message}`);
    console.error(error.stack);
    process.exitCode = 1;
  });
}
