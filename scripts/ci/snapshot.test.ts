/**
 * P01 validation suite — snapshot resolution and prospective-merge
 * materialization.
 *
 *   P01.TEST01  clean feature HEAD ahead of base
 *   P01.TEST02  HEAD identical to base
 *   P01.TEST03  snapshot schema / provenance validity + consumer independence
 *   P01.TEST04  determinism across repeats AND across wall-clock times
 *   P01.NEG01   merge conflict -> BLOCKED(MERGE_CONFLICT) with exact paths
 *   P01.NEG03   worktree creation failure -> INFRA-FAIL(WORKTREE), no orphan
 *   P01.NEG04   provenance bypass -> audit fails; control restores green
 *   P01.NEG05   every pinned metadata dimension is load-bearing
 *
 * P01.NEG02 (dirty tree) is exercised LIVE against the real repository by the
 * P01 driver, because the repository's 27 unrelated entries are the authentic
 * fixture. It is not simulated here.
 *
 * Every fixture lives in an OS temp directory. Nothing in this file touches the
 * developer's working tree.
 */
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
// @ts-expect-error — plain .mjs module without type declarations
import {
  MODES,
  SYNTHETIC_IDENTITY,
  SnapshotStop,
  buildSnapshot,
  createWorktree,
  disposeSnapshot,
  identityDigest,
  listWorktrees,
  resolveBase,
  resolveHead,
  runSnapshot,
  syntheticMergeCommit,
  syntheticMessage,
  syntheticTimestamp,
  validateSnapshot,
  workingTreeState,
  writeMergeTree,
} from "./snapshot.mjs";
// @ts-expect-error — plain .mjs module without type declarations
import {
  ALLOWLIST,
  auditConsumerIndependence,
  auditProvenance,
  invokesSubprocess,
  stripComments,
} from "./provenance-audit.mjs";

const SHA = /^[0-9a-f]{40}$/;
const temps: string[] = [];

afterAll(() => {
  while (temps.length) rmSync(temps.pop()!, { recursive: true, force: true });
});

function run(cwd: string, args: string[]) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "fixture",
      GIT_AUTHOR_EMAIL: "fixture@localhost",
      GIT_COMMITTER_NAME: "fixture",
      GIT_COMMITTER_EMAIL: "fixture@localhost",
      GIT_AUTHOR_DATE: "1700000000 +0000",
      GIT_COMMITTER_DATE: "1700000000 +0000",
    },
  }).trim();
}

/** Real clone with a real `origin/main`, so resolveBase behaves as in prod. */
function fixtureRepo() {
  const root = mkdtempSync(path.join(tmpdir(), "p01-"));
  temps.push(root);
  const upstream = path.join(root, "upstream.git");
  const work = path.join(root, "work");
  run(root, ["init", "--bare", "-b", "main", upstream]);
  run(root, ["clone", "-q", upstream, work]);
  writeFileSync(path.join(work, "base.txt"), "base\n");
  run(work, ["add", "-A"]);
  run(work, ["commit", "-q", "-m", "base commit"]);
  run(work, ["push", "-q", "origin", "main"]);
  return { root, upstream, work };
}

function commitOn(work: string, file: string, body: string, message: string) {
  writeFileSync(path.join(work, file), body);
  run(work, ["add", "-A"]);
  run(work, ["commit", "-q", "-m", message]);
  return run(work, ["rev-parse", "HEAD"]);
}

/** Synchronous sleep so TEST04 can straddle two distinct wall-clock seconds. */
function sleepSync(ms: number) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

