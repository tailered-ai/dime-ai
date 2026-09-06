#!/usr/bin/env node
/**
 * p06/step-driver.mjs — per-gate step executor (DEF-031/032/033 closure).
 *
 * Runs INSIDE the P04 executor as the gate command. Executes a gate's
 * contract steps in order, each as its own GHA-equivalent shell with its
 * own contract-effective working directory and env — exactly the semantics
 * GitHub Actions gives a job, which the previous joined-command runner
 * destroyed.
 *
 * Exit-code protocol (consumed by run-gates.mjs; NEVER reinterpretable as a
 * detector verdict except 0/20):
 *    0  every step ran; all detectors exited 0                → PASS
 *   20  a DETECTOR step executed and exited nonzero           → FAIL
 *   10  a PROVISIONING step failed                            → BLOCKED/INFRA_FAIL
 *   11  a MIXED (provisioning+detector) step failed           → INFRA_FAIL
 *   12  gate finished but no detector ever executed           → INFRA_FAIL
 *   30  contract cwd escapes the candidate (.. or symlink)    → BLOCKED
 *   31  contract cwd missing in the candidate                 → BLOCKED
 *   32  unresolved ${{ }} expression in step text/env         → BLOCKED
 *   33  spec unreadable/invalid                               → INFRA_FAIL
 *
 * The journal (steps.json in CI_VERIFY_STEP_DIR) is the authoritative
 * record; run-gates.mjs enforces the hard invariant that PASS/FAIL exist
 * only when the journal proves the detector validly began under a verified
 * cwd.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
/**
 * GHA shell fidelity (DEF-039): for a `run:` step with NO declared `shell:`,
 * GitHub executes `bash -e {0}` — WITHOUT pipefail. pipefail belongs only to
 * steps that declare `shell: bash`. This contract declares a shell on ZERO
 * steps, and its pervasive `${PIPESTATUS[0]}` discipline is written for
 * exactly those semantics. Running such steps under pipefail turned a
 * SUCCESSFUL `docker logs | grep -q` into exit 141 (SIGPIPE) — a false FAIL.
 * (--noprofile --norc kept for hermeticism; no semantic difference.)
 */
const GHA_UNDECLARED_SHELL = ["/bin/bash", "--noprofile", "--norc", "-e", "-c"];
import { GHA_DEFAULT_SHELL } from "../proc.mjs";

const specPath = process.argv[2];
const stepDir = process.env.CI_VERIFY_STEP_DIR;

function fail(code, journal, summary) {
  if (stepDir && journal) {
    journal.summary = { ...journal.summary, ...summary, driver_exit: code };
    writeFileSync(
      path.join(stepDir, "steps.json"),
      JSON.stringify(journal, null, 2) + "\n"
    );
  }
  console.error(`[driver] ${summary?.reason ?? "failure"} (exit ${code})`);
  process.exit(code);
}

let spec;
try {
  spec = JSON.parse(readFileSync(specPath, "utf8"));
  if (!stepDir) throw new Error("CI_VERIFY_STEP_DIR unset");
  mkdirSync(stepDir, { recursive: true });
} catch (error) {
  console.error(`[driver] SPEC_UNREADABLE: ${error.message}`);
  process.exit(33);
}

// --- short per-gate TMPDIR (AF_UNIX sun_path is 104 bytes on darwin) ----
// The executor's gate-isolated TMPDIR path is too long for unix-socket
// creation (tsx IPC pipes crashed with EINVAL), and CI's TMPDIR is plain
// /tmp anyway — a short per-gate dir is BOTH the fidelity and the fix.
// Isolation is preserved: unique per driver invocation, removed on exit.
const shortTmp = path.join(
  "/tmp",
  `cv-${createHash("sha256")
    .update(`${spec.gate_id}:${process.pid}:${stepDir}`)
    .digest("hex")
    .slice(0, 10)}`
);
mkdirSync(shortTmp, { recursive: true });
process.on("exit", () => {
  try {
    rmSync(shortTmp, { recursive: true, force: true });
  } catch {
    /* best effort; orchestrator records residue if any */
  }
});

