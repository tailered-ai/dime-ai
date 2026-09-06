#!/usr/bin/env node
/**
 * reporter.mjs — P03.T05 (structured JSONL) and P03.T06 (six-class summary).
 *
 * The JSONL stream is the MACHINE SOURCE OF TRUTH. Human-readable output is
 * rendered from it and never the other way round.
 *
 * Truthfulness rules this module enforces:
 *   - every record is validated BEFORE it is written; a malformed result is a
 *     verifier defect, not a row;
 *   - the log is APPEND-ONLY. A later PASS never overwrites an earlier failure,
 *     and a duplicate gate_id is a defect rather than a silent replacement;
 *   - a truncated or malformed line makes the whole stream unsummarizable —
 *     `readResults` refuses to report health it cannot substantiate;
 *   - every one of the six classes renders ALWAYS, including empty ones. A
 *     class that vanishes from a summary is indistinguishable from a class
 *     that passed;
 *   - CI_ONLY, SKIPPED_DECLARED and N/A are counted in their own columns and
 *     are never folded into PASS;
 *   - declared registry membership is compared against observed results, so a
 *     MISSING mandatory result cannot summarize green.
 */
import {
  appendFileSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  GATE_CLASSES,
  GATE_STATUSES,
  ResultError,
  externalStatus,
  validateResult,
} from "./result.mjs";

export class ReporterError extends Error {
  constructor(reason, detail = {}) {
    super(reason);
    this.name = "ReporterError";
    this.reason = reason;
    Object.assign(this, detail);
  }
}

/**
 * Append-only writer. Each result becomes exactly one independently parseable
 * line terminated by a newline, so a partial write is detectable as a line that
 * does not parse rather than a silently short record.
 */
export class JsonlReporter {
  constructor(filePath) {
    this.filePath = filePath;
    this.seen = new Set();
    let present = true;
    try {
      readFileSync(filePath);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      present = false;
      // wx: create-exclusive — a concurrent creator loses cleanly instead of
      // truncating (the exists-then-write race CodeQL flags).
      try {
        writeFileSync(filePath, "", { flag: "wx" });
      } catch (createError) {
        if (createError.code !== "EEXIST") throw createError;
      }
    }
    if (present) {
      for (const record of readResults(filePath).results) {
        this.seen.add(record.gate_id);
      }
    }
  }

  write(result) {
    validateResult(result);
    if (this.seen.has(result.gate_id)) {
      // Overwriting is how an earlier failure disappears. Refuse it.
      throw new ReporterError("DUPLICATE_GATE_ID", { gate_id: result.gate_id });
    }
    this.seen.add(result.gate_id);
    appendFileSync(this.filePath, `${JSON.stringify(result)}\n`);
    return result;
  }
}

/**
 * Read + validate a JSONL stream. A malformed or truncated line raises rather
 * than being skipped — a summary computed over a partially readable log would
 * be a fabricated health claim.
 */
export function readResults(filePath) {
  if (!existsSync(filePath)) {
    throw new ReporterError("RESULTS_MISSING", { filePath });
  }
  const raw = readFileSync(filePath, "utf8");
  if (raw.length > 0 && !raw.endsWith("\n")) {
    throw new ReporterError("TRUNCATED_JSONL", {
      filePath,
      detail: "stream does not end with a newline; the last record is partial",
    });
  }
  const lines = raw.split("\n").filter(line => line.length > 0);
  const results = [];
  const seen = new Set();
  for (const [index, line] of lines.entries()) {
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      throw new ReporterError("MALFORMED_JSONL", {
        filePath,
        line: index + 1,
        detail: error.message,
      });
    }
    try {
      validateResult(parsed);
    } catch (error) {
      throw new ReporterError("INVALID_RECORD", {
        filePath,
        line: index + 1,
        problems: error.problems ?? [error.message],
      });
    }
    if (seen.has(parsed.gate_id)) {
      throw new ReporterError("DUPLICATE_GATE_ID", {
        filePath,
        line: index + 1,
        gate_id: parsed.gate_id,
      });
    }
    seen.add(parsed.gate_id);
    results.push(parsed);
  }
  return { results, line_count: lines.length };
}

/** Zeroed status counters — every status present, always. */
function zeroCounts() {
  const counts = {};
  for (const status of GATE_STATUSES) counts[status] = 0;
  return counts;
}

/**
 * P03.T06 — six-class summary. Pure: it never mutates the results it reads.
 *
 * `declared` maps class -> array of gate ids the registry says SHOULD have
 * produced a result. Anything declared but absent is reported as MISSING and
 * marks the class blocking, so an omitted failure cannot read as green.
 */
