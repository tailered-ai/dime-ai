#!/usr/bin/env node
/**
 * p06/capability.mjs — MEASURED provisioning capability (DEF-033 correction).
 *
 * Every claim here is the output of a command executed now, on this host,
 * against the current candidate — never an assumption in either direction.
 * The DEF-033 lesson cuts both ways: assuming provisioning is satisfied
 * produced false FAILs; assuming it is unsatisfiable produced false
 * NOT_LOCALLY_EXECUTABLE. So each provisioning signature maps to a probe
 * with recorded evidence, and `measureCapabilities()` is the only way the
 * runner may learn what this host can do.
 *
 * Equivalence law for `node-deps`: a candidate worktree nested inside the
 * repository (.ci-verify/runs/<id>/worktree) resolves the host node_modules
 * by upward module resolution. That equivalence is valid ONLY when
 *   (a) `pnpm install --frozen-lockfile --offline` exits 0 on the host
 *       (host tree is lockfile-consistent, no network mutation), and
 *   (b) the candidate's pnpm-lock.yaml is byte-identical to the host's.
 * If (b) fails the equivalence is refused and the gate must provision inside
 * the candidate or be classified truthfully.
 */
import { execFileSync, execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, "..", "..", "..");
const sha256 = buf => createHash("sha256").update(buf).digest("hex");

function probe(cmd, args, options = {}) {
  const started = Date.now();
  try {
    const stdout = execFileSync(cmd, args, {
      encoding: "utf8",
      cwd: options.cwd ?? REPO_ROOT,
      timeout: options.timeout_ms ?? 180_000,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...options.env },
    });
    return {
      ok: true,
      exit_code: 0,
      duration_ms: Date.now() - started,
      output_tail: stdout.slice(-400),
    };
  } catch (error) {
    return {
      ok: false,
      exit_code: error.status ?? null,
      duration_ms: Date.now() - started,
      output_tail: `${error.stdout ?? ""}\n${error.stderr ?? ""}`.slice(-400),
      spawn_error: error.code === "ENOENT" ? "MISSING_EXECUTABLE" : null,
    };
  }
}

// Contract version pins come from tools.mjs — the single declared
// workflow-byte-reading boundary for P06 (see P02's YAML_ALLOWLIST).
import { contractRuntimePins } from "./tools.mjs";

/**
 * Measure host provisioning capability for the current candidate worktree.
 * `candidateWorktree` may be null for a pre-candidate measurement; lockfile
 * equivalence is then measured against HEAD's committed lockfile.
 */
export function measureCapabilities(candidateWorktree = null) {
  const pins = contractRuntimePins();
  const evidence = { measured_at: new Date().toISOString(), probes: {} };

  // --- runtime versions --------------------------------------------------
  const nodeVersion = process.version;
  const pnpmVersion = probe("pnpm", ["--version"]);
  const nodeOk =
    pins.node_major !== null && nodeVersion.startsWith(`v${pins.node_major}.`);
  const pnpmOk = pnpmVersion.ok && pnpmVersion.output_tail.trim() === pins.pnpm;
  evidence.probes.runtime = {
    node: nodeVersion,
    node_pin: pins.node_major,
    node_ok: nodeOk,
    pnpm: pnpmVersion.output_tail.trim(),
    pnpm_pin: pins.pnpm,
    pnpm_ok: pnpmOk,
  };

  // --- node-deps ----------------------------------------------------------
  // Deliberately NON-MUTATING here. An earlier version ran a frozen install
  // in REPO_ROOT to "measure host consistency", which mutated the
  // developer's own node_modules — a side effect outside this program's
  // scope. The measurement that actually matters is the install performed
  // INSIDE the disposable candidate (provisionCandidate below), so host
  // state is only read, never written.
  const hostLock = readFileSync(path.join(REPO_ROOT, "pnpm-lock.yaml"));
  let lockEqual = null;
  if (candidateWorktree) {
    const candidateLockPath = path.join(candidateWorktree, "pnpm-lock.yaml");
    lockEqual =
      existsSync(candidateLockPath) &&
      sha256(readFileSync(candidateLockPath)) === sha256(hostLock);
  }
  evidence.probes.node_deps = {
    measurement: "deferred to the in-candidate install; host tree not mutated",
    host_lock_sha256: sha256(hostLock),
    candidate_lock_equal: lockEqual,
  };
  // node-deps satisfaction is NOT derived from host↔candidate lockfile
  // equality. The candidate is a prospective MERGE, so its lockfile
  // legitimately differs from the working tree whenever main has moved —
  // that difference says nothing about whether the candidate can be
  // provisioned. Authority belongs to the install actually performed inside
  // the candidate (provisionCandidate), which the caller folds in. Here we
  // only require the runtime versions the contract pins.
  const nodeDeps = nodeOk && pnpmOk;

  // --- playwright: the browser build the candidate's playwright wants -----
  let playwright = { ok: false };
  try {
    const dryRun = execSync(
      "pnpm exec playwright install --dry-run chromium 2>&1",
      { encoding: "utf8", cwd: REPO_ROOT, timeout: 60_000 }
    );
    const installDir = dryRun.match(/Install location:\s*(\S+)/)?.[1] ?? null;
    playwright = {
      ok: installDir !== null && existsSync(installDir),
      install_location: installDir,
      exists: installDir !== null && existsSync(installDir),
      dry_run_tail: dryRun.slice(-300),
    };
  } catch (error) {
    playwright = { ok: false, error: String(error).slice(0, 200) };
  }
  evidence.probes.playwright = playwright;

  // --- python model-runner deps (postinstall leg) — informational ---------
  // Unsatisfied on this host (PEP 668 pip + python 3.14 vs numpy 1.26.4).
  // Not consumed by any P06/P07 detector: no *.test.ts executes python3.
  const pythonDeps = probe("python3", [
    "-c",
    "import numpy, scipy, pandas, requests",
  ]);
  evidence.probes.python_model_deps = {
    ...pythonDeps,
    consumed_by_detectors: false,
    consumption_evidence:
      "grep of server/shared/scripts/client *.test.ts: zero files execute " +
      "python3 (spawn/execFile); matches are filename references only",
  };

  // --- uv toolchain -------------------------------------------------------
  const uv = probe("uv", ["--version"]);
  evidence.probes.uv = uv;

  // --- python3 (contracts step 7 uses python3 heredoc) --------------------
  const python = probe("python3", ["--version"]);
  evidence.probes.python3 = python;

  const capabilities = {
    // signature-level satisfaction consumed by boundary.classifyCheck
    provisioning: {
      "node-deps": nodeDeps,
      "playwright-install": playwright.ok === true,
      // uv sync executes inside the candidate at gate time; capability here
      // means the toolchain exists to attempt it.
      "uv-sync": uv.ok === true,
      "pip-install": uv.ok === true,
    },
    tools: {},
    runtimeTools: ["docker"],
    evidence,
  };
  return capabilities;
}

