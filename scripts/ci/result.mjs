#!/usr/bin/env node
/**
 * result.mjs — P03.T01 / P03.T02: the canonical gate-result taxonomy and the
 * class-to-terminal-state reduction.
 *
 * FOUR VOCABULARIES, NEVER INTERCHANGEABLE:
 *
 *   1. UNIT STATUS      NOT_STARTED IN_PROGRESS PASS FAIL BLOCKED
 *                       INCONCLUSIVE SKIPPED_DECLARED N/A RETIRED   (ledger.mjs)
 *   2. GATE RESULT      the 12 statuses defined here
 *   3. PHASE STATE      NOT_STARTED .. ACCEPTED CLOSED + exceptional (ledger.mjs)
 *   4. SYSTEM TERMINAL  LOCAL_READY_FOR_PR LOCAL_BLOCKED LOCAL_INCONCLUSIVE
 *                       CONTRACT_DRIFT VERIFIER_BROKEN
 *
 * `PASS` appears in both (1) and (2) with different meaning. A unit PASS says a
 * blueprint unit is closed; a gate PASS says one execution produced a green
 * verdict. This module never converts between them.
 *
 * SPELLING: internally every status is the UNDERSCORE form. The blueprint's
 * rendered/external forms are hyphenated (CI-ONLY, INFRA-FAIL, CONTRACT-DRIFT,
 * BROKEN-GATE). `normalizeStatus` is the ONE boundary that accepts an external
 * spelling; `externalStatus` is the ONE boundary that produces it. Variants are
 * never allowed to proliferate inside the system.
 *
 * The schema is deliberately biased so that FALSE SUCCESS IS HARDER THAN
 * EXPLICIT FAILURE: unknown statuses throw rather than defaulting, N/A must be
 * declared rather than inferred, a retry-success is FLAKY rather than PASS, and
 * every non-green status must carry a reason.
 */

export const RESULT_SCHEMA_VERSION = "1.0.0";

/** The 12 frozen gate-result statuses. Order is canonical for rendering. */
export const GATE_STATUSES = [
  "PASS",
  "FAIL",
  "FLAKY",
  "TIMEOUT",
  "BLOCKED",
  "SKIPPED_DECLARED",
  "CI_ONLY",
  "N/A",
  "INFRA_FAIL",
  "CONTRACT_DRIFT",
  "BROKEN_GATE",
  "INCONCLUSIVE",
];

/** The six frozen gate classes. Order is canonical for rendering. */
export const GATE_CLASSES = [
  "PARITY",
  "HARDENING",
  "CLEANROOM",
  "ASSURANCE",
  "REMOTE",
  "AUDIT",
];

/** System terminal states. Distinct from unit status and phase state. */
export const TERMINAL_STATES = [
  "LOCAL_READY_FOR_PR",
  "LOCAL_BLOCKED",
  "LOCAL_INCONCLUSIVE",
  "CONTRACT_DRIFT",
  "VERIFIER_BROKEN",
];

/** External (rendered) spellings <-> internal identifiers. */
const EXTERNAL_BY_INTERNAL = {
  CI_ONLY: "CI-ONLY",
  INFRA_FAIL: "INFRA-FAIL",
  CONTRACT_DRIFT: "CONTRACT-DRIFT",
  BROKEN_GATE: "BROKEN-GATE",
  SKIPPED_DECLARED: "SKIPPED-DECLARED",
};
const INTERNAL_BY_EXTERNAL = Object.fromEntries(
  Object.entries(EXTERNAL_BY_INTERNAL).map(([internal, external]) => [
    external,
    internal,
  ])
);

export class ResultError extends Error {
  constructor(reason, detail = {}) {
    super(reason);
    this.name = "ResultError";
    this.reason = reason;
    Object.assign(this, detail);
  }
}

/** THE single boundary that accepts an external spelling. Never guesses. */
export function normalizeStatus(value) {
  if (typeof value !== "string") {
    throw new ResultError("UNKNOWN_STATUS", { value });
  }
  const candidate = INTERNAL_BY_EXTERNAL[value] ?? value;
  if (!GATE_STATUSES.includes(candidate)) {
    // Deliberately NOT falling back to N/A or INCONCLUSIVE. An unrecognised
    // status is a verifier defect, not a result.
    throw new ResultError("UNKNOWN_STATUS", { value });
  }
  return candidate;
}

/** THE single boundary that produces an external spelling. */
export function externalStatus(internal) {
  if (!GATE_STATUSES.includes(internal)) {
    throw new ResultError("UNKNOWN_STATUS", { value: internal });
  }
  return EXTERNAL_BY_INTERNAL[internal] ?? internal;
}

export function assertClass(value) {
  if (!GATE_CLASSES.includes(value)) {
    throw new ResultError("UNKNOWN_CLASS", { value });
  }
  return value;
}

