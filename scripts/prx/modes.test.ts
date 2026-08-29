// Rollout-mode proofs (SOL-PRX-010): audit never blocks, advisory never
// blocks, enforcing blocks ONLY on approved deterministic rules.
import { describe, expect, it } from "vitest";
import {
  APPROVED_BLOCKING,
  MODES,
  parseModeState,
  resolveVerdict,
} from "./modes.mjs";
import { makeFinding, RULES, ruleClass } from "./rules.mjs";

const deterministicError = makeFinding("PRX-C-SEPARATOR", "x");
const advisoryFinding = makeFinding("PRX-C-WRAP", "x");
const heuristicFinding = makeFinding("PRX-C-MOOD", "x");

describe("mode state", () => {
  it("accepts the committed shape", () => {
    expect(parseModeState('{"version":1,"mode":"audit"}').mode).toBe("audit");
  });

  it("rejects unknown modes and versions", () => {
    expect(() => parseModeState('{"version":1,"mode":"yolo"}')).toThrow();
    expect(() => parseModeState('{"version":2,"mode":"audit"}')).toThrow();
    expect(() => parseModeState("not json")).toThrow();
  });

  it("names the exact failure: invalid JSON vs invalid shape (R8)", () => {
    expect(() => parseModeState("not json")).toThrow(/not valid JSON/);
    // JSON null must hit the shape error, not a TypeError on property
    // access — this is what the optional chaining is for.
    expect(() => parseModeState("null")).toThrow(/prx-mode\.json must be/);
    expect(() => parseModeState('{"version":2,"mode":"audit"}')).toThrow(
      /prx-mode\.json must be/
    );
  });

  it("exposes exactly the three contract modes", () => {
    expect(MODES).toEqual(["audit", "advisory", "enforcing"]);
  });
});

describe("verdicts", () => {
  it("audit mode does not block even on deterministic errors", () => {
    const v = resolveVerdict("audit", [deterministicError, advisoryFinding]);
    expect(v.exitCode).toBe(0);
    expect(v.blocking).toEqual([]);
  });

  it("advisory mode does not block on style/advisory findings", () => {
    const v = resolveVerdict("advisory", [
      deterministicError,
      advisoryFinding,
      heuristicFinding,
    ]);
    expect(v.exitCode).toBe(0);
  });

  it("enforcing mode blocks only approved deterministic rules", () => {
    expect(resolveVerdict("enforcing", [deterministicError]).exitCode).toBe(1);
    expect(resolveVerdict("enforcing", [advisoryFinding]).exitCode).toBe(0);
    expect(resolveVerdict("enforcing", [heuristicFinding]).exitCode).toBe(0);
  });

  it("rejects unknown modes with a named error", () => {
    expect(() => resolveVerdict("blocking", [])).toThrow(/unknown PRX mode/);
  });

  it("blocks only findings that are BOTH error-level AND approved (R8)", () => {
    // Synthetic findings probe the conjunction directly: makeFinding can
    // never produce these shapes, but resolveVerdict's contract is the
    // pair (level, approved rule), not trust in its callers.
    const errorLevelUnapproved = { rule: "PRX-C-WRAP", level: "error" };
    const advisoryLevelApproved = { rule: "PRX-C-SUBJECT", level: "advisory" };
    expect(resolveVerdict("enforcing", [errorLevelUnapproved]).exitCode).toBe(
      0
    );
    expect(resolveVerdict("enforcing", [advisoryLevelApproved]).exitCode).toBe(
      0
    );
    expect(resolveVerdict("enforcing", []).exitCode).toBe(0);
  });
});

describe("APPROVED_BLOCKING integrity", () => {
  // Independent copy (r2 mutation-hardening): blanking or dropping any
  // entry in modes.mjs fails the exact-set pin, and every listed rule is
  // proven to actually block in enforcing mode.
  const EXPECTED_BLOCKING = [
    "PRX-C-SIZE",
    "PRX-C-SUBJECT",
    "PRX-C-PREFIX",
    "PRX-C-SEPARATOR",
    "PRX-C-FENCE",
    "PRX-C-TRAILER",
    "PRX-C-GOV",
    "PRX-C-FIXUP",
    "PRX-C-CONTROL",
    "PRX-B-SIZE",
    "PRX-B-VISIBLE",
    "PRX-B-SECTION-MISSING",
    "PRX-B-SECTION-DUP",
    "PRX-B-SECTION-EMPTY",
    "PRX-B-CAPSULE",
  ];

  it("equals the independent expected set exactly", () => {
    expect([...APPROVED_BLOCKING].sort()).toEqual(
      [...EXPECTED_BLOCKING].sort()
    );
  });

  for (const id of EXPECTED_BLOCKING) {
    it(`${id} blocks in enforcing mode`, () => {
      const verdict = resolveVerdict("enforcing", [
        { rule: id, level: "error" },
      ]);
      expect(verdict.exitCode).toBe(1);
    });
  }

  it("contains only deterministic-class rules", () => {
    for (const id of APPROVED_BLOCKING) {
      expect(ruleClass(id)).toBe("deterministic");
    }
  });

  it("never contains advisory or heuristic rules", () => {
    const soft = Object.entries(RULES)
      .filter(([, r]) => r.class !== "deterministic")
      .map(([id]) => id);
    for (const id of soft) {
      expect(APPROVED_BLOCKING).not.toContain(id);
    }
  });
});
