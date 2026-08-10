/**
 * repairManifest.ts — the immutable repair manifest for the M-203 closeout.
 *
 * ── The contract this enforces ───────────────────────────────────────────────
 * A historical repair must NOT be "recompute, then write whatever you get".
 * That pattern makes the reviewed preview and the executed write two separate
 * computations over mutable external state (the MLB Stats API, the games table,
 * the deployed code), so what a reviewer approved is not provably what runs.
 *
 * The sequence enforced here is instead:
 *
 *     compute → freeze → review → approve → apply the EXACT frozen result → verify
 *
 * The manifest is the frozen artifact. It carries, for every candidate row:
 * its identity, its complete pre-image, the inputs used, the proposed values,
 * and a classification. Applying a manifest performs no recomputation — it
 * writes recorded values under a compare-and-swap guard on the recorded
 * pre-image.
 *
 * ── Accounting identity ─────────────────────────────────────────────────────
 * Every candidate row reaches exactly one classification, and
 *
 *     TOTAL_CANDIDATES === sum(counts of every classification)
 *
 * is asserted, not assumed. An unexplained remainder is the failure mode this
 * whole module exists to make impossible: it is how a repair silently skips
 * rows and still reports success.
 */
import { createHash } from "node:crypto";
import {
  BRIER_MARKETS,
  M203_AFFECTED_FIELDS,
  M203_INVARIANT_FIELDS,
  brierEquals,
  isBrierInDomain,
  oracleBrier,
  readProbability,
  type BinaryOutcome,
  type BrierField,
} from "./brierOracle";

// ─── Classification ───────────────────────────────────────────────────────────

/**
 * Every terminal state a candidate row can reach. Mutually exclusive and
 * exhaustive by construction — classifyCandidate() returns exactly one.
 */
export const CLASSIFICATIONS = [
  /** Repairable: at least one affected Brier field changes. */
  "CORRECTION_REQUIRED",
  /** Already carries the correct value — nothing to do. */
  "ALREADY_CORRECT",
  /** Repairable in principle, but no field actually moves. */
  "EXPECTED_UNCHANGED",
  /** Correct result is NULL and the row already holds NULL. */
  "VALID_NULL_RESULT",
  /** A probability or book line needed for the affected markets is absent. */
  "MISSING_REQUIRED_INPUT",
  /** A persisted probability lies outside its column's declared domain. */
  "INVALID_PROBABILITY",
  /** No MLB Stats API outcome matched this row. */
  "MISSING_MLB_MATCH",
  /** More than one API outcome matched and identity is unresolvable. */
  "AMBIGUOUS_MATCH",
  /** Same-matchup duplicate on the date; needs mlbGamePk to disambiguate. */
  "DOUBLEHEADER_REVIEW",
  /** Upstream fetch or parse failed for this row. */
  "SOURCE_ERROR",
  /** Structurally impossible to repair (e.g. no game identity at all). */
  "UNREPAIRABLE",
  /** Proven to have been scored OUTSIDE the defect window — not a candidate. */
  "OUTSIDE_DEFECT_WINDOW",
  /** Required manifest evidence was not supplied by the dry run. */
  "EVIDENCE_INCOMPLETE",
  /** Anything that does not fit above — must be zero before closure. */
  "INVESTIGATION_REQUIRED",
] as const;

export type Classification = (typeof CLASSIFICATIONS)[number];

/** Classifications that authorize a write. */
export const WRITABLE_CLASSIFICATIONS: readonly Classification[] = [
  "CORRECTION_REQUIRED",
];

/** Classifications that must be zero before M-203 may be declared complete. */
export const CLOSURE_BLOCKING_CLASSIFICATIONS: readonly Classification[] = [
  "SOURCE_ERROR",
  "INVESTIGATION_REQUIRED",
  "EVIDENCE_INCOMPLETE",
];

/**
 * Terminal dispositions that are PROVEN safe to leave unwritten. A row here is
 * genuinely fine: its stored value already equals the corrected value, the
 * correct value is null and the row holds null, or it was scored outside the
 * defect window entirely.
 */
export const ACCEPTED_NO_WRITE_CLASSIFICATIONS: readonly Classification[] = [
  "ALREADY_CORRECT",
  "EXPECTED_UNCHANGED",
  "VALID_NULL_RESULT",
  "OUTSIDE_DEFECT_WINDOW",
];