const journal = {
  gate_id: spec.gate_id,
  worktree: spec.worktree,
  short_tmpdir: shortTmp,
  steps: [],
  summary: {
    detector_started: false,
    detectors_executed: 0,
    detectors_passed: 0,
    failed_step: null,
    reason: null,
  },
};

// --- GHA context emulation ---------------------------------------------
const ghaEnvFile = path.join(stepDir, "gha-env.txt");
const ghaOutFile = path.join(stepDir, "gha-output.txt");
const ghaPathFile = path.join(stepDir, "gha-path.txt");
for (const f of [ghaEnvFile, ghaOutFile, ghaPathFile]) writeFileSync(f, "");
let accumulatedEnv = {};

function parseGhaEnvFile() {
  // GHA supports NAME=value lines and NAME<<DELIM heredocs.
  const text = readFileSync(ghaEnvFile, "utf8");
  const lines = text.split("\n");
  const out = {};
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line.trim()) continue;
    const heredoc = line.match(/^([A-Za-z_][A-Za-z0-9_]*)<<(.+)$/);
    if (heredoc) {
      const [, name, delim] = heredoc;
      const body = [];
      i += 1;
      while (i < lines.length && lines[i] !== delim) {
        body.push(lines[i]);
        i += 1;
      }
      out[name] = body.join("\n");
      continue;
    }
    const eq = line.indexOf("=");
    if (eq > 0) out[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return out;
}

// --- per-step execution -------------------------------------------------
const worktreeReal = realpathSync(spec.worktree);

// Recorded fidelity adaptation: GHA runners spend 1-3s between steps; a
// contract step that reads another process's flushed output (docker logs)
// depends on that latency. Applied only where a gate declares it.
const interStepMs = Number(spec.inter_step_latency_ms ?? 0);
let firstStep = true;

