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

  it("rejects unknown modes", () => {
    expect(() => resolveVerdict("blocking", [])).toThrow();
  });
});

describe("APPROVED_BLOCKING integrity", () => {
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
