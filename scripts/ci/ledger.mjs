#!/usr/bin/env node
/**
 * ledger.mjs — the SOLE writer of the ci:verify execution ledger.
 *
 * Canonical state:  docs/verification/ci-verify-ledger.json
 * Integrity pin:    docs/verification/ci-verify-ledger.sha256
 * Rendered view:    docs/verification/CI-VERIFY-EXECUTION-LEDGER.md  (generated)
 *
 * Control-plane rules this file ENFORCES (frozen architecture §0.3):
 *   1. `set <ID> PASS` is REFUSED unless every declared evidence path exists,
 *      is non-empty, and hashes. The hash is written into the record.
 *   2. Hand-editing the JSON breaks the .sha256 pin -> LEDGER_TAMPERED.
 *   3. The .md is regenerated from the JSON; divergence -> RENDER_DRIFT.
 *   4. No prose status exists. "mostly passing" is not a representable state.
 *   5. Status transitions follow the state machine; a unit cannot jump from
 *      NOT_STARTED to PASS, because code existing is not completion.
 *
 * Genesis record GEN-000 is SELF-ATTESTING: it cannot be evidence-enforced by
 * a writer that does not yet exist at bootstrap. That is what a trust root is.
 * Its integrity is verified retroactively (P03.NEG04) and again at P10 via the
 * execution-history binding.
 *
 * Subcommands:
 *   init [--force]                     seed the ledger from the blueprint
 *   start <ID>                         NOT_STARTED|FAIL|BLOCKED -> IN_PROGRESS
 *   set <ID> <STATUS> [--evidence p]*  record a terminal status for a unit
 *   phase <PHASE_ID> <STATE>           advance a phase through the state machine
 *   decision <DEC_ID> <VALUE> [--evidence p]*
 *   defect open|update|close ...       append-only defect lifecycle
 *   checkpoint <PHASE_ID> --decision "..." [--evidence p]*
 *   progress [<PHASE_ID>]              closed/total over MANDATORY units
 *   show [<ID>|<PHASE_ID>]             inspect records
 *   render                             regenerate the markdown from the JSON
 *   verify                             tamper / drift / stale-evidence audit
 */
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  BLUEPRINT_VERSION,
  DECISIONS,
  PHASES,
  SCHEMA_VERSION,
  allUnits,
  assertBlueprintUnique,
  assertSeedComplete,
} from "./blueprint.mjs";
import {
  GATE_CLASSES,
  RESULT_SCHEMA_VERSION,
  externalStatus,
  reduceResults,
  validateResult,
} from "./result.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..");
const DOCS = path.join(REPO_ROOT, "docs", "verification");

export const LEDGER_PATH = path.join(DOCS, "ci-verify-ledger.json");
export const SHA_PATH = path.join(DOCS, "ci-verify-ledger.sha256");
export const MD_PATH = path.join(DOCS, "CI-VERIFY-EXECUTION-LEDGER.md");
export const IMPL_PATH = path.join(HERE, "ledger.mjs");
export const BLUEPRINT_PATH = path.join(HERE, "blueprint.mjs");

export const UNIT_STATUSES = [
  "NOT_STARTED",
  "IN_PROGRESS",
  "PASS",
  "FAIL",
  "BLOCKED",
  "INCONCLUSIVE",
  "SKIPPED_DECLARED",
  "N/A",
  "RETIRED",
];

export const PHASE_STATES = [
  "NOT_STARTED",
  "PRECONDITIONS",
  "READY",
  "IN_PROGRESS",
  "IMPLEMENTED",
  "TESTING",
  "AUDITING",
  "REMEDIATING",
  "RETESTING",
  "CHECKPOINT_REVIEW",
  "ACCEPTED",
  "CLOSED",
  "BLOCKED",
  "INCONCLUSIVE",
  "CONTRACT_DRIFT",
  "VERIFIER_BROKEN",
  "OWNER_DECISION_REQUIRED",
];

/** Statuses that count as closed for the acceptance algebra (§0.5). */
const CLOSED_STATUSES = new Set(["PASS", "N/A", "SKIPPED_DECLARED"]);

/** Statuses that require verifiable evidence before they may be recorded. */
const EVIDENCE_REQUIRED = new Set(["PASS"]);

/** Legal unit-status transitions. Anything else throws ILLEGAL_TRANSITION. */
const TRANSITIONS = {
  NOT_STARTED: [
    "IN_PROGRESS",
    "BLOCKED",
    "INCONCLUSIVE",
    "N/A",
    "SKIPPED_DECLARED",
    "RETIRED",
  ],
  IN_PROGRESS: [
    "PASS",
    "FAIL",
    "BLOCKED",
    "INCONCLUSIVE",
    "N/A",
    "SKIPPED_DECLARED",
  ],
  FAIL: ["IN_PROGRESS", "BLOCKED", "INCONCLUSIVE", "RETIRED"],
  BLOCKED: ["IN_PROGRESS", "INCONCLUSIVE", "RETIRED"],
  INCONCLUSIVE: ["IN_PROGRESS", "BLOCKED", "RETIRED"],
  SKIPPED_DECLARED: ["IN_PROGRESS", "RETIRED"],
  "N/A": ["IN_PROGRESS", "RETIRED"],
  PASS: ["RETIRED"],
  RETIRED: [],
};

