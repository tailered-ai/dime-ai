#!/usr/bin/env node
/**
 * coverage.mjs — P05.T06: the ASSURANCE coverage registry and the
 * mandatory-gate law.
 *
 * gate_id -> fixture(s) -> proof state, derived machine-readably from the
 * frozen PARITY registry + the fixture set + the proof records + the
 * graduated-gate declaration (`graduated.json`, maintained by P06/P07 as
 * they implement gates).
 *
 * THE LAW (frozen): locally executable + mandatory (graduated) + no valid
 * proof => BROKEN_GATE(UNPROVEN) => VERIFIER_BROKEN. P05 arms the law with
 * the graduated set EMPTY, so nothing is falsely required today and nothing
 * can be silently skipped tomorrow: P06/P07 cannot graduate a gate without
 * a proof, because this assertion runs against their own declaration.
 */
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { makeResult, reduceResults } from "../result.mjs";

export const PROOF_STATES = [
  "PROVEN",
  "UNPROVEN",
  "NOT_YET_MANDATORY",
  "CI_ONLY",
  "NOT_LOCALLY_EXECUTABLE",
  "INVALID_FIXTURE",
];

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const GRADUATED_PATH = path.join(HERE, "graduated.json");

export class CoverageError extends Error {
  constructor(reason, detail = {}) {
    super(reason);
    this.name = "CoverageError";
    this.reason = reason;
    Object.assign(this, detail);
  }
}

export function loadGraduated(filePath = GRADUATED_PATH) {
  const parsed = JSON.parse(readFileSync(filePath, "utf8"));
  if (!Array.isArray(parsed.graduated)) {
    throw new CoverageError("GRADUATED_MALFORMED", { filePath });
  }
  return parsed.graduated;
}

/** Observational probe: is an external tool actually on this host? */
export function toolAvailable(tool) {
  try {
    execFileSync("command", ["-v", tool], {
      encoding: "utf8",
      shell: "/bin/bash",
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Build the truthful coverage table. Inputs are explicit so tests can drive
 * controlled registries/fixtures/proofs without touching production state.
 */
export function buildCoverage(input) {
  const {
    registry, // frozen PARITY registry (or a controlled test double)
    fixtures = [], // loaded fixtures (seed applicability only counts)
    records = [], // proof records from runFixtureCycle
    invalidFixtures = [], // {fixture_id, expected_gate, reason}
    graduated = [], // gate_ids P06/P07 declared implemented+mandatory
    toolProbe = toolAvailable,
  } = input;
  const byGate = new Map();
  for (const fixture of fixtures) {
    if (fixture.expect.applicability !== "seed") continue;
    const list = byGate.get(fixture.expect.expected_gate) ?? [];
    list.push(fixture.id);
    byGate.set(fixture.expect.expected_gate, list);
  }
  const provenByGate = new Map();
  const cannotRejectByGate = new Map();
  for (const record of records) {
    // ONLY a seed fixture can prove. A `finding` record is the opposite of
    // proof and must never be able to satisfy the coverage law.
    if (record.verdict === "PROVEN" && record.applicability === "seed") {
      const list = provenByGate.get(record.expected_gate) ?? [];
      list.push(record.fixture_id);
      provenByGate.set(record.expected_gate, list);
    }
    if (
      record.applicability === "finding" &&
      record.verdict === "FINDING_CONFIRMED"
    ) {
      const list = cannotRejectByGate.get(record.expected_gate) ?? [];
      list.push(record.fixture_id);
      cannotRejectByGate.set(record.expected_gate, list);
    }
  }
  const invalidByGate = new Map();
  for (const invalid of invalidFixtures) {
    const list = invalidByGate.get(invalid.expected_gate) ?? [];
    list.push(invalid.fixture_id);
    invalidByGate.set(invalid.expected_gate, list);
  }

  const rows = registry.entries.map(entry => {
    const gateId = entry.gate_id;
    const fixtureIds = byGate.get(gateId) ?? [];
    const provenIds = provenByGate.get(gateId) ?? [];
    const missingTools = (entry.required_tools ?? []).filter(
      tool => !toolProbe(tool)
    );
    const cannotReject = cannotRejectByGate.get(gateId) ?? [];
    let state;
    let reason = null;
    if (cannotReject.length > 0) {
      // Empirically proven unable to reject. This outranks every other
      // classification: the gate is green by construction, so no amount of
      // "not yet mandatory" may soften it.
      state = "UNPROVEN";
      reason =
        `gate is empirically PROVEN UNABLE TO REJECT (finding fixture(s): ` +
        `${cannotReject.join(", ")}); it cannot be graduated until the ` +
        `underlying gate is repaired`;
    } else if (entry.runnability === "CI-ONLY") {
      state = "CI_ONLY";
      reason = "not meaningfully executable locally; no local proof required";
    } else if (missingTools.length > 0) {
      state = "NOT_LOCALLY_EXECUTABLE";
      reason = `required tool(s) unavailable on this host: ${missingTools.join(", ")}`;
    } else if (provenIds.length > 0) {
      state = "PROVEN";
    } else if ((invalidByGate.get(gateId) ?? []).length > 0) {
      state = "INVALID_FIXTURE";
      reason = `fixture(s) failed validation: ${(invalidByGate.get(gateId) ?? []).join(", ")}`;
    } else if (graduated.includes(gateId)) {
      state = "UNPROVEN";
      reason =
        "gate has graduated into mandatory local execution without a valid assurance proof";
    } else {
      state = "NOT_YET_MANDATORY";
      reason =
        "no P06/P07 implementation has graduated this gate yet; proof will be required at graduation";
    }
    return {
      gate_id: gateId,
      status_context: entry.status_context ?? null,
      runnability: entry.runnability,
      required: entry.required,
      graduating: entry.graduating,
      graduated: graduated.includes(gateId),
      fixtures: fixtureIds,
      proven_by: provenIds,
      cannot_reject_evidence: cannotReject,
      proof_state: state,
      reason,
      // A graduated gate with no valid proof blocks. A gate proven unable to
      // reject is UNPROVEN forever, so it blocks the instant anyone tries to
      // graduate it — which is why this lives in the machine table, not prose.
      blocking: state === "UNPROVEN" && graduated.includes(gateId),
      cannot_reject: cannotReject.length > 0,
    };
  });
  return {
    rows,
    counts: PROOF_STATES.reduce((acc, state) => {
      acc[state] = rows.filter(r => r.proof_state === state).length;
      return acc;
    }, {}),
    blocking: rows.filter(r => r.blocking).map(r => r.gate_id),
  };
}

/**
 * THE ARMED ASSERTION. Emits canonical BROKEN_GATE results for every
 * blocking row and reduces them through the frozen P03 semantics. An empty
 * blocking set reduces to LOCAL_READY_FOR_PR (i.e. contributes nothing).
 */
export function assertCoverage(coverage) {
  const results = coverage.rows
    .filter(row => row.blocking)
    .map(row =>
      makeResult({
        gate_id: `assurance-coverage:${row.gate_id}`,
        class: "ASSURANCE",
        status: "BROKEN_GATE",
        reason: `UNPROVEN: ${row.reason}`,
        contract_check_id: row.gate_id,
        evidence_path: GRADUATED_PATH,
      })
    );
  const reduction = reduceResults(results);
  return {
    ok: results.length === 0,
    results,
    terminal: reduction.terminal,
    blocking_gates: coverage.blocking,
  };
}

export function graduatedFileExists() {
  return existsSync(GRADUATED_PATH);
}
