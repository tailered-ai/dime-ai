#!/usr/bin/env node
/**
 * p03-audit.mjs — P03.AUD01 (contract -> registry fidelity) and
 * P03.AUD02 (runtime YAML isolation for P03 code).
 *
 * AUD01 proves the PARITY registry is a faithful projection of the frozen
 * contract — no invented membership, no silent omission, no local repair of an
 * upstream classification. It pays particular attention to the two defect
 * classes P02 already found and closed:
 *
 *   DEF-017 — a locally reproducible gate must not be CI-ONLY merely because
 *             its CI job also uploads an artifact.
 *   DEF-018 — external tool requirements (semgrep, zizmor, ...) must stay
 *             visible, because "missing tool => BLOCKED" depends on them.
 *
 * AUD02 proves no P03 RUNTIME module reads workflow YAML or reconstructs P02
 * semantics. The P02 extractor and the test suites are legitimate readers and
 * are classified separately — a raw grep would conflate them and produce a
 * false conclusion.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadVerifiedContract,
  buildParityRegistry,
  isParityEligible,
  REQUIRED_CONTEXTS,
} from "./registry.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, "..", "..");

/** Gates whose local reproducibility DEF-017 restored. Regression anchors. */
export const DEF017_ANCHORS = {
  "TypeScript Check": "LOCAL",
  "08-contract-and-data-integrity": "LOCAL",
  "10-ai-eval-critical": "LOCAL",
  "07-coverage-patch": "LOCAL",
};

/** Gates whose tool requirements DEF-018 restored. Regression anchors. */
export const DEF018_ANCHORS = {
  "05-workflow-security": "zizmor",
  "03-semgrep-blocking": "semgrep",
  "Security Audit": "osv-scanner",
  "Secret Scan (gitleaks)": "gitleaks",
};

export function auditRegistryFidelity(options = {}) {
  const { contract, contract_sha256 } = options.contract
    ? { contract: options.contract, contract_sha256: options.contract_sha256 }
    : loadVerifiedContract(options);
  const registry = buildParityRegistry({ contract, contract_sha256 });
  const problems = [];
  const byContext = new Map(
    registry.entries
      .filter(e => e.status_context)
      .map(e => [e.status_context, e])
  );

  // Membership fidelity in BOTH directions.
  const eligible = contract.checks
    .filter(isParityEligible)
    .map(c => c.check_id);
  const registered = registry.entries.map(e => e.gate_id);
  for (const id of eligible) {
    if (!registered.includes(id)) problems.push(`SILENT_OMISSION: ${id}`);
  }
  for (const id of registered) {
    if (!eligible.includes(id)) problems.push(`SILENT_EXTRA: ${id}`);
  }

  // Field-by-field fidelity against the contract.
  const byId = new Map(contract.checks.map(check => [check.check_id, check]));
  for (const entry of registry.entries) {
    const check = byId.get(entry.gate_id);
    const compare = (field, a, b) => {
      if (JSON.stringify(a) !== JSON.stringify(b)) {
        problems.push(`FIELD_DRIFT ${entry.gate_id}.${field}`);
      }
    };
    compare("runnability", entry.runnability, check.runnability);
    compare("status_context", entry.status_context, check.status_context);
    compare("workflow", entry.workflow, check.workflow);
    compare("job_id", entry.job_id, check.job_id);
    compare("step_count", entry.step_count, check.step_count);
    compare(
      "required_tools",
      [...entry.required_tools],
      [...(check.required_tools ?? [])]
    );
    compare(
      "ci_only_reasons",
      [...entry.ci_only_reasons],
      [...(check.ci_only_reasons ?? [])]
    );
    compare("steps", entry.steps, check.steps);
  }

  // Every currently-required context represented exactly once.
  for (const context of REQUIRED_CONTEXTS) {
    const matches = registry.entries.filter(e => e.status_context === context);
    if (matches.length !== 1) {
      problems.push(
        `REQUIRED_CONTEXT_NOT_REPRESENTED: ${context} (${matches.length})`
      );
    }
  }

  // DEF-017 regression: these must remain locally reproducible.
  for (const [context, expected] of Object.entries(DEF017_ANCHORS)) {
    const entry = byContext.get(context);
    if (!entry) {
      problems.push(`DEF017_ANCHOR_MISSING: ${context}`);
    } else if (entry.runnability !== expected) {
      problems.push(
        `DEF017_REGRESSION: ${context} is ${entry.runnability}, expected ${expected}`
      );
    }
  }

  // DEF-018 regression: these must still declare their external tool.
  for (const [context, tool] of Object.entries(DEF018_ANCHORS)) {
    const entry = byContext.get(context);
    if (!entry) {
      problems.push(`DEF018_ANCHOR_MISSING: ${context}`);
    } else if (!entry.required_tools.includes(tool)) {
      problems.push(
        `DEF018_REGRESSION: ${context} lost its ${tool} requirement (tools=[${entry.required_tools.join(",")}])`
      );
    }
  }

  // A CI-ONLY entry without a reason is an impossible classification.
  for (const entry of registry.entries) {
    if (entry.runnability === "CI-ONLY" && entry.ci_only_reasons.length === 0) {
      problems.push(`CI_ONLY_WITHOUT_REASON: ${entry.gate_id}`);
    }
  }

  return {
    ok: problems.length === 0,
    problems,
    contract_sha256,
    parity_entries: registry.entries.length,
    out_of_scope: registry.out_of_scope.length,
    required: registry.entries.filter(e => e.required).length,
    graduating: registry.entries.filter(e => e.graduating).length,
  };
}

