#!/usr/bin/env node
/**
 * contract-conformance.mjs — P02.T07 / P02.T08 / P02.AUD01.
 *
 * Conformance INDEPENDENTLY re-derives current workflow identity and compares
 * it against the frozen contract. It never regenerates the contract or its
 * hash to make the files agree — that would convert drift detection into drift
 * laundering. A mismatch is CONTRACT_DRIFT and nothing else.
 *
 * Subcommands:
 *   verify   conformance (P02.T07 / P02.CONF01)
 *   render   regenerate docs/verification/CONTRACT.md from the machine contract
 *   doc      rendered-document conformance (P02.CONF02)
 *   audit    runtime YAML-isolation audit (P02.AUD01)
 */
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CONTRACT_PATH,
  CONTRACT_SHA_PATH,
  CANONICALIZER_VERSION,
  SCHEMA_VERSION,
  REPO_ROOT,
  WORKFLOW_DIR,
  discoverWorkflows,
  parserVersion,
  sha256,
} from "./contract-extract.mjs";

export const DOC_PATH = path.join(REPO_ROOT, "docs/verification/CONTRACT.md");

/**
 * Contexts enforced today and contexts still graduating, from the P00.T02
 * measurement of ruleset 18701573. Ruleset state and workflow existence are
 * DIFFERENT facts and are never conflated: this list says what GitHub requires,
 * the contract says what the repository contains.
 */
export const REQUIRED_CONTEXTS = [
  "Security Audit",
  "TypeScript Check",
  "Vitest",
  "Secret Scan (gitleaks)",
  "01-pr-proof-contract",
  "05-workflow-security",
  "06-dependency-review",
  "08-contract-and-data-integrity",
  "10-ai-eval-critical",
];

export const GRADUATING_CONTEXTS = [
  "02-codeql",
  "03-semgrep-blocking",
  "07-coverage-patch",
  "09-artifact-build-and-smoke",
  "11-artifact-attestation",
];

export function loadContract(contractPath = CONTRACT_PATH) {
  return JSON.parse(readFileSync(contractPath, "utf8"));
}

export function verifyConformance(options = {}) {
  const root = options.root ?? REPO_ROOT;
  const contractPath = options.contractPath ?? CONTRACT_PATH;
  const shaPath = options.shaPath ?? CONTRACT_SHA_PATH;
  const problems = [];

  const bytes = readFileSync(contractPath);
  const contract = JSON.parse(bytes.toString("utf8"));

  // --- integrity pin (P02.T06) -------------------------------------------
  const pinned = readFileSync(shaPath, "utf8").trim().split(/\s+/)[0];
  const actual = sha256(bytes);
  if (pinned !== actual) {
    problems.push(
      `CONTRACT_DRIFT: contract.sha256 pin ${pinned.slice(0, 12)} != actual ${actual.slice(0, 12)}`
    );
  }

  // --- versions -----------------------------------------------------------
  if (contract.schema_version !== SCHEMA_VERSION) {
    problems.push(
      `SCHEMA_VERSION_UNSUPPORTED: ${contract.schema_version} != ${SCHEMA_VERSION}`
    );
  }
  if (contract.canonicalizer_version !== CANONICALIZER_VERSION) {
    problems.push(
      `CANONICALIZER_VERSION_MISMATCH: ${contract.canonicalizer_version} != ${CANONICALIZER_VERSION}`
    );
  }
  let currentParser = null;
  try {
    currentParser = parserVersion(options.toolchainRoot ?? REPO_ROOT);
  } catch (error) {
    problems.push(`PARSER_PIN_PROBLEM: ${error.reason ?? error.message}`);
  }
  if (currentParser && contract.parser_version !== currentParser) {
    problems.push(
      `PARSER_VERSION_MISMATCH: contract ${contract.parser_version} != installed ${currentParser}`
    );
  }

  // --- corpus coverage, both directions -----------------------------------
  const present = new Set(discoverWorkflows(root));
  const expected = new Map(
    contract.generated_from.workflows.map(w => [w.path, w])
  );
  for (const [rel, entry] of expected) {
    if (!present.has(rel)) {
      problems.push(
        `CONTRACT_DRIFT: workflow expected by the contract is missing: ${rel}`
      );
      continue;
    }
    const raw = sha256(readFileSync(path.join(root, rel)));
    if (raw !== entry.raw_sha256) {
      problems.push(
        `CONTRACT_DRIFT: ${rel} changed without contract regeneration ` +
          `(contract ${entry.raw_sha256.slice(0, 12)}, actual ${raw.slice(0, 12)})`
      );
    }
  }
  for (const rel of present) {
    if (!expected.has(rel)) {
      problems.push(
        `CONTRACT_DRIFT: workflow present but not represented: ${rel}`
      );
    }
  }

  // --- required-context mapping -------------------------------------------
  const byContext = new Map();
  for (const check of contract.checks) {
    if (!check.status_context) continue;
    if (!byContext.has(check.status_context))
      byContext.set(check.status_context, []);
    byContext.get(check.status_context).push(check.check_id);
  }
  for (const context of REQUIRED_CONTEXTS) {
    const mapped = byContext.get(context) ?? [];
    if (mapped.length === 0) {
      problems.push(
        `REQUIRED_CONTEXT_UNMAPPED: "${context}" has no contract check`
      );
    } else if (mapped.length > 1) {
      problems.push(
        `REQUIRED_CONTEXT_AMBIGUOUS: "${context}" maps to ${mapped.length}: ${mapped.join(", ")}`
      );
    }
  }
  for (const context of GRADUATING_CONTEXTS) {
    if ((byContext.get(context) ?? []).length !== 1) {
      problems.push(`GRADUATING_CONTEXT_UNMAPPED: "${context}"`);
    }
  }

  // --- CI-only reasons are mandatory --------------------------------------
  for (const check of contract.checks) {
    if (
      check.runnability === "CI-ONLY" &&
      !(check.ci_only_reasons ?? []).length
    ) {
      problems.push(`CI_ONLY_WITHOUT_REASON: ${check.check_id}`);
    }
  }

  return { ok: problems.length === 0, problems, contract };
}

