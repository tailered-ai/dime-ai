// Remediation R2: merge-base resolution FAILS CLOSED. Every failure mode is
// a hard error; the resolver never substitutes another range. These tests
// exercise the exact module the workflow executes.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { main, resolveAuditRange } from "./resolve-range.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, "resolve-range.mjs");
const MISSING_SHA = "0123456789abcdef0123456789abcdef01234567";

function makeGit(repo: string) {
  return (...args: string[]) =>
    execFileSync("git", ["-C", repo, ...args], {
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "T",
        GIT_AUTHOR_EMAIL: "t@example.com",
        GIT_COMMITTER_NAME: "T",
        GIT_COMMITTER_EMAIL: "t@example.com",
      },
    });
}

describe("resolveAuditRange fails closed (R2)", () => {
  const repo = mkdtempSync(join(tmpdir(), "prx-mb-"));
  const git = makeGit(repo);
  let root = "";
  let mainTip = "";
  let featureTip = "";
  let queueTip = "";
  let orphanTip = "";

  beforeAll(() => {
    git("init", "-b", "main");
    writeFileSync(join(repo, "a.txt"), "a\n");
    git("add", ".");
    git("commit", "-m", "feat(x): root");
    root = git("rev-parse", "HEAD").trim();
    git("checkout", "-b", "feature");
    writeFileSync(join(repo, "b.txt"), "b\n");
    git("add", ".");
    git("commit", "-m", "feat(x): feature work");
    featureTip = git("rev-parse", "HEAD").trim();
    git("checkout", "main");
    writeFileSync(join(repo, "c.txt"), "c\n");
    git("add", ".");
    git("commit", "-m", "feat(x): mainline advance");
    mainTip = git("rev-parse", "HEAD").trim();
    // merge-group topology: the queue commit merges the PR head onto the
    // advanced protected branch tip, exactly as GitHub's merge queue does.
    git("merge", "--no-ff", "feature", "-m", "queue merge");
    queueTip = git("rev-parse", "HEAD").trim();
    git("checkout", "main");
    // Unrelated history: an orphan root shares no commits with main.
    git("checkout", "--orphan", "orphan");
    git("rm", "-rf", ".");
    writeFileSync(join(repo, "z.txt"), "z\n");
    git("add", ".");
    git("commit", "-m", "feat(x): unrelated root");
    orphanTip = git("rev-parse", "HEAD").trim();
    git("checkout", "main");
  });

  afterAll(() => rmSync(repo, { recursive: true, force: true }));

  it("resolves an ordinary PR topology (base advanced past the fork point)", () => {
    const r = resolveAuditRange(repo, mainTip, featureTip);
    expect(r.mergeBase).toBe(root);
    expect(r.range).toBe(`${root}..${featureTip}`);
  });

  it("resolves a merge-group topology (queue commit on the branch tip)", () => {
    const r = resolveAuditRange(repo, mainTip, queueTip);
    expect(r.mergeBase).toBe(mainTip);
  });

  it("throws when the base commit does not exist", () => {
    expect(() => resolveAuditRange(repo, MISSING_SHA, featureTip)).toThrow(
      /base commit .* does not exist/
    );
  });

  it("throws when the head commit does not exist", () => {
    expect(() => resolveAuditRange(repo, mainTip, MISSING_SHA)).toThrow(
      /head commit .* does not exist/
    );
  });

  it("throws on unrelated histories instead of substituting a range", () => {
    expect(() => resolveAuditRange(repo, mainTip, orphanTip)).toThrow(
      /unable to resolve the merge base/
    );
  });

  it("rejects event SHAs that are not full 40-hex commit ids", () => {
    // Names ("main", a short SHA) that git WOULD resolve must still be
    // rejected up front — only full 40-hex event SHAs are acceptable, and
    // the error names which side failed.
    expect(() => resolveAuditRange(repo, "main", featureTip)).toThrow(
      /base SHA .* is not a full 40-hex commit SHA/
    );
    expect(() =>
      resolveAuditRange(repo, mainTip, featureTip.slice(0, 7))
    ).toThrow(/head SHA .* is not a full 40-hex commit SHA/);
    expect(() =>
      resolveAuditRange(repo, 12345 as unknown as string, featureTip)
    ).toThrow(/base SHA .* is not a full 40-hex commit SHA/);
    // The TYPE guard must act even when the value coerces to a 40-hex
    // string (an array wrapping a valid SHA): the regex alone would pass
    // it through to git with a non-string argument.
    expect(() =>
      resolveAuditRange(repo, [mainTip] as unknown as string, featureTip)
    ).toThrow(/base SHA .* is not a full 40-hex commit SHA/);
  });

  it("rejects malformed merge-base output (injected git runner)", () => {
    const fake = (_dir: string, args: string[]) =>
      args[0] === "merge-base" ? "not-a-sha\n" : "";
    expect(() =>
      resolveAuditRange(repo, mainTip, featureTip, { git: fake })
    ).toThrow(/merge-base output .* is not a full 40-hex commit SHA/);
  });

  it("rejects a merge base that is not an ancestor of head (injected)", () => {
    const fake = (_dir: string, args: string[]) => {
      if (args[0] === "merge-base" && args[1] === "--is-ancestor") {
        throw new Error("exit 1");
      }
      if (args[0] === "merge-base") return `${orphanTip}\n`;
      return "";
    };
    expect(() =>
      resolveAuditRange(repo, mainTip, featureTip, { git: fake })
    ).toThrow(/is not an ancestor of head/);
  });

  it("CLI prints only the merge base on success and exits 0", () => {
    const r = spawnSync(
      process.execPath,
      [CLI, "--repo", repo, "--base", mainTip, "--head", featureTip],
      { encoding: "utf8" }
    );
    expect(r.status).toBe(0);
    expect(r.stdout).toBe(`${root}\n`);
  });

  it("CLI exits 1 with a red failure on a missing commit", () => {
    const r = spawnSync(
      process.execPath,
      [CLI, "--repo", repo, "--base", MISSING_SHA, "--head", featureTip],
      { encoding: "utf8" }
    );
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("does not exist");
    expect(r.stdout).toBe("");
  });

  it("CLI exits 2 on usage errors", () => {
    const r = spawnSync(process.execPath, [CLI, "--repo", repo], {
      encoding: "utf8",
    });
    expect(r.status).toBe(2);
  });

  it("importing the CLI module executes nothing", async () => {
    const mod = await import("./resolve-range.mjs");
    expect(typeof mod.main).toBe("function");
    // If the module-entry guard ever fires on import, it sets
    // process.exitCode via main() — that side effect must not exist.
    expect(process.exitCode ?? 0).toBe(0);
  });

  // In-process main() coverage (R8): Stryker cannot activate mutants
  // across a process boundary, so the subprocess CLI tests above prove
  // the real artifact while these direct calls give the mutation run
  // visibility into the same wrapper logic.
  describe("main() called in-process", () => {
    function run(argv: string[]) {
      const out: string[] = [];
      const err: string[] = [];
      const outSpy = vi
        .spyOn(process.stdout, "write")
        .mockImplementation((s: string | Uint8Array) => {
          out.push(String(s));
          return true;
        });
      const errSpy = vi
        .spyOn(process.stderr, "write")
        .mockImplementation((s: string | Uint8Array) => {
          err.push(String(s));
          return true;
        });
      try {
        const code = main(argv);
        return { code, stdout: out.join(""), stderr: err.join("") };
      } finally {
        outSpy.mockRestore();
        errSpy.mockRestore();
      }
    }

    it("success prints exactly the merge base and returns 0", () => {
      const r = run(["--repo", repo, "--base", mainTip, "--head", featureTip]);
      expect(r.code).toBe(0);
      expect(r.stdout).toBe(`${root}\n`);
      expect(r.stderr).toBe("");
    });

    it("resolution failure returns 1 with the named error prefix", () => {
      const r = run([
        "--repo",
        repo,
        "--base",
        MISSING_SHA,
        "--head",
        featureTip,
      ]);
      expect(r.code).toBe(1);
      expect(r.stdout).toBe("");
      expect(r.stderr).toContain("prx/resolve-range:");
      expect(r.stderr).toContain("does not exist");
    });

    it("missing arguments return 2 with usage", () => {
      // Each of --repo/--base/--head missing ALONE must hit the usage
      // guard — including base-only-missing, where a fallen-through call
      // would fail later with exit 1 instead of the usage 2.
      for (const argv of [
        [],
        ["--repo", repo],
        ["--repo", repo, "--base", mainTip],
        ["--repo", repo, "--head", featureTip],
        ["--base", mainTip, "--head", featureTip],
      ]) {
        const r = run(argv);
        expect(r.code).toBe(2);
        expect(r.stderr).toContain("usage: resolve-range.mjs");
      }
    });

    it("unexpected arguments return 2 and name the argument", () => {
      const r = run(["--bogus"]);
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("unexpected argument: --bogus");
    });
  });
});
