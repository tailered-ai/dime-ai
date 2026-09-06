#!/usr/bin/env node
/**
 * p06/boundary.mjs — the execution-boundary model (DEF-031/032/033).
 *
 * Three distinctions the verifier previously blurred, each of which produced a
 * false verdict:
 *
 *   1. PROVISIONING vs DETECTOR. Installing a tool, fetching a tarball, or
 *      populating node_modules is not the check. If provisioning cannot run,
 *      the detector never validly executed, so no detector verdict exists —
 *      the result is BLOCKED/INFRA_FAIL, never FAIL. (DEF-031)
 *
 *   2. CONTRACT cwd. GitHub applies `defaults.run.working-directory` and
 *      step-level `working-directory`. Running from the wrong directory makes
 *      a tool fail for reasons that have nothing to do with the candidate.
 *      (DEF-032)
 *
 *   3. FAITHFUL vs PARTIAL execution. A job whose provisioning the verifier
 *      does not perform inside the candidate is NOT reproduced locally, even
 *      if some command can be coaxed into running. Reporting such a run as
 *      FAIL is as wrong as reporting it PASS. (DEF-033)
 *
 * DEF-033 correction of record: the original diagnosis said these jobs were
 * "secret-bound". Measured against the contract, `#proof` and `ci.yml#test`
 * contain ZERO `secrets.*` references, and `ci.yml` states plainly that
 * pull-request CI is "intentionally secretless" — credential probes are
 * SKIPPED and declared in `vitest.environment-failure-allowlist.json` (64
 * entries, exactly the `environmentBound=64` the gate reported). The real
 * cause is provisioning: the job runs `pnpm install --frozen-lockfile` and
 * `playwright install` inside its checkout, which the verifier did not do in
 * the disposable candidate.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, "..", "..", "..");

/** Frozen execution classes. */
export const EXECUTION_CLASSES = [
  "LOCAL",
  "LOCAL+TOOL",
  "NOT_LOCALLY_EXECUTABLE",
  "CI_ONLY",
];

/** Reason codes. Kept distinct — blurring them is how a gap hides. */
export const NONLOCAL_REASONS = [
  "SECRET_BOUND",
  "ACTION_SEMANTICS_UNREPRODUCED",
  "RUNTIME_UNAVAILABLE",
  "PROVISIONING_UNAVAILABLE",
  "TOOL_UNAVAILABLE",
  "GITHUB_API_BASELINE",
  "OIDC_ATTESTATION",
  "DEPENDENCY_REVIEW_EVENT",
];

/**
 * Step-level provisioning signatures. A step matching any of these prepares
 * the environment; it does not judge the candidate.
 */
export const PROVISIONING_PATTERNS = [
  { id: "node-deps", re: /^\s*(pnpm|npm|yarn)\s+(ci|install)\b/m },
  { id: "pipx-install", re: /^\s*pipx\s+install\b/m },
  { id: "pip-install", re: /^\s*(uv\s+)?pip\s+install\b/m },
  { id: "uv-sync", re: /^\s*uv\s+(sync|lock)\b/m },
  { id: "playwright-install", re: /playwright\s+install\b/ },
  { id: "privilege-escalation", re: /^\s*sudo\b/m },
  { id: "download", re: /^\s*(curl|wget)\b/m },
  { id: "pkg-manager", re: /^\s*(apt-get|apt|brew|yum|dnf|apk)\b/m },
  { id: "archive-extract", re: /^\s*(tar|unzip)\b\s+-?[xz]/m },
  { id: "go-install", re: /^\s*go\s+install\b/m },
  { id: "cargo-install", re: /^\s*cargo\s+install\b/m },
];

export function isProvisioningStep(runText) {
  const hits = PROVISIONING_PATTERNS.filter(p => p.re.test(runText));
  return hits.length ? hits.map(h => h.id) : null;
}

/**
 * Classify every `run:` step of a contract check as provisioning or detector,
 * and compute each step's contract-effective working directory.
 */
export function classifySteps(check) {
  const jobDefaultCwd =
    check.defaults?.run?.["working-directory"] ??
    check.defaults?.run?.working_directory ??
    null;
  const steps = [];
  for (const [index, step] of check.steps.entries()) {
    if (typeof step.run !== "string" || step.run.length === 0) continue;
    const stepCwd = step["working-directory"] ?? step.working_directory ?? null;
    const provisioning = isProvisioningStep(step.run);
    steps.push({
      index,
      kind: provisioning ? "PROVISIONING" : "DETECTOR",
      provisioning_signatures: provisioning ?? [],
      effective_cwd: stepCwd ?? jobDefaultCwd ?? ".",
      env: step.env ?? {},
      first_line:
        step.run.split("\n").find(l => l.trim() && !l.trim().startsWith("#")) ??
        "",
      run: step.run,
    });
  }
  return { job_default_cwd: jobDefaultCwd, steps };
}

/**
 * Secret dependence, derived from the contract rather than assumed. Returns
 * every site where a `secrets.*` expression appears.
 */
export function secretDependence(check) {
  const sites = [];
  const walk = (node, where) => {
    if (node == null) return;
    if (typeof node === "string") {
      const refs = node.match(/\$\{\{\s*secrets\.[A-Za-z0-9_]+\s*\}\}/g);
      if (refs) sites.push({ where, refs: [...new Set(refs)] });
      return;
    }
    if (Array.isArray(node))
      return node.forEach((v, i) => walk(v, `${where}[${i}]`));
    if (typeof node === "object")
      return Object.entries(node).forEach(([k, v]) => walk(v, `${where}.${k}`));
  };
  walk(check, "");
  return sites;
}