export function sha256Hex(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

export function sha256File(filePath) {
  return sha256Hex(readFileSync(filePath));
}

/**
 * Canonical serialization: recursively sorted keys, 2-space indent, trailing
 * newline. Deterministic bytes are what make the .sha256 pin meaningful.
 */
export function canonicalJson(value) {
  const sort = node => {
    if (Array.isArray(node)) return node.map(sort);
    if (node && typeof node === "object" && node.constructor === Object) {
      const out = {};
      for (const key of Object.keys(node).sort()) out[key] = sort(node[key]);
      return out;
    }
    return node;
  };
  return `${JSON.stringify(sort(value), null, 2)}\n`;
}

/** Build a single seeded unit record. Shared by buildLedger and `sync`. */
export function seedUnit(unit) {
  return {
    id: unit.id,
    phase: unit.phase,
    kind: unit.kind,
    class: unit.class,
    title: unit.title,
    status: "NOT_STARTED",
    depends_on: unit.depends_on ?? [],
    inputs: [],
    expected_output: unit.expected_output ?? null,
    validation: unit.validation ?? null,
    negative_validation: unit.negative_validation ?? null,
    evidence: [],
    started_at: null,
    completed_at: null,
    attempts: 0,
    // FLAKY is a distinct axis from unit status (§0.2) and from the gate
    // result taxonomy (P03). A retry-success is recorded here, never by
    // laundering the status to PASS.
    flaky: false,
    blocker: null,
    remediation: null,
    exit_requirement: unit.exit_requirement ?? null,
    defects: [],
    notes: [],
  };
}

/** Build the seeded ledger structure. Pure — unit-tested by PB.TEST01. */
export function buildLedger(phases, genesis) {
  assertBlueprintUnique(phases);
  const units = {};
  for (const unit of allUnits(phases)) {
    units[unit.id] = {
      ...seedUnit(unit),
      status: "NOT_STARTED",
    };
  }
  const ledger = {
    schema_version: SCHEMA_VERSION,
    blueprint_version: BLUEPRINT_VERSION,
    genesis,
    phases: phases.map(phase => ({
      id: phase.id,
      title: phase.title,
      assurance_property: phase.assurance_property,
      depends_on: phase.depends_on,
      entry: phase.entry,
      exit: phase.exit,
      state: "NOT_STARTED",
      state_history: [],
    })),
    units,
    decisions: DECISIONS.map(decision => ({ ...decision, evidence: [] })),
    defects: [],
    checkpoints: [],
    // Append-only log of AUTHORIZED implementation-hash changes. GEN-000 is
    // never rewritten; `verify` compares against the newest amendment, or
    // against genesis when the log is empty. (PB.T06, DEF-004 remediation.)
    amendments: [],
    // P03.T07 — gate RESULTS are a separate vocabulary from unit STATUS and
    // are stored append-only. A later PASS never replaces an earlier record.
    result_schema_version: RESULT_SCHEMA_VERSION,
    gate_results: [],
  };
  assertSeedComplete(phases, ledger);
  return ledger;
}

/**
 * Genesis as CORRECTED by the append-only amendment log. GEN-000 itself is
 * never rewritten — a correction is recorded alongside the superseded value,
 * so the original error stays visible forever. (DEF-005.)
 */
export function resolvedGenesis(ledger) {
  const resolved = { ...(ledger.genesis ?? {}) };
  for (const amendment of ledger.amendments ?? []) {
    for (const correction of amendment.genesis_corrections ?? []) {
      resolved[correction.field] = correction.to;
    }
  }
  return resolved;
}

/** Hashes the implementation is currently AUTHORIZED to have. */
export function authorizedHashes(ledger) {
  const latest = (ledger.amendments ?? []).at(-1);
  return {
    ledger_impl_sha256:
      latest?.new_ledger_impl_sha256 ?? ledger.genesis?.ledger_impl_sha256,
    blueprint_sha256:
      latest?.new_blueprint_sha256 ?? ledger.genesis?.blueprint_sha256,
    source: latest ? latest.id : "GEN-000",
  };
}

/**
 * Phases a defect is attributed to. Deliberately the UNION of the phase that
 * detected it and the phase whose gate it affects — the conservative reading.
 * Attributing only by affected_gate would have let every P00-discovered defect
 * fall outside P00 and silently unblock the phase that found it.
 */
export function defectPhases(defect) {
  const phaseOf = id => (typeof id === "string" ? id.split(".")[0] : null);
  return new Set(
    [phaseOf(defect.detected_by), phaseOf(defect.affected_gate)].filter(Boolean)
  );
}

function loadLedger() {
  if (!existsSync(LEDGER_PATH)) {
    throw new Error(`LEDGER_MISSING: ${LEDGER_PATH}`);
  }
  return JSON.parse(readFileSync(LEDGER_PATH, "utf8"));
}

/**
 * Persist ledger + integrity pin + rendered markdown together. Writing all
 * three in one place is what keeps `verify` from failing on ordinary work.
 */
function persist(ledger) {
  mkdirSync(DOCS, { recursive: true });
  const bytes = canonicalJson(ledger);
  writeFileSync(LEDGER_PATH, bytes);
  writeFileSync(
    SHA_PATH,
    `${sha256Hex(Buffer.from(bytes))}  ci-verify-ledger.json\n`
  );
  writeFileSync(MD_PATH, renderMarkdown(ledger));
}

/**
 * The three live control-plane artifacts. Recording any of them AS evidence is
 * structurally invalid: they are rewritten on every ledger write, so the hash
 * captured at record time is stale the instant the next unit is recorded.
 * Evidence must be an IMMUTABLE observation record; live artifacts are
 * referenced BY HASH inside such a record, never as an evidence path.
 * (DEF-001 — identified at design time during PB.T02, before it manifested.)
 */
const SELF_REFERENTIAL_EVIDENCE = new Set([LEDGER_PATH, SHA_PATH, MD_PATH]);

/** Validate + hash an evidence path. Throws rather than recording a lie. */
export function collectEvidence(paths, root = REPO_ROOT) {
  const out = [];
  for (const rel of paths) {
    const abs = path.isAbsolute(rel) ? rel : path.join(root, rel);
    if (SELF_REFERENTIAL_EVIDENCE.has(abs)) {
      throw new Error(
        `EVIDENCE_SELF_REFERENCE: ${rel} is a live control-plane artifact ` +
          `and is rewritten on every ledger write; record an immutable ` +
          `observation artifact that cites its hash instead`
      );
    }
    if (!existsSync(abs)) throw new Error(`EVIDENCE_MISSING: ${rel}`);
    const stat = statSync(abs);
    if (!stat.isFile()) throw new Error(`EVIDENCE_NOT_A_FILE: ${rel}`);
    if (stat.size === 0) throw new Error(`EVIDENCE_EMPTY: ${rel}`);
    out.push({
      path: path.relative(root, abs),
      sha256: sha256File(abs),
      bytes: stat.size,
    });
  }
  return out;
}

/**
 * Record a unit status. Pure over `ledger` (mutates and returns it) so the
 * evidence-refusal behaviour is directly unit-testable.
 */
export function setStatus(ledger, id, status, options = {}) {
  const unit = ledger.units[id];
  if (!unit) throw new Error(`UNKNOWN_UNIT_ID: ${id}`);
  if (!UNIT_STATUSES.includes(status)) {
    throw new Error(`UNKNOWN_STATUS: ${status}`);
  }
  const legal = TRANSITIONS[unit.status] ?? [];
  if (!legal.includes(status)) {
    throw new Error(
      `ILLEGAL_TRANSITION: ${id} ${unit.status} -> ${status} ` +
        `(legal: ${legal.join(", ") || "none"})`
    );
  }
  if (EVIDENCE_REQUIRED.has(status)) {
    const declared = options.evidence ?? [];
    if (declared.length === 0) {
      throw new Error(
        `EVIDENCE_REQUIRED: ${id} cannot be set ${status} without evidence`
      );
    }
    unit.evidence = collectEvidence(declared, options.root ?? REPO_ROOT);
  } else if (options.evidence?.length) {
    unit.evidence = collectEvidence(
      options.evidence,
      options.root ?? REPO_ROOT
    );
  }
  if (options.flaky !== undefined) {
    unit.flaky = options.flaky === true || options.flaky === "true";
  }
  const now = options.now ?? new Date().toISOString();
  if (status === "IN_PROGRESS") {
    unit.started_at = unit.started_at ?? now;
    unit.attempts += 1;
    unit.blocker = null;
  } else {
    unit.completed_at = now;
  }
  if (status === "BLOCKED" || status === "INCONCLUSIVE" || status === "FAIL") {
    unit.blocker = options.blocker ?? unit.blocker ?? "unspecified";
    unit.remediation = options.remediation ?? unit.remediation;
  }
  if (options.note) unit.notes.push(options.note);
  unit.status = status;
  return ledger;
}

/** Acceptance algebra (§0.5): closed/total over MANDATORY units only. */
export function progress(ledger, phaseId = null) {
  const units = Object.values(ledger.units).filter(
    unit =>
      (phaseId ? unit.phase === phaseId : true) && unit.class === "MANDATORY"
  );
  const byKind = {};
  for (const unit of units) {
    byKind[unit.kind] ??= { closed: 0, total: 0 };
    byKind[unit.kind].total += 1;
    if (CLOSED_STATUSES.has(unit.status)) byKind[unit.kind].closed += 1;
  }
  const closed = units.filter(unit => CLOSED_STATUSES.has(unit.status)).length;
  const failed = units.filter(unit => unit.status === "FAIL").length;
  const blocked = units.filter(unit =>
    ["BLOCKED", "INCONCLUSIVE"].includes(unit.status)
  ).length;
  const notStarted = units.filter(unit => unit.status === "NOT_STARTED").length;
  return {
    phase: phaseId,
    closed,
    total: units.length,
    failed,
    blocked,
    not_started: notStarted,
    by_kind: byKind,
    // DEF-004: this is the UNIT-CLOSURE TERM ONLY. It is deliberately not
    // named `acceptance_met` — phase acceptance is `acceptPhase()`.
    units_closed_complete: closed === units.length,
  };
}

/** Severities that block phase acceptance while a defect stays OPEN. */
const BLOCKING_SEVERITIES = new Set(["MEDIUM", "HIGH", "CRITICAL"]);

/**
 * The FULL frozen ACCEPT(P) predicate (§0.5). Returns every term separately so
 * a caller can never collapse a partial result into a green verdict — that was
 * exactly DEF-004.
 *
 *   ACCEPT(P) <=> all MANDATORY closed
 *              AND every GATE* = PASS
 *              AND every CP* recorded with valid evidence hashes
 *              AND every required AUTH* granted
 *              AND zero OPEN defects severity >= MEDIUM attributed to P
 *              AND evidence completeness = 100%
 *              AND zero FLAKY among MANDATORY units
 */
/**
 * P03.T07 — append a validated gate result. Append-only: a duplicate gate_id
 * is refused rather than overwritten, because overwriting is exactly how an
 * earlier failure disappears.
 */
export function recordGateResult(ledger, result) {
  validateResult(result);
  ledger.gate_results ??= [];
  if (
    ledger.gate_results.some(existing => existing.gate_id === result.gate_id)
  ) {
    throw new Error(`DUPLICATE_GATE_RESULT: ${result.gate_id}`);
  }
  ledger.gate_results.push(result);
  return ledger;
}

/**
 * P03.T07 — reduce recorded gate results to a SYSTEM TERMINAL state. This is a
 * separate axis from acceptPhase(): phase acceptance is about blueprint units,
 * the terminal state is about gate execution. Neither substitutes for the other.
 */
export function systemTerminal(ledger, options = {}) {
  return reduceResults(ledger.gate_results ?? [], options);
}

/** Six-class counts over recorded gate results. Empty classes always appear. */
export function gateResultSummary(ledger) {
  const summary = {};
  for (const klass of GATE_CLASSES) {
    const rows = (ledger.gate_results ?? []).filter(r => r.class === klass);
    const counts = {};
    for (const row of rows) counts[row.status] = (counts[row.status] ?? 0) + 1;
    summary[klass] = { total: rows.length, counts };
  }
  return summary;
}

export function acceptPhase(ledger, phaseId, options = {}) {
  const root = options.root ?? REPO_ROOT;
  const mandatory = Object.values(ledger.units).filter(
    unit => unit.phase === phaseId && unit.class === "MANDATORY"
  );
  const reasons = [];

  const unclosed = mandatory.filter(u => !CLOSED_STATUSES.has(u.status));
  if (unclosed.length) {
    reasons.push(`UNITS_NOT_CLOSED: ${unclosed.map(u => u.id).join(", ")}`);
  }

  const badGates = mandatory.filter(
    u => u.kind === "ACCEPTANCE_GATE" && u.status !== "PASS"
  );
  if (badGates.length) {
    reasons.push(`GATE_NOT_PASS: ${badGates.map(u => u.id).join(", ")}`);
  }

  const badCheckpoints = mandatory.filter(
    u =>
      u.kind === "CHECKPOINT" &&
      (u.status !== "PASS" || u.evidence.length === 0)
  );
  if (badCheckpoints.length) {
    reasons.push(
      `CHECKPOINT_NOT_RECORDED: ${badCheckpoints.map(u => u.id).join(", ")}`
    );
  }

  const ungranted = mandatory.filter(u => {
    if (u.kind !== "AUTHORIZATION") return false;
    if (u.status !== "PASS") return true;
    const referenced = (ledger.decisions ?? []).filter(
      d => d.required_by === u.id
    );
    return referenced.some(d => d.status !== "RECORDED" || d.value === null);
  });
  if (ungranted.length) {
    reasons.push(`AUTH_NOT_GRANTED: ${ungranted.map(u => u.id).join(", ")}`);
  }

  const blockingDefects = (ledger.defects ?? []).filter(
    d =>
      d.status !== "CLOSED" &&
      BLOCKING_SEVERITIES.has(d.severity) &&
      defectPhases(d).has(phaseId)
  );
  if (blockingDefects.length) {
    reasons.push(
      `OPEN_DEFECTS: ${blockingDefects.map(d => `${d.id}(${d.severity})`).join(", ")}`
    );
  }

  const evidenceGaps = [];
  for (const unit of mandatory) {
    if (!CLOSED_STATUSES.has(unit.status)) continue;
    if (unit.status === "PASS" && unit.evidence.length === 0) {
      evidenceGaps.push(`${unit.id}(none)`);
      continue;
    }
    for (const item of unit.evidence) {
      const abs = path.join(root, item.path);
      if (!existsSync(abs))
        evidenceGaps.push(`${unit.id}->${item.path}(missing)`);
      else if (sha256File(abs) !== item.sha256) {
        evidenceGaps.push(`${unit.id}->${item.path}(hash)`);
      }
    }
  }
  if (evidenceGaps.length) {
    reasons.push(`EVIDENCE_INCOMPLETE: ${evidenceGaps.join(", ")}`);
  }

  const flaky = mandatory.filter(u => u.flaky === true);
  if (flaky.length) {
    reasons.push(`FLAKY_MANDATORY: ${flaky.map(u => u.id).join(", ")}`);
  }

  return {
    phase: phaseId,
    accepted: reasons.length === 0,
    reasons,
    terms: {
      all_mandatory_closed: unclosed.length === 0,
      all_gates_pass: badGates.length === 0,
      all_checkpoints_recorded: badCheckpoints.length === 0,
      all_authorizations_granted: ungranted.length === 0,
      zero_blocking_open_defects: blockingDefects.length === 0,
      evidence_complete: evidenceGaps.length === 0,
      zero_flaky_mandatory: flaky.length === 0,
    },
  };
}

const KIND_ORDER = [
  "TASK",
  "SUBSTEP",
  "POSITIVE_VALIDATION",
  "NEGATIVE_VALIDATION",
  "REGRESSION",
  "CONFORMANCE",
  "FAILURE_INJECTION",
  "CLEANUP",
  "AUDIT",
  "EVIDENCE",
  "ACCEPTANCE_GATE",
  "AUTHORIZATION",
  "CHECKPOINT",
];

/**
 * Render the markdown view. PURE function of ledger state — no clocks, no
 * environment reads — so PB.TEST02 can assert exact conformance.
 */
export function renderMarkdown(ledger) {
  const lines = [];
  lines.push("# ci:verify — execution ledger");
  lines.push("");
  lines.push(
    "> GENERATED FILE. Do not edit by hand. Source of truth is",
    "> `ci-verify-ledger.json`, written only by `scripts/ci/ledger.mjs`.",
    "> Hand edits break `ci-verify-ledger.sha256` (LEDGER_TAMPERED) and are",
    "> detected by `node scripts/ci/ledger.mjs verify`."
  );
  lines.push("");
  lines.push("## Genesis — GEN-000 (self-attesting trust root)");
  lines.push("");
  lines.push("| Field | Value |");
  lines.push("| --- | --- |");
  for (const key of Object.keys(ledger.genesis).sort()) {
    lines.push(`| \`${key}\` | \`${ledger.genesis[key]}\` |`);
  }
  lines.push("");

  lines.push("## Phase roll-up (MANDATORY units only)");
  lines.push("");
  lines.push("| Phase | Title | State | Closed / Total | Failed | Blocked |");
  lines.push("| --- | --- | --- | --- | --- | --- |");
  for (const phase of ledger.phases) {
    const stats = progress(ledger, phase.id);
    lines.push(
      `| \`${phase.id}\` | ${phase.title} | \`${phase.state}\` | ` +
        `${stats.closed} / ${stats.total} | ${stats.failed} | ${stats.blocked} |`
    );
  }
  lines.push("");

  for (const phase of ledger.phases) {
    const stats = progress(ledger, phase.id);
    lines.push(`## ${phase.id} — ${phase.title}`);
    lines.push("");
    lines.push(`**State:** \`${phase.state}\``);
    lines.push("");
    lines.push(`**Assurance property:** ${phase.assurance_property}`);
    lines.push("");
    lines.push(
      `**Depends on:** ${phase.depends_on.length ? phase.depends_on.map(id => `\`${id}\``).join(", ") : "none"}`
    );
    lines.push("");
    lines.push(`**Progress (MANDATORY):** ${stats.closed} / ${stats.total}`);
    lines.push("");
    lines.push("**Entry checklist**");
    lines.push("");
    for (const item of phase.entry) lines.push(`- [ ] ${item}`);
    lines.push("");
    lines.push("**Exit checklist**");
    lines.push("");
    for (const item of phase.exit) lines.push(`- [ ] ${item}`);
    lines.push("");
    lines.push("| ID | Kind | Class | Status | Attempts | Evidence | Title |");
    lines.push("| --- | --- | --- | --- | --- | --- | --- |");
    const units = Object.values(ledger.units)
      .filter(unit => unit.phase === phase.id)
      .sort(
        (a, b) =>
          KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) ||
          a.id.localeCompare(b.id)
      );
    for (const unit of units) {
      const evidence = unit.evidence.length
        ? unit.evidence.map(item => `\`${item.sha256.slice(0, 12)}\``).join(" ")
        : "—";
      lines.push(
        `| \`${unit.id}\` | ${unit.kind} | ${unit.class} | \`${unit.status}\` | ` +
          `${unit.attempts} | ${evidence} | ${unit.title} |`
      );
    }
    lines.push("");
  }

  // P03.T08 — six-class gate-result summary, rendered from canonical JSON.
  // Every class appears even when empty: a class that vanishes from a report is
  // indistinguishable from a class that passed.
  lines.push("## Gate results by class (P03)");
  lines.push("");
  lines.push(
    `**Result schema:** \`${ledger.result_schema_version ?? "(not migrated)"}\``
  );
  lines.push("");
  lines.push("| Class | Results | Status breakdown |");
  lines.push("| --- | --- | --- |");
  {
    const summary = gateResultSummary(ledger);
    for (const klass of GATE_CLASSES) {
      const entry = summary[klass];
      const breakdown = Object.keys(entry.counts).length
        ? Object.entries(entry.counts)
            .sort()
            .map(([status, n]) => `${externalStatus(status)}=${n}`)
            .join(", ")
        : "—";
      lines.push(`| \`${klass}\` | ${entry.total} | ${breakdown} |`);
    }
  }
  lines.push("");

  lines.push("## Owner decisions");
  lines.push("");
  lines.push("| ID | Required by | Allowed values | Status | Value |");
  lines.push("| --- | --- | --- | --- | --- |");
  for (const decision of ledger.decisions) {
    lines.push(
      `| \`${decision.id}\` | \`${decision.required_by}\` | ` +
        `${decision.allowed_values.join(" \\| ")} | \`${decision.status}\` | ` +
        `${decision.value ? `\`${decision.value}\`` : "—"} |`
    );
  }
  lines.push("");

  lines.push("## Defects (append-only)");
  lines.push("");
  if (ledger.defects.length === 0) {
    lines.push("None recorded.");
  } else {
    lines.push("| ID | Detected by | Severity | Status | Title |");
    lines.push("| --- | --- | --- | --- | --- |");
    for (const defect of ledger.defects) {
      lines.push(
        `| \`${defect.id}\` | \`${defect.detected_by}\` | ${defect.severity} | ` +
          `\`${defect.status}\` | ${defect.title} |`
      );
    }
  }
  lines.push("");

  lines.push("## Checkpoints");
  lines.push("");
  if (ledger.checkpoints.length === 0) {
    lines.push("None recorded.");
  } else {
    lines.push("| Phase | Decision | Recorded at | Evidence |");
    lines.push("| --- | --- | --- | --- |");
    for (const checkpoint of ledger.checkpoints) {
      const evidence = checkpoint.evidence.length
        ? checkpoint.evidence
            .map(item => `\`${item.sha256.slice(0, 12)}\``)
            .join(" ")
        : "—";
      lines.push(
        `| \`${checkpoint.phase}\` | **${checkpoint.decision}** | ` +
          `${checkpoint.recorded_at} | ${evidence} |`
      );
    }
  }
  lines.push("");
  return `${lines.join("\n")}`;
}

