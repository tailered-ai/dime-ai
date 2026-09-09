#!/usr/bin/env node
/**
 * contract-extract.mjs — P02: the ONLY YAML-reading boundary in the verifier.
 *
 * Runtime verification never parses `.github/workflows/*.yml`. It consumes the
 * frozen contract this module emits. That boundary is enforced by
 * `provenance-audit.mjs` (P01.AUD01 / P02.AUD01), not merely documented.
 *
 * Pipeline: derive -> freeze -> conform.
 *
 *   census      (P02.T01) semantic inventory using the exact-pinned parser
 *   canonicalize(P02.T02) one deterministic representation
 *   hash        (P02.T03) per-workflow source identity
 *   emit        (P02.T04) versioned frozen contract
 *   allowlist   (P02.T05) fail-closed on any unclassified construct
 *   pin         (P02.T06) contract.sha256 over the exact emitted bytes
 *
 * PARSER: `yaml@2.9.0`, pinned exactly in devDependencies. It applies the
 * YAML 1.2 core schema, which is what GitHub Actions expects — verified, not
 * assumed:
 *   `on:`            -> the STRING key "on"  (YAML 1.1 would give boolean true)
 *   yes/no/on/off/y/n -> STRINGS              (YAML 1.1 would give booleans)
 *   true/false        -> booleans
 *   null / ~          -> null
 * These are exercised by the parser regression suite (P02.REG01) rather than
 * discovered accidentally during extraction.
 *
 * FAIL-CLOSED + ATOMIC: generation writes to an owned temporary file, validates
 * completeness, and only then replaces the target. Any unclassified construct
 * aborts with CONTRACT_GENERATION_FAILED and the previous known-good artifact
 * is left untouched.
 */
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse, parseDocument, isAlias, visit } from "yaml";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, "..", "..");

export const SCHEMA_VERSION = "1.0.0";
export const CANONICALIZER_VERSION = "1.0.0";
export const PARSER_NAME = "yaml";
export const WORKFLOW_DIR = ".github/workflows";
export const CONTRACT_PATH = path.join(HERE, "contract.frozen.json");
export const CONTRACT_SHA_PATH = path.join(HERE, "contract.sha256");

/** Terminal state, never a bare string. */
export class ContractStop extends Error {
  constructor(reason, detail = {}) {
    super(reason);
    this.name = "ContractStop";
    this.reason = reason;
    Object.assign(this, detail);
  }
}

export function parserVersion(root = REPO_ROOT) {
  const pkg = JSON.parse(
    readFileSync(path.join(root, "node_modules/yaml/package.json"), "utf8")
  );
  const pinned = JSON.parse(
    readFileSync(path.join(root, "package.json"), "utf8")
  ).devDependencies?.yaml;
  if (pinned !== pkg.version) {
    throw new ContractStop("PARSER_PIN_MISMATCH", {
      pinned,
      resolved: pkg.version,
    });
  }
  if (!/^\d+\.\d+\.\d+$/.test(pinned)) {
    throw new ContractStop("PARSER_PIN_NOT_EXACT", { pinned });
  }
  return `${PARSER_NAME}@${pkg.version}`;
}

export function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

/** Discover the corpus from repository reality. Never a hardcoded count. */
export function discoverWorkflows(root) {
  const dir = path.join(root, WORKFLOW_DIR);
  if (!existsSync(dir)) {
    throw new ContractStop("WORKFLOW_DIR_MISSING", { dir });
  }
  return readdirSync(dir)
    .filter(name => name.endsWith(".yml") || name.endsWith(".yaml"))
    .sort()
    .map(name => `${WORKFLOW_DIR}/${name}`);
}

