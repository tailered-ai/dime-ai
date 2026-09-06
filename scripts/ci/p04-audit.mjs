#!/usr/bin/env node
/**
 * p04-audit.mjs — P04.AUD01 (teardown ownership), P04.AUD02 (process /
 * exit-code fidelity, including the P04.NEG05 suppression detector), and
 * P04.AUD03 (P03 integration: exactly one result system).
 *
 * The audits are STRUCTURAL where structure is provable (which module may
 * contain which dangerous call) and RUNTIME where only execution proves the
 * property (pipeline suppression really preserves the producer's failure).
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GATE_STATUSES } from "./result.mjs";
import { GHA_DEFAULT_SHELL, resolveCommand, runCommand } from "./proc.mjs";
import { OWNERSHIP_SURFACE } from "./teardown.mjs";
import { NEVER_RETRY, RETRYABLE } from "./executor.mjs";
import { PREREQUISITE_PERMITS } from "./scheduler.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, "..", "..");

/** The P04 runtime modules under audit authority. */
export const P04_RUNTIME_MODULES = [
  "scripts/ci/scheduler.mjs",
  "scripts/ci/lane.mjs",
  "scripts/ci/environment.mjs",
  "scripts/ci/proc.mjs",
  "scripts/ci/teardown.mjs",
  "scripts/ci/executor.mjs",
  "scripts/ci/p04-audit.mjs",
];

function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map(line => line.replace(/(^|[^:])\/\/.*$/, "$1"))
    .join("\n");
}

/**
 * Remove string-literal CONTENT (quotes stay) so prose inside strings cannot
 * false-positive a JS-API scan — the DEF-009 lesson, applied structurally.
 * Newlines inside template literals are preserved so line numbers hold.
 */
function stripStrings(source) {
  return source
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
    .replace(/`(?:[^`\\]|\\[\s\S])*`/g, match => match.replace(/[^`\n]/g, ""));
}