/** Statuses that count as a green local verdict. Deliberately just one. */
export const GREEN_STATUSES = new Set(["PASS"]);

/** Statuses that are an explicit, declared non-execution. */
export const DECLARED_NON_EXECUTION = new Set([
  "SKIPPED_DECLARED",
  "CI_ONLY",
  "N/A",
]);

/** Statuses that must carry a reason. Everything except a clean PASS. */
export const REASON_REQUIRED = new Set(
  GATE_STATUSES.filter(status => status !== "PASS")
);

/** Statuses that block certificate eligibility when the gate is mandatory. */
export const BLOCKS_ACCEPTANCE = new Set([
  "FAIL",
  "FLAKY",
  "TIMEOUT",
  "BLOCKED",
  "INFRA_FAIL",
  "CONTRACT_DRIFT",
  "BROKEN_GATE",
  "INCONCLUSIVE",
]);

/**
 * Per-status terminal contribution. A gate result contributes at most one
 * terminal state; the run reduction takes the most severe contribution.
 * `null` means the status contributes nothing blocking on its own.
 */
export const TERMINAL_CONTRIBUTION = {
  PASS: null,
  // A declared non-execution is explicitly NOT green and explicitly not a
  // failure. It contributes nothing, and the summary must show it separately
  // so it can never be read as a local pass.
  SKIPPED_DECLARED: null,
  CI_ONLY: null,
  "N/A": null,
  FAIL: "LOCAL_BLOCKED",
  FLAKY: "LOCAL_BLOCKED",
  BLOCKED: "LOCAL_INCONCLUSIVE",
  TIMEOUT: "LOCAL_INCONCLUSIVE",
  INFRA_FAIL: "LOCAL_INCONCLUSIVE",
  INCONCLUSIVE: "LOCAL_INCONCLUSIVE",
  CONTRACT_DRIFT: "CONTRACT_DRIFT",
  BROKEN_GATE: "VERIFIER_BROKEN",
};

/**
 * Severity order for reduction. A more severe terminal state always wins, so
 * aggregation can never downgrade a verifier-broken or drift signal.
 */
export const TERMINAL_SEVERITY = {
  LOCAL_READY_FOR_PR: 0,
  LOCAL_INCONCLUSIVE: 1,
  LOCAL_BLOCKED: 2,
  CONTRACT_DRIFT: 3,
  VERIFIER_BROKEN: 4,
};

/**
 * Build + validate a gate result. Throws rather than coercing, so a malformed
 * result can never enter the record as a plausible-looking one.
 */
export function makeResult(input) {
  const result = {
    schema_version: RESULT_SCHEMA_VERSION,
    gate_id: input.gate_id,
    class: assertClass(input.class),
    status: normalizeStatus(input.status),
    mandatory: input.mandatory !== false,
    attempts: input.attempts ?? [],
    duration_ms: input.duration_ms ?? null,
    exit_code: input.exit_code === undefined ? null : input.exit_code,
    evidence_path: input.evidence_path ?? null,
    reason: input.reason ?? null,
    started_at: input.started_at ?? null,
    completed_at: input.completed_at ?? null,
    contract_check_id: input.contract_check_id ?? null,
    runnability: input.runnability ?? null,
  };
  validateResult(result);
  return result;
}

export function validateResult(result) {
  const problems = [];
  if (result?.schema_version !== RESULT_SCHEMA_VERSION) {
    problems.push(`schema_version != ${RESULT_SCHEMA_VERSION}`);
  }
  if (typeof result?.gate_id !== "string" || result.gate_id.length === 0) {
    problems.push("gate_id must be a non-empty string");
  }
  if (!GATE_CLASSES.includes(result?.class)) {
    problems.push(`unknown class: ${result?.class}`);
  }
  if (!GATE_STATUSES.includes(result?.status)) {
    problems.push(`unknown status: ${result?.status}`);
  }
  if (typeof result?.mandatory !== "boolean") {
    problems.push("mandatory must be boolean");
  }
  if (!Array.isArray(result?.attempts)) {
    problems.push("attempts must be an array");
  } else {
    for (const [index, attempt] of result.attempts.entries()) {
      if (!GATE_STATUSES.includes(normalizeSafe(attempt?.status))) {
        problems.push(`attempts[${index}].status is not a known status`);
      }
      if (attempt?.duration_ms !== undefined && attempt.duration_ms !== null) {
        if (
          typeof attempt.duration_ms !== "number" ||
          attempt.duration_ms < 0 ||
          !Number.isFinite(attempt.duration_ms)
        ) {
          problems.push(`attempts[${index}].duration_ms must be >= 0`);
        }
      }
    }
  }
  if (result?.duration_ms !== null) {
    if (
      typeof result?.duration_ms !== "number" ||
      result.duration_ms < 0 ||
      !Number.isFinite(result.duration_ms)
    ) {
      problems.push("duration_ms must be null or a finite number >= 0");
    }
  }
  if (
    result?.exit_code !== null &&
    (!Number.isInteger(result?.exit_code) || result.exit_code < 0)
  ) {
    problems.push("exit_code must be null or a non-negative integer");
  }
  if (REASON_REQUIRED.has(result?.status) && !result?.reason) {
    // Every non-green status must say WHY. A bare non-green result is how a
    // verdict becomes unfalsifiable.
    problems.push(`status ${result?.status} requires a reason`);
  }
  if (
    result?.status === "PASS" &&
    result?.exit_code !== null &&
    result.exit_code !== 0
  ) {
    problems.push("PASS cannot carry a non-zero exit code");
  }
  if (result?.status === "PASS" && hasFailedAttempt(result)) {
    // The core anti-false-green rule (P03.NEG01).
    problems.push(
      "PASS is invalid when the attempt history contains a failure; the correct status is FLAKY"
    );
  }
  if (result?.status === "CI_ONLY" && result?.exit_code !== null) {
    problems.push(
      "CI_ONLY did not execute locally and cannot carry an exit code"
    );
  }
  if (problems.length) {
    throw new ResultError("INVALID_RESULT", {
      gate_id: result?.gate_id ?? null,
      problems,
    });
  }
  return true;
}