export function summarize(results, options = {}) {
  for (const result of results) validateResult(result);
  const declared = options.declared ?? {};
  const classes = {};

  for (const klass of GATE_CLASSES) {
    const classResults = results.filter(result => result.class === klass);
    const counts = zeroCounts();
    for (const result of classResults) counts[result.status] += 1;

    const declaredIds = declared[klass] ?? [];
    const observedIds = new Set(classResults.map(result => result.gate_id));
    const missing = declaredIds.filter(id => !observedIds.has(id));
    const undeclared = declaredIds.length
      ? classResults
          .filter(r => !declaredIds.includes(r.gate_id))
          .map(r => r.gate_id)
      : [];

    const mandatory = classResults.filter(result => result.mandatory);
    const advisory = classResults.filter(result => !result.mandatory);
    const blockingStatuses = mandatory.filter(result =>
      [
        "FAIL",
        "FLAKY",
        "TIMEOUT",
        "BLOCKED",
        "INFRA_FAIL",
        "CONTRACT_DRIFT",
        "INCONCLUSIVE",
      ].includes(result.status)
    );
    const broken = classResults.filter(
      result => result.status === "BROKEN_GATE"
    );
    const withEvidence = classResults.filter(
      result => result.evidence_path
    ).length;

    classes[klass] = {
      class: klass,
      total: classResults.length,
      counts,
      mandatory_total: mandatory.length,
      advisory_total: advisory.length,
      declared_total: declaredIds.length,
      missing_gate_ids: missing,
      undeclared_gate_ids: undeclared,
      evidence_present: withEvidence,
      evidence_completeness:
        classResults.length === 0 ? null : withEvidence / classResults.length,
      // BROKEN_GATE blocks regardless of mandatory/advisory: an advisory gate
      // that cannot reject still means the verifier is untrustworthy.
      blocking:
        blockingStatuses.length > 0 || broken.length > 0 || missing.length > 0,
      blocking_reasons: [
        ...blockingStatuses.map(
          r => `${r.gate_id}: ${externalStatus(r.status)}`
        ),
        ...broken.map(r => `${r.gate_id}: ${externalStatus(r.status)}`),
        ...missing.map(id => `${id}: MISSING_RESULT`),
      ],
    };
  }

  const totals = zeroCounts();
  for (const result of results) totals[result.status] += 1;

  return {
    classes,
    totals,
    total_results: results.length,
    // Reconciliation: per-class totals must sum exactly to the global total.
    reconciles:
      GATE_CLASSES.reduce((sum, klass) => sum + classes[klass].total, 0) ===
      results.length,
    blocking_classes: GATE_CLASSES.filter(klass => classes[klass].blocking),
  };
}

/** Human-readable rendering. Derived from the summary, never from raw logs. */
export function renderSummary(summary) {
  const lines = [];
  lines.push(
    "CLASS       TOTAL  PASS  FAIL FLAKY   T/O  BLKD  SKIP CIONL   N/A INFRA DRIFT BROKN INCON  BLOCKING"
  );
  for (const klass of GATE_CLASSES) {
    const entry = summary.classes[klass];
    const c = entry.counts;
    const cell = value => String(value).padStart(5);
    lines.push(
      `${klass.padEnd(11)}${cell(entry.total)}${cell(c.PASS)}${cell(c.FAIL)}${cell(c.FLAKY)}` +
        `${cell(c.TIMEOUT)}${cell(c.BLOCKED)}${cell(c.SKIPPED_DECLARED)}${cell(c.CI_ONLY)}` +
        `${cell(c["N/A"])}${cell(c.INFRA_FAIL)}${cell(c.CONTRACT_DRIFT)}${cell(c.BROKEN_GATE)}` +
        `${cell(c.INCONCLUSIVE)}  ${entry.blocking ? "YES" : "no"}`
    );
  }
  lines.push("");
  lines.push(
    `totals: ${summary.total_results} result(s); reconciles=${summary.reconciles}; ` +
      `blocking classes: ${summary.blocking_classes.join(", ") || "none"}`
  );
  for (const klass of GATE_CLASSES) {
    const entry = summary.classes[klass];
    if (entry.blocking_reasons.length) {
      lines.push(`  ${klass}: ${entry.blocking_reasons.join(" | ")}`);
    }
  }
  return lines.join("\n");
}

/** closed/total over declared units — the frozen progress algebra, never a %. */
export function progressOf(summary, klass) {
  const entry = summary.classes[klass];
  const closed =
    entry.counts.PASS + entry.counts["N/A"] + entry.counts.SKIPPED_DECLARED;
  const total = entry.declared_total || entry.total;
  return { closed, total };
}

function main() {
  const [command, filePath] = process.argv.slice(2);
  if (command === "summarize") {
    const { results } = readResults(filePath);
    console.log(renderSummary(summarize(results)));
    return;
  }
  throw new ReporterError("UNKNOWN_COMMAND", { command: command ?? "(none)" });
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
) {
  try {
    main();
  } catch (error) {
    console.error(`[reporter] ${error.reason ?? error.message}`);
    process.exitCode = 1;
  }
}