/**
 * Unresolved dispositions that BLOCK mutation of the date they appear on.
 *
 * These are not "safely skipped". Each one means the evidence for that row is
 * incomplete or contradictory, and mutating its neighbours while it sits
 * unexplained is exactly how a repair silently leaves a hole. An ambiguous
 * doubleheader match must stop the date, not quietly become a skip.
 */
export const APPLY_BLOCKING_CLASSIFICATIONS: readonly Classification[] = [
  "MISSING_REQUIRED_INPUT",
  "INVALID_PROBABILITY",
  "MISSING_MLB_MATCH",
  "AMBIGUOUS_MATCH",
  "DOUBLEHEADER_REVIEW",
  "SOURCE_ERROR",
  "UNREPAIRABLE",
  "INVESTIGATION_REQUIRED",
  "EVIDENCE_INCOMPLETE",
];

// ─── Manifest shapes ──────────────────────────────────────────────────────────

export type BrierMap = Record<BrierField, number | null>;

export interface CandidateInputs {
  modelOverRate: string | null;
  modelF5OverRate: string | null;
  modelPNrfi: string | null;
  modelHomeWinPct: string | null;
  modelF5HomeWinPct: string | null;
  bookTotal: string | null;
  f5Total: string | null;
}

export interface ComputedOutcomes {
  actualFgTotal: number | null;
  actualF5Total: number | null;
  actualNrfiBinary: number | null;
  outcomeFgOver: BinaryOutcome | null;
  outcomeF5Over: BinaryOutcome | null;
  outcomeNrfi: BinaryOutcome | null;
  outcomeHomeWin: BinaryOutcome | null;
  outcomeF5HomeWin: BinaryOutcome | null;
}

export interface ManifestRow {
  gameRowId: number;
  mlbGamePk: number | null;
  gameDate: string;
  matchup: string;
  matchMethod: "mlbGamePk" | "teamAbbrev" | "none";
  outcomeIngestedAt: number | null;
  sourcePayloadHash: string;
  previousBrier: BrierMap;
  previousActualFgTotal: string | null;
  inputs: CandidateInputs;
  computedOutcomes: ComputedOutcomes;
  proposedBrier: BrierMap;
  /** Fields whose value differs between previousBrier and proposedBrier. */
  changeFields: BrierField[];
  classification: Classification;
  /** Populated for non-writable classifications. */
  reason: string | null;
}

export interface RepairManifest {
  repairRunId: string;
  generatedAt: number;
  codeSha: string;
  schemaVersion: string;
  defectWindowStart: string;
  defectWindowEnd: string;
  dates: string[];
  rows: ManifestRow[];
}

export interface SealedManifest {
  manifest: RepairManifest;
  manifestSha256: string;
  rowCount: number;
}

// ─── Deterministic serialization ──────────────────────────────────────────────

/**
 * Stable JSON: object keys sorted recursively so two structurally identical
 * manifests always serialize byte-identically. Key order from an object literal
 * is insertion-ordered in JS, which would otherwise make the checksum depend on
 * construction order rather than content.
 */
export function stableStringify(value: unknown): string {
  const walk = (v: unknown): unknown => {
    if (v === null || typeof v !== "object") return v;
    if (Array.isArray(v)) return v.map(walk);
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      out[k] = walk((v as Record<string, unknown>)[k]);
    }
    return out;
  };
  return JSON.stringify(walk(value));
}

export function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Seals a manifest: any subsequent content change alters the checksum. */
export function sealManifest(manifest: RepairManifest): SealedManifest {
  return {
    manifest,
    manifestSha256: sha256(stableStringify(manifest)),
    rowCount: manifest.rows.length,
  };
}

/** Re-derives the checksum and reports whether the manifest is untampered. */
export function verifyManifestSeal(sealed: SealedManifest): boolean {
  return sha256(stableStringify(sealed.manifest)) === sealed.manifestSha256;
}

// ─── Classification ───────────────────────────────────────────────────────────

const EMPTY_BRIER: BrierMap = {
  brierFgTotal: null,
  brierF5Total: null,
  brierNrfi: null,
  brierFgMl: null,
  brierF5Ml: null,
};

/** Which Brier fields differ between two maps, at storage resolution. */
export function diffBrier(before: BrierMap, after: BrierMap): BrierField[] {
  return BRIER_MARKETS.map(m => m.field).filter(
    f => !brierEquals(before[f], after[f])
  );
}

