// Registry contract tests. The class table below is an INDEPENDENT copy of
// the intended enforcement classes — deliberately duplicated so a mutation
// (or accidental edit) of any class value in rules.mjs fails here instead
// of silently changing blocking behavior (R8: direct negative coverage for
// every deterministic blocking condition's class wiring).
import { describe, expect, it } from "vitest";
import { RULE_METADATA } from "./rule-metadata.mjs";
import { makeFinding, ruleClass, RULES } from "./rules.mjs";

const EXPECTED_CLASSES: Record<string, string> = {
  "PRX-C-SIZE": "deterministic",
  "PRX-C-SUBJECT": "deterministic",
  "PRX-C-PREFIX": "deterministic",
  "PRX-C-SEPARATOR": "deterministic",
  "PRX-C-LENGTH": "advisory",
  "PRX-C-WRAP": "advisory",
  "PRX-C-FENCE": "deterministic",
  "PRX-C-TRAILER": "deterministic",
  "PRX-C-GOV": "deterministic",
  "PRX-C-FIXUP": "deterministic",
  "PRX-C-MOOD": "heuristic",
  "PRX-C-CONTROL": "deterministic",
  "PRX-C-CONTEXT-UNVERIFIED": "advisory",
  "PRX-B-SIZE": "deterministic",
  "PRX-B-VISIBLE": "deterministic",
  "PRX-B-SECTION-MISSING": "deterministic",
  "PRX-B-SECTION-DUP": "deterministic",
  "PRX-B-SECTION-EMPTY": "deterministic",
  "PRX-B-ORDER": "advisory",
  "PRX-B-CAPSULE": "deterministic",
  "PRX-B-EXT": "advisory",
  "PRX-B-STRUCTURE": "advisory",
  "PRX-B-FENCE": "advisory",
  "PRX-B-COMMENT": "advisory",
};

describe("rule registry classes (independent table)", () => {
  it("registry ids match the expected table exactly", () => {
    expect(Object.keys(RULES).sort()).toEqual(
      Object.keys(EXPECTED_CLASSES).sort()
    );
  });

  for (const [id, cls] of Object.entries(EXPECTED_CLASSES)) {
    it(`${id} is ${cls}`, () => {
      expect(ruleClass(id)).toBe(cls);
    });
  }

  it("ruleClass throws on unknown ids", () => {
    expect(() => ruleClass("PRX-NOPE")).toThrow(/unknown PRX rule id/);
  });
});

describe("display metadata stays in lockstep with the registry", () => {
  it("rule-metadata.mjs keys equal rules.mjs keys", () => {
    expect(Object.keys(RULE_METADATA).sort()).toEqual(
      Object.keys(RULES).sort()
    );
  });

  it("every rule has a surface and a non-empty title", () => {
    for (const meta of Object.values(RULE_METADATA)) {
      expect(["commit", "body"]).toContain(
        (meta as { surface: string }).surface
      );
      expect((meta as { title: string }).title.length).toBeGreaterThan(0);
    }
  });
});

describe("finding level derivation", () => {
  it("deterministic rules yield error-level findings", () => {
    expect(makeFinding("PRX-C-FENCE", "m").level).toBe("error");
  });

  it("advisory rules yield advisory-level findings", () => {
    expect(makeFinding("PRX-C-WRAP", "m").level).toBe("advisory");
  });

  it("heuristic rules yield advisory-level findings", () => {
    expect(makeFinding("PRX-C-MOOD", "m").level).toBe("advisory");
  });

  it("every emitted finding carries the class recorded in the registry", () => {
    for (const id of Object.keys(RULES)) {
      const f = makeFinding(id, "m", 3);
      expect(f.class).toBe(EXPECTED_CLASSES[id]);
      expect(f.line).toBe(3);
    }
    expect(makeFinding("PRX-C-SIZE", "m")).not.toHaveProperty("line");
  });
});