for (const step of spec.steps) {
  if (!firstStep && interStepMs > 0 && step.mode !== "satisfied") {
    spawnSync("/bin/sleep", [String(interStepMs / 1000)]);
  }
  firstStep = false;
  const record = {
    index: step.index,
    kind: step.kind,
    mode: step.mode,
    provisioning_signatures: step.provisioning_signatures ?? [],
    contract_cwd: step.cwd ?? ".",
    adaptation: step.adapted_run
      ? {
          reason: step.adaptation_reason,
          original_first_line: (step.run ?? "").split("\n")[0],
        }
      : null,
  };

  if (step.mode === "satisfied") {
    record.satisfied_by = step.satisfied_by;
    record.executed = false;
    journal.steps.push(record);
    console.log(
      `[driver] step ${step.index} SATISFIED (${step.kind}): ${step.satisfied_by}`
    );
    continue;
  }

  const runText = step.adapted_run ?? step.run;
  // Any unresolved GHA expression is a refusal, never a guess.
  const unresolved = runText.match(/\$\{\{[^}]*\}\}/);
  const envUnresolved = Object.values(step.env ?? {}).find(
    v => typeof v === "string" && /\$\{\{[^}]*\}\}/.test(v)
  );
  if (unresolved || envUnresolved) {
    record.executed = false;
    journal.steps.push(record);
    fail(32, journal, {
      failed_step: step.index,
      reason: `EXPRESSION_UNRESOLVED: ${(unresolved?.[0] ?? envUnresolved).slice(0, 80)}`,
    });
  }

  // Contract-effective cwd, verified against the candidate boundary.
  const resolved = path.resolve(spec.worktree, step.cwd ?? ".");
  if (!existsSync(resolved)) {
    record.executed = false;
    record.resolved_cwd = resolved;
    journal.steps.push(record);
    fail(31, journal, {
      failed_step: step.index,
      reason: `CWD_MISSING: ${step.cwd} → ${resolved}`,
    });
  }
  const cwdReal = realpathSync(resolved);
  if (
    cwdReal !== worktreeReal &&
    !cwdReal.startsWith(worktreeReal + path.sep)
  ) {
    record.executed = false;
    record.resolved_cwd = cwdReal;
    journal.steps.push(record);
    fail(30, journal, {
      failed_step: step.index,
      reason: `CWD_ESCAPES_CANDIDATE: ${step.cwd} → ${cwdReal}`,
    });
  }
  record.resolved_cwd = cwdReal;
  record.cwd_verified = true;

  const extraPath = readFileSync(ghaPathFile, "utf8")
    .split("\n")
    .filter(Boolean);
  const env = {
    ...process.env,
    TMPDIR: shortTmp,
    TMP: shortTmp,
    TEMP: shortTmp,
    // CI-profile parity (DEF-062): ubuntu-latest exposes 4 vCPUs, so vitest
    // there never runs more than 4 workers. Locally vitest defaults to every
    // host core, so 8 workers share the machine with the verifier itself —
    // per-worker CPU starvation CI never experiences, which is how three
    // different subprocess-heavy tests tripped the 15s testTimeout here
    // while staying green in CI and isolated. Environment normalization
    // only: the contract command text stays verbatim, and contract-declared
    // step env (spread below) still supersedes.
    VITEST_MAX_FORKS: "4",
    VITEST_MAX_THREADS: "4",
    ...spec.gha,
    GITHUB_ENV: ghaEnvFile,
    GITHUB_OUTPUT: ghaOutFile,
    GITHUB_PATH: ghaPathFile,
    ...accumulatedEnv,
    ...(step.env ?? {}),
    ...(extraPath.length
      ? { PATH: `${extraPath.join(":")}:${process.env.PATH}` }
      : {}),
  };

  const stdoutFd = openSync(
    path.join(stepDir, `step-${step.index}.stdout`),
    "w"
  );
  const stderrFd = openSync(
    path.join(stepDir, `step-${step.index}.stderr`),
    "w"
  );
  const started = Date.now();
  console.log(
    `[driver] step ${step.index} EXEC (${step.kind}) cwd=${step.cwd ?? "."}: ${runText.split("\n")[0].slice(0, 100)}`
  );
  const shell =
    step.shell === "bash" ? GHA_DEFAULT_SHELL : GHA_UNDECLARED_SHELL;
  record.shell_mode =
    step.shell === "bash"
      ? "declared-bash-pipefail"
      : "gha-default-no-pipefail";
  const child = spawnSync(shell[0], [...shell.slice(1), runText], {
    cwd: cwdReal,
    env,
    stdio: ["ignore", stdoutFd, stderrFd],
  });
  record.executed = true;
  record.exit_code = child.status;
  record.signal = child.signal ?? null;
  record.duration_ms = Date.now() - started;
  journal.steps.push(record);
  accumulatedEnv = { ...accumulatedEnv, ...parseGhaEnvFile() };

  const isDetector = step.kind === "DETECTOR";
  if (isDetector) {
    journal.summary.detector_started = true;
    journal.summary.detectors_executed += 1;
  }
  if (child.status !== 0 || child.signal) {
    const tail = readFileSync(
      path.join(stepDir, `step-${step.index}.stderr`),
      "utf8"
    ).slice(-500);
    console.error(tail);
    if (step.kind === "PROVISIONING") {
      fail(10, journal, {
        failed_step: step.index,
        reason: `PROVISIONING_STEP_FAILED: exit ${child.status ?? child.signal}`,
      });
    } else if (step.kind === "MIXED") {
      fail(11, journal, {
        failed_step: step.index,
        reason: `MIXED_STEP_FAILED: exit ${child.status ?? child.signal} (provisioning and detector share this step; attribution requires the captured output)`,
      });
    } else {
      fail(20, journal, {
        failed_step: step.index,
        reason: `DETECTOR_FAILED: step ${step.index} exit ${child.status ?? child.signal}: ${runText.split("\n")[0].slice(0, 90)}`,
      });
    }
  }
  if (isDetector) journal.summary.detectors_passed += 1;
}

if (journal.summary.detectors_executed === 0) {
  fail(12, journal, {
    reason: "NO_DETECTOR_EXECUTED: gate had no executable detector step",
  });
}
journal.summary.driver_exit = 0;
journal.summary.reason = null;
writeFileSync(
  path.join(stepDir, "steps.json"),
  JSON.stringify(journal, null, 2) + "\n"
);
console.log(
  `[driver] gate ${spec.gate_id}: ${journal.summary.detectors_passed}/${journal.summary.detectors_executed} detectors passed`
);
process.exit(0);
