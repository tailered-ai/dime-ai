// PRX r2 correction-pass fixtures — permanent negative regressions for the
// second independent review's finding register (BYP-C-01..09, BYP-B-01..04,
// and same-class finds made while wiring). Same contract as the Sol suite:
// every fixture is pinned to an EXACT expected finding multiset, and no
// fixture passes silently.
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

const expectedFiles = readdirSync(join(AF, "r2", "expected"))
  .filter(f => f.endsWith(".json"))
  .sort();

describe("r2 adversarial fixtures (correction-pass regressions)", () => {
  it("matches the manifest r2 register exactly", () => {
    const manifest = JSON.parse(
      readFileSync(join(AF, "manifest.json"), "utf8")
    );
    expect(expectedFiles.map(f => f.replace(".json", ""))).toEqual(
      Object.keys(manifest.r2_fixtures).sort()
    );
  });

  for (const file of expectedFiles) {
    const spec: Expected = JSON.parse(
      readFileSync(join(AF, "r2", "expected", file), "utf8")
    );
    const id = file.replace(".json", "");
    it(`${id} — ${spec.mechanism.slice(0, 72)}`, () => {
      const input = readFileSync(join(AF, spec.fixture), "utf8");
      const findings = spec.fixture.includes("/commit/")
        ? checkCommit(input, spec.options)
        : checkBody(input);
      const actual = findings.map(f => `${f.level}:${f.rule}`).sort();
      expect(actual).toEqual([...spec.expected_findings].sort());
      expect(actual.length).toBeGreaterThan(0);
    });
  }
});