// ---------------------------------------------------------------------------
// P02.T08 — CONTRACT.md rendered from the machine contract.
// ---------------------------------------------------------------------------
export function renderDoc(contract) {
  const lines = [];
  const push = (...xs) => lines.push(...xs);
  push("# Verification contract — machine-derived");
  push("");
  push(
    "> GENERATED FILE. Do not edit by hand. Rendered from",
    "> `scripts/ci/contract.frozen.json` by `scripts/ci/contract-conformance.mjs render`.",
    "> Rendered-document conformance (P02.CONF02) fails if this file and the",
    "> machine contract disagree."
  );
  push("");
  push("## What P02 certifies");
  push("");
  push(
    "P02 extraction is the ONLY boundary in the verifier that reads workflow",
    "YAML. Runtime verification consumes `contract.frozen.json` and never parses",
    "`.github/workflows/*.yml`. That isolation is enforced by an audit, not by",
    "convention."
  );
  push("");
  push("| Field | Value |");
  push("| --- | --- |");
  push(`| schema_version | \`${contract.schema_version}\` |`);
  push(`| parser_version | \`${contract.parser_version}\` |`);
  push(`| canonicalizer_version | \`${contract.canonicalizer_version}\` |`);
  push(`| workflows | ${contract.generated_from.workflow_count} |`);
  push(
    `| jobs / checks | ${contract.generated_from.job_count} / ${contract.checks.length} |`
  );
  push(`| steps represented | ${contract.generated_from.step_count} |`);
  push("");
  push("## Runnability");
  push("");
  push(
    "Runnability answers: can the LOCAL verifier reproduce this check's",
    'VERIFICATION VALUE? It is not "would every step succeed locally" —',
    "reporting sinks such as artifact and SARIF upload are represented but",
    "excluded from the verdict."
  );
  push("");
  push("| Class | Count |");
  push("| --- | --- |");
  for (const key of Object.keys(contract.runnability_summary).sort()) {
    push(`| \`${key}\` | ${contract.runnability_summary[key]} |`);
  }
  push("");
  push("## Required status contexts (enforced today)");
  push("");
  push("| Context | Check | Runnability | Tools |");
  push("| --- | --- | --- | --- |");
  const byContext = new Map(
    contract.checks
      .filter(c => c.status_context)
      .map(c => [c.status_context, c])
  );
  for (const context of REQUIRED_CONTEXTS) {
    const check = byContext.get(context);
    push(
      `| \`${context}\` | \`${check?.check_id ?? "UNMAPPED"}\` | ${check?.runnability ?? "—"} | ${(check?.required_tools ?? []).join(", ") || "—"} |`
    );
  }
  push("");
  push("## Graduating contexts (represented, NOT currently required)");
  push("");
  push("| Context | Check | Runnability |");
  push("| --- | --- | --- |");
  for (const context of GRADUATING_CONTEXTS) {
    const check = byContext.get(context);
    push(
      `| \`${context}\` | \`${check?.check_id ?? "UNMAPPED"}\` | ${check?.runnability ?? "—"} |`
    );
  }
  push("");
  push("## Construct allowlist");
  push("");
  push(
    "Derived from the `yaml@2.9.0` census of the current corpus. There is no",
    "implicit ignored class: an unclassified construct aborts generation with",
    "`CONTRACT_GENERATION_FAILED`."
  );
  push("");
  push("| Category | Construct | Classification | Note |");
  push("| --- | --- | --- | --- |");
  for (const category of Object.keys(contract.construct_allowlist).sort()) {
    for (const key of Object.keys(
      contract.construct_allowlist[category]
    ).sort()) {
      const [cls, note] = contract.construct_allowlist[category][key];
      push(`| ${category} | \`${key}\` | ${cls} | ${note} |`);
    }
  }
  push("");
  push("## CI-only capabilities");
  push("");
  push("| Action | Reason it cannot be reproduced locally |");
  push("| --- | --- |");
  for (const action of Object.keys(contract.ci_only_actions).sort()) {
    push(`| \`${action}\` | ${contract.ci_only_actions[action]} |`);
  }
  push("");
  push("## Workflow source identities");
  push("");
  push("| Workflow | raw sha256 | canonical sha256 |");
  push("| --- | --- | --- |");
  for (const wf of contract.generated_from.workflows) {
    push(
      `| \`${wf.path.replace(`${WORKFLOW_DIR}/`, "")}\` | \`${wf.raw_sha256.slice(0, 16)}\` | \`${wf.canonical_sha256.slice(0, 16)}\` |`
    );
  }
  push("");
  push("## Regeneration and failure semantics");
  push("");
  push("```");
  push("node scripts/ci/contract-extract.mjs emit --root <candidate-worktree>");
  push("node scripts/ci/contract-conformance.mjs verify");
  push("node scripts/ci/contract-conformance.mjs render");
  push("```");
  push("");
  push("| Condition | Result |");
  push("| --- | --- |");
  push(
    "| unclassified construct | `CONTRACT_GENERATION_FAILED`, no partial write, prior artifact preserved |"
  );
  push(
    "| workflow changed without regeneration | `CONTRACT_DRIFT`, naming the workflow |"
  );
  push(
    "| hand-edited `contract.frozen.json` | pin mismatch, `CONTRACT_DRIFT` |"
  );
  push(
    "| required context with no mapped check | `REQUIRED_CONTEXT_UNMAPPED`, naming the context |"
  );
  push(
    "| runtime module parsing workflow YAML | audit failure, blocks acceptance |"
  );
  push("");
  return `${lines.join("\n")}`;
}