// ---------------------------------------------------------------------------
// P03.AUD02 — runtime YAML isolation.
// ---------------------------------------------------------------------------
export const P03_RUNTIME_MODULES = [
  "scripts/ci/result.mjs",
  "scripts/ci/registry.mjs",
  "scripts/ci/reporter.mjs",
  "scripts/ci/p03-audit.mjs",
];

/** Legitimate YAML readers, each with a written reason. */
export const YAML_READER_ALLOWLIST = [
  {
    file: "scripts/ci/contract-extract.mjs",
    reason:
      "P02 extraction is the designated and only YAML-reading boundary; it produces the frozen contract that P03+ consumes.",
  },
  {
    file: "scripts/ci/contract-conformance.mjs",
    reason:
      "Re-derives workflow source hashes for drift detection. It reads workflow BYTES and never parses YAML.",
  },
  {
    file: "scripts/ci/selftest/placement.mjs",
    reason:
      "P05.T02 must NAME the GitHub workflows directory as a sensitive root " +
      "in order to refuse fixture material there. It declares paths to " +
      "protect and never opens, reads, or parses a workflow.",
  },
  {
    file: "scripts/ci/selftest/p05-audit.mjs",
    reason:
      "P05.AUD02's isolation table must NAME the YAML-parsing patterns it " +
      "forbids P05 from using. It parses no YAML.",
  },
];

export const YAML_PATTERNS = [
  { id: "yaml-import", re: /from\s+["']yaml["']|require\(["']yaml["']\)/ },
  {
    id: "js-yaml-import",
    re: /from\s+["']js-yaml["']|require\(["']js-yaml["']\)/,
  },
  { id: "workflow-path", re: /\.github\/workflows/ },
  { id: "yaml-parse-call", re: /\bparseDocument\b|\byamlParse\b/ },
];

function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map(line => line.replace(/(^|[^:])\/\/.*$/, "$1"))
    .join("\n");
}

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry.startsWith(".")) continue;
    const abs = path.join(dir, entry);
    if (statSync(abs).isDirectory()) walk(abs, out);
    else out.push(abs);
  }
  return out;
}

