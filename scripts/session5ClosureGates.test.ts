/**
 * session5ClosureGates.test.ts
 *
 * The structural fix for a defect this session shipped twice.
 *
 * PR #474 published "32 PASS · 6 BLOCKED · 1 NOT PROVEN" and PR #475 published
 * "32 PASS · 7 BLOCKED · 0 NOT PROVEN", both over a declared denominator of 39.
 * Both aggregates were wrong. The individual gate rows were correct; the totals
 * were prose that nothing verified. Two things made the error survive review:
 *
 *   1. Several markdown rows silently carried more than one gate — "#467 · #468
 *      · #469 merged and present", "Human / agent / pipelines under enforcement
 *      ×3" — so counting rows and counting gates gave different answers.
 *   2. The recount script written to catch it had its own defect: it matched
 *      /×(\d+)/ against the whole line, so "×3 shapes" in an EVIDENCE column was
 *      read as a gate multiplier. The first correction was also wrong.
 *
 * Correcting the number by hand would have fixed one instance of an unbounded
 * problem. This test removes the class: totals are declared in the manifest and
 * recomputed from `gates[]` on every CI run, so a stale or mistyped aggregate
 * cannot merge.
 *
 * The manifest — not any markdown record — is authoritative for gate status and
 * counts. Prose records cite it.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const MANIFEST_PATH = path.join(
  import.meta.dirname,
  "..",
  "docs",
  "audits",
  "2026-08-06-edge-identity-forensic",
  "session5-closure-gates.json"
);

interface Gate {
  gate_id: string;
  requirement: string;
  status: string;
  evidence_class: string;
  evidence_reference: string;
  dependency: string | null;
}

interface Manifest {
  allowed_statuses: string[];
  gates: Gate[];
  totals: Record<string, number>;
  verdict: string;
}

/** Read fresh per test so a mutation in an isolated copy is actually observed. */
function loadManifest(): Manifest {
  return JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) as Manifest;
}

/** Count statuses from the gate rows. The ONLY derivation path — never parse prose. */
function countByStatus(gates: Gate[]): Record<string, number> {
  const counts: Record<string, number> = {
    PASS: 0,
    BLOCKED: 0,
    NOT_PROVEN: 0,
    FAIL: 0,
  };
  for (const g of gates) counts[g.status] = (counts[g.status] ?? 0) + 1;
  return counts;
}