/**
 * Full integrity audit: tamper pin, blueprint conformance, render conformance,
 * genesis completeness, implementation drift, stale evidence.
 */
export function verifyLedger(options = {}) {
  const problems = [];
  const phases = options.phases ?? PHASES;
  if (!existsSync(LEDGER_PATH))
    return { ok: false, problems: ["LEDGER_MISSING"] };

  const raw = readFileSync(LEDGER_PATH);
  const ledger = JSON.parse(raw.toString("utf8"));

  if (!existsSync(SHA_PATH)) problems.push("SHA_PIN_MISSING");
  else {
    const pinned = readFileSync(SHA_PATH, "utf8").trim().split(/\s+/)[0];
    const actual = sha256Hex(raw);
    if (pinned !== actual) {
      problems.push(
        `LEDGER_TAMPERED: pinned=${pinned.slice(0, 12)} actual=${actual.slice(0, 12)}`
      );
    }
  }

  try {
    assertBlueprintUnique(phases);
    assertSeedComplete(phases, ledger);
  } catch (error) {
    problems.push(`BLUEPRINT_DRIFT: ${error.message}`);
  }

  if (!existsSync(MD_PATH)) problems.push("RENDER_MISSING");
  else if (readFileSync(MD_PATH, "utf8") !== renderMarkdown(ledger)) {
    problems.push("RENDER_DRIFT");
  }

  const required = [
    "schema_version",
    "ledger_impl_sha256",
    "blueprint_sha256",
    "git_head_at_bootstrap",
    "created_at",
  ];
  const resolvedGen = resolvedGenesis(ledger);
  // DEF-005 regression guard: a placeholder is truthy, so a presence-only
  // check let `git_head_at_bootstrap: "unknown"` into the trust root. The
  // bootstrap commit must now be a real 40-hex object id.
  if (!/^[0-9a-f]{40}$/.test(resolvedGen.git_head_at_bootstrap ?? "")) {
    problems.push(
      `GENESIS_INVALID: git_head_at_bootstrap is not a 40-hex commit id (${resolvedGen.git_head_at_bootstrap})`
    );
  }
  for (const field of required) {
    if (!resolvedGen?.[field]) problems.push(`GENESIS_INCOMPLETE: ${field}`);
  }
  // Compare against the AUTHORIZED hashes (latest AMD-* amendment, or genesis
  // when the log is empty). GEN-000 is never rewritten — the amendment log is
  // append-only, so the chain from bootstrap stays fully auditable.
  const authorized = authorizedHashes(ledger);
  if (authorized.ledger_impl_sha256 !== sha256File(IMPL_PATH)) {
    problems.push(
      `LEDGER_IMPL_DRIFT: ledger.mjs differs from the hash authorized by ${authorized.source}`
    );
  }
  if (authorized.blueprint_sha256 !== sha256File(BLUEPRINT_PATH)) {
    problems.push(
      `BLUEPRINT_IMPL_DRIFT: blueprint.mjs differs from the hash authorized by ${authorized.source}`
    );
  }
  for (const amendment of ledger.amendments ?? []) {
    for (const field of [
      "id",
      "reason",
      "defect",
      "superseded_ledger_impl_sha256",
      "new_ledger_impl_sha256",
    ]) {
      if (!amendment[field]) {
        problems.push(`AMENDMENT_INCOMPLETE: ${amendment.id ?? "?"}.${field}`);
      }
    }
  }

  for (const unit of Object.values(ledger.units)) {
    for (const item of unit.evidence) {
      const abs = path.join(REPO_ROOT, item.path);
      if (!existsSync(abs)) {
        problems.push(`STALE_EVIDENCE: ${unit.id} -> ${item.path} (missing)`);
      } else if (sha256File(abs) !== item.sha256) {
        problems.push(
          `STALE_EVIDENCE: ${unit.id} -> ${item.path} (hash changed)`
        );
      }
    }
  }

  return { ok: problems.length === 0, problems, ledger };
}