describe("P01.TEST01 — clean feature HEAD ahead of base", () => {
  it("produces correctly related head/base/merge_tree/merge_commit and materializes the combined tree", () => {
    const { work } = fixtureRepo();
    const base_sha = run(work, ["rev-parse", "origin/main"]);
    const head_sha = commitOn(
      work,
      "feature.txt",
      "feature\n",
      "feature commit"
    );

    expect(base_sha).toMatch(SHA);
    expect(head_sha).toMatch(SHA);
    expect(head_sha).not.toBe(base_sha);

    const { merge_tree_sha } = writeMergeTree(work, base_sha, head_sha);
    expect(merge_tree_sha).toMatch(SHA);
    // Head is a descendant of base, so the merge tree IS head's tree.
    expect(merge_tree_sha).toBe(run(work, ["rev-parse", `${head_sha}^{tree}`]));

    const synthetic = syntheticMergeCommit(work, {
      base_sha,
      head_sha,
      merge_tree_sha,
    });
    expect(synthetic.merge_commit_sha).toMatch(SHA);
    expect(
      run(work, [
        "rev-list",
        "--parents",
        "-n",
        "1",
        synthetic.merge_commit_sha,
      ])
    ).toBe(`${synthetic.merge_commit_sha} ${base_sha} ${head_sha}`);
    expect(
      run(work, ["rev-parse", `${synthetic.merge_commit_sha}^{tree}`])
    ).toBe(merge_tree_sha);

    const handle = runSnapshot({
      repo: work,
      mode: "default",
      keepRunDir: true,
    });
    try {
      expect(handle.snapshot.identity.head_sha).toBe(head_sha);
      expect(handle.snapshot.identity.base_sha).toBe(base_sha);
      expect(handle.snapshot.identity.merge_tree_sha).toBe(merge_tree_sha);
      // The disposable worktree materializes the combined content.
      expect(run(handle.paths.worktree, ["rev-parse", "HEAD"])).toBe(
        handle.snapshot.identity.merge_commit_sha
      );
      expect(
        readFileSync(path.join(handle.paths.worktree, "feature.txt"), "utf8")
      ).toBe("feature\n");
    } finally {
      disposeSnapshot(handle);
    }
  });
});

describe("P01.TEST02 — HEAD identical to base", () => {
  it("yields the base tree without relying on accidental SHA assumptions", () => {
    const { work } = fixtureRepo();
    const base_sha = run(work, ["rev-parse", "origin/main"]);
    const head_sha = resolveHead(work);
    expect(head_sha).toBe(base_sha);

    const { merge_tree_sha } = writeMergeTree(work, base_sha, head_sha);
    expect(merge_tree_sha).toBe(run(work, ["rev-parse", `${base_sha}^{tree}`]));

    const synthetic = syntheticMergeCommit(work, {
      base_sha,
      head_sha,
      merge_tree_sha,
    });
    // DEF-011: git DEDUPLICATES identical parents, so the degenerate case
    // stores ONE parent even though two were declared. Asserted explicitly
    // rather than assumed — this is exactly the "accidental SHA assumption"
    // this test exists to rule out.
    expect(synthetic.parents_declared).toEqual([base_sha, head_sha]);
    expect(synthetic.parents_effective).toEqual([base_sha]);
    expect(synthetic.degenerate).toBe(true);
    expect(
      run(work, [
        "rev-list",
        "--parents",
        "-n",
        "1",
        synthetic.merge_commit_sha,
      ])
    ).toBe(`${synthetic.merge_commit_sha} ${base_sha}`);
    expect(synthetic.merge_commit_sha).not.toBe(base_sha);
  });

  it("records the degenerate collapse truthfully in the snapshot artifact", () => {
    const { work } = fixtureRepo();
    const handle = runSnapshot({
      repo: work,
      mode: "default",
      keepRunDir: true,
    });
    try {
      const identity = handle.snapshot.identity;
      expect(identity.base_sha).toBe(identity.head_sha);
      expect(identity.parent_order).toEqual([
        identity.base_sha,
        identity.head_sha,
      ]);
      expect(identity.parents_effective).toEqual([identity.base_sha]);
      expect(identity.degenerate_merge).toBe(true);
      expect(validateSnapshot(handle.snapshot)).toBe(true);
    } finally {
      disposeSnapshot(handle);
    }
  });

  it("rejects a snapshot whose degenerate flag disagrees with the stored parents", () => {
    const { work } = fixtureRepo();
    const handle = runSnapshot({
      repo: work,
      mode: "default",
      keepRunDir: true,
    });
    try {
      const snapshot = JSON.parse(JSON.stringify(handle.snapshot));
      snapshot.identity.degenerate_merge = false;
      snapshot.identity_digest = identityDigest(snapshot.identity);
      expect(() => validateSnapshot(snapshot)).toThrowError(/SNAPSHOT_INVALID/);
    } finally {
      disposeSnapshot(handle);
    }
  });
});