export interface ClassifyInput {
  previousBrier: BrierMap;
  proposedBrier: BrierMap;
  inputs: CandidateInputs;
  matchMethod: ManifestRow["matchMethod"];
  /** Set when the API produced no usable outcome for this row. */
  sourceError: string | null;
  /** True when >1 same-matchup outcomes existed and mlbGamePk was absent. */
  ambiguous: boolean;
  /** True when the date contained a same-matchup duplicate. */
  doubleheader: boolean;
}

export interface ClassifyResult {
  classification: Classification;
  changeFields: BrierField[];
  reason: string | null;
}

/**
 * Assigns exactly one terminal classification. Order matters: structural
 * failures are decided before value comparison, because a row with no outcome
 * has nothing meaningful to compare.
 */
export function classifyCandidate(input: ClassifyInput): ClassifyResult {
  const none: BrierField[] = [];

  if (input.sourceError) {
    return {
      classification: "SOURCE_ERROR",
      changeFields: none,
      reason: input.sourceError,
    };
  }
  if (input.ambiguous) {
    return {
      classification: "AMBIGUOUS_MATCH",
      changeFields: none,
      reason: "multiple same-matchup outcomes and no mlbGamePk",
    };
  }
  if (input.matchMethod === "none") {
    return {
      classification: input.doubleheader
        ? "DOUBLEHEADER_REVIEW"
        : "MISSING_MLB_MATCH",
      changeFields: none,
      reason: input.doubleheader
        ? "same-matchup duplicate on date; requires mlbGamePk"
        : "no MLB Stats API outcome matched this row",
    };
  }

  // Domain violations in the probabilities the AFFECTED markets depend on.
  for (const m of BRIER_MARKETS) {
    if (!M203_AFFECTED_FIELDS.includes(m.field)) continue;
    const raw = input.inputs[m.probColumn as keyof CandidateInputs];
    const reading = readProbability(raw, m.scale);
    if (
      reading.rejection === "OUT_OF_DOMAIN" ||
      reading.rejection === "NOT_NUMERIC"
    ) {
      return {
        classification: "INVALID_PROBABILITY",
        changeFields: none,
        reason: `${m.probColumn}=${reading.raw} violates ${m.scale} domain`,
      };
    }
  }

  // Any proposed Brier outside [0,1] is impossible and must not be written.
  for (const m of BRIER_MARKETS) {
    if (!isBrierInDomain(input.proposedBrier[m.field])) {
      return {
        classification: "INVESTIGATION_REQUIRED",
        changeFields: none,
        reason: `proposed ${m.field}=${input.proposedBrier[m.field]} outside [0,1]`,
      };
    }
  }

  const changeFields = diffBrier(input.previousBrier, input.proposedBrier);

  if (changeFields.length > 0) {
    return {
      classification: "CORRECTION_REQUIRED",
      changeFields,
      reason: null,
    };
  }

  const allProposedNull = BRIER_MARKETS.every(
    m => input.proposedBrier[m.field] === null
  );
  if (allProposedNull) {
    const affectedInputsAbsent = M203_AFFECTED_FIELDS.some(f => {
      const m = BRIER_MARKETS.find(x => x.field === f)!;
      const reading = readProbability(
        input.inputs[m.probColumn as keyof CandidateInputs],
        m.scale
      );
      return reading.rejection === "ABSENT";
    });
    return {
      classification: affectedInputsAbsent
        ? "MISSING_REQUIRED_INPUT"
        : "VALID_NULL_RESULT",
      changeFields: none,
      reason: affectedInputsAbsent
        ? "model probability absent for an affected market"
        : "correct result is null and the row already holds null",
    };
  }

  const anyAffectedPresent = M203_AFFECTED_FIELDS.some(
    f => input.proposedBrier[f] !== null
  );
  return {
    classification: anyAffectedPresent
      ? "ALREADY_CORRECT"
      : "EXPECTED_UNCHANGED",
    changeFields: none,
    reason: anyAffectedPresent
      ? "stored value already equals the corrected value"
      : "no affected market is priced for this row",
  };
}

// ─── Accounting ───────────────────────────────────────────────────────────────

export type ClassificationCounts = Record<Classification, number>;

export function emptyCounts(): ClassificationCounts {
  return Object.fromEntries(
    CLASSIFICATIONS.map(c => [c, 0])
  ) as ClassificationCounts;
}

