/**
 * dependabot-guard.test.ts — DEF-027 regression.
 *
 * The Dependabot auto-merge job's identity guard must rest on the PR AUTHOR,
 * which an attacker cannot control, and must not rest on `github.actor`,
 * which becomes whoever re-ran the workflow.
 *
 * This reads the workflow as BYTES and extracts the condition with a regex —
 * it never parses YAML, so P02 remains the only YAML-reading boundary. The
 * condition is then evaluated against controlled contexts by a tiny evaluator
 * that understands exactly the operators this guard uses and THROWS on
 * anything else, so a future rewrite into a form it cannot evaluate fails
 * loudly instead of being silently mis-approved.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..", "..");
const WORKFLOW = path.join(
  REPO_ROOT,
  ".github/workflows/auto-merge-dependabot.yml"
);

const source = readFileSync(WORKFLOW, "utf8");

/** Strip comment lines so documentation can never satisfy an assertion. */
const code = source
  .split("\n")
  .filter(line => !line.trim().startsWith("#"))
  .join("\n");

/** The job-level identity condition (the first `if:` at job indentation). */
function jobCondition(): string {
  const match = code.match(/^ {4}if: (.+)$/m);
  if (!match) throw new Error("job-level identity condition not found");
  return match[1].trim();
}

type Ctx = { actor: string; prAuthor: string };

/**
 * Evaluate a GitHub expression limited to `A == 'literal'` terms joined by
 * `&&`. Any other construct throws — refusing to guess is the point.
 */
function evaluate(condition: string, ctx: Ctx): boolean {
  const terms = condition.split("&&").map(t => t.trim());
  return terms.every(term => {
    const match = term.match(/^([\w.]+)\s*==\s*'([^']*)'$/);
    if (!match) {
      throw new Error(`UNEVALUATABLE_TERM: ${term}`);
    }
    const [, contextPath, literal] = match;
    let actual: string;
    if (contextPath === "github.actor") actual = ctx.actor;
    else if (contextPath === "github.event.pull_request.user.login")
      actual = ctx.prAuthor;
    else throw new Error(`UNKNOWN_CONTEXT: ${contextPath}`);
    return actual === literal;
  });
}

const DEPENDABOT = "dependabot[bot]";

describe("DEF-027 — Dependabot identity guard", () => {
  it("keeps the authoritative PR-author clause", () => {
    expect(jobCondition()).toContain(
      "github.event.pull_request.user.login == 'dependabot[bot]'"
    );
  });

  it("no longer relies on the spoofable actor context", () => {
    expect(jobCondition()).not.toContain("github.actor");
  });

  it("runs for a genuine Dependabot PR", () => {
    expect(
      evaluate(jobCondition(), { actor: DEPENDABOT, prAuthor: DEPENDABOT })
    ).toBe(true);
  });

  it("still runs when a human re-runs a genuine Dependabot PR", () => {
    // The behavioural change the fix introduces, stated explicitly: a re-run
    // no longer disables the job. The PR author is what the guard is about.
    expect(
      evaluate(jobCondition(), { actor: "a-human", prAuthor: DEPENDABOT })
    ).toBe(true);
  });

  it("REFUSES a non-Dependabot PR even when the actor claims to be Dependabot", () => {
    // The security property. Spoofing the actor cannot satisfy the guard,
    // because the actor is no longer part of it.
    expect(
      evaluate(jobCondition(), { actor: DEPENDABOT, prAuthor: "attacker" })
    ).toBe(false);
  });

  it("refuses an ordinary human-authored PR", () => {
    expect(
      evaluate(jobCondition(), { actor: "a-human", prAuthor: "a-human" })
    ).toBe(false);
  });

  it("the evaluator refuses constructs it cannot judge", () => {
    // If the guard is ever rewritten into a shape this test cannot evaluate,
    // it must fail loudly rather than silently approve.
    expect(() =>
      evaluate("github.actor != 'x'", { actor: "x", prAuthor: "y" })
    ).toThrow(/UNEVALUATABLE_TERM/);
    expect(() =>
      evaluate("github.repository == 'x'", { actor: "x", prAuthor: "y" })
    ).toThrow(/UNKNOWN_CONTEXT/);
  });

  it("preserves the downstream patch-only guard and merge behaviour", () => {
    expect(code).toContain(
      "steps.meta.outputs.update-type == 'version-update:semver-patch'"
    );
    expect(code).toContain(
      "steps.meta.outputs.update-type != 'version-update:semver-patch'"
    );
    expect(code).toContain("--auto");
    expect(code).toContain("--squash");
  });

  it("preserves triggers, permissions, job identity, and SHA pinning", () => {
    expect(code).toContain("types: [opened, synchronize, reopened]");
    expect(code).toContain("contents: write");
    expect(code).toContain("pull-requests: write");
    expect(code).toContain("name: Auto-merge Dependabot patch PRs");
    const uses = [...code.matchAll(/uses: (\S+)/g)].map(m => m[1]);
    expect(uses.length).toBeGreaterThan(0);
    for (const ref of uses) {
      expect(ref, `${ref} must be SHA-pinned`).toMatch(/@[0-9a-f]{40}$/);
    }
  });
});
