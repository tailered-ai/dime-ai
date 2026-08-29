// Trusted CI boundary regression (SOL-PRX-004): a pull request that
// modifies its own copy of the checker must not change the policy that
// produces the verdict. Mirrors the workflow's base-checkout design via
// selectPolicySource().
import { createHash } from "node:crypto";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { parseNulList, selectPolicySource } from "./policy-source.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REAL_CHECKER = join(HERE, "check-commit.mjs");
const sha256 = (p: string) =>
  createHash("sha256").update(readFileSync(p)).digest("hex");

const root = mkdtempSync(join(tmpdir(), "prx-boundary-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function makeTree(name: string) {
  const dir = join(root, name, "scripts", "prx");
  mkdirSync(dir, { recursive: true });
  cpSync(REAL_CHECKER, join(dir, "check-commit.mjs"));
  return join(root, name);
}

describe("trusted policy selection", () => {
  it("selects the base policy when it exists", () => {
    const trusted = makeTree("base");
    const head = makeTree("head");
    const pick = selectPolicySource({ trustedDir: trusted, headDir: head });
    expect(pick.trusted).toBe(true);
    expect(pick.dir).toBe(trusted);
  });

  it("a mutated head checker changes neither the selection nor the bytes", () => {
    const trusted = makeTree("base2");
    const head = makeTree("head2");
    const before = selectPolicySource({ trustedDir: trusted, headDir: head });
    const trustedHash = sha256(
      join(before.dir, "scripts", "prx", "check-commit.mjs")
    );

    // The attack: the PR head neuters its own copy of the checker.
    writeFileSync(
      join(head, "scripts", "prx", "check-commit.mjs"),
      "export function checkCommit() { return []; } // gate removed\n"
    );

    const after = selectPolicySource({ trustedDir: trusted, headDir: head });
    expect(after.trusted).toBe(true);
    expect(after.dir).toBe(trusted);
    expect(sha256(join(after.dir, "scripts", "prx", "check-commit.mjs"))).toBe(
      trustedHash
    );
    expect(trustedHash).toBe(sha256(REAL_CHECKER));
  });

  it("bootstrap fallback is explicit and labeled untrusted", () => {
    const head = makeTree("head3");
    const emptyBase = join(root, "empty-base");
    mkdirSync(emptyBase, { recursive: true });
    const pick = selectPolicySource({ trustedDir: emptyBase, headDir: head });
    expect(pick.trusted).toBe(false);
    expect(pick.dir).toBe(head);
    expect(pick.reason).toContain("UNTRUSTED");
    expect(pick.reason).toContain("bootstrap");
  });

  it("the trusted reason names the base ref (R8)", () => {
    const trusted = makeTree("base4");
    const head = makeTree("head4");
    const pick = selectPolicySource({ trustedDir: trusted, headDir: head });
    expect(pick.reason).toContain("trusted base ref");
  });

  it("a scripts/prx DIRECTORY without the checker is NOT trusted policy (R8)", () => {
    // The marker is the checker FILE; a partial tree (directory present,
    // checker absent) must fall back to the explicit bootstrap.
    const partial = join(root, "partial-base");
    mkdirSync(join(partial, "scripts", "prx"), { recursive: true });
    const head = makeTree("head5");
    const pick = selectPolicySource({ trustedDir: partial, headDir: head });
    expect(pick.trusted).toBe(false);
    expect(pick.dir).toBe(head);
  });
});

describe("NUL-safe file-list transfer (SOL-PRX-017)", () => {
  it("survives spaces, tabs, newlines, and leading hyphens", () => {
    const names = [
      "a file with spaces.md",
      "tab\tseparated.md",
      "new\nline.md",
      "-leading-hyphen.md",
      "--range.md",
    ];
    expect(parseNulList(`${names.join("\0")}\0`)).toEqual(names);
  });

  it("drops empty entries", () => {
    expect(parseNulList("\0\0a.md\0")).toEqual(["a.md"]);
  });
});
