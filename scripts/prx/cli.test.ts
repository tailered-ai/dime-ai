// CLI wrapper behavior: import safety, exit-code contract, range mode with
// real git topology (merge exemption from parent count, never the subject).
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const COMMIT_CLI = join(HERE, "check-commit.mjs");
const BODY_CLI = join(HERE, "check-body.mjs");

function runCli(cli: string, args: string[], input?: string) {
  const res = spawnSync(process.execPath, [cli, ...args], {
    input,
    encoding: "utf8",
  });
  return { code: res.status, stdout: res.stdout, stderr: res.stderr };
}

describe("import safety (SOL-PRX-008)", () => {
  it("importing the CLI modules executes nothing", async () => {
    const commit = await import("./check-commit.mjs");
    const body = await import("./check-body.mjs");
    expect(typeof commit.main).toBe("function");
    expect(typeof body.main).toBe("function");
    // If a module-entry guard ever fires on import, it sets
    // process.exitCode via main() — that side effect must not exist.
    expect(process.exitCode ?? 0).toBe(0);
  });
});

describe("exit-code contract", () => {
  const broken = "Add policy gate\n\n\nTwo blanks above.\n";

  it("audit mode reports but exits 0", () => {
    const r = runCli(COMMIT_CLI, ["-", "--mode=audit"], broken);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("PRX-C-SEPARATOR");
  });

  it("advisory mode exits 0", () => {
    const r = runCli(COMMIT_CLI, ["-", "--mode=advisory"], broken);
    expect(r.code).toBe(0);
  });

  it("enforcing mode exits 1 on deterministic findings", () => {
    const r = runCli(COMMIT_CLI, ["-", "--mode=enforcing"], broken);
    expect(r.code).toBe(1);
  });

  it("enforcing mode exits 0 when only advisory findings exist", () => {
    const long = `feat(x): ${"a".repeat(80)}\n`;
    const r = runCli(COMMIT_CLI, ["-", "--mode=enforcing"], long);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("PRX-C-LENGTH");
  });

  it("usage errors exit 2", () => {
    expect(runCli(COMMIT_CLI, []).code).toBe(2);
    expect(runCli(BODY_CLI, []).code).toBe(2);
    expect(runCli(COMMIT_CLI, ["-", "--range", "junk"], "x\n").code).toBe(2);
  });

  it("body CLI emits JSON with a verdict", () => {
    const r = runCli(BODY_CLI, ["-", "--mode=audit", "--json"], "hello\n");
    const parsed = JSON.parse(r.stdout);
    expect(parsed.verdict.mode).toBe("audit");
    expect(Array.isArray(parsed.findings)).toBe(true);
    // stdin must arrive as a STRING: a Buffer would trip the size/type
    // guard and report PRX-B-SIZE instead of the real section findings.
    expect(
      parsed.findings.some(
        (f: { rule: string }) => f.rule === "PRX-B-SECTION-MISSING"
      )
    ).toBe(true);
    expect(
      parsed.findings.some((f: { rule: string }) => f.rule === "PRX-B-SIZE")
    ).toBe(false);
  });
});

describe("range mode with real topology", () => {
  const repo = mkdtempSync(join(tmpdir(), "prx-range-"));
  afterAll(() => rmSync(repo, { recursive: true, force: true }));

  const git = (...args: string[]) =>
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

  it("exempts merges by parent count and judges ordinary commits", () => {
    git("init", "-b", "main");
    writeFileSync(join(repo, "a.txt"), "a\n");
    git("add", ".");
    git("commit", "-m", "feat(x): base commit");
    const base = git("rev-parse", "HEAD").trim();
    git("checkout", "-b", "side");
    writeFileSync(join(repo, "b.txt"), "b\n");
    git("add", ".");
    git("commit", "-m", "Bad subject without prefix");
    git("checkout", "main");
    writeFileSync(join(repo, "c.txt"), "c\n");
    git("add", ".");
    git("commit", "-m", "feat(x): mainline work");
    git("merge", "--no-ff", "side", "-m", "Merge branch 'side'");
    const head = git("rev-parse", "HEAD").trim();

    const r = runCli(COMMIT_CLI, [
      "--range",
      `${base}..${head}`,
      "--repo",
      repo,
      "--mode=enforcing",
      "--json",
    ]);
    const parsed = JSON.parse(r.stdout);
    const byId = Object.fromEntries(
      parsed.results.map((x: { id: string; findings: unknown[] }) => [
        x.id,
        x.findings,
      ])
    );
    const mergeSha = head.slice(0, 7);
    expect(byId[mergeSha]).toEqual([]);
    const flat = parsed.results.flatMap(
      (x: { findings: { rule: string }[] }) => x.findings
    );
    expect(flat.some((f: { rule: string }) => f.rule === "PRX-C-PREFIX")).toBe(
      true
    );
    expect(r.code).toBe(1);
  });
});