// ---------------------------------------------------------------------------
// P02.T02 — canonicalization.
//
// Rules, all deliberate and all tested:
//  - MAPPING keys are sorted. YAML mapping order is not semantic for Actions.
//  - SEQUENCES keep their order. `steps`, `needs`, `branches`, matrix values
//    and `uses` argument order ARE semantic and are never sorted.
//  - Scalars keep their parsed type. null / boolean / number / string stay
//    distinct, so `if: true` never collapses into `if: "true"`.
//  - `${{ ... }}` expressions are preserved verbatim inside their strings.
//  - Multiline `run` bodies are preserved byte-for-byte including internal
//    newlines; only a trailing CR is stripped as part of the line-ending rule.
//  - Line endings normalise CRLF -> LF (a checkout artefact, never semantic).
//  - Unicode is preserved and serialized as-is; JSON.stringify escapes are not
//    applied to content, so identical text always canonicalizes identically.
//  - COMMENTS are dropped. They cannot alter Actions behaviour, and keeping
//    them would make the contract churn on prose edits.
//  - ANCHORS/ALIASES are resolved by the parser. Their PRESENCE is detected
//    separately and must be explicitly classified, because an alias makes the
//    canonical form diverge from the source shape.
// ---------------------------------------------------------------------------
export function normalizeScalar(value) {
  if (typeof value !== "string") return value;
  return value.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

export function canonicalize(node) {
  if (Array.isArray(node)) return node.map(canonicalize);
  if (node && typeof node === "object") {
    const out = {};
    for (const key of Object.keys(node).sort())
      out[key] = canonicalize(node[key]);
    return out;
  }
  return normalizeScalar(node);
}

export function canonicalJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/** Anchors/aliases change the relationship between source and canonical form. */
export function detectAliases(source) {
  const doc = parseDocument(source);
  const aliases = [];
  visit(doc, {
    Alias(_key, node) {
      aliases.push(String(node.source));
    },
  });
  return aliases;
}

// ---------------------------------------------------------------------------
// P02.T01 — semantic census.
// ---------------------------------------------------------------------------
const EXPRESSION_ROOT = /\$\{\{\s*([A-Za-z_][A-Za-z0-9_-]*)/g;

function collectExpressionRoots(value, into) {
  if (typeof value === "string") {
    for (const match of value.matchAll(EXPRESSION_ROOT)) into.add(match[1]);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectExpressionRoots(item, into);
    return;
  }
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) collectExpressionRoots(item, into);
  }
}

export function censusWorkflow(relPath, source) {
  const doc = parse(source);
  if (doc === null || typeof doc !== "object") {
    throw new ContractStop("WORKFLOW_NOT_A_MAPPING", { file: relPath });
  }
  const workflowKeys = Object.keys(doc);
  const triggers = [];
  const on = doc.on;
  if (on === null || on === undefined) triggers.push("(none)");
  else if (typeof on === "string") triggers.push(on);
  else if (Array.isArray(on)) triggers.push(...on.map(String));
  else triggers.push(...Object.keys(on));

  const jobKeyCounts = new Map();
  const stepKeyCounts = new Map();
  const shells = new Set();
  const bumpLocal = (map, key) => map.set(key, (map.get(key) ?? 0) + 1);
  const usesRefs = [];
  const reusableWorkflowCalls = [];
  const expressionRoots = new Set();
  collectExpressionRoots(doc, expressionRoots);

  let jobCount = 0;
  let stepCount = 0;
  const jobs = {};
  for (const [jobId, job] of Object.entries(doc.jobs ?? {})) {
    jobCount += 1;
    for (const key of Object.keys(job ?? {})) bumpLocal(jobKeyCounts, key);
    if (job?.uses) reusableWorkflowCalls.push({ job: jobId, uses: job.uses });
    const steps = job?.steps ?? [];
    for (const step of steps) {
      stepCount += 1;
      for (const key of Object.keys(step ?? {})) bumpLocal(stepKeyCounts, key);
      if (step?.shell) shells.add(step.shell);
      if (step?.uses) usesRefs.push(step.uses);
    }
    jobs[jobId] = job;
  }

  return {
    file: relPath,
    workflow_keys: workflowKeys.sort(),
    triggers: [...new Set(triggers)].sort(),
    job_key_counts: Object.fromEntries([...jobKeyCounts].sort()),
    step_key_counts: Object.fromEntries([...stepKeyCounts].sort()),
    shells: [...shells].sort(),
    expression_roots: [...expressionRoots].sort(),
    expression_root_counts: (() => {
      const counts = new Map();
      for (const m of source.matchAll(EXPRESSION_ROOT)) {
        counts.set(m[1], (counts.get(m[1]) ?? 0) + 1);
      }
      return Object.fromEntries([...counts].sort());
    })(),
    uses_refs: usesRefs,
    reusable_workflow_calls: reusableWorkflowCalls,
    aliases: detectAliases(source),
    job_count: jobCount,
    step_count: stepCount,
    jobs,
    doc,
  };
}

/**
 * Two distinct roots, deliberately never conflated:
 *   candidateRoot — the prospective-merge worktree being verified (source only)
 *   toolchainRoot — the installed toolchain the verifier runs WITH (node_modules)
 * The candidate carries no node_modules, so parser identity must come from the
 * toolchain root. Merging the two would either crash or, worse, silently read a
 * parser version from the wrong tree.
 */
export function censusCorpus(candidateRoot, options = {}) {
  const toolchainRoot = options.toolchainRoot ?? REPO_ROOT;
  const root = candidateRoot;
  const files = discoverWorkflows(root);
  const perFile = [];
  const totals = {
    workflow_keys: new Map(),
    triggers: new Map(),
    job_keys: new Map(),
    step_keys: new Map(),
    shells: new Map(),
    expression_roots: new Map(),
  };
  const bump = (map, key) => map.set(key, (map.get(key) ?? 0) + 1);
  let jobs = 0;
  let steps = 0;
  let shaPinned = 0;
  let unpinned = 0;
  const aliasFiles = [];

  for (const rel of files) {
    const source = readFileSync(path.join(root, rel), "utf8");
    const entry = censusWorkflow(rel, source);
    jobs += entry.job_count;
    steps += entry.step_count;
    for (const key of entry.workflow_keys) bump(totals.workflow_keys, key);
    for (const key of entry.triggers) bump(totals.triggers, key);
    // Occurrence sums (per job / per step / per expression match), matching the
    // P00 methodology so the two parsers are comparable like-for-like.
    for (const [key, n] of Object.entries(entry.job_key_counts)) {
      totals.job_keys.set(key, (totals.job_keys.get(key) ?? 0) + n);
    }
    for (const [key, n] of Object.entries(entry.step_key_counts)) {
      totals.step_keys.set(key, (totals.step_keys.get(key) ?? 0) + n);
    }
    for (const key of entry.shells) bump(totals.shells, key);
    for (const [key, n] of Object.entries(entry.expression_root_counts)) {
      totals.expression_roots.set(
        key,
        (totals.expression_roots.get(key) ?? 0) + n
      );
    }
    for (const ref of entry.uses_refs) {
      if (/@[0-9a-f]{40}$/.test(ref)) shaPinned += 1;
      else unpinned += 1;
    }
    if (entry.aliases.length) aliasFiles.push(rel);
    perFile.push(entry);
  }

  const asObject = map =>
    Object.fromEntries(
      [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]))
    );

  return {
    parser: parserVersion(toolchainRoot),
    candidate_root_is_toolchain_root:
      path.resolve(candidateRoot) === path.resolve(toolchainRoot),
    files,
    file_count: files.length,
    job_count: jobs,
    step_count: steps,
    uses_sha_pinned: shaPinned,
    uses_unpinned: unpinned,
    alias_files: aliasFiles,
    workflow_keys: asObject(totals.workflow_keys),
    triggers: asObject(totals.triggers),
    job_keys: asObject(totals.job_keys),
    step_keys: asObject(totals.step_keys),
    shells: asObject(totals.shells),
    expression_roots: asObject(totals.expression_roots),
    per_file: perFile,
  };
}