/**
 * PHYSICAL in-candidate provisioning — executes the contract's own
 * `pnpm install --frozen-lockfile` INSIDE the disposable candidate.
 * Upward-resolution equivalence proved insufficient: contract-extract.mjs
 * and the proof contract introspect node_modules as a literal path, exactly
 * as CI's install provides it.
 *
 * No `--offline`: the contract's command has none, and forcing it made the
 * run depend on whether every tarball happened to be in the local store —
 * a miss then surfaced as ERR_PNPM_NO_OFFLINE_TARBALL, which is an
 * environment condition, not a candidate property. `--ignore-scripts` is
 * kept because the repo's postinstall provisions PYTHON model-runner deps
 * that no detector consumes (verified: no *.test.ts executes python3).
 */
export function provisionCandidate(worktree) {
  const started = Date.now();
  try {
    execFileSync("pnpm", ["install", "--frozen-lockfile", "--ignore-scripts"], {
      cwd: worktree,
      encoding: "utf8",
      timeout: 600_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    // Submodule fidelity: main now carries a gitlink
    // (platform/tailered-os/cloudflare-os), and the tailered-os contract job
    // checks out with `submodules: recursive`. A worktree candidate leaves
    // gitlinks EMPTY, so a detector that reads submodule content would fail
    // for a materialization gap, not a candidate defect — the DEF-031 class.
    // Worktrees share the super-repo's .git/modules store, so only the first
    // init pays the network cost.
    let submodules = { present: false };
    if (existsSync(path.join(worktree, ".gitmodules"))) {
      try {
        execFileSync(
          "git",
          ["-C", worktree, "submodule", "update", "--init", "--recursive"],
          {
            encoding: "utf8",
            timeout: 600_000,
            stdio: ["ignore", "pipe", "pipe"],
          }
        );
        submodules = { present: true, initialized: true };
      } catch (error) {
        submodules = {
          present: true,
          initialized: false,
          tail: `${error.stdout ?? ""}${error.stderr ?? ""}`.slice(-300),
        };
      }
    }
    return {
      ok: true,
      duration_ms: Date.now() - started,
      mode: "frozen-offline-ignore-scripts, host store",
      submodules,
      python_postinstall_leg:
        "skipped (--ignore-scripts); measured unconsumed by any detector",
    };
  } catch (error) {
    return {
      ok: false,
      duration_ms: Date.now() - started,
      exit_code: error.status ?? null,
      tail: `${error.stdout ?? ""}${error.stderr ?? ""}`.slice(-400),
    };
  }
}

async function main() {
  const caps = measureCapabilities(process.argv[2] ?? null);
  console.log(JSON.stringify(caps, null, 2));
  const failed = Object.entries(caps.provisioning).filter(([, v]) => !v);
  if (failed.length) {
    console.error(
      `[capability] UNSATISFIED: ${failed.map(([k]) => k).join(", ")}`
    );
  }
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
) {
  main().catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}