/** A definition-table row (a regex literal naming a pattern) is not a call. */
function isPatternDefinitionRow(line) {
  return /^\s*\{?\s*pattern:\s*\//.test(line);
}

function scanModule(rel) {
  const source = readFileSync(path.join(REPO_ROOT, rel), "utf8");
  const code = stripComments(source);
  return { rel, raw: source, code, codeNoStrings: stripStrings(code) };
}

// ---------------------------------------------------------------------------
// P04.AUD01 — teardown ownership.
// ---------------------------------------------------------------------------

/**
 * Which module may contain which destructive primitive, and why. Anything
 * destructive found outside its declared home is a violation. DETECTION
 * primitives (ps, kill(pid, 0)) are classified, not banned.
 */
export const DESTRUCTIVE_ALLOWANCES = [
  {
    pattern: /\brmSync\s*\(/,
    id: "rmSync",
    allowed_in: ["scripts/ci/teardown.mjs"],
    reason:
      "file deletion exists ONLY behind safeRemoveOwned's realpath containment",
  },
  {
    pattern: /\brmdirSync\s*\(|\bunlinkSync\s*\(/,
    id: "rmdir/unlink",
    allowed_in: ["scripts/ci/lane.mjs"],
    reason:
      "lock-dir removal happens ONLY in release/reclaimStale, both of which " +
      "verify ownership (run_id + acquisition_id) or journal a classified " +
      "stale reclaim first",
  },
  {
    pattern: /process\.kill\s*\(\s*-?[A-Za-z]/,
    id: "process.kill",
    allowed_in: ["scripts/ci/teardown.mjs", "scripts/ci/proc.mjs"],
    reason:
      "teardown kills only marker-verified pids; proc kills only the group " +
      "of a child it spawned itself (handle ownership)",
  },
];

/** Patterns that are forbidden EVERYWHERE in P04 modules — broad destroyers. */
export const FORBIDDEN_DESTRUCTIVE = [
  { pattern: /\bpkill\b/, id: "pkill (name-based process killing)" },
  { pattern: /\bkillall\b/, id: "killall (name-based process killing)" },
  { pattern: /rm\s+-rf?\s/, id: "shell rm -r/-f" },
  { pattern: /docker\s+(system\s+prune|rm|rmi)/, id: "docker prune/rm" },
  { pattern: /worktree\s+remove/, id: "git worktree remove (P01 owns this)" },
  { pattern: /rmSync\s*\(\s*["'`]\//, id: "rmSync of an absolute literal" },
  {
    pattern: /rmSync\s*\(\s*(os\.)?tmpdir\s*\(/,
    id: "rmSync of the SYSTEM temp root",
  },
];

export function auditTeardownOwnership() {
  const findings = [];
  const classified = [];
  for (const rel of P04_RUNTIME_MODULES) {
    const { code, codeNoStrings } = scanModule(rel);
    // JS-API destroyers are CALLS — scanned with string content removed so
    // prose in a string can never look like a call (DEF-009 class guard).
    const apiLines = codeNoStrings.split("\n");
    for (const rule of DESTRUCTIVE_ALLOWANCES) {
      for (let i = 0; i < apiLines.length; i += 1) {
        if (!rule.pattern.test(apiLines[i])) continue;
        const record = { file: rel, line: i + 1, primitive: rule.id };
        if (rule.allowed_in.includes(rel)) {
          classified.push({ ...record, class: "ALLOWED", reason: rule.reason });
        } else {
          findings.push({
            ...record,
            class: "VIOLATION",
            detail: `destructive primitive outside its declared home (${rule.allowed_in.join(", ")})`,
          });
        }
      }
    }
    // Shell-string destroyers CAN live inside string literals, so this scan
    // keeps strings — only regex-definition rows (the detector's own table)
    // are recognized as declarations rather than uses.
    const lines = code.split("\n");
    for (const rule of FORBIDDEN_DESTRUCTIVE) {
      for (let i = 0; i < lines.length; i += 1) {
        if (!rule.pattern.test(lines[i])) continue;
        if (isPatternDefinitionRow(lines[i])) continue;
        findings.push({
          file: rel,
          line: i + 1,
          primitive: rule.id,
          class: "VIOLATION",
          detail: "broad destructive mechanism — forbidden everywhere",
        });
      }
    }
  }
  return {
    ok: findings.length === 0,
    findings,
    classified,
    ownership_surface: OWNERSHIP_SURFACE,
    modules_scanned: P04_RUNTIME_MODULES,
  };
}

// ---------------------------------------------------------------------------
// P04.AUD02 — process / exit-code fidelity (+ NEG05 suppression detection).
// ---------------------------------------------------------------------------

/**
 * Suppression shapes that would let a producer's failure vanish at the TOP
 * LEVEL of an executor-owned wrapper. Inside a CONTRACT command they are the
 * contract's own (CI-parity) semantics and are classified, not banned.
 */
export const SUPPRESSION_PATTERNS = [
  { pattern: /\|\|\s*true\b/, id: "top-level || true" },
  { pattern: /;\s*true\s*$/, id: "trailing ; true" },
  { pattern: /\$\?\s*=|=\s*\$\?/, id: "textual $? capture" },
  { pattern: /\becho\s+\$\?/, id: "echoed $?" },
  { pattern: /2>&1\s*\|\s*tee\b/, id: "merged-stream tee pipe" },
];

/**
 * Static leg: no P04 module may BUILD a shell string containing a
 * suppression shape. (Fixtures and test files deliberately contain them —
 * they are the negative corpus, and they are not runtime modules.)
 */
export function auditSuppressionStatic() {
  const findings = [];
  for (const rel of P04_RUNTIME_MODULES) {
    const { code } = scanModule(rel);
    const lines = code.split("\n");
    for (const rule of SUPPRESSION_PATTERNS) {
      for (let i = 0; i < lines.length; i += 1) {
        if (!rule.pattern.test(lines[i])) continue;
        // This audit file quotes the patterns to define them; the definition
        // table itself is the one legitimate appearance.
        if (rel === "scripts/ci/p04-audit.mjs") continue;
        findings.push({ file: rel, line: i + 1, pattern: rule.id });
      }
    }
  }
  return { ok: findings.length === 0, findings };
}

/**
 * Runtime leg: prove the runner PRESERVES producer failure through the
 * classic suppression shapes, and that deliberate contract suppression is
 * classified as the contract's own choice rather than silently trusted.
 * Every probe's exit code comes from the child 'exit' event — never text.
 */
export async function auditSuppressionRuntime(scratchDir) {
  const probes = [
    {
      id: "piped-producer-failure",
      shell: "false | tee /dev/null",
      expect_nonzero: true,
      anchor:
        "DEF-007 regression anchor: a piped $? once produced a false PASS; " +
        "under GHA-default pipefail the producer's failure survives the pipe",
    },
    {
      id: "mid-pipeline-exit-code",
      shell: "(exit 7) | cat",
      expect_nonzero: true,
      expect_exit: 7,
      anchor: "pipefail surfaces the leftmost failing producer's code",
    },
    {
      id: "subshell-failure",
      shell: "(false)",
      expect_nonzero: true,
      anchor: "a subshell failure is not lost by the wrapper",
    },
    {
      id: "errexit-mid-script",
      shell: "false\necho unreachable",
      expect_nonzero: true,
      anchor: "-e stops the script at the failing command (GHA semantics)",
    },
    {
      id: "deliberate-contract-suppression",
      shell: "false || true",
      expect_nonzero: false,
      anchor:
        "a contract that suppresses its own failure exits 0 BY ITS OWN " +
        "declaration — the audit records the choice; the runner does not " +
        "second-guess the contract, and the static leg forbids the executor " +
        "from ADDING such suppression itself",
    },
  ];
  const results = [];
  for (const probe of probes) {
    const record = await runCommand(
      { shell: probe.shell },
      {
        env: { PATH: process.env.PATH },
        cwd: scratchDir,
        timeout_ms: 10_000,
        stdout_path: path.join(scratchDir, `${probe.id}.stdout`),
        stderr_path: path.join(scratchDir, `${probe.id}.stderr`),
      }
    );
    const nonzero = record.exit_code !== 0;
    const exitOk =
      probe.expect_exit === undefined || record.exit_code === probe.expect_exit;
    results.push({
      id: probe.id,
      shell: probe.shell,
      exit_code: record.exit_code,
      shell_mode: record.shell_mode,
      ok: nonzero === probe.expect_nonzero && exitOk,
      anchor: probe.anchor,
    });
  }
  return { ok: results.every(item => item.ok), probes: results };
}

/** Structural description of every spawn path, verified against source. */
export function auditSpawnPaths() {
  const findings = [];
  const paths = [];
  for (const rel of P04_RUNTIME_MODULES) {
    const { codeNoStrings } = scanModule(rel);
    const lines = codeNoStrings.split("\n");
    for (let i = 0; i < lines.length; i += 1) {
      if (/\bspawn\s*\(/.test(lines[i])) {
        if (rel !== "scripts/ci/proc.mjs") {
          findings.push({
            file: rel,
            line: i + 1,
            detail:
              "child spawn outside proc.mjs — a second spawn path evades " +
              "the fidelity rules",
          });
        } else {
          paths.push({
            file: rel,
            line: i + 1,
            kind: "gate child",
            executable: "resolveCommand argv[0] (explicit)",
            args: "resolveCommand argv[1..] (explicit)",
            cwd: "caller-required; CWD_REQUIRED if absent",
            env: "buildEnvironment product only",
            stdout_stderr: "separate createWriteStream captures",
            exit_capture: "child 'exit' event (code, signal) — direct",
            timeout: "monotonic deadline, SIGTERM->grace->SIGKILL, latched",
            shell: "opt-in, GHA default flags (-e -o pipefail) only",
          });
        }
      }
      if (/execFileSync\s*\(/.test(lines[i])) {
        const allowed = rel === "scripts/ci/teardown.mjs";
        (allowed ? paths : findings).push({
          file: rel,
          line: i + 1,
          ...(allowed
            ? {
                kind: "read-only ps probe",
                executable: "ps (fixed literal)",
                args: "fixed flags + pid",
                exit_capture: "throws on failure; output parsed, never $?",
              }
            : { detail: "unexpected execFileSync outside teardown ps probe" }),
        });
      }
    }
  }
  // The shell contract itself: exact GHA default flags, asserted not assumed.
  const expected = [
    "/bin/bash",
    "--noprofile",
    "--norc",
    "-e",
    "-o",
    "pipefail",
    "-c",
  ];
  if (JSON.stringify(GHA_DEFAULT_SHELL) !== JSON.stringify(expected)) {
    findings.push({
      file: "scripts/ci/proc.mjs",
      detail: `GHA_DEFAULT_SHELL drifted: ${GHA_DEFAULT_SHELL.join(" ")}`,
    });
  }
  // resolveCommand refuses ambiguity — negative probe, structural.
  let ambiguous = false;
  try {
    resolveCommand({ argv: ["x"], shell: "x" });
    ambiguous = true;
  } catch {
    /* expected: AMBIGUOUS_COMMAND */
  }
  if (ambiguous) {
    findings.push({
      file: "scripts/ci/proc.mjs",
      detail: "resolveCommand accepted an ambiguous argv+shell command",
    });
  }
  return { ok: findings.length === 0, findings, paths };
}

// ---------------------------------------------------------------------------
// P04.AUD03 — P03 integration: exactly one result system.
// ---------------------------------------------------------------------------
export const PARALLEL_IMPLEMENTATION_PATTERNS = [
  {
    pattern: /GATE_STATUSES\s*=\s*\[/,
    id: "second status taxonomy",
    home: "scripts/ci/result.mjs",
  },
  {
    pattern: /function\s+summarize\s*\(|const\s+summarize\s*=/,
    id: "second summary implementation",
    home: "scripts/ci/reporter.mjs",
  },
  {
    pattern: /buildParityRegistry|PARITY_REGISTRY\s*=/,
    id: "second PARITY registry",
    home: "scripts/ci/registry.mjs",
  },
  {
    pattern: /from\s+["']yaml["']|require\(["']yaml["']\)/,
    id: "second YAML boundary",
    home: "scripts/ci/contract-extract.mjs",
  },
  {
    pattern: /ci-verify-ledger\.json/,
    id: "second ledger writer",
    home: "scripts/ci/ledger.mjs",
  },
  {
    pattern: /acceptPhase|acceptance_met/,
    id: "second acceptance predicate",
    home: "scripts/ci/ledger.mjs",
  },
];

export function auditP03Integration() {
  const findings = [];
  const evidence = [];
  for (const rel of P04_RUNTIME_MODULES) {
    const { code } = scanModule(rel);
    const lines = code.split("\n");
    for (const rule of PARALLEL_IMPLEMENTATION_PATTERNS) {
      for (let i = 0; i < lines.length; i += 1) {
        if (!rule.pattern.test(lines[i])) continue;
        if (rel === "scripts/ci/p04-audit.mjs") continue; // definition table
        findings.push({
          file: rel,
          line: i + 1,
          duplicate_of: rule.home,
          kind: rule.id,
        });
      }
    }
  }
  // Positive evidence: the executor IMPORTS the canonical system.
  const executor = scanModule("scripts/ci/executor.mjs").code;
  for (const [what, pattern] of [
    [
      "makeResult from result.mjs",
      /import\s*\{[^}]*makeResult[^}]*\}\s*from\s*"\.\/result\.mjs"/,
    ],
    ["classifyAttempts from result.mjs", /classifyAttempts/],
    [
      "JsonlReporter from reporter.mjs",
      /import\s*\{[^}]*JsonlReporter[^}]*\}\s*from\s*"\.\/reporter\.mjs"/,
    ],
    ["summarize from reporter.mjs", /summarize/],
  ]) {
    if (pattern.test(executor)) {
      evidence.push({ integration: what, present: true });
    } else {
      findings.push({
        file: "scripts/ci/executor.mjs",
        kind: `missing canonical integration: ${what}`,
      });
    }
  }
  // Runtime totality: every status P04's tables speak of is canonical.
  for (const [table, members] of [
    ["PREREQUISITE_PERMITS", Object.keys(PREREQUISITE_PERMITS)],
    ["NEVER_RETRY", [...NEVER_RETRY]],
    ["RETRYABLE", [...RETRYABLE]],
  ]) {
    for (const status of members) {
      if (!GATE_STATUSES.includes(status)) {
        findings.push({ table, status, kind: "status outside P03 taxonomy" });
      }
    }
  }
  if (Object.keys(PREREQUISITE_PERMITS).length !== GATE_STATUSES.length) {
    findings.push({
      table: "PREREQUISITE_PERMITS",
      kind: "not total over the 12 statuses",
    });
  }
  return { ok: findings.length === 0, findings, evidence };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
async function main() {
  const scratch = process.argv[2];
  const aud1 = auditTeardownOwnership();
  console.log(
    `[p04-audit] AUD01 modules=${aud1.modules_scanned.length} ` +
      `allowed_sites=${aud1.classified.length} violations=${aud1.findings.length}`
  );
  for (const item of aud1.classified) {
    console.log(
      `[p04-audit]   ALLOWED ${item.file}:${item.line} ${item.primitive} — ${item.reason}`
    );
  }
  for (const item of aud1.findings) {
    console.error(`[p04-audit]   VIOLATION ${JSON.stringify(item)}`);
  }
  for (const surface of aud1.ownership_surface) {
    console.log(
      `[p04-audit]   surface: ${surface.operation} [${surface.resource_types.join(",")}] proof=${surface.ownership_proof}`
    );
  }
  console.log(
    aud1.ok
      ? "[p04-audit] AUD01 PASS — every destructive primitive lives behind an ownership proof"
      : "[p04-audit] AUD01 FAIL"
  );

  const staticLeg = auditSuppressionStatic();
  const spawnLeg = auditSpawnPaths();
  let runtimeLeg = { ok: false, probes: [], skipped: true };
  if (scratch) {
    runtimeLeg = await auditSuppressionRuntime(scratch);
  }
  console.log(
    `[p04-audit] AUD02 static_suppression_findings=${staticLeg.findings.length} ` +
      `spawn_paths=${spawnLeg.paths.length} spawn_findings=${spawnLeg.findings.length} ` +
      `runtime_probes=${runtimeLeg.probes.length}`
  );
  for (const probe of runtimeLeg.probes) {
    console.log(
      `[p04-audit]   probe ${probe.id}: exit=${probe.exit_code} ok=${probe.ok} — ${probe.anchor}`
    );
  }
  for (const item of [...staticLeg.findings, ...spawnLeg.findings]) {
    console.error(`[p04-audit]   AUD02 FINDING ${JSON.stringify(item)}`);
  }
  const aud2ok = staticLeg.ok && spawnLeg.ok && (!scratch || runtimeLeg.ok);
  console.log(
    aud2ok
      ? "[p04-audit] AUD02 PASS — exit codes are captured directly on every path" +
          (scratch
            ? ""
            : " (static legs only; pass a scratch dir for runtime probes)")
      : "[p04-audit] AUD02 FAIL"
  );

  const aud3 = auditP03Integration();
  console.log(
    `[p04-audit] AUD03 findings=${aud3.findings.length} integrations=${aud3.evidence.length}`
  );
  for (const item of aud3.evidence) {
    console.log(`[p04-audit]   integration present: ${item.integration}`);
  }
  for (const item of aud3.findings) {
    console.error(`[p04-audit]   AUD03 FINDING ${JSON.stringify(item)}`);
  }
  console.log(
    aud3.ok
      ? "[p04-audit] AUD03 PASS — one taxonomy, one reporter, one registry, one ledger"
      : "[p04-audit] AUD03 FAIL"
  );

  if (!aud1.ok || !aud2ok || !aud3.ok) process.exitCode = 1;
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
) {
  main().catch(error => {
    console.error(`[p04-audit] ${error.reason ?? error.message}`);
    process.exitCode = 1;
  });
}
