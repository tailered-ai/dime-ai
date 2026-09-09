#!/usr/bin/env node
/**
 * p06/classify.mjs — §6 scope re-projection + §14 nonlocal/CI-only audit.
 *
 * Emits two artifacts, both derived from the CURRENT frozen contract, the
 * MEASURED host capability, the GOVERNED tool inventory, and the RECORDED
 * execution results — never from a prior run's numbers.
 *
 * The audit's job is to make absence explicit: for every check this verifier
 * does not fully reproduce, it states what CI proves, what the local verifier
 * proves, what it cannot prove, and — crucially — whether some local subcheck
 * still runs and why that subcheck is NOT the full required verdict. A
 * nonlocal check is never counted as an executed PASS.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadVerifiedContract } from "../registry.mjs";
import { deriveScope } from "./scope.mjs";
import { classifySteps, secretDependence } from "./boundary.mjs";
import { bootstrapTools } from "./tools.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, "..", "..", "..");

const CI_ONLY_REASONS = {
  GITHUB_API_BASELINE:
    "the verdict is computed from GitHub API state (branch protection, " +
    "required-context lists, PR metadata) that has no local equivalent",
  OIDC_ATTESTATION:
    "the verdict depends on GitHub's OIDC identity / attestation signing",
  DEPENDENCY_REVIEW_EVENT:
    "the verdict comes from GitHub's dependency-review event payload, which " +
    "is produced by the platform, not by any command",
};

/** What a marketplace-action step contributes, if anything, to the verdict. */
const ACTION_DISPOSITION = {
  "actions/checkout": "candidate materialization — P01 owns this locally",
  "pnpm/action-setup":
    "toolchain setup — measured capability owns this locally",
  "actions/setup-node":
    "toolchain setup — measured capability owns this locally",
  "actions/setup-python": "toolchain setup — uv toolchain owns this locally",
  "astral-sh/setup-uv": "toolchain setup — governed uv owns this locally",
  "actions/upload-artifact": "CI plumbing; carries no candidate verdict",
  "actions/cache": "CI plumbing; carries no candidate verdict",
  "github/codeql-action/upload-sarif":
    "CI plumbing (uploads findings to GitHub code scanning); the finding " +
    "itself is produced by the scanner step, which IS reproduced locally",
  "aquasecurity/trivy-action":
    "verdict-bearing; reproduced by a governed-trivy adapter derived from the " +
    "pinned action's own input→CLI mapping",
  "anchore/sbom-action":
    "verdict-bearing (generation); reproduced by a governed-syft adapter",
  "gitleaks/gitleaks-action":
    "verdict-bearing; reproduced by a faithful adapter using the pinned " +
    "action's exact argv and gitleaks version",
};

export function buildClassification() {
  const { contract, contract_sha256 } = loadVerifiedContract();
  const scope = deriveScope();
  const tools = bootstrapTools();

  const recordsPath = path.join(REPO_ROOT, ".ci-verify/p06/p06-records.json");
  const records = existsSync(recordsPath)
    ? JSON.parse(readFileSync(recordsPath, "utf8"))
    : { records: [] };
  const byGate = new Map(records.records.map(r => [r.gate_id, r]));

  const assurancePath = path.join(
    REPO_ROOT,
    ".ci-verify/p06-assurance/assurance.json"
  );
  const assurance = existsSync(assurancePath)
    ? JSON.parse(readFileSync(assurancePath, "utf8"))
    : { proofs: [], coverage: [] };
  const provenGates = new Set(
    assurance.proofs.filter(p => p.verdict === "PROVEN").map(p => p.gate_id)
  );

  const GATE_TOOL_IDS = {
    ".github/workflows/03-semgrep.yml#advisory": ["semgrep"],
    ".github/workflows/03-semgrep.yml#blocking": ["semgrep"],
    ".github/workflows/05-workflow-security.yml#zizmor": ["zizmor"],
    ".github/workflows/ci.yml#security-audit": ["osv-scanner@security-audit"],
    ".github/workflows/12-nightly-verification.yml#full-osv": [
      "osv-scanner@full-osv",
    ],
    ".github/workflows/09-artifact-build-and-smoke.yml#artifact": [
      "trivy",
      "syft",
    ],
    ".github/workflows/12-nightly-verification.yml#full-container-scan": [
      "trivy",
    ],
    ".github/workflows/gitleaks.yml#gitleaks": ["gitleaks"],
  };

  const rows = [];
  for (const row of scope.rows.filter(r => r.owner === "P06")) {
    const check = contract.checks.find(c => c.check_id === row.gate_id);
    const { steps, job_default_cwd } = classifySteps(check);
    const secrets = secretDependence(check);
    const actions = check.steps
      .filter(s => typeof s.uses === "string")
      .map(s => {
        const base = s.uses.split("@")[0];
        return {
          uses: s.uses,
          disposition: ACTION_DISPOSITION[base] ?? "unclassified",
        };
      });
    const toolIds = GATE_TOOL_IDS[row.gate_id] ?? [];
    const executed = byGate.get(row.gate_id);

    let classification;
    let reasonCode = null;
    if (row.runnability === "CI-ONLY") {
      classification = "CI_ONLY";
      reasonCode = (check.ci_only_reasons ?? row.reason ?? "").includes("OIDC")
        ? "OIDC_ATTESTATION"
        : "GITHUB_API_BASELINE";
    } else if (
      secrets.length > 0 &&
      !provenGates.has(row.gate_id) &&
      !executed
    ) {
      classification = "NOT_LOCALLY_EXECUTABLE";
      reasonCode = "SECRET_BOUND";
    } else if (executed && ["PASS", "FAIL"].includes(executed.status)) {
      classification = toolIds.length ? "LOCAL+TOOL" : "LOCAL";
    } else if (executed) {
      classification = "NOT_LOCALLY_EXECUTABLE";
      reasonCode =
        executed.status === "BLOCKED"
          ? "TOOL_UNAVAILABLE"
          : "RUNTIME_UNAVAILABLE";
    } else {
      classification = "UNMEASURED";
    }

    rows.push({
      gate_id: row.gate_id,
      status_context: row.status_context,
      required: row.required,
      graduating: row.graduating,
      contract_job: `${check.workflow}#${check.job_id}`,
      provisioning_steps: steps
        .filter(s => s.kind === "PROVISIONING")
        .map(s => ({ index: s.index, signatures: s.provisioning_signatures })),
      detector_steps: steps
        .filter(s => s.kind === "DETECTOR")
        .map(s => ({ index: s.index, first_line: s.first_line.slice(0, 90) })),
      effective_cwd: {
        job_default: job_default_cwd,
        per_step: steps.map(s => ({ index: s.index, cwd: s.effective_cwd })),
      },
      job_env: check.env ?? null,
      secret_sites: secrets,
      required_tools: toolIds.map(id => ({
        id,
        version: tools.resolved[id]?.version ?? null,
        mode: tools.resolved[id]?.mode ?? "UNRESOLVED",
        derived_from: tools.resolved[id]?.derived_from ?? null,
      })),
      network_required: Boolean(
        steps.some(s =>
          /curl|wget|npm|pnpm|osv-scanner|semgrep|trivy|docker (pull|build)/.test(
            s.run
          )
        )
      ),
      service_or_container_required:
        Boolean(check.services) ||
        steps.some(s => /docker (run|build)/.test(s.run)),
      marketplace_actions: actions,
      classification,
      reason_code: reasonCode,
      executed_status: executed?.status ?? null,
      executed_reason: executed?.reason ?? null,
      assurance_state: provenGates.has(row.gate_id)
        ? "PROVEN"
        : row.required
          ? "UNPROVEN"
          : "NOT_REQUIRED",
    });
  }

  return { contract_sha256, generated_at: new Date().toISOString(), rows };
}

