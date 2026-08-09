import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
// @ts-expect-error — plain .mjs module without type declarations
import {
  PLANNED_PATHS,
  extractCitedPaths,
  extractQuotedCheckNames,
  findDanglingPaths,
  findMisadvertisedSkills,
  findOrdinalCitations,
  findStalePlannedPaths,
  findUnmatchedCheckNames,
  parseOutcomeEnum,
  parseStandardRecord,
  parseTemplateRecord,
  parseYamlishKeys,
  listActiveDocs,
  runChecks,
} from "./check-federation-docs.mjs";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function fixture(files: Record<string, string>): string {
  const root = mkdtempSync(path.join(tmpdir(), "federation-docs-"));
  dirs.push(root);
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  return root;
}

describe("extractCitedPaths", () => {
  it("finds repo-rooted paths in prose, backticks, and links", () => {
    const found = extractCitedPaths(
      "see `server/routers.ts` and scripts/smoke-deploy.mjs, plus [x](docs/audits/a.md)."
    );
    expect(found).toContain("server/routers.ts");
    expect(found).toContain("scripts/smoke-deploy.mjs");
    expect(found).toContain("docs/audits/a.md");
  });

  it("strips trailing punctuation rather than treating it as filename", () => {
    expect(extractCitedPaths("see `server/a.ts`.")).toContain("server/a.ts");
  });

  it("ignores placeholder patterns, which are templates not paths", () => {
    const found = extractCitedPaths(
      "design-system/dime-ai/pages/<page>.md and docs/audits/[slug]-evidence/x.md"
    );
    expect(found).toHaveLength(0);
  });

  it("ignores bare words that are not paths", () => {
    expect(extractCitedPaths("the server handles it")).toHaveLength(0);
  });
});

describe("findDanglingPaths", () => {
  it("flags a cited path that does not exist", () => {
    const root = fixture({ "docs/real.md": "x" });
    const dangling = findDanglingPaths(
      "see docs/gone.md",
      "a/b/SKILL.md",
      root
    );
    expect(dangling).toEqual(["docs/gone.md"]);
  });

  it("resolves `references/…` relative to the citing doc's own directory", () => {
    const root = fixture({
      ".claude/skills/design-federation/references/registry.md": "x",
    });
    const dangling = findDanglingPaths(
      "pins live in `references/registry.md`",
      ".claude/skills/design-federation/SKILL.md",
      root
    );
    expect(dangling).toEqual([]);
  });

  it("resolves a command file's `references/…` against the federation roots", () => {
    const root = fixture({
      ".claude/skills/engineering-federation/references/record-template.yaml":
        "x",
    });
    // eng-loop.md lives in .claude/commands/, but its shorthand means the skill's tree.
    const dangling = findDanglingPaths(
      "copy references/record-template.yaml",
      ".claude/commands/eng-loop.md",
      root
    );
    expect(dangling).toEqual([]);
  });

  it("does not flag a declared planned path", () => {
    const root = fixture({});
    const planned = Object.keys(PLANNED_PATHS)[0];
    expect(findDanglingPaths(`see ${planned}`, "a/SKILL.md", root)).toEqual([]);
  });
});

describe("findStalePlannedPaths", () => {
  it("is empty when the planned artifacts still do not exist", () => {
    expect(findStalePlannedPaths(fixture({}))).toEqual([]);
  });

  it("fires once a planned path is built, so the allowance gets removed", () => {
    const planned = Object.keys(PLANNED_PATHS)[0];
    const root = fixture({ [planned]: "// now real" });
    expect(findStalePlannedPaths(root)).toContain(planned);
  });
});

