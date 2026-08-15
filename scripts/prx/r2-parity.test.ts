// r2 parity proofs.
//
// 1. Input-mode parity (BYP-C-07/08): the SAME commit message must produce
//    the SAME findings whether it arrives via file, stdin, or a git range —
//    the control policy and every other predicate run inside checkCommit,
//    which all three modes share; these tests pin that through the real
//    CLI surfaces.
// 2. Fence parity (BYP-C-09): equivalent fence inputs receive consistent
//    classification on both surfaces where their contracts overlap — the
//    commit checker's CommonMark-consistent line classifier agrees with
//    the pinned GFM parser (mdast) on which lines are code content.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";
import { describe, expect, it } from "vitest";
import { classifyCommitBodyLines } from "./lib/canonical.mjs";
import { main as commitMain } from "./check-commit.mjs";

function runInProcess(
  mainFn: (argv: string[]) => number,
  argv: string[],
  stdinText?: string
) {
  const outChunks: string[] = [];
  const errChunks: string[] = [];
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((chunk: string) => {
    outChunks.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string) => {
    errChunks.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  let code: number;
  const dir = mkdtempSync(join(tmpdir(), "prx-parity-stdin-"));
  try {
    let args = argv;
    if (stdinText !== undefined) {
      // The CLI reads fd 0 for "-": emulate by substituting a file path is
      // NOT allowed here (that would test file mode twice), so spawn the
      // real subprocess for stdin mode instead.
      throw new Error("use runStdin for stdin mode");
    }
    code = mainFn(args);
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
    rmSync(dir, { recursive: true, force: true });
  }
  return { code, stdout: outChunks.join(""), stderr: errChunks.join("") };
}

function runStdin(message: string, extraArgs: string[] = []) {
  const out = execFileSync(
    process.execPath,
    ["scripts/prx/check-commit.mjs", "-", "--json", ...extraArgs],
    { input: message, encoding: "utf8" }
  );
  return JSON.parse(out);
}

const ruleMultiset = (findings: { level: string; rule: string }[]) =>
  findings.map(f => `${f.level}:${f.rule}`).sort();

// A message exercising the control policy in both contexts, the wrap rule,
// and an ordinary paragraph. Built with explicit escapes; git range mode
// carries the same bytes through `git commit -F`.
const PARITY_MESSAGE =
  "feat(x): parity probe\n\n" +
  "prose line with an \u001B[31mescape\u001B[0m sequence\n\n" +
  "```\ncode line with an \u001B[31mescape\u001B[0m sequence\n```\n";

describe("input-mode parity (file, stdin, range)", () => {
  it("produces identical finding multisets in all three modes", () => {
    const dir = mkdtempSync(join(tmpdir(), "prx-parity-"));
    try {
      // File mode.
      const file = join(dir, "msg.txt");
      writeFileSync(file, PARITY_MESSAGE);
      const fileRun = runInProcess(commitMain, [file, "--json"]);
      const fileFindings = JSON.parse(fileRun.stdout).results[0].findings;

      // Stdin mode (real subprocess so fd 0 is exercised).
      const stdinFindings = runStdin(PARITY_MESSAGE).results[0].findings;

      // Range mode (real git repository, same bytes via -F).
      const g = (...args: string[]) =>
        execFileSync("git", ["-C", dir, ...args], {
          encoding: "utf8",
          env: {
            ...process.env,
            GIT_AUTHOR_NAME: "T",
            GIT_AUTHOR_EMAIL: "t@example.com",
            GIT_COMMITTER_NAME: "T",
            GIT_COMMITTER_EMAIL: "t@example.com",
          },
        });
      g("init", "-b", "main");
      writeFileSync(join(dir, "a.txt"), "a\n");
      g("add", ".");
      g("commit", "-m", "feat(x): base commit");
      const base = g("rev-parse", "HEAD").trim();
      writeFileSync(join(dir, "b.txt"), "b\n");
      g("add", ".");
      const msgFile = join(dir, "parity-msg.txt");
      writeFileSync(msgFile, PARITY_MESSAGE);
      g("commit", "-F", msgFile);
      const head = g("rev-parse", "HEAD").trim();
      const rangeRun = runInProcess(commitMain, [
        "--range",
        `${base}..${head}`,
        "--repo",
        dir,
        "--json",
      ]);
      const rangeFindings = JSON.parse(rangeRun.stdout).results[0].findings;

      expect(ruleMultiset(fileFindings)).toEqual(["error:PRX-C-CONTROL"]);
      expect(ruleMultiset(stdinFindings)).toEqual(ruleMultiset(fileFindings));
      expect(ruleMultiset(rangeFindings)).toEqual(ruleMultiset(fileFindings));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// Which body lines does the pinned GFM parser consider code content?
// Derived from the mdast `code` node positions over the body text.
function mdastCodeLines(bodyText: string): Set<number> {
  const tree = fromMarkdown(bodyText, {
    extensions: [gfm()],
    mdastExtensions: [gfmFromMarkdown()],
  });
  const lines = new Set<number>();
  for (const node of tree.children ?? []) {
    if (node.type !== "code" || !node.position) continue;
    for (
      let l = node.position.start.line;
      l <= node.position.end.line;
      l += 1
    ) {
      lines.add(l);
    }
  }
  return lines;
}

function classifierCodeLines(bodyLines: string[]): Set<number> {
  const { kinds } = classifyCommitBodyLines(bodyLines);
  const lines = new Set<number>();
  for (const [i, kind] of kinds.entries()) {
    if (
      kind === "fence-open" ||
      kind === "fence-close" ||
      kind === "fence-content" ||
      kind === "indented-code"
    ) {
      lines.add(i + 1);
    }
  }
  return lines;
}

describe("fence parity with the pinned GFM parser", () => {
  const CASES: Record<string, string[]> = {
    "closed backtick fence": ["```", "content", "```"],
    "longer closing marker": ["```", "content", "``````"],
    "shorter marker stays content": ["`````", "content", "```", "tail"],
    "marker with trailing text is content": ["```", "content", "```yy"],
    "three-space-indented fence": ["  ```", "x", "   ```"],
    "four-space marker is code, not fence": ["    ```", "    x"],
    "tilde fence with info string": ["~~~ info `tick`", "x", "~~~"],
    "backtick info with backtick is not an opener": ["``` `bad`", "text"],
    "foreign marker inside fence": ["```", "~~~", "```"],
    "indented code after blank": ["para one", "", "    code line"],
    "lazy continuation is not code": ["para one", "    still para"],
  };

  for (const [name, bodyLines] of Object.entries(CASES)) {
    it(name, () => {
      expect(classifierCodeLines(bodyLines)).toEqual(
        mdastCodeLines(bodyLines.join("\n"))
      );
    });
  }
});