describe("P01.TEST03 — snapshot schema and provenance validity", () => {
  it("validates every required field, sha format, parent relationship and digest", () => {
    const { work } = fixtureRepo();
    commitOn(work, "feature.txt", "feature\n", "feature commit");
    const handle = runSnapshot({
      repo: work,
      mode: "default",
      keepRunDir: true,
    });
    try {
      const snapshot = handle.snapshot;
      expect(validateSnapshot(snapshot)).toBe(true);
      expect(snapshot.schema_version).toBe("1.0.0");
      expect(snapshot.mode).toBe("default");
      expect(snapshot.authoritative).toBe(MODES.default.authoritative);
      expect(snapshot.identity.parent_order).toEqual([
        snapshot.identity.base_sha,
        snapshot.identity.head_sha,
      ]);
      expect(snapshot.identity_digest).toBe(identityDigest(snapshot.identity));
      expect(snapshot.observational.base_source).toBe("origin/main");
      expect(typeof snapshot.observational.dirty_working_tree).toBe("boolean");
      expect(snapshot.provenance.owner).toBe("scripts/ci/snapshot.mjs");
    } finally {
      disposeSnapshot(handle);
    }
  });

  it("lets a consumer obtain identity WITHOUT shelling out to git", () => {
    const { work } = fixtureRepo();
    commitOn(work, "feature.txt", "feature\n", "feature commit");
    const handle = runSnapshot({
      repo: work,
      mode: "default",
      keepRunDir: true,
    });
    try {
      const independence = auditConsumerIndependence(handle.snapshot);
      expect(independence.ok).toBe(true);
      expect(independence.missing).toEqual([]);
      for (const key of independence.required) {
        expect(handle.snapshot.identity[key]).toBeDefined();
      }
    } finally {
      disposeSnapshot(handle);
    }
  });

  it("rejects a snapshot whose identity_digest does not match", () => {
    const { work } = fixtureRepo();
    const base_sha = run(work, ["rev-parse", "origin/main"]);
    const head_sha = commitOn(work, "f.txt", "x\n", "c");
    const { merge_tree_sha } = writeMergeTree(work, base_sha, head_sha);
    const synthetic = syntheticMergeCommit(work, {
      base_sha,
      head_sha,
      merge_tree_sha,
    });
    const snapshot = buildSnapshot({
      mode: "default",
      base_sha,
      head_sha,
      merge_tree_sha,
      merge_commit_sha: synthetic.merge_commit_sha,
      synthetic_timestamp: synthetic.synthetic_timestamp,
      message: synthetic.message,
      run_id: "r",
      resolved_at: "t",
      worktree_path: "w",
      git_version: "g",
      base_source: "origin/main",
      base_fetched: true,
      dirty_working_tree: false,
      tracked_modified_count: 0,
      untracked_count: 0,
    });
    snapshot.identity.head_sha = "0".repeat(40);
    expect(() => validateSnapshot(snapshot)).toThrowError(/SNAPSHOT_INVALID/);
  });

  it("keeps observational churn OUT of the stability-critical digest", () => {
    const { work } = fixtureRepo();
    const base_sha = run(work, ["rev-parse", "origin/main"]);
    const head_sha = commitOn(work, "f.txt", "x\n", "c");
    const { merge_tree_sha } = writeMergeTree(work, base_sha, head_sha);
    const synthetic = syntheticMergeCommit(work, {
      base_sha,
      head_sha,
      merge_tree_sha,
    });
    const common = {
      mode: "default" as const,
      base_sha,
      head_sha,
      merge_tree_sha,
      merge_commit_sha: synthetic.merge_commit_sha,
      synthetic_timestamp: synthetic.synthetic_timestamp,
      message: synthetic.message,
      base_source: "origin/main",
      base_fetched: true,
      dirty_working_tree: false,
      tracked_modified_count: 0,
      untracked_count: 0,
      git_version: "git version 2.55.0",
    };
    const a = buildSnapshot({
      ...common,
      run_id: "RUN-A",
      resolved_at: "2026-01-01T00:00:00Z",
      worktree_path: "a/w",
    });
    const b = buildSnapshot({
      ...common,
      run_id: "RUN-B",
      resolved_at: "2027-09-09T09:09:09Z",
      worktree_path: "b/w",
    });
    expect(a.identity_digest).toBe(b.identity_digest);
    expect(a.observational).not.toEqual(b.observational);
  });
});