function normalizeSafe(value) {
  try {
    return normalizeStatus(value);
  } catch {
    return null;
  }
}

export function hasFailedAttempt(result) {
  return (result.attempts ?? []).some(attempt => {
    const status = normalizeSafe(attempt?.status);
    return (
      status !== null &&
      status !== "PASS" &&
      !DECLARED_NON_EXECUTION.has(status)
    );
  });
}

/**
 * Classify an execution history. A retry that eventually succeeds is FLAKY —
 * never PASS — and the original failing attempts are preserved.
 */
export function classifyAttempts(attempts, options = {}) {
  if (!Array.isArray(attempts) || attempts.length === 0) {
    throw new ResultError("NO_ATTEMPTS", {});
  }
  const statuses = attempts.map(attempt => normalizeStatus(attempt.status));
  const last = statuses.at(-1);
  const anyFailed = statuses.some(
    status => status !== "PASS" && !DECLARED_NON_EXECUTION.has(status)
  );
  if (last === "PASS" && anyFailed) {
    return {
      status: "FLAKY",
      reason:
        options.reason ??
        `attempt ${statuses.indexOf(statuses.find(s => s !== "PASS")) + 1} of ${statuses.length} did not pass; a later attempt did`,
      attempts,
    };
  }
  return { status: last, reason: options.reason ?? null, attempts };
}

/**
 * Reduce a set of validated results to a system terminal state.
 * Advisory results never contribute a blocking terminal state, but they are
 * never hidden either — the summary still counts them.
 */
export function reduceResults(results, options = {}) {
  const contributions = [];
  for (const result of results) {
    validateResult(result);
    const contribution = TERMINAL_CONTRIBUTION[result.status];
    if (!contribution) continue;
    // BROKEN_GATE means the VERIFIER is untrustworthy. That is true whether the
    // broken gate was mandatory or advisory, so it is never filtered out.
    if (!result.mandatory && result.status !== "BROKEN_GATE") continue;
    contributions.push({ gate_id: result.gate_id, terminal: contribution });
  }
  const missing = options.expectedGateIds
    ? [...options.expectedGateIds].filter(
        id => !results.some(result => result.gate_id === id)
      )
    : [];
  if (missing.length) {
    contributions.push({
      gate_id: missing.join(", "),
      terminal: "LOCAL_INCONCLUSIVE",
    });
  }
  let terminal = "LOCAL_READY_FOR_PR";
  for (const contribution of contributions) {
    if (
      TERMINAL_SEVERITY[contribution.terminal] > TERMINAL_SEVERITY[terminal]
    ) {
      terminal = contribution.terminal;
    }
  }
  return {
    terminal,
    blocking: terminal !== "LOCAL_READY_FOR_PR",
    contributions,
    missing_gate_ids: missing,
  };
}

/** Certificate eligibility. Any mandatory blocking status disqualifies. */
export function certificateEligible(results, options = {}) {
  const reduction = reduceResults(results, options);
  const disqualifying = results.filter(
    result => result.mandatory && BLOCKS_ACCEPTANCE.has(result.status)
  );
  return {
    eligible:
      reduction.terminal === "LOCAL_READY_FOR_PR" && disqualifying.length === 0,
    terminal: reduction.terminal,
    disqualifying: disqualifying.map(result => ({
      gate_id: result.gate_id,
      status: result.status,
    })),
    missing_gate_ids: reduction.missing_gate_ids,
  };
}