export function tallyClassifications(
  rows: ManifestRow[]
): ClassificationCounts {
  const counts = emptyCounts();
  for (const r of rows) counts[r.classification]++;
  return counts;
}

export interface AccountingResult {
  total: number;
  counts: ClassificationCounts;
  /** total === sum(counts). Anything else is a defect in the ledger itself. */
  balanced: boolean;
  writable: number;
  closureBlocking: number;
  /** Rows whose unresolved evidence blocks mutation of their date. */
  applyBlocking: number;
  acceptedNoWrite: number;
}

/**
 * The accounting identity. `balanced` false means a row escaped classification
 * or was double-counted — a hard stop, never a warning.
 */
export function reconcileAccounting(rows: ManifestRow[]): AccountingResult {
  const counts = tallyClassifications(rows);
  const summed = CLASSIFICATIONS.reduce((s, c) => s + counts[c], 0);
  return {
    total: rows.length,
    counts,
    balanced: summed === rows.length,
    writable: WRITABLE_CLASSIFICATIONS.reduce((s, c) => s + counts[c], 0),
    closureBlocking: CLOSURE_BLOCKING_CLASSIFICATIONS.reduce(
      (s, c) => s + counts[c],
      0
    ),
    applyBlocking: APPLY_BLOCKING_CLASSIFICATIONS.reduce(
      (s, c) => s + counts[c],
      0
    ),
    acceptedNoWrite: ACCEPTED_NO_WRITE_CLASSIFICATIONS.reduce(
      (s, c) => s + counts[c],
      0
    ),
  };
}

// ─── Invariant guard ──────────────────────────────────────────────────────────

export interface InvariantViolation {
  gameRowId: number;
  field: BrierField;
  previous: number | null;
  proposed: number | null;
}

/**
 * M-203 must change ONLY the two unit-scaled markets. A percent-scaled market
 * moving means the run is doing something beyond M-203 — a production stop
 * condition, checked against the manifest BEFORE any write occurs.
 */
export function findInvariantViolations(
  rows: ManifestRow[]
): InvariantViolation[] {
  const out: InvariantViolation[] = [];
  for (const r of rows) {
    for (const f of M203_INVARIANT_FIELDS) {
      if (!brierEquals(r.previousBrier[f], r.proposedBrier[f])) {
        out.push({
          gameRowId: r.gameRowId,
          field: f,
          previous: r.previousBrier[f],
          proposed: r.proposedBrier[f],
        });
      }
    }
  }
  return out;
}

// ─── Rollback ─────────────────────────────────────────────────────────────────

export interface RollbackRow {
  gameRowId: number;
  /** State to assert before rolling back — what the repair wrote. */
  expectedCurrent: BrierMap;
  /** State to restore — exactly what was there before the repair. */
  restoreTo: BrierMap;
}

export interface RollbackManifest {
  repairRunId: string;
  generatedAt: number;
  sourceManifestSha256: string;
  rows: RollbackRow[];
}

/**
 * Builds the rollback artifact from the SAME frozen manifest that authorizes
 * the write, so repair and rollback cannot disagree about the pre-image.
 *
 * Rollback restores the recorded previous DATABASE STATE. It never recomputes
 * the old values — reproducing them would require running the defective scorer,
 * which is both absurd and impossible to validate.
 */
export function buildRollbackManifest(
  sealed: SealedManifest,
  generatedAt: number
): RollbackManifest {
  return {
    repairRunId: sealed.manifest.repairRunId,
    generatedAt,
    sourceManifestSha256: sealed.manifestSha256,
    rows: sealed.manifest.rows
      .filter(r => WRITABLE_CLASSIFICATIONS.includes(r.classification))
      .map(r => ({
        gameRowId: r.gameRowId,
        expectedCurrent: { ...r.proposedBrier },
        restoreTo: { ...r.previousBrier },
      })),
  };
}

/**
 * Validates a rollback artifact against the manifest it claims to reverse.
 *
 * Row-ID coverage alone is insufficient: an artifact can name every correct row
 * and still carry the wrong values, which would "restore" the data to a state
 * it never held. Every writable row is therefore checked for exact CONTENT
 * agreement in both directions — expectedCurrent must equal what the repair
 * will write, and restoreTo must equal what was there before it.
 */