describe("RS-byte truncation regression (review finding, high)", () => {
  const repo = mkdtempSync(join(tmpdir(), "prx-rs-"));
  afterAll(() => rmSync(repo, { recursive: true, force: true }));
  const git = (...args: string[]) =>
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

  it("a 0x1e byte in a message hides nothing from the audit", async () => {
    git("init", "-b", "main");
    writeFileSync(join(repo, "a.txt"), "a\n");
    git("add", ".");
    git("commit", "-m", "feat(x): base");
    const base = git("rev-parse", "HEAD").trim();
    writeFileSync(join(repo, "b.txt"), "b\n");
    git("add", ".");
    const msg = join(repo, ".msg");
    writeFileSync(
      msg,
      "feat(x): visible subject\n\nvisible body.\n\x1ehidden after RS\n\n```\nunclosed fence hidden here\n"
    );
    git("commit", "-F", ".msg");
    const head = git("rev-parse", "HEAD").trim();

    const { listCommits } = await import("./check-commit.mjs");
    const { checkCommit } = await import("./commit-check.mjs");
    const commits = listCommits(repo, `${base}..${head}`);
    expect(commits.length).toBe(1);
    expect(commits[0].message).toContain("hidden after RS");
    expect(commits[0].message).toContain("unclosed fence hidden here");
    const findings = checkCommit(commits[0].message, {});
    expect(findings.some(f => f.rule === "PRX-C-FENCE")).toBe(true);
  });
});

// In-process main() coverage (R8): the CLI wrappers joined the focused
// mutation scope, and Stryker cannot activate mutants across a process
// boundary — the subprocess tests above pin the real artifact, while
// these direct calls give the mutation run visibility into the same
// wrapper logic (arg parsing, mode resolution, verdict wiring, output).
import {
  main as commitMain,
  listCommits as listCommitsFn,
} from "./check-commit.mjs";
import { main as bodyMain } from "./check-body.mjs";
import {
  mkdtempSync as mkdtemp2,
  rmSync as rm2,
  readFileSync as read2,
} from "node:fs";
import { vi } from "vitest";

function runInProcess(fn: (argv: string[]) => number, argv: string[]) {
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
    const code = fn(argv);
    return { code, stdout: out.join(""), stderr: err.join("") };
  } finally {
    outSpy.mockRestore();
    errSpy.mockRestore();
  }
}