/**
 * Flags that take NO value. Without this set a boolean flag swallows the next
 * token as its value — which is exactly how `init --force --head <sha>` wrote
 * `git_head_at_bootstrap: "unknown"` into GEN-000 (DEF-005).
 */
const BOOLEAN_FLAGS = new Set(["force", "flaky", "no-flaky"]);

export function parseArgs(argv) {
  const positional = [];
  const flags = { evidence: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--evidence") flags.evidence.push(argv[(index += 1)]);
    else if (token.startsWith("--")) {
      const key = token.slice(2);
      if (BOOLEAN_FLAGS.has(key)) flags[key] = true;
      else flags[key] = argv[(index += 1)];
    } else positional.push(token);
  }
  return { positional, flags };
}

function cmdInit(flags) {
  if (existsSync(LEDGER_PATH) && flags.force === undefined) {
    throw new Error(`LEDGER_EXISTS: ${LEDGER_PATH} (use --force to reseed)`);
  }
  const genesis = {
    record_id: "GEN-000",
    schema_version: SCHEMA_VERSION,
    blueprint_version: BLUEPRINT_VERSION,
    ledger_impl_sha256: sha256File(IMPL_PATH),
    blueprint_sha256: sha256File(BLUEPRINT_PATH),
    git_head_at_bootstrap: flags.head ?? "unknown",
    created_at: flags.now ?? new Date().toISOString(),
    self_attesting: true,
    note:
      "Trust root. Cannot be evidence-enforced by a writer that does not yet " +
      "exist at bootstrap; verified retroactively by P03.NEG04 and bound into " +
      "the P10 execution-history hash.",
  };
  const ledger = buildLedger(PHASES, genesis);
  persist(ledger);
  const stats = progress(ledger);
  console.log(
    `[ledger] initialized ${Object.keys(ledger.units).length} units across ` +
      `${ledger.phases.length} phases (${stats.total} MANDATORY)`
  );
  console.log(
    `[ledger] genesis ledger_impl_sha256=${genesis.ledger_impl_sha256}`
  );
  console.log(`[ledger] genesis blueprint_sha256=${genesis.blueprint_sha256}`);
}

