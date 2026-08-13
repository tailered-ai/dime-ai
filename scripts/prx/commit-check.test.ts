import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { checkCommit, parseCommitMessage } from "./commit-check.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) =>
  readFileSync(join(HERE, "fixtures/commit", name), "utf8");
const rules = (findings: { rule: string }[]) =>
  findings.map(f => f.rule).sort();

describe("healthy fixtures", () => {
  for (const name of [
    "healthy-basic.txt",
    "healthy-governed.txt",
    "healthy-subject-only.txt",
    "healthy-revert.txt",
  ]) {
    it(`${name} is clean`, () => {
      expect(checkCommit(fixture(name), {})).toEqual([]);
    });
  }
});

describe("structural parser", () => {
  it("separates subject, separator, body, trailers", () => {
    const parsed = parseCommitMessage(
      "feat(x): subject\n\nBody line.\n\nRun-Id: ONE-20260812-AAAA\n"
    );
    expect(parsed.subject).toBe("feat(x): subject");
    expect(parsed.separatorBlanks).toBe(1);
    expect(parsed.trailers?.entries).toEqual([
      { key: "Run-Id", value: "ONE-20260812-AAAA", line: 5 },
    ]);
  });

  it("does not treat a mid-body Key: line as a trailer", () => {
    const parsed = parseCommitMessage(
      "feat(x): subject\n\nEvidence: prose here\n\nA final ordinary paragraph.\n"
    );
    expect(parsed.trailers).toBeNull();
  });

  it("treats an all-shaped final block as a formal trailer block", () => {
    const parsed = parseCommitMessage(
      "feat(x): s\n\nWhy.\n\nRun-Id: ONE-20260812-AAAA\nEvidence: UNKNOWN\n"
    );
    expect(parsed.trailers?.entries.map(e => e.key)).toEqual([
      "Run-Id",
      "Evidence",
    ]);
  });
});

describe("deterministic rules", () => {
  it("flags a missing blank separator (zero blanks)", () => {
    const f = checkCommit("feat(x): s\nbody immediately\n", {});
    expect(rules(f)).toContain("PRX-C-SEPARATOR");
  });

  it("flags a trailing period and whitespace", () => {
    const f = checkCommit("feat(x): does the thing. \n", {});
    expect(rules(f)).toContain("PRX-C-SUBJECT");
  });

  it("flags control characters in the subject", () => {
    const f = checkCommit("feat(x): has\u0007bell\n", {});
    expect(f.some(x => x.rule === "PRX-C-SUBJECT")).toBe(true);
  });

  it("flags an empty subject", () => {
    expect(rules(checkCommit("\n\nbody\n", {}))).toContain("PRX-C-SUBJECT");
  });

  it("rejects fixup!/squash! outright", () => {
    expect(rules(checkCommit("fixup! feat(x): s\n", {}))).toContain(
      "PRX-C-FIXUP"
    );
  });

  it("merge exemption comes from topology, not the subject", () => {
    const msg = "Merge branch 'x' into main\n";
    expect(rules(checkCommit(msg, {}))).toContain("PRX-C-PREFIX");
    expect(checkCommit(msg, { isMerge: true })).toEqual([]);
  });

  it("bot exemption comes from authenticated author metadata", () => {
    const msg = "Bump lodash from 1 to 2\n";
    expect(rules(checkCommit(msg, {}))).toContain("PRX-C-PREFIX");
    expect(checkCommit(msg, { authorIsBot: true })).toEqual([]);
  });

  it("revert exemption needs the generated body marker, not the subject", () => {
    const noMarker = 'Revert "feat(x): thing"\n\nBecause reasons.\n';
    expect(rules(checkCommit(noMarker, {}))).toContain("PRX-C-PREFIX");
  });

  it("rejects duplicate governed trailers", () => {
    const msg =
      "feat(x): s\n\nWhy.\n\nRun-Id: ONE-20260812-AAAA\nRun-Id: ONE-20260812-BBBB\nEvidence: UNKNOWN\nCo-Authored-By: A B <a@b.co>\n";
    const f = checkCommit(msg, {});
    expect(f.some(x => x.rule === "PRX-C-TRAILER")).toBe(true);
    expect(f.some(x => x.rule === "PRX-C-GOV")).toBe(true);
  });

  it("enforces the size bound", () => {
    const f = checkCommit(`feat(x): s\n\n${"a".repeat(1024 * 1024)}\n`, {});
    expect(rules(f)).toEqual(["PRX-C-SIZE"]);
  });
});

