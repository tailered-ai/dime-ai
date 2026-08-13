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