export function auditP03YamlIsolation(options = {}) {
  const root = options.root ?? REPO_ROOT;
  const scanDir = path.join(root, options.scanDir ?? "scripts/ci");
  const violations = [];
  const notes = [];
  const scanned = [];
  const runtimeSet = new Set(options.runtimeModules ?? P03_RUNTIME_MODULES);

  for (const abs of walk(scanDir)) {
    const rel = path.relative(root, abs);
    const allow = YAML_READER_ALLOWLIST.find(entry => entry.file === rel);
    const kind = allow
      ? "allowlisted-extractor"
      : runtimeSet.has(rel)
        ? "p03-runtime"
        : /\.(test|spec)\.(ts|mts|js|mjs)$/.test(rel)
          ? "test"
          : /\.(mjs|js|ts|mts)$/.test(rel)
            ? "other-runtime"
            : "data";
    scanned.push({ file: rel, kind });
    if (kind === "allowlisted-extractor" || kind === "data") continue;

    const source = stripComments(readFileSync(abs, "utf8"));
    const lines = source.split("\n");
    for (const pattern of YAML_PATTERNS) {
      for (let i = 0; i < lines.length; i += 1) {
        if (!pattern.re.test(lines[i])) continue;
        const record = { file: rel, line: i + 1, pattern: pattern.id, kind };
        if (kind === "p03-runtime" || kind === "other-runtime")
          violations.push(record);
        else notes.push(record);
      }
    }
  }
  return {
    ok: violations.length === 0,
    violations,
    notes,
    scanned,
    allowlist: YAML_READER_ALLOWLIST,
    counts: scanned.reduce((acc, item) => {
      acc[item.kind] = (acc[item.kind] ?? 0) + 1;
      return acc;
    }, {}),
  };
}

function main() {
  const fidelity = auditRegistryFidelity();
  console.log(
    `[p03-audit] contract sha256 ${fidelity.contract_sha256}\n` +
      `[p03-audit] PARITY entries=${fidelity.parity_entries} out_of_scope=${fidelity.out_of_scope} ` +
      `required=${fidelity.required} graduating=${fidelity.graduating}`
  );
  for (const [context, expected] of Object.entries(DEF017_ANCHORS)) {
    console.log(`[p03-audit] DEF-017 anchor ${context} => ${expected}`);
  }
  for (const [context, tool] of Object.entries(DEF018_ANCHORS)) {
    console.log(`[p03-audit] DEF-018 anchor ${context} => requires ${tool}`);
  }
  if (!fidelity.ok) {
    console.error(
      "[p03-audit] FAIL — registry is not a faithful projection of the contract:"
    );
    for (const problem of fidelity.problems) console.error(`  ${problem}`);
    process.exitCode = 1;
    return;
  }
  console.log(
    "[p03-audit] AUD01 PASS — PARITY registry faithful to the frozen contract"
  );

  const isolation = auditP03YamlIsolation();
  console.log(
    `[p03-audit] scanned ${isolation.scanned.length} file(s): ` +
      Object.entries(isolation.counts)
        .map(([k, v]) => `${k}=${v}`)
        .join(" ")
  );
  for (const entry of isolation.allowlist) {
    console.log(`[p03-audit] allowlisted ${entry.file} — ${entry.reason}`);
  }
  for (const note of isolation.notes) {
    console.log(
      `[p03-audit] note (${note.kind}) ${note.file}:${note.line} ${note.pattern}`
    );
  }
  if (!isolation.ok) {
    console.error("[p03-audit] FAIL — runtime module reads workflow YAML:");
    for (const v of isolation.violations) {
      console.error(`  ${v.file}:${v.line} ${v.pattern} (${v.kind})`);
    }
    process.exitCode = 1;
    return;
  }
  console.log(
    "[p03-audit] AUD02 PASS — no P03 runtime module parses workflow YAML"
  );
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
) {
  try {
    main();
  } catch (error) {
    console.error(`[p03-audit] ${error.reason ?? error.message}`);
    if (error.reason) console.error(JSON.stringify({ ...error }, null, 2));
    process.exitCode = 1;
  }
}