export function buildNonlocalAudit(classification) {
  const entries = [];
  for (const row of classification.rows) {
    if (row.classification === "LOCAL" || row.classification === "LOCAL+TOOL")
      continue;
    const localSubchecks = row.detector_steps.map(s => s.first_line);
    entries.push({
      gate_id: row.gate_id,
      required: row.required,
      disposition:
        row.classification === "CI_ONLY"
          ? `CI_ONLY(${row.reason_code})`
          : `NOT_LOCALLY_EXECUTABLE(${row.reason_code})`,
      what_ci_proves:
        row.classification === "CI_ONLY"
          ? (CI_ONLY_REASONS[row.reason_code] ??
            "a platform-computed verdict with no local equivalent")
          : "the complete required status, with the platform supplying the " +
            "credential/runtime the local host lacks",
      what_local_can_prove: localSubchecks.length
        ? `the contract text and step structure are verified, and these detector ` +
          `commands exist and are reproducible in principle: ${localSubchecks.join("; ")}`
        : "only the contract's declared structure — the job carries no `run:` detector",
      what_local_cannot_prove:
        row.reason_code === "SECRET_BOUND"
          ? "the verdict itself, because it depends on a repository secret that " +
            "must never be injected locally"
          : row.reason_code === "RUNTIME_UNAVAILABLE"
            ? "the verdict itself, because the required runtime is unavailable on this host"
            : "the verdict itself",
      local_subcheck_runs: localSubchecks.length > 0,
      why_subcheck_is_not_the_verdict:
        "the required GitHub status is the WHOLE job; a passing fragment of it " +
        "is not the status, and this audit never counts it as one",
      counted_as_executed_pass: false,
    });
  }
  return entries;
}

function main() {
  const classification = buildClassification();
  const audit = buildNonlocalAudit(classification);
  const outDir = path.join(REPO_ROOT, "docs/verification/evidence/p06");
  mkdirSync(outDir, { recursive: true });
  writeFileSync(
    path.join(outDir, "T01-classification.json"),
    JSON.stringify(classification, null, 2) + "\n"
  );
  writeFileSync(
    path.join(outDir, "T13-nonlocal-audit.json"),
    JSON.stringify(
      { generated_at: classification.generated_at, entries: audit },
      null,
      2
    ) + "\n"
  );

  const counts = {};
  for (const r of classification.rows)
    counts[r.classification] = (counts[r.classification] ?? 0) + 1;
  console.log(
    `[classify] contract ${classification.contract_sha256.slice(0, 16)}`
  );
  console.log(`[classify] P06 gates: ${classification.rows.length}`);
  console.log(`[classify] classification: ${JSON.stringify(counts)}`);
  const required = classification.rows.filter(r => r.required);
  console.log(
    `[classify] required: ${required.length}; locally executable: ` +
      `${required.filter(r => ["LOCAL", "LOCAL+TOOL"].includes(r.classification)).length}; ` +
      `ASSURANCE PROVEN: ${required.filter(r => r.assurance_state === "PROVEN").length}`
  );
  console.log(`[classify] nonlocal audit entries: ${audit.length}`);
  for (const r of classification.rows) {
    console.log(
      `  ${(r.required ? "REQ " : "    ") + r.classification.padEnd(24)} ${r.assurance_state.padEnd(12)} ${r.gate_id}` +
        (r.reason_code ? ` — ${r.reason_code}` : "")
    );
  }
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
) {
  main();
}
