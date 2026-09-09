#!/usr/bin/env node
/**
 * registry.mjs — P03.T03 (PARITY) and P03.T04 (HARDENING scaffold).
 *
 * ARCHITECTURAL BOUNDARY, enforced not merely documented:
 *
 *   workflow YAML -> P02 extractor -> contract.frozen.json -> P03+ runtime
 *
 * This module NEVER reads `.github/workflows`, never imports a YAML parser, and
 * never reconstructs P02 semantics. PARITY membership is derived exclusively
 * from the committed frozen contract, whose SHA is verified against its pin
 * before a single entry is built.
 *
 * The PARITY registry is IMMUTABLE to ordinary callers. Append, delete,
 * replace, reclassify, or override all fail deterministically. The only legal
 * way to change PARITY membership is:
 *
 *   change the workflow -> regenerate the contract (P02) -> pass conformance
 *
 * If this module finds a contract omission, duplicate, or impossible
 * classification it raises — it never repairs the contract locally. That would
 * turn P03 into a second contract generator, which is exactly what the
 * boundary forbids.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CONTRACT_PATH,
  CONTRACT_SHA_PATH,
  REPO_ROOT,
  sha256,
} from "./contract-extract.mjs";
import { GATE_CLASSES, ResultError, assertClass } from "./result.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

export class RegistryError extends Error {
  constructor(reason, detail = {}) {
    super(reason);
    this.name = "RegistryError";
    this.reason = reason;
    Object.assign(this, detail);
  }
}

/**
 * Contexts enforced today vs still graduating. Sourced from the P00.T02
 * measurement of ruleset 18701573 and re-asserted by P02 conformance.
 * Ruleset state and workflow existence remain DIFFERENT facts.
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

/**
 * A PARITY entry is eligible only if the contract gives it a STATIC status
 * context. A dynamic context (one containing an expression) cannot be matched
 * to a GitHub required check by name, so it is represented as out-of-scope
 * rather than silently invented.
 */