describe("smoke-check citation rules", () => {
  it("catches ordinal citations", () => {
    expect(
      findOrdinalCitations("asserted by deploy-smoke check #5 today")
    ).toEqual(["check #5"]);
  });

  it("catches count citations", () => {
    expect(findOrdinalCitations("the script runs 8 checks")).toEqual([
      "8 checks",
    ]);
  });

  it("does not fire on ordinary prose about checks", () => {
    expect(findOrdinalCitations("run the checks before merging")).toEqual([]);
  });

  it("extracts italic-quoted check names", () => {
    expect(
      extractQuotedCheckNames('the check *"GET /health → 200"* passes')
    ).toEqual(["GET /health → 200"]);
  });

  it("matches a quoted name even when prose wrapped it across lines", () => {
    const doc =
      'runs *"rate-limit keying resists\nX-Forwarded-For spoofing"* per deploy';
    const smoke =
      'check("rate-limit keying resists X-Forwarded-For spoofing", async () => {';
    expect(findUnmatchedCheckNames(doc, smoke)).toEqual([]);
  });

  it("flags a quoted name absent from the smoke script", () => {
    expect(
      findUnmatchedCheckNames('*"check that never existed"*', 'check("other")')
    ).toEqual(["check that never existed"]);
  });
});

describe("evidence-record schema parsing", () => {
  it("separates top-level keys from nested subfields and ignores comments", () => {
    const parsed = parseYamlishKeys(
      [
        "outcome: # shipped | rejected",
        "verification:",
        "  focused_checks: ''",
        "# note: x",
      ].join("\n")
    );
    expect(parsed.top).toEqual(["outcome", "verification"]);
    expect(parsed.nested).toEqual(["focused_checks"]);
  });

  it("reads the seven terminal outcomes from an enum run", () => {
    const found = parseOutcomeEnum(
      "outcome: shipped | rejected | halted_attempts | halted_budget | halted_permission | halted_environment | failed_verification"
    );
    expect(found).toHaveLength(7);
    expect(found).toContain("halted_permission");
  });

  it("extracts the §21.3 block from the vendored standard shape", () => {
    const std = parseStandardRecord(
      [
        "### 21.3 Required agent evidence record",
        "",
        "```yaml",
        "outcome: shipped | rejected",
        "artifact_digest: immutable digest when built",
        "verification:",
        "  focused_checks: recorded results",
        "```",
      ].join("\n")
    );
    expect(std.top).toContain("artifact_digest");
    expect(std.nested).toContain("focused_checks");
  });

  it("throws a clear error when the standard's block is missing", () => {
    expect(() => parseStandardRecord("no record section here")).toThrow(
      /21\.3/
    );
  });

  it("reads the template with the same shape", () => {
    const tpl = parseTemplateRecord(
      "artifact_digest: ''\nverification:\n  full_suite: ''"
    );
    expect(tpl.top).toContain("artifact_digest");
    expect(tpl.nested).toContain("full_suite");
  });
});

describe("findMisadvertisedSkills", () => {
  const agentsOnly = ["architect-backend-systems"];

  it("flags a table row calling an .agents/skills-only skill Skill-invocable", () => {
    const row =
      "| architect-backend-systems | Skill tool (`.agents/skills/`) | Lead |";
    expect(findMisadvertisedSkills(row, agentsOnly)).toEqual([
      "architect-backend-systems",
    ]);
  });

  it("accepts a row that gives a Read path instead", () => {
    const row =
      "| architect-backend-systems | **Read-path only** — `Read .agents/skills/architect-backend-systems/SKILL.md` | Lead |";
    expect(findMisadvertisedSkills(row, agentsOnly)).toEqual([]);
  });

  it("ignores prose outside a table row", () => {
    expect(
      findMisadvertisedSkills(
        "architect-backend-systems is a Skill tool somewhere",
        agentsOnly
      )
    ).toEqual([]);
  });
});

describe("runChecks against this repo", () => {
  it("reports no violations — the federations describe the repo as it is", () => {
    const violations = runChecks(process.cwd());
    expect(violations, JSON.stringify(violations, null, 2)).toEqual([]);
  });
});

/**
 * The gate's scope boundary, which is itself a claim that must be tested.
 *
 * On 2026-08-09 two link defects were found BY HAND in exactly these surfaces,
 * because the gate governed only the nine federation documents under .claude/.
 * A controlled fixture confirmed the gap: dangling references injected into an
 * active os/ document and an active evidence summary both survived a green run.
 */