/**
 * The authoritative per-check classification.
 *
 * `capabilities` declares what this host can actually do; nothing is assumed.
 * A check is LOCAL/LOCAL+TOOL only when EVERY detector step can run with the
 * contract's own cwd/env AND every provisioning step it depends on either is
 * unnecessary locally or can be performed faithfully.
 */
export function classifyCheck(check, entry, capabilities) {
  const { steps, job_default_cwd } = classifySteps(check);
  const detectors = steps.filter(s => s.kind === "DETECTOR");
  const provisioning = steps.filter(s => s.kind === "PROVISIONING");
  const secrets = secretDependence(check);
  const missingTools = (entry.required_tools ?? []).filter(
    t => !capabilities.tools?.[t]
  );

  const nonlocal = (reason, detail) => ({
    execution_class: "NOT_LOCALLY_EXECUTABLE",
    reason_code: reason,
    reason: detail,
    detector_steps: detectors.map(s => s.index),
    provisioning_steps: provisioning.map(s => s.index),
    job_default_cwd,
    secret_sites: secrets,
    reproducible_subchecks: detectors
      .filter(s => !s.requires_provisioning)
      .map(s => s.first_line),
    ci_authoritative: true,
  });

  if (entry.runnability === "CI-ONLY") {
    return {
      execution_class: "CI_ONLY",
      reason_code: "CI_ONLY",
      reason: (entry.ci_only_reasons ?? []).join("; ") || "declared CI-ONLY",
      detector_steps: detectors.map(s => s.index),
      provisioning_steps: provisioning.map(s => s.index),
      job_default_cwd,
      secret_sites: secrets,
      ci_authoritative: true,
    };
  }
  if (secrets.length > 0) {
    return nonlocal(
      "SECRET_BOUND",
      `job references repository secrets at ${secrets.length} site(s): ` +
        secrets.map(s => s.refs.join(",")).join(" | ")
    );
  }
  if (missingTools.length > 0) {
    return nonlocal(
      capabilities.runtimeTools?.some(t => missingTools.includes(t))
        ? "RUNTIME_UNAVAILABLE"
        : "TOOL_UNAVAILABLE",
      `required tool(s) unavailable: ${missingTools.join(", ")}`
    );
  }
  if (detectors.length === 0) {
    return nonlocal(
      "ACTION_SEMANTICS_UNREPRODUCED",
      "the job has no `run:` detector step; its verdict comes from a " +
        "marketplace action, and no faithful local adapter is registered"
    );
  }
  // Provisioning is not automatically disqualifying. What matters is whether
  // the state it would establish is PROVABLY already available to the
  // candidate. `pnpm install --frozen-lockfile` populates node_modules from
  // the lockfile; a candidate nested inside the repository resolves that same
  // lockfile-pinned tree by upward module resolution, so the provisioning is
  // satisfied by equivalence — provided the host tree is proven
  // lockfile-consistent. Assuming satisfaction would be as wrong as assuming
  // unavailability, so each signature is checked against measured capability.
  const unsatisfied = [];
  for (const step of provisioning) {
    for (const sig of step.provisioning_signatures) {
      const satisfied = capabilities.provisioning?.[sig];
      if (satisfied === true) continue;
      // Acquisition-style provisioning (sudo/download/pkg-manager) is never
      // performed by the verifier; it is only acceptable when the tool it
      // would install is already present under governed identity, which the
      // required_tools check above already established.
      if (
        [
          "privilege-escalation",
          "download",
          "pkg-manager",
          "pipx-install",
          "go-install",
          "cargo-install",
          "archive-extract",
        ].includes(sig)
      ) {
        continue;
      }
      unsatisfied.push({ step: step.index, signature: sig });
    }
  }
  if (unsatisfied.length) {
    return nonlocal(
      "PROVISIONING_UNAVAILABLE",
      "the job provisions its own checkout (" +
        [...new Set(unsatisfied.map(u => u.signature))].join(", ") +
        ") and the verifier cannot prove the equivalent state is available to " +
        "the candidate; the detector cannot execute faithfully"
    );
  }
  return {
    execution_class: (entry.required_tools ?? []).length
      ? "LOCAL+TOOL"
      : "LOCAL",
    reason_code: null,
    reason: null,
    detector_steps: detectors.map(s => s.index),
    provisioning_steps: provisioning.map(s => s.index),
    job_default_cwd,
    secret_sites: secrets,
    ci_authoritative: false,
  };
}

/**
 * Map a provisioning-stage failure onto a truthful non-detector result.
 * A detector verdict is never issued for a run that failed before the
 * detector executed.
 */
export function provisioningOutcome(signatures, detail) {
  if (signatures.includes("privilege-escalation")) {
    return {
      status: "BLOCKED",
      reason: `PROVISIONING_REQUIRES_PRIVILEGE: ${detail}`,
    };
  }
  if (signatures.includes("download")) {
    return { status: "INFRA_FAIL", reason: `PROVISIONING_DOWNLOAD: ${detail}` };
  }
  return { status: "INFRA_FAIL", reason: `PROVISIONING_FAILED: ${detail}` };
}