describe("narrow exemption spans (SOL-PRX-007)", () => {
  it("a long line that is ONLY a URL is exempt from wrap", () => {
    const url = `https://example.com/${"a".repeat(90)}`;
    const f = checkCommit(`feat(x): s\n\n${url}\n`, {});
    expect(f.filter(x => x.rule === "PRX-C-WRAP")).toEqual([]);
  });

  it("a long prose line is not excused by containing a URL", () => {
    const line = `This prose mentions https://example.com and then ${"keeps going ".repeat(10)}without a break.`;
    const f = checkCommit(`feat(x): s\n\n${line}\n`, {});
    expect(f.some(x => x.rule === "PRX-C-WRAP")).toBe(true);
  });

  it("fence content and table rows are wrap-exempt", () => {
    const body = `\`\`\`\n${"x".repeat(100)}\n\`\`\`\n| ${"y".repeat(100)} |\n`;
    const f = checkCommit(`feat(x): s\n\n${body}`, {});
    expect(f.filter(x => x.rule === "PRX-C-WRAP")).toEqual([]);
  });
});

describe("heuristic honesty", () => {
  it("mood findings are advisory-level, never errors", () => {
    const f = checkCommit("feat(x): parser is now stricter\n", {});
    const mood = f.filter(x => x.rule === "PRX-C-MOOD");
    expect(mood.length).toBe(1);
    expect(mood[0].level).toBe("advisory");
    expect(mood[0].class).toBe("heuristic");
  });

  it("an imperative subject with no copula gets no mood finding", () => {
    const f = checkCommit("feat(x): tighten the trailer grammar\n", {});
    expect(f.filter(x => x.rule === "PRX-C-MOOD")).toEqual([]);
  });
});

describe("mutation-hardening (targeted survivor kills)", () => {
  it("accepts input at exactly the 1 MiB bound", () => {
    const msg = "feat(x): s\n\n";
    const padded = msg + "a".repeat(1024 * 1024 - msg.length);
    const f = checkCommit(padded, {});
    expect(f.some(x => x.rule === "PRX-C-SIZE")).toBe(false);
  });

  it("detects every copula alternative (is/are/was/were)", () => {
    for (const subject of [
      "feat(x): parser is strict",
      "feat(x): tables are stale",
      "feat(x): field was dropped",
      "feat(x): rows were dropped",
    ]) {
      const f = checkCommit(`${subject}\n`, {});
      expect(f.some(x => x.rule === "PRX-C-MOOD")).toBe(true);
    }
  });

  it("accepts the docs/ alternative of the Evidence grammar", () => {
    const msg =
      "feat(x): s\n\nWhy.\n\nRun-Id: ONE-20260812-PRX\nEvidence: docs/verification/prx/threat-model.md\nCo-Authored-By: A B <a@b.co>\n";
    expect(checkCommit(msg, {})).toEqual([]);
  });

  it("rejects an Evidence value with an invalid character even at valid depth", () => {
    const msg =
      "feat(x): s\n\nWhy.\n\nRun-Id: ONE-20260812-PRX\nEvidence: run/ONE-20260812-PRX/bad value.json\nCo-Authored-By: A B <a@b.co>\n";
    const f = checkCommit(msg, {});
    expect(f.some(x => x.rule === "PRX-C-GOV")).toBe(true);
  });
});