describe("P01.TEST04 — determinism of the synthetic merge", () => {
  it("produces identical merge_tree_sha and merge_commit_sha across 5 repeats and 2 wall-clock times", () => {
    const { work } = fixtureRepo();
    const base_sha = run(work, ["rev-parse", "origin/main"]);
    const head_sha = commitOn(
      work,
      "feature.txt",
      "feature\n",
      "feature commit"
    );

    const observed: Array<{
      tree: string;
      commit: string;
      wallSecond: number;
    }> = [];
    const once = () => {
      const { merge_tree_sha } = writeMergeTree(work, base_sha, head_sha);
      const { merge_commit_sha } = syntheticMergeCommit(work, {
        base_sha,
        head_sha,
        merge_tree_sha,
      });
      observed.push({
        tree: merge_tree_sha,
        commit: merge_commit_sha,
        wallSecond: Math.floor(Date.now() / 1000),
      });
    };

    for (let i = 0; i < 5; i += 1) once();
    sleepSync(1100); // cross a wall-clock second boundary
    for (let i = 0; i < 5; i += 1) once();

    expect(observed).toHaveLength(10);
    const trees = new Set(observed.map(o => o.tree));
    const commits = new Set(observed.map(o => o.commit));
    const seconds = new Set(observed.map(o => o.wallSecond));

    expect(trees.size).toBe(1);
    expect(commits.size).toBe(1);
    // The test is only meaningful if the wall clock actually moved.
    expect(seconds.size).toBeGreaterThanOrEqual(2);

    // The pinned timestamp is derived from commit metadata, never from now().
    expect(syntheticTimestamp(work, base_sha, head_sha)).toBe(1700000001);
    expect(syntheticMessage(base_sha, head_sha)).toBe(
      `ci-verify synthetic merge ${base_sha} ${head_sha}`
    );
  });
});

describe("P01.NEG01 — merge conflict", () => {
  it("returns BLOCKED(MERGE_CONFLICT) with exact paths and emits no snapshot", () => {
    const { work } = fixtureRepo();
    writeFileSync(path.join(work, "conflict.txt"), "original\n");
    run(work, ["add", "-A"]);
    run(work, ["commit", "-q", "-m", "seed conflict file"]);
    run(work, ["push", "-q", "origin", "main"]);
    const base_before = run(work, ["rev-parse", "HEAD"]);

    run(work, ["checkout", "-q", "-b", "theirs"]);
    commitOn(work, "conflict.txt", "THEIRS\n", "theirs");
    run(work, ["push", "-q", "origin", "theirs:main", "--force"]);
    run(work, ["fetch", "-q", "origin", "main"]);

    run(work, ["checkout", "-q", "-b", "ours", base_before]);
    const head_sha = commitOn(work, "conflict.txt", "OURS\n", "ours");
    const base_sha = run(work, ["rev-parse", "origin/main"]);

    let stop: any = null;
    try {
      writeMergeTree(work, base_sha, head_sha);
    } catch (error) {
      stop = error;
    }
    expect(stop).toBeInstanceOf(SnapshotStop);
    expect(stop.state).toBe("BLOCKED");
    expect(stop.reason).toBe("MERGE_CONFLICT");
    expect(stop.conflicting_paths).toEqual(["conflict.txt"]);

    // No snapshot certificate, and no worktree left behind.
    const before = listWorktrees(work).length;
    let runStop: any = null;
    try {
      runSnapshot({ repo: work, mode: "committed" });
    } catch (error) {
      runStop = error;
    }
    expect(runStop.reason).toBe("MERGE_CONFLICT");
    expect(listWorktrees(work).length).toBe(before);
  });
});

