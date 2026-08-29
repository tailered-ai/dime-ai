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
    const f = checkCommit(noMarker, {});
    expect(rules(f)).toContain("PRX-C-PREFIX");
    // Subject shape alone is not even revert-SHAPED: no advisory either.
    expect(rules(f)).not.toContain("PRX-C-CONTEXT-UNVERIFIED");
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

  it("counts the size bound in UTF-8 bytes, exact at the boundary (r2)", () => {
    // 12 ASCII bytes of scaffold + N two-byte chars: at the bound passes,
    // one more char exceeds it — while the UTF-16 unit count stays far
    // below the limit in both cases (BYP-C-06).
    const scaffold = "feat(x): s\n\n";
    const fill = (1024 * 1024 - scaffold.length) / 2;
    const at = scaffold + "é".repeat(fill);
    expect(checkCommit(at, {}).some(x => x.rule === "PRX-C-SIZE")).toBe(false);
    const over = scaffold + "é".repeat(fill + 1);
    const f = checkCommit(over, {});
    expect(f.map(x => x.rule)).toEqual(["PRX-C-SIZE"]);
  });

  it("applies the Evidence byte cap in UTF-8 on the commit surface (r2)", () => {
    // 58 two-byte chars: 121 bytes but only 63 UTF-16 units.
    const msg =
      "feat(x): s\n\nWhy.\n\nRun-Id: ONE-20260812-PRX\nEvidence: docs/" +
      "é".repeat(58) +
      "\nCo-Authored-By: A B <a@b.co>\n";
    expect(checkCommit(msg, {}).some(x => x.rule === "PRX-C-GOV")).toBe(true);
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

  it("a mid-body Co-Authored-By: line is validated where it appears (r2)", () => {
    // BYP-C-02: recognized governed-key lines in ordinary body text are no
    // longer invisible — this line draws a placement error plus a value
    // grammar error, and still does not activate governed scope.
    const msg =
      "feat(x): s\n\nCo-Authored-By: nobody was harmed by this sentence.\n\nA final ordinary paragraph.\n";
    const f = checkCommit(msg, {});
    expect(trailer(f)).toBe(2);
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

  it("a prose tail no longer hides a governed trailer from validation (r2)", () => {
    // The prose tail still degrades the FORMAL block, but the recognized
    // Run-Id line is validated where it appears: one placement error, and
    // governed scope activates (Evidence and Co-Authored-By missing).
    const msg =
      "feat(x): s\n\nWhy.\n\nRun-Id: ONE-20260812-PRX\nplain prose tail\n";
    const f = checkCommit(msg, {});
    expect(f.filter(x => x.rule === "PRX-C-TRAILER").length).toBe(1);
    expect(f.filter(x => x.rule === "PRX-C-GOV").length).toBe(2);
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
      "feat(x): s\n\n```" + "x".repeat(75) + "\ncode\n```\n\nTail paragraph.\n";
    expect(checkCommit(msg, {})).toEqual([]);
  });

  it("a marker with trailing text cannot close a fence (CommonMark, r2)", () => {
    // Under BYP-C-09 the closing fence must carry nothing after the
    // marker, so the old ```yyy "closer" is fence CONTENT and the fence
    // stays open — matching how the pinned GFM parser reads the same text.
    const msg =
      "feat(x): s\n\n```" +
      "x".repeat(75) +
      "\ncode\n```" +
      "y".repeat(75) +
      "\n\nTail paragraph.\n";
    const f = checkCommit(msg, {});
    expect(f.some(x => x.rule === "PRX-C-FENCE")).toBe(true);
    expect(f.filter(x => x.rule === "PRX-C-WRAP")).toEqual([]);
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

  it("a revert-shaped message earns no exemption without verification (r2)", () => {
    // BYP-C-04: message shape alone is forgeable. The ordinary prefix
    // result applies, plus the advisory explaining why.
    const msg =
      'Revert "feat(x): thing"\n\nThis reverts commit ' +
      "1".repeat(40) +
      ".\nReverted because the deploy broke.\n";
    const f = checkCommit(msg, {});
    expect(rules(f)).toEqual(["PRX-C-CONTEXT-UNVERIFIED", "PRX-C-PREFIX"]);
  });

  it("a trusted caller's verified revert classification exempts the prefix", () => {
    const msg =
      'Revert "feat(x): thing"\n\nThis reverts commit ' +
      "1".repeat(40) +
      ".\nReverted because the deploy broke.\n";
    expect(checkCommit(msg, { verifiedRevert: true })).toEqual([]);
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

describe("r2 mutation-hardening (post-rerun survivor kills)", () => {
  it("a duplicate governed pair split across block and body still counts", () => {
    // Kills the governed:false mutant on out-of-block record entries.
    const msg =
      "feat(x): s\n\nrun-id: ONE-20260812-BBBB\nprose tail line\n\n" +
      "Run-Id: ONE-20260812-AAAA\nEvidence: UNKNOWN\nCo-Authored-By: A B <a@b.co>\n";
    const f = checkCommit(msg, {});
    expect(
      f.some(
        x => x.rule === "PRX-C-TRAILER" && x.message.includes("appears 2 times")
      )
    ).toBe(true);
  });

  it("out-of-block trailer values are trimmed before grammar checks", () => {
    const msg =
      "feat(x): s\n\nCo-Authored-By: A B <a@b.co>   \nprose tail line\n\n" +
      "Final ordinary paragraph.\n";
    const f = checkCommit(msg, {});
    const trailer = f.filter(x => x.rule === "PRX-C-TRAILER");
    // Placement error only — the trimmed value satisfies the grammar.
    expect(trailer.length).toBe(1);
    expect(trailer[0].message).toContain("outside the formal trailer block");
  });

  it("an out-of-block governed trailer with an empty value reports it", () => {
    const msg = "feat(x): s\n\nRun-Id:\nprose tail line\n\nFinal paragraph.\n";
    const f = checkCommit(msg, {});
    expect(
      f.some(
        x => x.rule === "PRX-C-TRAILER" && x.message.includes("empty value")
      )
    ).toBe(true);
  });

  it("duplicate UNGOVERNED trailer keys draw no governed-count finding", () => {
    const msg =
      "feat(x): s\n\nWhy.\n\nAcked-by: one\nAcked-by: two\n" +
      "Run-Id: ONE-20260812-PRX\nEvidence: UNKNOWN\nCo-Authored-By: A B <a@b.co>\n";
    const f = checkCommit(msg, {});
    expect(f.filter(x => x.rule === "PRX-C-TRAILER")).toEqual([]);
  });

  it("control findings name the offending code points and context", () => {
    const msg =
      "feat(x): s\n\nprose with an \u001B escape\n\n```\na\u0000b\n```\n";
    const f = checkCommit(msg, {});
    const controls = f.filter(x => x.rule === "PRX-C-CONTROL");
    expect(controls.length).toBe(2);
    expect(
      controls.some(
        x => x.message.includes("U+001B") && x.message.includes("body text")
      )
    ).toBe(true);
    expect(
      controls.some(
        x => x.message.includes("U+0000") && x.message.includes("code content")
      )
    ).toBe(true);
  });

  it("subject control findings name the code points", () => {
    const f = checkCommit("feat(x): has\ttab here\n", {});
    const subj = f.filter(x => x.rule === "PRX-C-SUBJECT");
    expect(subj.length).toBe(1);
    expect(subj[0].message).toContain("U+0009");
  });

  it("the context advisory names each unverified claim", () => {
    const revert = checkCommit(
      'Revert "feat(x): thing"\n\nThis reverts commit ' +
        "1".repeat(40) +
        ".\n",
      {}
    );
    const ra = revert.find(x => x.rule === "PRX-C-CONTEXT-UNVERIFIED");
    expect(ra?.message).toContain("revert-shaped");
    const bot = checkCommit("Bump lodash from 1 to 2\n", { claimedBot: true });
    const ba = bot.find(x => x.rule === "PRX-C-CONTEXT-UNVERIFIED");
    expect(ba?.message).toContain("claim a bot identity");
    const both = checkCommit(
      'Revert "feat(x): thing"\n\nThis reverts commit ' +
        "1".repeat(40) +
        ".\n",
      { claimedBot: true }
    );
    const bm = both.find(x => x.rule === "PRX-C-CONTEXT-UNVERIFIED");
    expect(bm?.message).toContain("revert-shaped");
    expect(bm?.message).toContain("claim a bot identity");
  });
});

describe("r3 blocking-path survivors (mutation run 2 residual)", () => {
  it("a line broken by a lone CR or line separator is not a trailer", () => {
    // TRAILER_LINE_RE's trailing $ is load-bearing, contradicting the r1
    // disposition that called dropping it equivalent. That proof assumed
    // "(.*) always consumes to end-of-string", but `.` also excludes CR,
    // U+2028 and U+2029, and parseCommitMessage normalizes only CRLF — so
    // those code points survive INSIDE a body line. Without the anchor
    // such a line parses as a trailer, which flips the commit into
    // governed scope and invents PRX-C-GOV findings.
    for (const sep of ["\r", "\u2028", "\u2029"]) {
      const msg = `feat(x): s\n\nRun-Id: ONE-20260812-AAAA${sep}tail\n`;
      const parsed = parseCommitMessage(msg);
      expect(parsed.trailers).toBeNull();
      expect(parsed.trailerRecord).toEqual([]);
      expect(rules(checkCommit(msg, {}))).toEqual(["PRX-C-CONTROL"]);
    }
  });

  it("the control policy treats fenced content as code, prose as text", () => {
    // CODE_KINDS must contain "fence-content": without it a fenced line
    // is scanned under the body-text policy and an ESC inside a code
    // block raises PRX-C-CONTROL, which is APPROVED_BLOCKING.
    const fenced = "feat(x): s\n\n```\nab\u001b\n```\n\nTail paragraph.\n";
    expect(checkCommit(fenced, {})).toEqual([]);
    // Positive control: the same byte in ordinary prose still fires, so
    // the assertion above cannot pass by the scan being switched off.
    const prose = "feat(x): s\n\nprose\u001bhere.\n";
    expect(rules(checkCommit(prose, {}))).toEqual(["PRX-C-CONTROL"]);
  });
});

describe("r3 classifier consequences on the control policy", () => {
  // The line classifier decides which control policy applies. Each of
  // these inputs is ordinary indented code carrying a BEL, which the code
  // policy tolerates; a classifier mutant that demotes the line to text
  // makes PRX-C-CONTROL (APPROVED_BLOCKING) fire on all three.
  const BEL = String.fromCharCode(7);

  it("indented code after a tab-stop indent is code", () => {
    expect(checkCommit(`feat(x): y\n\n \t${BEL}oops\n`, {})).toEqual([]);
  });

  it("indented code after a whitespace-only line is code", () => {
    expect(
      checkCommit(`feat(x): y\n\nintro\n   \n    ${BEL}code\n`, {})
    ).toEqual([]);
  });

  it("indented code after a closed fence is code", () => {
    expect(
      checkCommit(`feat(x): y\n\n\`\`\`\nc\n\`\`\`\n    ${BEL}code\n`, {})
    ).toEqual([]);
  });
});
