#!/usr/bin/env node
/**
 * p06/scope.mjs — P06.T01: derive P06's gate scope from the CURRENT frozen
 * contract and PARITY registry. Nothing here is hardcoded from a prior run;
 * the list is a projection of the contract, so a workflow change moves the
 * scope automatically rather than silently diverging from a stale copy.
 *
 * Ownership split (frozen): P06 owns static analysis, workflow/source
 * security, supply chain, migration hygiene, documentation/federation, and
 * deterministic AI-eval configuration checks. P07 owns the test/data stage
 * (Vitest, DB tests, coverage). A gate is assigned by the JOB it belongs to,
 * never by guessing from its command text.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { loadVerifiedContract, buildParityRegistry } from "../registry.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, "..", "..", "..");

/** Gates the TEST/DATA phase owns. Everything else locally runnable is P06's. */
export const P07_OWNED = new Set([
  ".github/workflows/ci.yml#test",
  ".github/workflows/ci.yml#db-tests",
  ".github/workflows/07-coverage-patch.yml#coverage",
  ".github/workflows/12-nightly-verification.yml#mutation-diff",
]);

/**
 * Gates that are locally runnable per the contract but are OPERATIONAL
 * probes of live production rather than static verification of the
 * candidate. They belong to neither P06 nor P07's parity surface; recorded
 * with a reason so the exclusion is auditable rather than silent.
 */
export const OPERATIONAL_EXCLUSIONS = {
  ".github/workflows/p0-feed-verify.yml#verify":
    "probes live production feed data; not a property of the candidate",
  ".github/workflows/railway-p0-control.yml#health":
    "probes live production health; not a property of the candidate",
  ".github/workflows/refresh-cf-cidrs.yml#check":
    "fetches live Cloudflare CIDR ranges; network-dependent, not candidate state",
  ".github/workflows/os-ledger-append.yml#append":
    "appends to the operations ledger; mutates state, not a verification gate",
  ".github/workflows/os-observe-crons.yml#observe":
    "observes live cron state; not a property of the candidate",
  ".github/workflows/edge-arming-gate.yml#enforce":
    "reads live production edge arming state; the offline contract half is the candidate-verifiable one",
  ".github/workflows/12-nightly-verification.yml#dependency-release-age":
    "queries the live npm registry for release ages; network-dependent",
};

/** Probe a tool the way the contract's own runner would find it. */
export function toolPresent(tool) {
  if (tool === "playwright-browsers") {
    try {
      const out = execFileSync(
        "ls",
        [`${process.env.HOME}/Library/Caches/ms-playwright`],
        { encoding: "utf8" }
      );
      return /chromium/.test(out);
    } catch {
      return false;
    }
  }
  if (tool === "docker") {
    try {
      execFileSync("docker", ["info"], { stdio: "ignore", timeout: 20_000 });
      return true;
    } catch {
      return false;
    }
  }
  try {
    execFileSync("command", ["-v", tool], {
      shell: "/bin/bash",
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

export function deriveScope(options = {}) {
  const { contract, contract_sha256 } = loadVerifiedContract();
  const registry = buildParityRegistry({ contract, contract_sha256 });
  const probe = options.toolProbe ?? toolPresent;
  const toolCache = new Map();
  const has = tool => {
    if (!toolCache.has(tool)) toolCache.set(tool, probe(tool));
    return toolCache.get(tool);
  };

  const rows = [];
  for (const entry of registry.entries) {
    const check = contract.checks.find(c => c.check_id === entry.gate_id);
    const runSteps = check.steps
      .map((s, i) => (typeof s.run === "string" && s.run.length ? i : null))
      .filter(i => i !== null);
    const missingTools = (entry.required_tools ?? []).filter(t => !has(t));

    let owner;
    let exclusion = null;
    if (entry.runnability === "CI-ONLY") {
      owner = "CI_ONLY";
    } else if (P07_OWNED.has(entry.gate_id)) {
      owner = "P07";
    } else if (OPERATIONAL_EXCLUSIONS[entry.gate_id]) {
      owner = "OPERATIONAL";
      exclusion = OPERATIONAL_EXCLUSIONS[entry.gate_id];
    } else {
      owner = "P06";
    }

    let executability = "EXECUTABLE";
    let reason = null;
    if (entry.runnability === "CI-ONLY") {
      executability = "CI_ONLY";
      reason = (entry.ci_only_reasons ?? []).join("; ") || "declared CI-ONLY";
    } else if (missingTools.length) {
      executability = "NOT_LOCALLY_EXECUTABLE";
      reason = `required tool(s) unavailable: ${missingTools.join(", ")}`;
    } else if (runSteps.length === 0) {
      executability = "NO_RUN_STEPS";
      reason =
        "the contract job has no `run:` step; its verdict comes from a " +
        "marketplace action, so local execution needs a P06 adapter";
    }

    rows.push({
      gate_id: entry.gate_id,
      status_context: entry.status_context ?? null,
      owner,
      required: entry.required,
      graduating: entry.graduating,
      runnability: entry.runnability,
      required_tools: entry.required_tools ?? [],
      missing_tools: missingTools,
      run_step_indexes: runSteps,
      executability,
      reason,
      exclusion,
    });
  }

  const p06 = rows.filter(r => r.owner === "P06");
  return {
    contract_sha256,
    registry_entries: registry.entries.length,
    rows,
    p06: {
      total: p06.length,
      executable: p06.filter(r => r.executability === "EXECUTABLE").length,
      required: p06.filter(r => r.required).length,
      required_executable: p06.filter(
        r => r.required && r.executability === "EXECUTABLE"
      ).length,
      blocked: p06.filter(r => r.executability !== "EXECUTABLE"),
    },
    counts: rows.reduce((acc, r) => {
      acc[r.owner] = (acc[r.owner] ?? 0) + 1;
      return acc;
    }, {}),
  };
}

function main() {
  const scope = deriveScope();
  console.log(`[p06-scope] contract ${scope.contract_sha256.slice(0, 16)}`);
  console.log(`[p06-scope] registry entries: ${scope.registry_entries}`);
  console.log(`[p06-scope] ownership: ${JSON.stringify(scope.counts)}`);
  console.log(
    `[p06-scope] P06 gates: ${scope.p06.total} (executable ${scope.p06.executable}, ` +
      `required ${scope.p06.required}, required+executable ${scope.p06.required_executable})`
  );
  console.log("");
  for (const r of scope.rows.filter(x => x.owner === "P06")) {
    console.log(
      `${r.required ? "REQ " : "    "}${r.graduating ? "GRAD " : "     "}${r.executability.padEnd(23)} ${r.gate_id}`
    );
    if (r.reason) console.log(`         reason: ${r.reason}`);
  }
  console.log("\n[p06-scope] NOT owned by P06:");
  for (const r of scope.rows.filter(
    x => x.owner !== "P06" && x.owner !== "CI_ONLY"
  )) {
    console.log(`  ${r.owner.padEnd(12)} ${r.gate_id}`);
    if (r.exclusion) console.log(`               ${r.exclusion}`);
  }
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
) {
  main();
}