describe("governed scope without circularity (R3)", () => {
  const gov = (f: { rule: string }[]) =>
    f.filter(x => x.rule === "PRX-C-GOV").length;
  const trailer = (f: { rule: string }[]) =>
    f.filter(x => x.rule === "PRX-C-TRAILER").length;

  it("missing ALL governed trailers is caught only with --governed", () => {
    const msg = "feat(x): s\n\nWhy this change exists.\n";
    expect(gov(checkCommit(msg, {}))).toBe(0);
    // Run-Id absent, Evidence absent, Co-Authored-By absent = 3 findings.
    expect(gov(checkCommit(msg, { governed: true }))).toBe(3);
  });

  it("valid governed trailers pass with --governed", () => {
    const msg =
      "feat(x): s\n\nWhy.\n\nRun-Id: ONE-20260812-PRX\nEvidence: UNKNOWN\nCo-Authored-By: A B <a@b.co>\n";
    expect(checkCommit(msg, { governed: true })).toEqual([]);
  });

  it("a Run-Id trailer self-declares governed scope", () => {
    const msg = "feat(x): s\n\nWhy.\n\nRun-Id: ONE-20260812-PRX\n";
    const f = checkCommit(msg, {});
    // Evidence missing + Co-Authored-By missing once scope is declared.
    expect(gov(f)).toBe(2);
  });

  it("a malformed LONE Co-Authored-By is a trailer error, not governed activation", () => {
    const msg = "feat(x): s\n\nWhy.\n\nCo-Authored-By: nobody\n";
    const f = checkCommit(msg, {});
    expect(trailer(f)).toBe(1);
    expect(gov(f)).toBe(0);
  });

  it("a valid lone Co-Authored-By is clean and does not activate governed scope", () => {
    const msg = "feat(x): s\n\nWhy.\n\nCo-Authored-By: A B <a@b.co>\n";
    expect(checkCommit(msg, {})).toEqual([]);
  });

  it("a mid-body Co-Authored-By: prose line is not a formal trailer", () => {
    const msg =
      "feat(x): s\n\nCo-Authored-By: nobody was harmed by this sentence.\n\nA final ordinary paragraph.\n";
    const f = checkCommit(msg, {});
    expect(trailer(f)).toBe(0);
    expect(gov(f)).toBe(0);
  });

  it("duplicate Run-Id fails both the trailer and governed grammars", () => {
    const msg =
      "feat(x): s\n\nWhy.\n\nRun-Id: ONE-20260812-AAAA\nRun-Id: ONE-20260812-BBBB\nEvidence: UNKNOWN\nCo-Authored-By: A B <a@b.co>\n";
    const f = checkCommit(msg, {});
    expect(trailer(f)).toBe(1);
    expect(gov(f)).toBe(1);
  });

  it("duplicate Evidence fails both the trailer and governed grammars", () => {
    const msg =
      "feat(x): s\n\nWhy.\n\nRun-Id: ONE-20260812-AAAA\nEvidence: UNKNOWN\nEvidence: docs/x.md\nCo-Authored-By: A B <a@b.co>\n";
    const f = checkCommit(msg, {});
    expect(trailer(f)).toBe(1);
    expect(gov(f)).toBe(1);
  });

  it("multiple VALID Co-Authored-By trailers are allowed", () => {
    const msg =
      "feat(x): s\n\nWhy.\n\nRun-Id: ONE-20260812-PRX\nEvidence: UNKNOWN\nCo-Authored-By: A B <a@b.co>\nCo-Authored-By: C D <c@d.co>\n";
    expect(checkCommit(msg, {})).toEqual([]);
  });

  it("a malformed Co-Authored-By among governed trailers is a trailer error", () => {
    const msg =
      "feat(x): s\n\nWhy.\n\nRun-Id: ONE-20260812-PRX\nEvidence: UNKNOWN\nCo-Authored-By: nobody\n";
    const f = checkCommit(msg, {});
    expect(trailer(f)).toBe(1);
    // Presence satisfied; value grammar handled by PRX-C-TRAILER.
    expect(gov(f)).toBe(0);
  });
});