// ---------------------------------------------------------------------------
// P02.T05 — construct allowlist. DERIVED from the yaml@2.9.0 census of the
// current corpus, never guessed. Every observed construct must be classified.
// There is deliberately NO implicit "ignored" class: an unknown construct
// aborts generation.
// ---------------------------------------------------------------------------
export const SUPPORTED = "SUPPORTED";
export const SUPPORTED_NORMALIZED = "SUPPORTED_WITH_EXPLICIT_NORMALIZATION";
export const CI_ONLY_REPRESENTED = "CI_ONLY_BUT_REPRESENTED";

export const CONSTRUCT_ALLOWLIST = {
  workflow_keys: {
    name: [SUPPORTED, "workflow display name"],
    on: [SUPPORTED, "trigger map; YAML 1.2 keeps `on` a string key"],
    jobs: [SUPPORTED, "job map"],
    permissions: [SUPPORTED, "GITHUB_TOKEN scope, security-relevant"],
    concurrency: [SUPPORTED, "cancellation group"],
    env: [SUPPORTED, "workflow-level environment"],
  },
  triggers: {
    pull_request: [SUPPORTED, "PR gate; checks out refs/pull/N/merge"],
    push: [SUPPORTED, "post-merge validation"],
    schedule: [
      CI_ONLY_REPRESENTED,
      "cron is GitHub-scheduled; represented, never run locally",
    ],
    workflow_dispatch: [CI_ONLY_REPRESENTED, "manual GitHub dispatch surface"],
    merge_group: [
      CI_ONLY_REPRESENTED,
      "merge queue; INERT — queue not enabled (P00.T01)",
    ],
  },
  job_keys: {
    "runs-on": [SUPPORTED, "runner selection"],
    steps: [SUPPORTED, "ordered step list"],
    name: [SUPPORTED, "job display name; becomes the status context"],
    "timeout-minutes": [SUPPORTED, "job timeout"],
    permissions: [SUPPORTED, "job token scope"],
    environment: [
      CI_ONLY_REPRESENTED,
      "protected GitHub environment; secrets binding",
    ],
    env: [SUPPORTED, "job environment"],
    needs: [SUPPORTED, "ordered dependency list"],
    if: [SUPPORTED, "conditional execution"],
    strategy: [SUPPORTED, "matrix expansion"],
    defaults: [SUPPORTED, "default shell / working-directory"],
    services: [SUPPORTED, "service containers"],
  },
  step_keys: {
    name: [SUPPORTED, "step display name"],
    run: [SUPPORTED, "shell command; multiline preserved verbatim"],
    uses: [SUPPORTED, "action reference; SHA pinning enforced elsewhere"],
    with: [SUPPORTED, "action inputs"],
    env: [SUPPORTED, "step environment"],
    if: [SUPPORTED, "conditional execution"],
    id: [SUPPORTED, "step id for outputs"],
  },
  expression_roots: {
    github: [SUPPORTED, "github context"],
    inputs: [SUPPORTED, "workflow_dispatch inputs"],
    matrix: [SUPPORTED, "matrix context"],
    steps: [SUPPORTED, "step outputs"],
    vars: [SUPPORTED, "repository variables"],
    secrets: [
      CI_ONLY_REPRESENTED,
      "repository secrets are structurally unavailable locally",
    ],
    success: [
      SUPPORTED_NORMALIZED,
      "status FUNCTION success(), not a context; matched by the root regex and classified explicitly",
    ],
  },
};