// ---------------------------------------------------------------------------
// P02.AUD01 — runtime YAML isolation.
// ---------------------------------------------------------------------------
export const YAML_ALLOWLIST = [
  {
    file: "scripts/ci/contract-extract.mjs",
    reason:
      "P02 extraction is the designated and only YAML-reading boundary; it " +
      "produces the frozen contract that every runtime stage consumes.",
  },
  {
    file: "scripts/ci/contract-conformance.mjs",
    reason:
      "Names the workflow directory to re-derive source hashes. It reads " +
      "workflow BYTES for hashing and never parses YAML.",
  },
];

export const YAML_PATTERNS = [
  { id: "yaml-import", re: /from\s+["']yaml["']|require\(["']yaml["']\)/ },
  {
    id: "js-yaml-import",
    re: /from\s+["']js-yaml["']|require\(["']js-yaml["']\)/,
  },
  { id: "workflow-glob", re: /\.github\/workflows/ },
  { id: "yaml-parse-call", re: /\byamlParse\b|\bparseDocument\b/ },
];

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry.startsWith(".")) continue;
    const abs = path.join(dir, entry);
    if (statSync(abs).isDirectory()) walk(abs, out);
    else out.push(abs);
  }
  return out;
}

export function auditYamlIsolation(options = {}) {
  const root = options.root ?? REPO_ROOT;
  const scanDir = path.join(root, options.scanDir ?? "scripts/ci");
  const violations = [];
  const notes = [];
  const scanned = [];
  for (const abs of walk(scanDir)) {
    const rel = path.relative(root, abs);
    const allow = YAML_ALLOWLIST.find(entry => entry.file === rel);
    const kind = allow
      ? "allowlisted-extractor"
      : /\.(test|spec)\.(ts|mts|js|mjs)$/.test(rel)
        ? "test"
        : /\.(mjs|js|ts|mts)$/.test(rel)
          ? "runtime"
          : "data";
    scanned.push({ file: rel, kind });
    if (kind !== "runtime" && kind !== "test") continue;
    const source = readFileSync(abs, "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .map(line => line.replace(/(^|[^:])\/\/.*$/, "$1"))
      .join("\n");
    for (const pattern of YAML_PATTERNS) {
      const lines = source.split("\n");
      for (let i = 0; i < lines.length; i += 1) {
        if (!pattern.re.test(lines[i])) continue;
        const record = { file: rel, line: i + 1, pattern: pattern.id, kind };
        if (kind === "runtime") violations.push(record);
        else notes.push(record);
      }
    }
  }
  return {
    ok: violations.length === 0,
    violations,
    notes,
    scanned,
    allowlist: YAML_ALLOWLIST,
  };
}

function main() {
  const [command] = process.argv.slice(2);
  if (command === "verify") {
    const result = verifyConformance();
    if (result.ok) {
      console.log(
        `[conformance] PASS — ${result.contract.generated_from.workflow_count} workflows, ` +
          `${result.contract.checks.length} checks, ${REQUIRED_CONTEXTS.length} required contexts mapped`
      );
      return;
    }
    console.error("[conformance] FAIL");
    for (const problem of result.problems) console.error(`  - ${problem}`);
    process.exitCode = 1;
    return;
  }
  if (command === "render") {
    const contract = loadContract();
    writeFileSync(DOC_PATH, renderDoc(contract));
    console.log(`[conformance] rendered ${DOC_PATH}`);
    return;
  }
  if (command === "doc") {
    const contract = loadContract();
    const onDisk = readFileSync(DOC_PATH, "utf8");
    if (onDisk === renderDoc(contract)) {
      console.log(
        "[conformance] PASS — CONTRACT.md matches the machine contract"
      );
      return;
    }
    console.error(
      "[conformance] FAIL — DOC_DRIFT: CONTRACT.md disagrees with contract.frozen.json"
    );
    process.exitCode = 1;
    return;
  }
  if (command === "audit") {
    const result = auditYamlIsolation();
    console.log(
      `[yaml-audit] scanned ${result.scanned.length} file(s); allowlisted ${result.allowlist.length}`
    );
    for (const entry of result.allowlist) {
      console.log(`[yaml-audit] allowlisted ${entry.file} — ${entry.reason}`);
    }
    for (const note of result.notes) {
      console.log(
        `[yaml-audit] note (${note.kind}) ${note.file}:${note.line} ${note.pattern}`
      );
    }
    if (!result.ok) {
      console.error("[yaml-audit] FAIL — runtime module reads workflow YAML:");
      for (const v of result.violations) {
        console.error(`  ${v.file}:${v.line} ${v.pattern}`);
      }
      process.exitCode = 1;
      return;
    }
    console.log(
      "[yaml-audit] PASS — extraction is the only YAML-reading boundary"
    );
    return;
  }
  console.error(`[conformance] UNKNOWN_COMMAND: ${command ?? "(none)"}`);
  process.exitCode = 1;
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
) {
  main();
}