describe("active os/ and docs/ surfaces", () => {
  const federationStubs = () => ({
    // Minimal well-formed federation docs so runChecks reaches rule 1a without
    // drowning the assertion in unrelated missing-file violations.
    ".claude/skills/engineering-federation/SKILL.md": "ok",
    ".claude/skills/engineering-federation/references/routing.md": "ok",
    ".claude/skills/engineering-federation/references/dime-mapping.md": "ok",
    ".claude/skills/design-federation/SKILL.md": "ok",
    ".claude/skills/design-federation/references/routing.md": "ok",
    ".claude/skills/design-federation/references/registry.md": "ok",
    ".claude/skills/design-federation/references/evidence-bundle.md": "ok",
    ".claude/commands/eng-loop.md": "ok",
    ".claude/commands/ui-loop.md": "ok",
  });
  const violationsFor = (files: Record<string, string>) =>
    runChecks(fixture({ ...federationStubs(), ...files }));
  const danglingIn = (files: Record<string, string>, doc: string) =>
    violationsFor(files).filter(
      v => v.file === doc && v.msg.includes("does not exist")
    );

  it("[FD-OS-1] a broken link in an active os/ document FAILS", () => {
    expect(
      danglingIn(
        { "os/STATE.md": "See `server/_core/doesNotExist.ts` for the wiring." },
        "os/STATE.md"
      )
    ).toHaveLength(1);
  });

  it("[FD-DOCS-1] a broken link in an active docs/ document FAILS", () => {
    expect(
      danglingIn(
        { "docs/runbook.md": "Run `scripts/nope-missing.mjs` first." },
        "docs/runbook.md"
      )
    ).toHaveLength(1);
  });

  it("[FD-EV-1] a broken link in an evidence summary FAILS", () => {
    const doc = "docs/audits/2026-01-01-thing-evidence/summary.md";
    expect(
      danglingIn({ [doc]: "Proof in `server/_core/ghost.ts`." }, doc)
    ).toHaveLength(1);
  });

  it("[FD-OK-1] the same references PASS once the files exist", () => {
    const files = {
      "os/STATE.md": "See `server/_core/real.ts` for the wiring.",
      "docs/runbook.md": "Run `scripts/real.mjs` first.",
      "docs/audits/2026-01-01-thing-evidence/summary.md":
        "Proof in `server/_core/real.ts`.",
      "server/_core/real.ts": "export {};",
      "scripts/real.mjs": "",
    };
    const dangling = violationsFor(files).filter(v =>
      v.msg.includes("does not exist")
    );
    expect(dangling, JSON.stringify(dangling)).toEqual([]);
  });

  it("[FD-EX-1] decision records are excluded DELIBERATELY, not by accident", () => {
    // They argue about work that may never exist — DR-006 alone cites 16 paths
    // that do not. Governing them would need a ~130-entry allowlist, which is
    // the anti-pattern this gate exists to avoid. Pinned so the exclusion is a
    // decision someone has to change on purpose.
    const doc = "os/decisions/DR-999-proposal.md";
    expect(listActiveDocs(fixture({ [doc]: "x" }))).not.toContain(doc);
    expect(
      danglingIn({ [doc]: "Plan: build `server/_core/future.ts`." }, doc)
    ).toHaveLength(0);
  });

  it("[FD-EX-2] non-summary files inside an evidence bundle are not scanned", () => {
    // rendered-proof / detector output is machine-written and may quote paths
    // that were real when captured.
    const doc = "docs/audits/2026-01-01-thing-evidence/rendered-proof.txt";
    expect(listActiveDocs(fixture({ [doc]: "x" }))).not.toContain(doc);
  });

  it("[FD-SC-1] the governed set is exactly the three declared surfaces", () => {
    const docs = listActiveDocs(
      fixture({
        "os/STATE.md": "x",
        "os/decisions/DR-1.md": "x",
        "os/memory/lessons/a.md": "x",
        "docs/top.md": "x",
        "docs/audits/2026-01-01-a-evidence/summary.md": "x",
        "docs/audits/2026-01-01-a-evidence/other.md": "x",
        "docs/nested/deep.md": "x",
      })
    );
    expect(docs).toEqual([
      "docs/audits/2026-01-01-a-evidence/summary.md",
      "docs/top.md",
      "os/STATE.md",
    ]);
  });
});