function main(argv) {
  const { positional, flags } = parseArgs(argv);
  const [command, ...rest] = positional;

  if (command === "init") return cmdInit(flags);

  if (command === "render") {
    const ledger = loadLedger();
    persist(ledger);
    return console.log(`[ledger] rendered ${MD_PATH}`);
  }

  if (command === "verify") {
    const result = verifyLedger();
    if (result.ok) {
      console.log(
        "[ledger] VERIFY OK — no tampering, drift, or stale evidence"
      );
      return;
    }
    console.error("[ledger] VERIFY FAILED");
    for (const problem of result.problems) console.error(`  - ${problem}`);
    process.exitCode = 1;
    return;
  }

  if (command === "migrate") {
    // ADDITIVE ONLY (P03.T07). Adds top-level keys a newer schema requires,
    // preserving every existing value. History is never rewritten as though
    // the new schema had always existed.
    const ledger = loadLedger();
    const added = [];
    if (ledger.gate_results === undefined) {
      ledger.gate_results = [];
      added.push("gate_results");
    }
    if (ledger.result_schema_version === undefined) {
      ledger.result_schema_version = RESULT_SCHEMA_VERSION;
      added.push("result_schema_version");
    }
    persist(ledger);
    console.log(
      `[ledger] migrate added ${added.length} key(s): ${added.join(", ") || "(none)"}`
    );
    return;
  }

  if (command === "sync") {
    // ADDITIVE ONLY. Seeds units newly declared in the blueprint; never
    // modifies or removes an existing record. (PB.T06)
    const ledger = loadLedger();
    ledger.amendments ??= [];
    const declared = allUnits(PHASES);
    const added = [];
    for (const unit of declared) {
      if (!ledger.units[unit.id]) {
        ledger.units[unit.id] = seedUnit(unit);
        added.push(unit.id);
      }
    }
    const declaredDecisions = new Set(ledger.decisions.map(d => d.id));
    const addedDecisions = [];
    for (const decision of DECISIONS) {
      if (!declaredDecisions.has(decision.id)) {
        ledger.decisions.push({ ...decision, evidence: [] });
        addedDecisions.push(decision.id);
      }
    }
    for (const phase of PHASES) {
      if (!ledger.phases.some(p => p.id === phase.id)) {
        throw new Error(`SYNC_CANNOT_ADD_PHASE: ${phase.id}`);
      }
    }
    assertSeedComplete(PHASES, ledger);
    persist(ledger);
    console.log(
      `[ledger] sync added ${added.length} unit(s): ${added.join(", ") || "(none)"}`
    );
    console.log(
      `[ledger] sync added ${addedDecisions.length} decision(s): ${addedDecisions.join(", ") || "(none)"}`
    );
    return;
  }

  if (command === "amend") {
    // Append-only authorization of a new implementation hash. GEN-000 is left
    // byte-identical; the amendment records what changed and why. (PB.T06)
    const ledger = loadLedger();
    ledger.amendments ??= [];
    if (!flags.reason) throw new Error("AMENDMENT_REASON_REQUIRED");
    if (!flags.defect) throw new Error("AMENDMENT_DEFECT_REQUIRED");
    const previous = authorizedHashes(ledger);
    const amendment = {
      id: `AMD-${String(ledger.amendments.length + 1).padStart(3, "0")}`,
      reason: flags.reason,
      defect: flags.defect,
      superseded_source: previous.source,
      superseded_ledger_impl_sha256: previous.ledger_impl_sha256,
      superseded_blueprint_sha256: previous.blueprint_sha256,
      new_ledger_impl_sha256: sha256File(IMPL_PATH),
      new_blueprint_sha256: sha256File(BLUEPRINT_PATH),
      at: new Date().toISOString(),
      // Optional append-only correction of a GEN-000 field. The superseded
      // value is retained so the original error stays auditable (DEF-005).
      genesis_corrections: flags["correct-genesis"]
        ? [
            {
              field: flags["correct-genesis"],
              from: resolvedGenesis(ledger)[flags["correct-genesis"]] ?? null,
              to: flags["correct-value"],
              reason: flags.reason,
            },
          ]
        : [],
      evidence: collectEvidence(flags.evidence),
    };
    if (flags["correct-genesis"] && !flags["correct-value"]) {
      throw new Error("GENESIS_CORRECTION_VALUE_REQUIRED");
    }
    ledger.amendments.push(amendment);
    persist(ledger);
    console.log(
      `[ledger] ${amendment.id} authorizes ledger.mjs=${amendment.new_ledger_impl_sha256.slice(0, 12)} ` +
        `blueprint.mjs=${amendment.new_blueprint_sha256.slice(0, 12)} (was ${previous.source})`
    );
    return;
  }

  if (command === "accept") {
    const ledger = loadLedger();
    const result = acceptPhase(ledger, rest[0]);
    console.log(JSON.stringify(result, null, 2));
    if (!result.accepted) process.exitCode = 1;
    return;
  }

  if (command === "start") {
    const ledger = loadLedger();
    setStatus(ledger, rest[0], "IN_PROGRESS", flags);
    persist(ledger);
    return console.log(`[ledger] ${rest[0]} -> IN_PROGRESS`);
  }

  if (command === "set") {
    const ledger = loadLedger();
    setStatus(ledger, rest[0], rest[1], {
      evidence: flags.evidence,
      blocker: flags.blocker,
      remediation: flags.remediation,
      note: flags.note,
    });
    persist(ledger);
    const unit = ledger.units[rest[0]];
    return console.log(
      `[ledger] ${unit.id} -> ${unit.status} (evidence: ${unit.evidence.length})`
    );
  }

  if (command === "phase") {
    const ledger = loadLedger();
    const [phaseId, state] = rest;
    if (!PHASE_STATES.includes(state))
      throw new Error(`UNKNOWN_PHASE_STATE: ${state}`);
    const phase = ledger.phases.find(item => item.id === phaseId);
    if (!phase) throw new Error(`UNKNOWN_PHASE: ${phaseId}`);
    phase.state_history.push({
      from: phase.state,
      to: state,
      at: new Date().toISOString(),
    });
    phase.state = state;
    persist(ledger);
    return console.log(`[ledger] phase ${phaseId} -> ${state}`);
  }

  if (command === "decision") {
    const ledger = loadLedger();
    const [decisionId, value] = rest;
    const decision = ledger.decisions.find(item => item.id === decisionId);
    if (!decision) throw new Error(`UNKNOWN_DECISION: ${decisionId}`);
    if (!decision.allowed_values.includes(value)) {
      throw new Error(
        `ILLEGAL_DECISION_VALUE: ${value} (allowed: ${decision.allowed_values.join(", ")})`
      );
    }
    decision.value = value;
    decision.status = "RECORDED";
    decision.recorded_at = new Date().toISOString();
    decision.evidence = collectEvidence(flags.evidence);
    persist(ledger);
    return console.log(`[ledger] ${decisionId} = ${value}`);
  }

  if (command === "supersede-evidence") {
    // APPEND-ONLY evidence supersession (DEF-028). A closed unit's status is
    // terminal and is NOT touched here; only its evidence pointer moves, and
    // the superseded paths AND their original hashes are retained forever so
    // the original record stays auditable. Same shape as the append-only
    // GEN-000 correction AMD-001 introduced for DEF-005.
    //
    // This exists because a RUN ARTIFACT was recorded as immutable unit
    // evidence and a later authorized run legitimately regenerated it. It is
    // deliberately expensive to use: reason, defect, and replacement evidence
    // are all mandatory, and every use is visible in the rendered ledger.
    const ledger = loadLedger();
    const [unitId] = rest;
    const unit = ledger.units[unitId];
    if (!unit) throw new Error(`UNKNOWN_UNIT_ID: ${unitId}`);
    if (!flags.reason) throw new Error("SUPERSESSION_REASON_REQUIRED");
    if (!flags.defect) throw new Error("SUPERSESSION_DEFECT_REQUIRED");
    if (!flags.evidence.length) {
      throw new Error("SUPERSESSION_EVIDENCE_REQUIRED");
    }
    unit.superseded_evidence ??= [];
    unit.superseded_evidence.push({
      at: new Date().toISOString(),
      reason: flags.reason,
      defect: flags.defect,
      previous: unit.evidence.map(item => ({
        path: item.path,
        sha256: item.sha256,
      })),
    });
    unit.evidence = collectEvidence(flags.evidence);
    persist(ledger);
    return console.log(
      `[ledger] ${unit.id} evidence superseded (${unit.superseded_evidence.length} supersession(s) on record; status unchanged: ${unit.status})`
    );
  }

  if (command === "defect") {
    const ledger = loadLedger();
    const [action, defectId] = rest;
    if (action === "open") {
      if (ledger.defects.some(item => item.id === defectId)) {
        throw new Error(`DEFECT_ID_REUSED: ${defectId}`);
      }
      ledger.defects.push({
        id: defectId,
        detected_by: flags["detected-by"] ?? null,
        severity: flags.severity ?? "MEDIUM",
        status: "OPEN",
        title: flags.title ?? "",
        root_cause: null,
        affected_gate: flags["affected-gate"] ?? null,
        blast_radius: null,
        corrective_action: null,
        regression_test_id: null,
        evidence: [],
        retest_result: null,
        opened_at: new Date().toISOString(),
        closed_at: null,
        history: [],
      });
    } else {
      const defect = ledger.defects.find(item => item.id === defectId);
      if (!defect) throw new Error(`UNKNOWN_DEFECT: ${defectId}`);
      defect.history.push({ at: new Date().toISOString(), action, flags });
      for (const [key, value] of Object.entries(flags)) {
        if (key === "evidence") continue;
        if (key in defect) defect[key] = value;
      }
      if (flags.evidence.length)
        defect.evidence = collectEvidence(flags.evidence);
      if (action === "close") {
        defect.status = "CLOSED";
        defect.closed_at = new Date().toISOString();
      }
    }
    persist(ledger);
    return console.log(`[ledger] defect ${defectId} ${action}`);
  }

  if (command === "checkpoint") {
    const ledger = loadLedger();
    const [phaseId] = rest;
    if (!flags.decision) throw new Error("CHECKPOINT_DECISION_REQUIRED");
    ledger.checkpoints.push({
      phase: phaseId,
      decision: flags.decision,
      recorded_at: new Date().toISOString(),
      evidence: collectEvidence(flags.evidence),
    });
    persist(ledger);
    return console.log(`[ledger] checkpoint ${phaseId}: ${flags.decision}`);
  }

  if (command === "progress") {
    const ledger = loadLedger();
    const stats = progress(ledger, rest[0] ?? null);
    console.log(JSON.stringify(stats, null, 2));
    return;
  }

  if (command === "show") {
    const ledger = loadLedger();
    const key = rest[0];
    if (!key) return console.log(JSON.stringify(progress(ledger), null, 2));
    if (ledger.units[key])
      return console.log(JSON.stringify(ledger.units[key], null, 2));
    const units = Object.values(ledger.units).filter(
      unit => unit.phase === key
    );
    return console.log(JSON.stringify(units, null, 2));
  }

  throw new Error(`UNKNOWN_COMMAND: ${command ?? "(none)"}`);
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(`[ledger] ${error.message}`);
    process.exitCode = 1;
  }
}