export function validateRollback(
  sealed: SealedManifest,
  rollback: RollbackManifest
): string[] {
  const problems: string[] = [];

  if (rollback.sourceManifestSha256 !== sealed.manifestSha256) {
    problems.push(
      `sourceManifestSha256 mismatch: rollback=${rollback.sourceManifestSha256} manifest=${sealed.manifestSha256}`
    );
  }
  if (rollback.repairRunId !== sealed.manifest.repairRunId) {
    problems.push(
      `repairRunId mismatch: rollback=${rollback.repairRunId} manifest=${sealed.manifest.repairRunId}`
    );
  }

  const writable = sealed.manifest.rows.filter(r =>
    WRITABLE_CLASSIFICATIONS.includes(r.classification)
  );
  const byId = new Map<number, RollbackRow[]>();
  for (const rb of rollback.rows) {
    if (!byId.has(rb.gameRowId)) byId.set(rb.gameRowId, []);
    byId.get(rb.gameRowId)!.push(rb);
  }

  for (const [id, entries] of Array.from(byId.entries())) {
    if (entries.length > 1) {
      problems.push(`duplicate rollback entry for row ${id}`);
    }
  }
  const writableIds = new Set(writable.map(r => r.gameRowId));
  for (const id of Array.from(byId.keys())) {
    if (!writableIds.has(id)) {
      problems.push(
        `rollback covers row ${id}, which the manifest does not write`
      );
    }
  }

  for (const row of writable) {
    const entries = byId.get(row.gameRowId);
    if (!entries || entries.length === 0) {
      problems.push(`rollback is missing writable row ${row.gameRowId}`);
      continue;
    }
    const rb = entries[0];
    for (const m of BRIER_MARKETS) {
      if (
        !brierEquals(rb.expectedCurrent[m.field], row.proposedBrier[m.field])
      ) {
        problems.push(
          `row ${row.gameRowId} ${m.field}: rollback expectedCurrent=${rb.expectedCurrent[m.field]} != manifest proposed=${row.proposedBrier[m.field]}`
        );
      }
      if (!brierEquals(rb.restoreTo[m.field], row.previousBrier[m.field])) {
        problems.push(
          `row ${row.gameRowId} ${m.field}: rollback restoreTo=${rb.restoreTo[m.field]} != manifest previous=${row.previousBrier[m.field]}`
        );
      }
    }
  }

  return problems;
}

/**
 * A rollback artifact is complete when every row the repair would write has a
 * corresponding restore entry whose CONTENT matches the manifest exactly.
 * Mutation must never begin without this.
 */
export function rollbackIsComplete(
  sealed: SealedManifest,
  rollback: RollbackManifest
): boolean {
  return validateRollback(sealed, rollback).length === 0;
}

// ─── Oracle cross-check ───────────────────────────────────────────────────────

export interface OracleDisagreement {
  gameRowId: number;
  field: BrierField;
  manifestValue: number | null;
  oracleValue: number | null;
}

/**
 * Recomputes every proposed value with the INDEPENDENT oracle and reports
 * disagreements. This is the common-mode-failure guard: the manifest was built
 * by production code, and is checked here by an implementation that shares none
 * of it.
 */
export function crossCheckWithOracle(
  rows: ManifestRow[]
): OracleDisagreement[] {
  const out: OracleDisagreement[] = [];
  const outcomeFor = (
    field: BrierField,
    o: ComputedOutcomes
  ): BinaryOutcome | null => {
    switch (field) {
      case "brierFgTotal":
        return o.outcomeFgOver;
      case "brierF5Total":
        return o.outcomeF5Over;
      case "brierNrfi":
        return o.outcomeNrfi;
      case "brierFgMl":
        return o.outcomeHomeWin;
      case "brierF5Ml":
        return o.outcomeF5HomeWin;
    }
  };

  for (const r of rows) {
    for (const m of BRIER_MARKETS) {
      const reading = readProbability(
        r.inputs[m.probColumn as keyof CandidateInputs],
        m.scale
      );
      const expected = oracleBrier(
        reading.value,
        outcomeFor(m.field, r.computedOutcomes)
      );
      if (!brierEquals(expected, r.proposedBrier[m.field])) {
        out.push({
          gameRowId: r.gameRowId,
          field: m.field,
          manifestValue: r.proposedBrier[m.field],
          oracleValue: expected,
        });
      }
    }
  }
  return out;
}

export { EMPTY_BRIER };
