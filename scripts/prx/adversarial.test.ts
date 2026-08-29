// PRX v1.1 permanent negative fixtures — all 23 Sol v1.0 bypasses
// (SOL-PRX-005/-006/-007). Each fixture is pinned to an EXACT expected
// finding multiset: a missing finding fails, an unexpected finding fails,
// and a fixture that produces zero findings fails (nothing passes silently).
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { checkCommit } from "./commit-check.mjs";
import { checkBody } from "./body-check.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const AF = join(HERE, "../../docs/verification/prx/adversarial-fixtures");

interface Expected {
  fixture: string;
  mechanism: string;
  options: Record<string, boolean>;
  expected_findings: string[];
}

const expectedFiles = readdirSync(join(AF, "expected"))
  .filter(f => f.endsWith(".json"))
  .sort();

describe("Sol adversarial fixtures (23 permanent bypass regressions)", () => {
  it("covers exactly the 23 Sol cases", () => {
    expect(expectedFiles.length).toBe(23);
  });

  for (const file of expectedFiles) {
    const spec: Expected = JSON.parse(
      readFileSync(join(AF, "expected", file), "utf8")
    );
    const id = file.replace(".json", "");
    it(`${id} — ${spec.mechanism}`, () => {
      const input = readFileSync(join(AF, spec.fixture), "utf8");
      const findings = spec.fixture.startsWith("commit/")
        ? checkCommit(input, spec.options)
        : checkBody(input);
      const actual = findings.map(f => `${f.level}:${f.rule}`).sort();
      expect(actual).toEqual([...spec.expected_findings].sort());
      expect(actual.length).toBeGreaterThan(0);
    });
  }
});