/** Actions that require a GitHub-platform capability. Reason is mandatory. */
export const CI_ONLY_ACTIONS = {
  "github/codeql-action/init":
    "CodeQL database creation is a GitHub code-scanning capability",
  "github/codeql-action/analyze":
    "CodeQL analysis + alert attribution is GitHub-side",
  "github/codeql-action/upload-sarif":
    "SARIF upload targets the GitHub Security tab",
  "actions/dependency-review-action":
    "compares PR dependency graphs via the GitHub API",
  "actions/attest-build-provenance": "requires GitHub OIDC provenance signing",
  "ossf/scorecard-action":
    "queries GitHub repository metadata and publishes results",
  "dependabot/fetch-metadata":
    "reads Dependabot PR metadata from the GitHub API",
  "actions/upload-artifact": "GitHub artifact storage",
};

/**
 * DEF-017: artifact storage is a SIDE EFFECT, never a verdict. A step using one
 * of these is represented in the contract and classified CI-ONLY at STEP level,
 * but it does not make the CHECK unreproducible locally.
 */
export const NON_GATING_ACTIONS = new Set([
  "actions/upload-artifact",
  "actions/download-artifact",
  // A SARIF upload is a REPORTING SINK to the GitHub Security tab. The
  // verification value of the check is produced by the scanner step that runs
  // before it (zizmor, trivy); uploading adds nothing a local run needs.
  // CodeQL is unaffected: its verdict comes from init+analyze, which carry no
  // local equivalent and keep 02-codeql correctly CI-ONLY.
  "github/codeql-action/upload-sarif",
]);