export function isParityEligible(check) {
  return Boolean(check.status_context) && check.status_context_dynamic !== true;
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

/** Verify the contract against its pin BEFORE any entry is built. */
export function loadVerifiedContract(options = {}) {
  const contractPath = options.contractPath ?? CONTRACT_PATH;
  const shaPath = options.shaPath ?? CONTRACT_SHA_PATH;
  const bytes = readFileSync(contractPath);
  const pinned = readFileSync(shaPath, "utf8").trim().split(/\s+/)[0];
  const actual = sha256(bytes);
  if (pinned !== actual) {
    throw new RegistryError("CONTRACT_DRIFT", {
      detail: "frozen contract does not match its integrity pin",
      pinned,
      actual,
    });
  }
  return {
    contract: JSON.parse(bytes.toString("utf8")),
    contract_sha256: actual,
  };
}

/**
 * P03.T03 — build the PARITY registry from the frozen contract.
 * Every field stays CONTRACT-OWNED: nothing is defaulted, inferred, repaired,
 * or overridden here.
 */
export function buildParityRegistry(options = {}) {
  const { contract, contract_sha256 } = options.contract
    ? {
        contract: options.contract,
        contract_sha256: options.contract_sha256 ?? null,
      }
    : loadVerifiedContract(options);

  const seen = new Set();
  const entries = [];
  const outOfScope = [];

  for (const check of contract.checks) {
    if (!isParityEligible(check)) {
      outOfScope.push({
        contract_check_id: check.check_id,
        reason: check.status_context_dynamic
          ? `dynamic status context: ${check.status_context_template}`
          : "job has no status context",
      });
      continue;
    }
    if (seen.has(check.check_id)) {
      // Upstream contract defect — raised, never de-duplicated locally.
      throw new RegistryError("CONTRACT_DUPLICATE_CHECK_ID", {
        check_id: check.check_id,
      });
    }
    seen.add(check.check_id);

    if (!["LOCAL", "LOCAL+TOOL", "CI-ONLY"].includes(check.runnability)) {
      throw new RegistryError("CONTRACT_INVALID_RUNNABILITY", {
        check_id: check.check_id,
        runnability: check.runnability,
      });
    }
    if (
      check.runnability === "CI-ONLY" &&
      !(check.ci_only_reasons ?? []).length
    ) {
      throw new RegistryError("CONTRACT_CI_ONLY_WITHOUT_REASON", {
        check_id: check.check_id,
      });
    }

    entries.push(
      deepFreeze({
        gate_id: check.check_id,
        class: "PARITY",
        contract_check_id: check.check_id,
        workflow: check.workflow,
        job_id: check.job_id,
        status_context: check.status_context,
        required: REQUIRED_CONTEXTS.includes(check.status_context),
        graduating: GRADUATING_CONTEXTS.includes(check.status_context),
        runnability: check.runnability,
        required_tools: Object.freeze([...(check.required_tools ?? [])]),
        ci_only_reasons: Object.freeze([...(check.ci_only_reasons ?? [])]),
        step_count: check.step_count,
        // Commands/env/cwd/deps remain CONTRACT-owned. The registry exposes a
        // frozen reference so a caller can read them without being able to
        // rewrite the contract's meaning.
        steps: Object.freeze(
          check.steps.map(step => Object.freeze({ ...step }))
        ),
        needs: check.needs ?? null,
        env: check.env ?? null,
        defaults: check.defaults ?? null,
        services: check.services ?? null,
        permissions: check.permissions ?? null,
        strategy: check.strategy ?? null,
        if: check.if ?? null,
        timeout_minutes: check.timeout_minutes ?? null,
        mandatory: REQUIRED_CONTEXTS.includes(check.status_context),
      })
    );
  }

  entries.sort((a, b) => a.gate_id.localeCompare(b.gate_id));

  const registry = {
    class: "PARITY",
    source: "scripts/ci/contract.frozen.json",
    contract_sha256,
    contract_schema_version: contract.schema_version,
    parser_version: contract.parser_version,
    canonicalizer_version: contract.canonicalizer_version,
    entries: Object.freeze(entries),
    out_of_scope: Object.freeze(outOfScope.map(item => Object.freeze(item))),
  };

  // Immutable to ordinary runtime callers. Mutation attempts throw in strict
  // mode (every ESM module is strict), which is what the negative test asserts.
  return deepFreeze(registry);
}

/**
 * Consistency assertion: registry membership == contract checks eligible for
 * PARITY representation. No silent extras, no silent omissions.
 */
export function assertParityFidelity(registry, contract) {
  const eligible = contract.checks
    .filter(isParityEligible)
    .map(c => c.check_id)
    .sort();
  const registered = registry.entries.map(entry => entry.gate_id).sort();
  const missing = eligible.filter(id => !registered.includes(id));
  const extra = registered.filter(id => !eligible.includes(id));
  if (missing.length || extra.length) {
    throw new RegistryError("PARITY_REGISTRY_INFIDELITY", { missing, extra });
  }

  const byId = new Map(contract.checks.map(check => [check.check_id, check]));
  const mismatches = [];
  for (const entry of registry.entries) {
    const check = byId.get(entry.gate_id);
    if (entry.runnability !== check.runnability) {
      mismatches.push(`${entry.gate_id}: runnability`);
    }
    if (entry.status_context !== check.status_context) {
      mismatches.push(`${entry.gate_id}: status_context`);
    }
    if (entry.step_count !== check.step_count) {
      mismatches.push(`${entry.gate_id}: step_count`);
    }
    const tools = [...(check.required_tools ?? [])].sort().join(",");
    if ([...entry.required_tools].sort().join(",") !== tools) {
      mismatches.push(`${entry.gate_id}: required_tools`);
    }
  }
  if (mismatches.length) {
    throw new RegistryError("PARITY_REGISTRY_FIELD_MISMATCH", { mismatches });
  }

  // Every currently-required context must be represented exactly once.
  for (const context of REQUIRED_CONTEXTS) {
    const matches = registry.entries.filter(e => e.status_context === context);
    if (matches.length !== 1) {
      throw new RegistryError("REQUIRED_CONTEXT_NOT_REPRESENTED", {
        context,
        matches: matches.length,
      });
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// P03.T04 — HARDENING scaffold.
//
// Deliberately EMPTY. P09 owns deploy-order, schema-type-drift, knip and a11y.
// An empty HARDENING registry must still render explicitly with zero counts —
// a class that disappears from a summary is indistinguishable from a class
// that passed, which is exactly the false-green shape this phase exists to
// prevent.
// ---------------------------------------------------------------------------
export const HARDENING_ENTRIES = [];

export function buildHardeningRegistry(entries = HARDENING_ENTRIES) {
  const seen = new Set();
  const built = [];
  for (const entry of entries) {
    if (!entry?.gate_id) {
      throw new RegistryError("HARDENING_ENTRY_MISSING_ID", { entry });
    }
    if (seen.has(entry.gate_id)) {
      throw new RegistryError("HARDENING_DUPLICATE_ID", {
        gate_id: entry.gate_id,
      });
    }
    seen.add(entry.gate_id);
    assertClass(entry.class ?? "HARDENING");
    if ((entry.class ?? "HARDENING") !== "HARDENING") {
      throw new RegistryError("HARDENING_WRONG_CLASS", {
        gate_id: entry.gate_id,
        class: entry.class,
      });
    }
    built.push(
      deepFreeze({
        gate_id: entry.gate_id,
        class: "HARDENING",
        mandatory: entry.mandatory !== false,
        owner_phase: entry.owner_phase ?? "P09",
        description: entry.description ?? null,
      })
    );
  }
  built.sort((a, b) => a.gate_id.localeCompare(b.gate_id));
  return deepFreeze({
    class: "HARDENING",
    source: "hand-authored scaffold (P03.T04)",
    owner_phase: "P09",
    entries: Object.freeze(built),
  });
}

/** Every class, always — including the ones with no entries. */
export function buildAllRegistries(options = {}) {
  const parity = buildParityRegistry(options);
  const hardening = buildHardeningRegistry(options.hardeningEntries);
  const empty = klass =>
    deepFreeze({
      class: klass,
      source: `not yet populated — owned by a later phase`,
      entries: Object.freeze([]),
    });
  return deepFreeze({
    PARITY: parity,
    HARDENING: hardening,
    CLEANROOM: empty("CLEANROOM"),
    ASSURANCE: empty("ASSURANCE"),
    REMOTE: empty("REMOTE"),
    AUDIT: empty("AUDIT"),
  });
}

function main() {
  const { contract, contract_sha256 } = loadVerifiedContract();
  const registry = buildParityRegistry({ contract, contract_sha256 });
  assertParityFidelity(registry, contract);
  const all = buildAllRegistries({ contract, contract_sha256 });
  console.log(`[registry] contract sha256 verified: ${contract_sha256}`);
  console.log(
    `[registry] PARITY entries=${registry.entries.length} out_of_scope=${registry.out_of_scope.length}`
  );
  const required = registry.entries.filter(e => e.required).length;
  const graduating = registry.entries.filter(e => e.graduating).length;
  console.log(`[registry] required=${required} graduating=${graduating}`);
  const byRun = registry.entries.reduce((acc, e) => {
    acc[e.runnability] = (acc[e.runnability] ?? 0) + 1;
    return acc;
  }, {});
  console.log(`[registry] runnability=${JSON.stringify(byRun)}`);
  for (const klass of GATE_CLASSES) {
    console.log(
      `[registry] ${klass.padEnd(10)} entries=${all[klass].entries.length}`
    );
  }
  console.log(
    "[registry] PASS — PARITY derived from the frozen contract and fidelity-checked"
  );
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
) {
  try {
    main();
  } catch (error) {
    console.error(`[registry] ${error.reason ?? error.message}`);
    if (error.reason) console.error(JSON.stringify({ ...error }, null, 2));
    process.exitCode = 1;
  }
}
