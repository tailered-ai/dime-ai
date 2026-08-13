// Evidence-integrity guard (review finding): the adversarial fixture
// manifest's SHA-256 pins are verified on every test run, so a fixture
// edit that forgets the manifest (or vice versa) fails loudly.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const AF = join(HERE, "../../docs/verification/prx/adversarial-fixtures");

describe("adversarial fixture manifest integrity", () => {
  const manifest = JSON.parse(readFileSync(join(AF, "manifest.json"), "utf8"));

  it("pins all 23 fixtures", () => {
    expect(Object.keys(manifest.fixtures).length).toBe(23);
  });

  for (const [id, meta] of Object.entries<{ fixture: string; sha256: string }>(
    manifest.fixtures
  )) {
    it(`${id} bytes match the manifest pin`, () => {
      const actual = createHash("sha256")
        .update(readFileSync(join(AF, meta.fixture)))
        .digest("hex");
      expect(actual).toBe(meta.sha256);
    });
  }
});