describe("P01.NEG03 — worktree creation failure", () => {
  it("returns INFRA-FAIL(WORKTREE) and leaves no orphan registration", () => {
    const { work } = fixtureRepo();
    const head_sha = commitOn(work, "feature.txt", "f\n", "feature");
    const blocked = path.join(work, "blocked-worktree");
    mkdirSync(blocked, { recursive: true });
    writeFileSync(path.join(blocked, "occupied.txt"), "in the way\n");

    const before = listWorktrees(work);
    let stop: any = null;
    try {
      createWorktree(work, blocked, head_sha);
    } catch (error) {
      stop = error;
    }
    expect(stop).toBeInstanceOf(SnapshotStop);
    expect(stop.state).toBe("INFRA-FAIL");
    expect(stop.reason).toBe("WORKTREE");
    expect(listWorktrees(work)).toEqual(before);
  });

  it("refuses to clean a path outside the owned run root", async () => {
    const { work } = fixtureRepo();
    const mod: any = await import("./snapshot.mjs");
    expect(() => mod.removeWorktree(work, path.join(work, "src"))).toThrowError(
      /UNOWNED_CLEANUP_PATH/
    );
  });
});

describe("P01.NEG04 — provenance bypass", () => {
  it("fails the audit when an implementation module resolves identity itself, and restores green", () => {
    const root = mkdtempSync(path.join(tmpdir(), "p01-aud-"));
    temps.push(root);
    const scan = path.join(root, "scripts", "ci");
    mkdirSync(scan, { recursive: true });
    writeFileSync(
      path.join(scan, "clean-consumer.mjs"),
      'import { readSnapshot } from "./snapshot.mjs";\nexport const head = s => s.identity.head_sha;\n'
    );

    const control = auditProvenance({ root, scanDir: "scripts/ci" });
    expect(control.ok).toBe(true);
    expect(control.violations).toEqual([]);

    writeFileSync(
      path.join(scan, "bypass-gate.mjs"),
      'import { execFileSync } from "node:child_process";\n' +
        'export const head = () => execFileSync("git", ["rev-parse", "HEAD"]).toString();\n'
    );
    const violated = auditProvenance({ root, scanDir: "scripts/ci" });
    expect(violated.ok).toBe(false);
    expect(violated.violations.map((v: any) => v.file)).toContain(
      "scripts/ci/bypass-gate.mjs"
    );
    expect(violated.violations.map((v: any) => v.pattern)).toContain(
      "rev-parse"
    );

    rmSync(path.join(scan, "bypass-gate.mjs"), { force: true });
    const restored = auditProvenance({ root, scanDir: "scripts/ci" });
    expect(restored.ok).toBe(true);
  });

  it("does not raise a false violation on prose or on declaration-only modules (DEF-009)", () => {
    expect(stripComments("// git rev-parse HEAD\nconst a = 1;\n")).not.toMatch(
      /rev-parse/
    );
    expect(invokesSubprocess('const s = "origin/main";')).toBe(false);
    expect(
      invokesSubprocess(
        'import {execFileSync} from "node:child_process"; execFileSync("git",[])'
      )
    ).toBe(true);

    const real = auditProvenance();
    expect(real.ok).toBe(true);
    const declaration = real.notes.filter(
      (n: any) => n.file === "scripts/ci/blueprint.mjs"
    );
    expect(declaration.length).toBeGreaterThan(0);
    expect(declaration[0].kind).toBe("declaration-only");
  });

  it("keeps every allowlist entry explicit and reasoned", () => {
    expect(ALLOWLIST.length).toBeGreaterThan(0);
    for (const entry of ALLOWLIST) {
      expect(entry.file).toMatch(/^scripts\/ci\//);
      expect(entry.reason.length).toBeGreaterThan(40);
    }
    expect(ALLOWLIST.map((e: any) => e.file)).toContain(
      "scripts/ci/snapshot.mjs"
    );
  });
});

describe("P01.NEG05 — every pinned metadata dimension is load-bearing", () => {
  it("changing any single pinned dimension changes merge_commit_sha", () => {
    const { work } = fixtureRepo();
    const base_sha = run(work, ["rev-parse", "origin/main"]);
    const head_sha = commitOn(work, "feature.txt", "f\n", "feature");
    const { merge_tree_sha } = writeMergeTree(work, base_sha, head_sha);
    const input = { base_sha, head_sha, merge_tree_sha };

    const pinned = syntheticMergeCommit(work, input).merge_commit_sha;

    const variations: Array<[string, Record<string, unknown>]> = [
      ["author_name", { author_name: "someone-else" }],
      ["author_email", { author_email: "someone@else" }],
      ["committer_name", { committer_name: "someone-else" }],
      ["committer_email", { committer_email: "someone@else" }],
      ["timestamp", { timestamp: 1700009999 }],
      ["date/timezone", { date: "1700000001 +0530" }],
      ["message", { message: "not the pinned message" }],
      ["parent order", { parents: [head_sha, base_sha] }],
    ];

    const changed: string[] = [];
    for (const [label, override] of variations) {
      const varied = syntheticMergeCommit(
        work,
        input,
        override
      ).merge_commit_sha;
      if (varied !== pinned) changed.push(label);
    }
    // Every dimension must matter — and at minimum one must, or the pin is
    // decorative. Asserting all of them is the stronger claim.
    expect(changed).toEqual(variations.map(([label]) => label));

    // The production path stays pinned and reproducible.
    expect(syntheticMergeCommit(work, input).merge_commit_sha).toBe(pinned);
    expect(SYNTHETIC_IDENTITY.parent_order).toEqual(["base_sha", "head_sha"]);
  });
});

describe("P01.T03 — dirty-tree policy (fixture half; the live half is P01.NEG02)", () => {
  it("blocks a default-mode run on a dirty tree and permits --committed", () => {
    const { work } = fixtureRepo();
    commitOn(work, "feature.txt", "f\n", "feature");
    writeFileSync(path.join(work, "untracked-unrelated.txt"), "do not touch\n");

    const tree = workingTreeState(work);
    expect(tree.dirty).toBe(true);

    let stop: any = null;
    try {
      runSnapshot({ repo: work, mode: "default" });
    } catch (error) {
      stop = error;
    }
    expect(stop.state).toBe("BLOCKED");
    expect(stop.reason).toBe("DIRTY_TREE");

    const handle = runSnapshot({
      repo: work,
      mode: "committed",
      keepRunDir: true,
    });
    try {
      expect(handle.snapshot.authoritative).toBe(true);
      expect(handle.snapshot.observational.dirty_working_tree).toBe(true);
      // The unrelated file is NOT part of the candidate and is untouched.
      expect(
        readFileSync(path.join(work, "untracked-unrelated.txt"), "utf8")
      ).toBe("do not touch\n");
      expect(workingTreeState(work).untracked).toContain(
        "untracked-unrelated.txt"
      );
    } finally {
      disposeSnapshot(handle);
    }
  });

  it("marks stash-probe as advisory — it can never certify", () => {
    expect(MODES["stash-probe"].authoritative).toBe(false);
    expect(MODES.default.authoritative).toBe(true);
    expect(MODES.committed.authoritative).toBe(true);
  });
});

describe("P01.T02 — base resolution never falls back to stale state", () => {
  it("raises an explicit terminal state when the base ref cannot be resolved", () => {
    const { work } = fixtureRepo();
    let stop: any = null;
    try {
      resolveBase(work, { fetch: false, branch: "does-not-exist" });
    } catch (error) {
      stop = error;
    }
    expect(stop).toBeInstanceOf(SnapshotStop);
    expect(stop.state).toBe("BLOCKED");
    expect(stop.reason).toBe("BASE_UNRESOLVED");
  });

  it("reports the ref it resolved from", () => {
    const { work } = fixtureRepo();
    const resolved = resolveBase(work, { fetch: false });
    expect(resolved.base_source).toBe("origin/main");
    expect(resolved.base_sha).toMatch(SHA);
  });
});