describe("review-pass regressions", () => {
  it("catches a copula that is the FIRST description word", () => {
    for (const s of ["feat(x): is broken on main", "fix: is now stricter"]) {
      const f = checkCommit(`${s}\n`, {});
      expect(f.some(x => x.rule === "PRX-C-MOOD")).toBe(true);
    }
  });

  it("trailer continuation lines share the wrap exemption", () => {
    const msg =
      "feat(x): s\n\nWhy.\n\nRun-Id: ONE-20260812-PRX\nEvidence: UNKNOWN\nCo-Authored-By: A B <a@b.co>\n  " +
      "x".repeat(90) +
      "\n";
    const f = checkCommit(msg, {});
    expect(f.filter(x => x.rule === "PRX-C-WRAP")).toEqual([]);
  });
});

describe("mutation-hardening R8 (commit-check survivors)", () => {
  it("accepts every conventional type prefix", () => {
    for (const type of [
      "feat",
      "fix",
      "chore",
      "docs",
      "refactor",
      "test",
      "perf",
      "ci",
      "build",
      "style",
      "revert",
    ]) {
      const f = checkCommit(`${type}: tighten the gate\n`, {});
      expect(f.filter(x => x.rule === "PRX-C-PREFIX")).toEqual([]);
    }
  });

  it("parses a no-space Key:value trailer with its value intact", () => {
    const parsed = parseCommitMessage(
      "feat(x): s\n\nWhy.\n\nAcked-by:reviewer\n"
    );
    expect(parsed.trailers?.entries).toEqual([
      { key: "Acked-by", value: "reviewer", line: 5 },
    ]);
  });

  it("a prose tail line degrades the whole final block to prose", () => {
    const msg =
      "feat(x): s\n\nWhy.\n\nRun-Id: ONE-20260812-PRX\nplain prose tail\n";
    expect(checkCommit(msg, {})).toEqual([]);
  });

  it("a single-space continuation line stays in the trailer block", () => {
    const msg =
      "feat(x): s\n\nWhy.\n\nAcked-by: reviewer\n " + "x".repeat(90) + "\n";
    expect(checkCommit(msg, {})).toEqual([]);
  });

  it("URL tokens are removed exactly, on http and https alike", () => {
    const l3 = `See https://example.com/${"a".repeat(60)} for the evidence trail`;
    const l4 = `See http://example.com/${"a".repeat(60)} for the evidence trail`;
    const l5 = "p".repeat(58) + " https://e.co/x";
    const msg = `feat(x): s\n\n${l3}\n${l4}\n${l5}\n\nTail paragraph.\n`;
    expect(checkCommit(msg, {}).filter(x => x.rule === "PRX-C-WRAP")).toEqual(
      []
    );
  });

  it("fence markers open fences only at line start with three marker chars", () => {
    const midline = "feat(x): s\n\nUse the ``` marker to fence.\n";
    const oneTick = "feat(x): s\n\n`inline code` reference\n";
    const oneTilde = "feat(x): s\n\n~one tilde line\n";
    for (const msg of [midline, oneTick, oneTilde]) {
      expect(
        checkCommit(msg, {}).filter(x => x.rule === "PRX-C-FENCE")
      ).toEqual([]);
    }
  });

  it("Co-Authored-By grammar is anchored at both ends", () => {
    const msg =
      "feat(x): s\n\nWhy.\n\nCo-Authored-By: <Dev> Real Name <dev@example.com>\nCo-Authored-By: A B <a@b.co> and friends\n";
    const f = checkCommit(msg, {});
    expect(f.filter(x => x.rule === "PRX-C-TRAILER").length).toBe(2);
  });

  it("detects a copula that ends the subject", () => {
    const f = checkCommit("feat(x): confirm what it is\n", {});
    expect(f.some(x => x.rule === "PRX-C-MOOD")).toBe(true);
  });

  it("CRLF input normalizes to the same structure as LF input", () => {
    const parsed = parseCommitMessage("feat(x): s\r\n\r\nbody line here.\r\n");
    expect(parsed.subject).toBe("feat(x): s");
    expect(parsed.bodyLines.map(l => l.text)).toEqual(["body line here."]);
  });

  it("all trailing newlines are stripped, not just one", () => {
    const parsed = parseCommitMessage("feat(x): s\n\nbody\n\n\n");
    expect(parsed.bodyLines.length).toBe(1);
  });

  it("a whitespace-only separator line counts as a blank separator", () => {
    expect(checkCommit("feat(x): s\n \nbody text\n", {})).toEqual([]);
  });

  it("a properly closed fence is not reported unclosed", () => {
    const msg = "feat(x): s\n\n```\ncode line\n```\n\nAfter paragraph.\n";
    expect(checkCommit(msg, {})).toEqual([]);
  });

  it("long fence marker lines are themselves wrap-exempt", () => {
    const msg =
      "feat(x): s\n\n```" +
      "x".repeat(75) +
      "\ncode\n```" +
      "y".repeat(75) +
      "\n\nTail paragraph.\n";
    expect(checkCommit(msg, {})).toEqual([]);
  });

  it("a mismatched fence marker does not close the open fence", () => {
    const f = checkCommit("feat(x): s\n\n```\ncontent\n~~~\n", {});
    expect(f.some(x => x.rule === "PRX-C-FENCE")).toBe(true);
  });

  it("a trailing whitespace-only line does not detach the trailer block", () => {
    const msg =
      "feat(x): s\n\nWhy.\n\nRun-Id: ONE-20260812-PRX\nEvidence: UNKNOWN\nCo-Authored-By: A B <a@b.co>\n  ";
    expect(checkCommit(msg, { governed: true })).toEqual([]);
  });

  it("a whitespace-only line delimits the trailer block like a blank line", () => {
    const msg =
      "feat(x): s\n\nWhy prose.\n \nRun-Id: ONE-20260812-PRX\nEvidence: UNKNOWN\nCo-Authored-By: A B <a@b.co>\n";
    expect(checkCommit(msg, { governed: true })).toEqual([]);
  });

  it("trailer values are trimmed before grammar checks", () => {
    const msg =
      "feat(x): s\n\nWhy.\n\nRun-Id: ONE-20260812-PRX  \nEvidence: UNKNOWN\nCo-Authored-By: A B <a@b.co>\n";
    expect(checkCommit(msg, {})).toEqual([]);
  });

  it("continuation lines are appended trimmed to the previous value", () => {
    const msg = "feat(x): s\n\nWhy.\n\nCo-Authored-By: A B\n <a@b.co> \n";
    expect(checkCommit(msg, {})).toEqual([]);
  });

  it("non-string input is bounced by the size/type guard", () => {
    expect(rules(checkCommit(null as unknown as string, {}))).toEqual([
      "PRX-C-SIZE",
    ]);
  });

  it("hasBody is not fooled by any particular body text", () => {
    const f = checkCommit("feat(x): s\nStryker was here!\n", {});
    expect(rules(f)).toContain("PRX-C-SEPARATOR");
  });

  it("a whitespace-only subject is reported as empty, not stray whitespace", () => {
    const f = checkCommit("   \n\nbody.\n", {});
    const subj = f.filter(x => x.rule === "PRX-C-SUBJECT");
    expect(subj.length).toBe(1);
    expect(subj[0].message).toBe("subject line is empty");
  });

  it("trailing whitespace alone (no period) is flagged", () => {
    const f = checkCommit("feat(x): does the thing \n", {});
    expect(f.some(x => x.rule === "PRX-C-SUBJECT")).toBe(true);
  });

  it("the trailing-period check is anchored and whitespace-tolerant", () => {
    const bare = checkCommit("feat(x): does the thing.\n", {});
    expect(bare.filter(x => x.rule === "PRX-C-SUBJECT").length).toBe(1);

    const mid = checkCommit("feat(x): bump v1.2 loader\n", {});
    expect(mid.filter(x => x.rule === "PRX-C-SUBJECT")).toEqual([]);

    const spaced = checkCommit("feat(x): does the thing. \n", {});
    expect(spaced.filter(x => x.rule === "PRX-C-SUBJECT").length).toBe(2);
  });

  it("a mid-subject fixup! mention is not a fixup commit", () => {
    const f = checkCommit("feat(x): reject fixup! subjects in the gate\n", {});
    expect(f.filter(x => x.rule === "PRX-C-FIXUP")).toEqual([]);
  });

  it("subject length is advisory-flagged strictly above 72", () => {
    const long = checkCommit(`feat(x): ${"a".repeat(80)}\n`, {});
    expect(rules(long)).toContain("PRX-C-LENGTH");
    const exact = checkCommit(`feat(x): ${"a".repeat(63)}\n`, {});
    expect(exact.filter(x => x.rule === "PRX-C-LENGTH")).toEqual([]);
  });

  it("the table-row exemption is anchored and allows indentation", () => {
    const msg = `feat(x): s\n\n${"x".repeat(40)} | ${"y".repeat(40)}\n  | ${"z".repeat(80)} |\n\nTail paragraph.\n`;
    const wraps = checkCommit(msg, {}).filter(x => x.rule === "PRX-C-WRAP");
    expect(wraps.map(w => w.line)).toEqual([3]);
  });

  it("a 72-column body line is exactly at the advisory bound", () => {
    const msg = `feat(x): s\n\n${"w".repeat(72)}\n\nTail paragraph.\n`;
    expect(checkCommit(msg, {}).filter(x => x.rule === "PRX-C-WRAP")).toEqual(
      []
    );
  });

  it("the Evidence length cap is exact and independent of the grammar", () => {
    const at120 =
      "feat(x): s\n\nWhy.\n\nRun-Id: ONE-20260812-PRX\nEvidence: docs/" +
      "a".repeat(115) +
      "\nCo-Authored-By: A B <a@b.co>\n";
    expect(checkCommit(at120, {})).toEqual([]);

    const over =
      "feat(x): s\n\nWhy.\n\nRun-Id: ONE-20260812-PRX\nEvidence: docs/" +
      "a".repeat(150) +
      "\nCo-Authored-By: A B <a@b.co>\n";
    expect(checkCommit(over, {}).some(x => x.rule === "PRX-C-GOV")).toBe(true);
  });

  it("the revert subject shape is anchored at line start", () => {
    const msg =
      'Undo the Revert "feat(x): thing" commit\n\nThis reverts commit ' +
      "a".repeat(40) +
      ".\n";
    expect(rules(checkCommit(msg, {}))).toContain("PRX-C-PREFIX");
  });

  it("a generated revert may carry extra body lines beside the marker", () => {
    const msg =
      'Revert "feat(x): thing"\n\nThis reverts commit ' +
      "1".repeat(40) +
      ".\nReverted because the deploy broke.\n";
    expect(checkCommit(msg, {})).toEqual([]);
  });

  it("the revert body marker must start its line", () => {
    const msg =
      'Revert "feat(x): thing"\n\nSee that This reverts commit abcdef1 in spirit.\n';
    expect(rules(checkCommit(msg, {}))).toContain("PRX-C-PREFIX");
  });

  it("truncate keeps 60-char values whole and clips longer ones at 57+'...'", () => {
    const msg =
      "feat(x): s\n\nWhy.\n\nCo-Authored-By: nobody\nCo-Authored-By: " +
      "x".repeat(70) +
      "\nCo-Authored-By: " +
      "y".repeat(60) +
      "\n";
    const msgs = checkCommit(msg, {})
      .filter(x => x.rule === "PRX-C-TRAILER")
      .map(x => x.message);
    expect(msgs).toEqual([
      'Co-Authored-By "nobody" is not "Name <email>"',
      `Co-Authored-By "${"x".repeat(57)}..." is not "Name <email>"`,
      `Co-Authored-By "${"y".repeat(60)}" is not "Name <email>"`,
    ]);
  });

  it("a foreign fence marker line inside a fence stays wrap-exempt", () => {
    const msg = "feat(x): s\n\n```\n~~~" + "z".repeat(75) + "\n```\n\nTail.\n";
    expect(checkCommit(msg, {})).toEqual([]);
  });
});