describe("check-commit main() in-process (R8)", () => {
  const HEALTHY = join(HERE, "fixtures/commit/healthy-basic.txt");
  const GOVERNED = join(HERE, "fixtures/commit/healthy-governed.txt");
  const C08 = join(
    HERE,
    "../../docs/verification/prx/adversarial-fixtures/commit/C08.txt"
  );

  it("healthy file exits 0 in enforcing mode", () => {
    const r = runInProcess(commitMain, [HEALTHY, "--mode=enforcing"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("PRX commit gate: 0 error(s)");
  });

  it("C08 exits 1 enforcing with the separator finding, 0 in audit", () => {
    const enforcing = runInProcess(commitMain, [C08, "--mode=enforcing"]);
    expect(enforcing.code).toBe(1);
    expect(enforcing.stdout).toContain("PRX-C-SEPARATOR");
    const audit = runInProcess(commitMain, [C08, "--mode=audit"]);
    expect(audit.code).toBe(0);
  });

  it("the committed default mode (audit) applies when --mode is absent", () => {
    const r = runInProcess(commitMain, [C08]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("mode=audit");
  });

  it("--governed engages the governed schema on a governed fixture", () => {
    const r = runInProcess(commitMain, [
      GOVERNED,
      "--governed",
      "--mode=enforcing",
    ]);
    expect(r.code).toBe(0);
  });

  it("usage and argument errors exit 2", () => {
    expect(runInProcess(commitMain, []).code).toBe(2);
    expect(runInProcess(commitMain, [HEALTHY, "extra"]).code).toBe(2);
    const bad = runInProcess(commitMain, ["--range", "junk"]);
    expect(bad.code).toBe(2);
    expect(bad.stderr).toContain("--range requires");
  });

  it("range mode emits JSON with the governed-scope note (R3)", () => {
    const repo2 = mkdtemp2(join(tmpdir(), "prx-inproc-"));
    try {
      const g = (...args: string[]) =>
        execFileSync("git", ["-C", repo2, ...args], {
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
      writeFileSync(join(repo2, "a.txt"), "a\n");
      g("add", ".");
      g("commit", "-m", "feat(x): base");
      const base = g("rev-parse", "HEAD").trim();
      writeFileSync(join(repo2, "b.txt"), "b\n");
      g("add", ".");
      g("commit", "-m", "no prefix here");
      const head = g("rev-parse", "HEAD").trim();
      const r = runInProcess(commitMain, [
        "--range",
        `${base}..${head}`,
        "--repo",
        repo2,
        "--mode=enforcing",
        "--json",
      ]);
      expect(r.code).toBe(1);
      const parsed = JSON.parse(r.stdout);
      expect(parsed.governedScope).toContain("opt-in");
      expect(
        parsed.results.some((x: { findings: { rule: string }[] }) =>
          x.findings.some(f => f.rule === "PRX-C-PREFIX")
        )
      ).toBe(true);
      const plain = runInProcess(commitMain, [
        "--range",
        `${base}..${head}`,
        "--repo",
        repo2,
        "--mode=audit",
      ]);
      expect(plain.code).toBe(0);
      expect(plain.stdout).toContain("note: governed scope is opt-in");
    } finally {
      rm2(repo2, { recursive: true, force: true });
    }
  });
});

describe("check-body main() in-process (R8)", () => {
  const HEALTHY_BODY = join(HERE, "fixtures/body/healthy.md");
  const B03 = join(
    HERE,
    "../../docs/verification/prx/adversarial-fixtures/body/B03.md"
  );

  it("healthy body exits 0 enforcing; B03 exits 1 enforcing and 0 audit", () => {
    expect(
      runInProcess(bodyMain, [HEALTHY_BODY, "--mode=enforcing"]).code
    ).toBe(0);
    const broken = runInProcess(bodyMain, [B03, "--mode=enforcing"]);
    expect(broken.code).toBe(1);
    expect(broken.stdout).toContain("PRX-B-SECTION-EMPTY");
    expect(runInProcess(bodyMain, [B03, "--mode=audit"]).code).toBe(0);
  });

  it("--json carries the verdict and --extract-prose writes the prose file", () => {
    const dir = mkdtemp2(join(tmpdir(), "prx-prose-"));
    try {
      const prosePath = join(dir, "prose.md");
      const r = runInProcess(bodyMain, [
        HEALTHY_BODY,
        "--mode=audit",
        "--json",
        "--extract-prose",
        prosePath,
      ]);
      expect(r.code).toBe(0);
      const parsed = JSON.parse(r.stdout);
      expect(parsed.verdict.mode).toBe("audit");
      expect(read2(prosePath, "utf8").length).toBeGreaterThan(0);
    } finally {
      rm2(dir, { recursive: true, force: true });
    }
  });

  it("usage errors exit 2", () => {
    expect(runInProcess(bodyMain, []).code).toBe(2);
    expect(runInProcess(bodyMain, [HEALTHY_BODY, "extra"]).code).toBe(2);
  });
});

describe("wrapper output contracts (R8 wrapper hardening)", () => {
  const HEALTHY_C = join(HERE, "fixtures/commit/healthy-basic.txt");
  const C08 = join(
    HERE,
    "../../docs/verification/prx/adversarial-fixtures/commit/C08.txt"
  );
  const HEALTHY_B = join(HERE, "fixtures/body/healthy.md");
  const B03 = join(
    HERE,
    "../../docs/verification/prx/adversarial-fixtures/body/B03.md"
  );
  const B10 = join(
    HERE,
    "../../docs/verification/prx/adversarial-fixtures/body/B10.md"
  );

  it("commit findings print level, rule, label, and line exactly", () => {
    const r = runInProcess(commitMain, [C08, "--mode=enforcing"]);
    expect(r.stdout).toContain(`ERROR PRX-C-SEPARATOR [${C08}] line 2:`);
    expect(r.stdout).not.toContain("undefined");
    expect(r.stdout).not.toContain("Stryker");
  });

  it("commit summary counts errors and advisories exactly", () => {
    const c08 = runInProcess(commitMain, [C08, "--mode=enforcing"]);
    expect(c08.stdout).toContain(
      "PRX commit gate: 2 error(s), 0 advisory; mode=enforcing; exit=1"
    );
    const dir = mkdtemp2(join(tmpdir(), "prx-msg-"));
    try {
      const longSubject = join(dir, "long.txt");
      writeFileSync(longSubject, `feat(x): ${"a".repeat(80)}\n`);
      const adv = runInProcess(commitMain, [longSubject, "--mode=enforcing"]);
      expect(adv.stdout).toContain(
        "PRX commit gate: 0 error(s), 1 advisory; mode=enforcing; exit=0"
      );
    } finally {
      rm2(dir, { recursive: true, force: true });
    }
  });

  it("lineless governed findings never print a line suffix", () => {
    const r = runInProcess(commitMain, [
      HEALTHY_C,
      "--governed",
      "--mode=enforcing",
    ]);
    // healthy-basic carries only Co-Authored-By: governed scope demands
    // Run-Id and Evidence (2 lineless errors).
    expect(r.code).toBe(1);
    expect(r.stdout).toContain(
      "PRX commit gate: 2 error(s), 0 advisory; mode=enforcing; exit=1"
    );
    expect(r.stdout).not.toContain("undefined");
    expect(r.stdout).not.toContain("Stryker");
  });

  it("--merge and --bot exemptions work through the CLI flags", () => {
    const dir = mkdtemp2(join(tmpdir(), "prx-flags-"));
    try {
      const mergeMsg = join(dir, "merge.txt");
      writeFileSync(mergeMsg, "Merge branch 'side' into main\n");
      expect(
        runInProcess(commitMain, [mergeMsg, "--mode=enforcing"]).code
      ).toBe(1);
      expect(
        runInProcess(commitMain, [mergeMsg, "--merge", "--mode=enforcing"]).code
      ).toBe(0);
      const botMsg = join(dir, "bot.txt");
      writeFileSync(botMsg, "Bump lodash from 1 to 2\n");
      expect(runInProcess(commitMain, [botMsg, "--mode=enforcing"]).code).toBe(
        1
      );
      expect(
        runInProcess(commitMain, [botMsg, "--bot", "--mode=enforcing"]).code
      ).toBe(0);
    } finally {
      rm2(dir, { recursive: true, force: true });
    }
  });

  it("non-range JSON output has results+verdict and no governedScope", () => {
    const r = runInProcess(commitMain, [HEALTHY_C, "--json", "--mode=audit"]);
    expect(r.code).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(Array.isArray(parsed.results)).toBe(true);
    expect(parsed.verdict.mode).toBe("audit");
    expect(parsed).not.toHaveProperty("governedScope");
  });

  it("plain non-range output has no governed note; range note is complete", () => {
    const plain = runInProcess(commitMain, [HEALTHY_C, "--mode=audit"]);
    expect(plain.stdout).not.toContain("note: governed scope");

    const repo3 = mkdtemp2(join(tmpdir(), "prx-note-"));
    try {
      const g = (...args: string[]) =>
        execFileSync("git", ["-C", repo3, ...args], {
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
      writeFileSync(join(repo3, "a.txt"), "a\n");
      g("add", ".");
      g("commit", "-m", "feat(x): base");
      const base = g("rev-parse", "HEAD").trim();
      // A bot-authored non-conforming commit: exempt through the author
      // metadata that listCommits derives (suppression-only).
      writeFileSync(join(repo3, "b.txt"), "b\n");
      g("add", ".");
      // The author env must carry the bot identity (env beats -c config).
      execFileSync(
        "git",
        ["-C", repo3, "commit", "-m", "Bump lodash from 1 to 2"],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            GIT_AUTHOR_NAME: "dependabot[bot]",
            GIT_AUTHOR_EMAIL:
              "49699333+dependabot[bot]@users.noreply.github.com",
            GIT_COMMITTER_NAME: "GitHub",
            GIT_COMMITTER_EMAIL: "noreply@github.com",
          },
        }
      );
      // A merge commit: exempt through topology.
      g("checkout", "-b", "side", base);
      writeFileSync(join(repo3, "c.txt"), "c\n");
      g("add", ".");
      g("commit", "-m", "feat(x): side work");
      g("checkout", "main");
      g("merge", "--no-ff", "side", "-m", "Merge branch 'side'");
      const head = g("rev-parse", "HEAD").trim();

      const r = runInProcess(commitMain, [
        "--range",
        `${base}..${head}`,
        "--repo",
        repo3,
        "--mode=enforcing",
        "--json",
      ]);
      const parsed = JSON.parse(r.stdout);
      // The merge exemption holds via topology (parent count). The bot
      // CLAIM in the author fields earns no exemption (r2 BYP-C-05): the
      // bot-authored commit takes the ordinary prefix error plus the
      // PRX-C-CONTEXT-UNVERIFIED advisory, so enforcing mode now blocks.
      for (const res of parsed.results) {
        expect(res.id).toHaveLength(7);
      }
      const flagged = parsed.results.filter(
        (res: { findings: { rule: string }[] }) => res.findings.length > 0
      );
      expect(flagged.length).toBe(1);
      expect(
        flagged[0].findings.map((f: { rule: string }) => f.rule).sort()
      ).toEqual(["PRX-C-CONTEXT-UNVERIFIED", "PRX-C-PREFIX"]);
      expect(r.code).toBe(1);

      const plainRange = runInProcess(commitMain, [
        "--range",
        `${base}..${head}`,
        "--repo",
        repo3,
        "--mode=audit",
      ]);
      expect(plainRange.stdout).toContain("note: governed scope is opt-in");
      expect(plainRange.stdout).toContain(
        "does not classify commits as governed"
      );
    } finally {
      rm2(repo3, { recursive: true, force: true });
    }
  });

  it("range grammar rejections name the flag; anchors are enforced", () => {
    for (const bad of ["junk", "zz1..2", "1..2zz"]) {
      const r = runInProcess(commitMain, ["--range", bad]);
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("--range requires");
    }
  });

  it("usage and error paths name themselves on stderr", () => {
    const usage = runInProcess(commitMain, []);
    expect(usage.stderr).toContain("usage: check-commit.mjs");
    expect(usage.stderr).toContain("--range <base>..<head>");
    const extra = runInProcess(commitMain, [HEALTHY_C, "extra"]);
    expect(extra.stderr).toContain("unexpected argument: extra");
    const missing = runInProcess(commitMain, ["/nonexistent/prx-missing.txt"]);
    expect(missing.code).toBe(2);
    expect(missing.stderr).toContain("prx/check-commit:");

    const busage = runInProcess(bodyMain, []);
    expect(busage.stderr).toContain("usage: check-body.mjs");
    expect(busage.stderr).toContain("--extract-prose");
    const bextra = runInProcess(bodyMain, [HEALTHY_B, "extra"]);
    expect(bextra.stderr).toContain("unexpected argument: extra");
    const bmissing = runInProcess(bodyMain, ["/nonexistent/prx-missing.md"]);
    expect(bmissing.code).toBe(2);
    expect(bmissing.stderr).toContain("prx/check-body:");
  });

  it("body defaults to the committed audit mode when --mode is absent", () => {
    const r = runInProcess(bodyMain, [B03]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("mode=audit");
  });

  it("body plain output prints level/rule/line and the exact summary", () => {
    const r = runInProcess(bodyMain, [B03, "--mode=enforcing"]);
    expect(r.stdout).toContain("ERROR PRX-B-SECTION-EMPTY");
    expect(r.stdout).toContain(" line ");
    expect(r.stdout).toContain(
      "PRX body gate: 14 error(s), 0 advisory; mode=enforcing; exit=1"
    );
    const healthy = runInProcess(bodyMain, [HEALTHY_B, "--mode=audit"]);
    expect(healthy.stdout).toContain(
      "PRX body gate: 0 error(s), 0 advisory; mode=audit; exit=0"
    );
    const b10 = runInProcess(bodyMain, [B10, "--mode=audit"]);
    expect(b10.stdout).not.toContain("undefined");
    expect(b10.stdout).not.toContain("Stryker");
  });
});

describe("wrapper survivors round 2 (R8)", () => {
  it("body summary separates error and advisory counts (B04: 1 + 1)", () => {
    const B04 = join(
      HERE,
      "../../docs/verification/prx/adversarial-fixtures/body/B04.md"
    );
    const r = runInProcess(bodyMain, [B04, "--mode=enforcing"]);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain(
      "PRX body gate: 1 error(s), 1 advisory; mode=enforcing; exit=1"
    );
  });

  it("an empty-message commit is a 5-field record, not a malformed stream", async () => {
    // git log -z --format=%H%n%P%n%an%n%ae%n%B yields EXACTLY five fields
    // when %B is empty — the malformed-record guard must not fire on it.
    const repo4 = mkdtemp2(join(tmpdir(), "prx-empty-"));
    try {
      const g = (...args: string[]) =>
        execFileSync("git", ["-C", repo4, ...args], {
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
      writeFileSync(join(repo4, "a.txt"), "a\n");
      g("add", ".");
      g("commit", "-m", "feat(x): base");
      const base = g("rev-parse", "HEAD").trim();
      writeFileSync(join(repo4, "b.txt"), "b\n");
      g("add", ".");
      g("commit", "--allow-empty-message", "-m", "");
      const head = g("rev-parse", "HEAD").trim();
      const { listCommits } = await import("./check-commit.mjs");
      const commits = listCommits(repo4, `${base}..${head}`);
      expect(commits.length).toBe(1);
      expect(commits[0].message).toBe("");
    } finally {
      rm2(repo4, { recursive: true, force: true });
    }
  });
});

describe("r3 blocking-path survivors (mutation run 2 residual)", () => {
  const repo5 = mkdtemp2(join(tmpdir(), "prx-r3-"));
  afterAll(() => rm2(repo5, { recursive: true, force: true }));
  const g5 = (...args: string[]) =>
    execFileSync("git", ["-C", repo5, ...args], {
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "T",
        GIT_AUTHOR_EMAIL: "t@example.com",
        GIT_COMMITTER_NAME: "T",
        GIT_COMMITTER_EMAIL: "t@example.com",
      },
    });

  it("listCommits fails closed on a range that rewrites the log format", () => {
    // The malformed-record guard is reachable through the ARGUMENT
    // channel, not only the commit-object channel the r1 disposition
    // considered: `range` is passed straight to `git log`, so a caller
    // supplying a --format/--pretty argument overrides the record shape.
    // The guard must refuse the stream rather than audit bogus records —
    // without it the checker reports PRX-C-SUBJECT and PRX-C-PREFIX
    // errors for commits that were never parsed.
    g5("init", "-b", "main");
    writeFileSync(join(repo5, "a.txt"), "a\n");
    g5("add", ".");
    g5("commit", "-m", "feat(x): base");
    expect(() => listCommitsFn(repo5, "--format=%H%n%P")).toThrow(
      /malformed git log record \(2 fields\)/
    );
    expect(() => listCommitsFn(repo5, "--pretty=%s")).toThrow(
      /malformed git log record \(1 fields\)/
    );
  });

  it("--verified-revert actually grants the trusted-caller exemption", () => {
    // The flag is r2 code with no in-process coverage: three mutants on
    // its parsing branch survived run 2, and each silently drops the
    // exemption so a verified revert gains an APPROVED_BLOCKING
    // PRX-C-PREFIX finding.
    const revert = join(repo5, "revert.txt");
    writeFileSync(
      revert,
      'Revert "feat(x): thing"\n\nThis reverts commit abcdef1234567.\n'
    );
    const r = runInProcess(commitMain, [
      revert,
      "--verified-revert",
      "--mode=enforcing",
    ]);
    expect(r.code).toBe(0);
    expect(r.stderr).toBe("");
    expect(r.stdout).not.toContain("PRX-C-PREFIX");
    expect(r.stdout).toContain("PRX commit gate: 0 error(s), 0 advisory");
    // Positive control: without the flag the same message is rejected,
    // so the assertions above cannot pass by the message being clean.
    const bare = runInProcess(commitMain, [revert, "--mode=enforcing"]);
    expect(bare.code).toBe(1);
    expect(bare.stdout).toContain("PRX-C-PREFIX");
  });
});