describe("Session #5 closure gate manifest — arithmetic integrity", () => {
  it("parses, and carries a non-empty gate list (positive control)", () => {
    const m = loadManifest();
    // Without this, every "counted 0 mismatches" assertion below would pass
    // vacuously on an empty or malformed array — the same shape as the false
    // zeros this session produced from broken command pipelines.
    expect(Array.isArray(m.gates)).toBe(true);
    expect(m.gates.length).toBeGreaterThan(0);
    console.log(`[STATE] manifest carries ${m.gates.length} gates`);
  });

  it("declares totals that match the gate rows exactly, per status", () => {
    const m = loadManifest();
    const actual = countByStatus(m.gates);
    for (const status of ["PASS", "BLOCKED", "NOT_PROVEN", "FAIL"]) {
      console.log(
        `[STATE] ${status}: declared=${m.totals[status]} actual=${actual[status]}`
      );
      expect(
        m.totals[status],
        `declared ${status} count does not match the gate rows`
      ).toBe(actual[status]);
    }
  });

  it("declares a TOTAL equal to both the sum of statuses and the row count", () => {
    const m = loadManifest();
    const actual = countByStatus(m.gates);
    const sumOfStatuses = Object.values(actual).reduce((a, b) => a + b, 0);
    console.log(
      `[STATE] declared TOTAL=${m.totals.TOTAL} sumOfStatuses=${sumOfStatuses} rows=${m.gates.length}`
    );
    // Three independent reconciliations must agree.
    expect(m.totals.TOTAL).toBe(sumOfStatuses);
    expect(m.totals.TOTAL).toBe(m.gates.length);
  });

  it("agrees with a count of UNIQUE gate IDs — the third independent path", () => {
    const m = loadManifest();
    const unique = new Set(m.gates.map(g => g.gate_id));
    console.log(
      `[STATE] unique gate IDs=${unique.size} rows=${m.gates.length} declared=${m.totals.TOTAL}`
    );
    expect(unique.size).toBe(m.gates.length);
    expect(unique.size).toBe(m.totals.TOTAL);
  });

  it("has no duplicate gate IDs", () => {
    const m = loadManifest();
    const seen = new Set<string>();
    const dupes: string[] = [];
    for (const g of m.gates) {
      if (seen.has(g.gate_id)) dupes.push(g.gate_id);
      seen.add(g.gate_id);
    }
    expect(dupes, `duplicate gate IDs: ${dupes.join(", ")}`).toEqual([]);
  });

  it("uses only the declared status vocabulary — no synonyms, no free text", () => {
    const m = loadManifest();
    const allowed = new Set(m.allowed_statuses);
    const bad = m.gates
      .filter(g => !allowed.has(g.status))
      .map(g => `${g.gate_id}=${g.status}`);
    expect(bad, `statuses outside the allowed set: ${bad.join(", ")}`).toEqual(
      []
    );
  });

  it("gives every gate the required fields, non-empty", () => {
    const m = loadManifest();
    const missing: string[] = [];
    for (const g of m.gates) {
      for (const field of [
        "gate_id",
        "requirement",
        "status",
        "evidence_class",
        "evidence_reference",
      ] as const) {
        if (typeof g[field] !== "string" || g[field].trim() === "") {
          missing.push(`${g.gate_id ?? "<no id>"}.${field}`);
        }
      }
    }
    expect(missing, `missing or empty fields: ${missing.join(", ")}`).toEqual(
      []
    );
  });

  it("uses gate IDs of the form G-NNN, contiguous from G-001", () => {
    const m = loadManifest();
    const ids = m.gates.map(g => g.gate_id);
    const malformed = ids.filter(id => !/^G-\d{3}$/.test(id));
    expect(malformed, `malformed gate IDs: ${malformed.join(", ")}`).toEqual(
      []
    );
    const expected = m.gates.map(
      (_, i) => `G-${String(i + 1).padStart(3, "0")}`
    );
    expect(ids).toEqual(expected);
  });

  it("requires a named dependency on every BLOCKED and NOT_PROVEN gate", () => {
    const m = loadManifest();
    // A blocker with no stated dependency is indistinguishable from a defect
    // someone declined to classify. The record must always say what is being
    // waited on, and who owns it.
    const unexplained = m.gates
      .filter(g => g.status === "BLOCKED" || g.status === "NOT_PROVEN")
      .filter(g => !g.dependency || g.dependency.trim() === "")
      .map(g => g.gate_id);
    expect(
      unexplained,
      `BLOCKED/NOT_PROVEN gates with no dependency: ${unexplained.join(", ")}`
    ).toEqual([]);
  });

  it("carries a verdict consistent with its own stated rule", () => {
    const m = loadManifest();
    const c = countByStatus(m.gates);
    const expected =
      c.FAIL > 0
        ? "INCOMPLETE"
        : c.BLOCKED === 0 && c.NOT_PROVEN === 0
          ? "COMPLETE"
          : "COMPLETE WITH EXPLICIT EXTERNAL BLOCKER";
    console.log(
      `[STATE] verdict declared="${m.verdict}" derived="${expected}"`
    );
    // The verdict is DERIVED, never chosen. This is what stops a preferred
    // conclusion from outrunning the evidence.
    expect(m.verdict).toBe(expected);
  });

  it("never records a FAIL without it being visible in the verdict", () => {
    const m = loadManifest();
    const c = countByStatus(m.gates);
    if (c.FAIL > 0) expect(m.verdict).toBe("INCOMPLETE");
    else expect(m.verdict).not.toBe("INCOMPLETE");
  });
});