/**
 * RUNNABILITY, defined precisely so later phases cannot reinterpret it:
 * can the LOCAL verifier reproduce this check's VERIFICATION VALUE?
 *   LOCAL       — yes, with the repository toolchain alone
 *   LOCAL+TOOL  — yes, with an additional pinned external tool
 *   CI-ONLY     — no; the verdict depends on a GitHub-platform capability or a
 *                 repository secret that is structurally unavailable locally
 * It is NOT "would every step in this job succeed locally". Reporting sinks are
 * represented but excluded from the verdict (DEF-017).
 */

/** Steps whose execution needs a tool that is not part of the repo toolchain. */
export const TOOL_SIGNATURES = [
  [/pipx install "?semgrep/, "semgrep"],
  [/pipx install "?zizmor/, "zizmor"],
  [/osv-scanner/, "osv-scanner"],
  [/docker build|docker run/, "docker"],
  [/gitleaks/, "gitleaks"],
  [/trivy/, "trivy"],
  [/playwright install/, "playwright-browsers"],
];

export function classifyStep(step) {
  const action = String(step?.uses ?? "").split("@")[0];
  // DEF-018: match RAW text. JSON.stringify escapes quotes, so
  // `install "zizmor` became `install \"zizmor` and tool patterns stopped
  // matching — silently reporting a gate as needing no external tool.
  const text = [String(step?.run ?? ""), String(step?.uses ?? "")].join("\n");
  if (action && CI_ONLY_ACTIONS[action]) {
    return {
      runnability: "CI-ONLY",
      reason: `${action}: ${CI_ONLY_ACTIONS[action]}`,
      gating: !NON_GATING_ACTIONS.has(action),
    };
  }
  const tools = new Set();
  for (const [re, tool] of TOOL_SIGNATURES) if (re.test(text)) tools.add(tool);
  if (tools.size) {
    return {
      runnability: "LOCAL+TOOL",
      required_tools: [...tools].sort(),
      gating: true,
    };
  }
  return { runnability: "LOCAL", gating: true };
}

/**
 * Check-level runnability = worst case over GATING steps, plus job-level
 * causes. DEF-017: a non-gating side-effect step never makes a check CI-ONLY.
 */
export function classifyRunnability(job, jobSource) {
  const jobReasons = [];
  if (job?.environment) {
    jobReasons.push(
      `binds protected environment '${typeof job.environment === "string" ? job.environment : JSON.stringify(job.environment)}'`
    );
  }
  const secretRefs = [...jobSource.matchAll(/secrets\.([A-Z0-9_]+)/g)]
    .map(m => m[1])
    .filter(n => n !== "GITHUB_TOKEN");
  if (secretRefs.length) {
    jobReasons.push(
      `references repository secret(s): ${[...new Set(secretRefs)].join(", ")}`
    );
  }

  const stepClasses = (job?.steps ?? []).map(classifyStep);
  const gating = stepClasses.filter(s => s.gating);
  const nonGating = stepClasses.filter(s => !s.gating);
  const stepReasons = gating
    .filter(s => s.runnability === "CI-ONLY")
    .map(s => s.reason);
  const reasons = [...new Set([...jobReasons, ...stepReasons])];

  const tools = [
    ...new Set(gating.flatMap(s => s.required_tools ?? [])),
  ].sort();

  let runnability = "LOCAL";
  if (reasons.length) runnability = "CI-ONLY";
  else if (tools.length) runnability = "LOCAL+TOOL";

  return {
    runnability,
    ...(reasons.length ? { ci_only_reasons: reasons } : {}),
    ...(tools.length ? { required_tools: tools } : {}),
    non_gating_step_count: nonGating.length,
    non_gating_reasons: [...new Set(nonGating.map(s => s.reason))],
    step_runnability: stepClasses.map(s => s.runnability),
  };
}

// ---------------------------------------------------------------------------
// P02.T03 / P02.T04 — per-workflow identity and the frozen contract.
// ---------------------------------------------------------------------------
const DYNAMIC = /\$\{\{/;

export function buildChecks(census, root) {
  const checks = [];
  for (const entry of census.per_file) {
    const rawSource = readFileSync(path.join(root, entry.file), "utf8");
    // GHA's env cascade is workflow ∪ job ∪ step (later layer wins). The
    // contract's per-check `env` must therefore fold the workflow-level env:
    // block under the job's — capturing only job?.env dropped
    // EXPECTED_CLOUDFLARE_OS_PIN and turned a correct submodule pin into a
    // detector FAIL (DEF-058).
    const workflowEnv = entry.doc?.env ?? null;
    for (const [jobId, job] of Object.entries(entry.jobs)) {
      const jobSource = JSON.stringify(job);
      const contextName = job?.name ?? jobId;
      const dynamic = DYNAMIC.test(String(contextName));
      const steps = (job?.steps ?? []).map((step, index) => ({
        index,
        name: step?.name ?? null,
        id: step?.id ?? null,
        uses: step?.uses ?? null,
        run: step?.run ?? null,
        with: step?.with ?? null,
        env: step?.env ?? null,
        if: step?.if ?? null,
      }));
      checks.push({
        check_id: `${entry.file}#${jobId}`,
        workflow: entry.file,
        job_id: jobId,
        status_context: dynamic ? null : String(contextName),
        status_context_dynamic: dynamic,
        status_context_template: dynamic ? String(contextName) : null,
        ...classifyRunnability(job, jobSource + rawSource.slice(0, 0)),
        runs_on: job?.["runs-on"] ?? null,
        needs: job?.needs ?? null,
        if: job?.if ?? null,
        timeout_minutes: job?.["timeout-minutes"] ?? null,
        permissions: job?.permissions ?? null,
        environment: job?.environment ?? null,
        env:
          workflowEnv || job?.env
            ? { ...(workflowEnv ?? {}), ...(job?.env ?? {}) }
            : null,
        defaults: job?.defaults ?? null,
        services: job?.services ?? null,
        strategy: job?.strategy ?? null,
        step_count: steps.length,
        steps,
      });
    }
  }
  return checks.sort((a, b) => a.check_id.localeCompare(b.check_id));
}

export function assertConstructsAllowlisted(census) {
  const unknown = [];
  const check = (category, observed) => {
    for (const key of Object.keys(observed)) {
      if (!CONSTRUCT_ALLOWLIST[category]?.[key])
        unknown.push(`${category}.${key}`);
    }
  };
  check("workflow_keys", census.workflow_keys);
  check("triggers", census.triggers);
  check("job_keys", census.job_keys);
  check("step_keys", census.step_keys);
  check("expression_roots", census.expression_roots);
  if (census.alias_files.length) {
    unknown.push(`anchors_aliases in ${census.alias_files.join(", ")}`);
  }
  if (Object.keys(census.shells).length) {
    for (const shell of Object.keys(census.shells))
      unknown.push(`shell.${shell}`);
  }
  if (unknown.length) {
    throw new ContractStop("CONTRACT_GENERATION_FAILED", {
      unclassified_constructs: unknown,
      remedy:
        "Classify each construct in CONSTRUCT_ALLOWLIST as SUPPORTED, " +
        "SUPPORTED_WITH_EXPLICIT_NORMALIZATION, or CI_ONLY_BUT_REPRESENTED. " +
        "There is no implicit ignored class.",
    });
  }
  return true;
}

export function buildContract(candidateRoot, options = {}) {
  const toolchainRoot = options.toolchainRoot ?? REPO_ROOT;
  const census = censusCorpus(candidateRoot, { toolchainRoot });
  assertConstructsAllowlisted(census);

  const workflows = census.files.map(rel => {
    const bytes = readFileSync(path.join(candidateRoot, rel));
    const canonical = canonicalJson(
      canonicalize(parse(bytes.toString("utf8")))
    );
    return {
      path: rel,
      raw_sha256: sha256(bytes),
      canonical_sha256: sha256(Buffer.from(canonical, "utf8")),
    };
  });

  const checks = buildChecks(census, candidateRoot);
  const { per_file, ...censusSummary } = census;

  return {
    schema_version: SCHEMA_VERSION,
    parser_version: census.parser,
    canonicalizer_version: CANONICALIZER_VERSION,
    generated_from: {
      workflow_dir: WORKFLOW_DIR,
      workflow_count: census.file_count,
      job_count: census.job_count,
      step_count: census.step_count,
      workflows,
    },
    construct_census: censusSummary,
    construct_allowlist: CONSTRUCT_ALLOWLIST,
    ci_only_actions: CI_ONLY_ACTIONS,
    runnability_summary: checks.reduce((acc, c) => {
      acc[c.runnability] = (acc[c.runnability] ?? 0) + 1;
      return acc;
    }, {}),
    checks,
  };
}

/** Atomic: build in an owned temp file, validate, then replace. */
export function emitContract(candidateRoot, options = {}) {
  const contract = buildContract(candidateRoot, options);
  const bytes = canonicalJson(contract);
  const dir = mkdtempSync(path.join(tmpdir(), "contract-"));
  const staged = path.join(dir, "contract.frozen.json");
  try {
    writeFileSync(staged, bytes);
    const reread = JSON.parse(readFileSync(staged, "utf8"));
    if (reread.checks.length !== contract.checks.length) {
      throw new ContractStop("CONTRACT_GENERATION_FAILED", {
        reason_detail: "staged artifact did not round-trip",
      });
    }
    const target = options.contractPath ?? CONTRACT_PATH;
    const shaTarget = options.shaPath ?? CONTRACT_SHA_PATH;
    renameSync(staged, target);
    writeFileSync(
      shaTarget,
      `${sha256(Buffer.from(bytes, "utf8"))}  contract.frozen.json\n`
    );
    return {
      contract,
      bytes,
      sha256: sha256(Buffer.from(bytes, "utf8")),
      path: target,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function main() {
  const [command, ...rest] = process.argv.slice(2);
  const rootFlag = rest.indexOf("--root");
  const root = rootFlag === -1 ? REPO_ROOT : path.resolve(rest[rootFlag + 1]);
  if (command === "emit") {
    const result = emitContract(root);
    console.log(`[contract] emitted ${result.path}`);
    console.log(`[contract] sha256=${result.sha256}`);
    console.log(
      `[contract] ${result.contract.generated_from.workflow_count} workflows, ` +
        `${result.contract.checks.length} checks, ` +
        JSON.stringify(result.contract.runnability_summary)
    );
    return;
  }
  if (command === "census") {
    const census = censusCorpus(root);
    const { per_file, ...summary } = census;
    console.log(JSON.stringify(summary, null, 2));
    return;
  }
  throw new ContractStop("UNKNOWN_COMMAND", { command: command ?? "(none)" });
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
) {
  try {
    main();
  } catch (error) {
    console.error(`[contract] ${error.reason ?? error.message}`);
    if (error.reason) console.error(JSON.stringify({ ...error }, null, 2));
    process.exitCode = 1;
  }
}
