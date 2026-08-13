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
