#!/usr/bin/env node
/**
 * snapshot.mjs — P01: snapshot resolution and prospective-merge materialization.
 *
 * THE SOLE OWNER OF VERIFICATION SHA RESOLUTION (P01.T08).
 * No other module in the verifier may call `git rev-parse`, recompute a base,
 * infer HEAD, or substitute another commit identity. That invariant is
 * ENFORCED, not merely documented — see `provenance-audit.mjs` (P01.AUD01) and
 * its negative fixture (P01.NEG04).
 *
 * Why this phase exists: GitHub's `pull_request` event checks out
 * `refs/pull/N/merge` — the auto-generated merge of the head into the base.
 * Verifying HEAD alone therefore certifies a revision GitHub never evaluates.
 * P01 materializes that combined state locally so every later gate runs against
 * the candidate GitHub will actually judge.
 *
 * Determinism contract (P01.T05): the synthetic merge commit is a pure function
 * of {base_sha, head_sha}. No wall clock, hostname, user identity, locale,
 * random value, run id, or path may influence the object.
 *
 *   T          = max(committer_time(base), committer_time(head)) + 1
 *   author     = committer = "ci-verify" <ci-verify@localhost>
 *   dates      = "<T> +0000"
 *   parents    = base_sha FIRST, head_sha SECOND (mirrors refs/pull/N/merge)
 *   message    = "ci-verify synthetic merge <base_sha> <head_sha>"
 *
 * The resulting `merge_commit_sha` is LOCAL PROVENANCE ONLY. It is NOT expected
 * to equal GitHub's `refs/pull/N/merge` SHA — GitHub uses its own author,
 * committer and timestamps. Cross-environment reconciliation compares
 * {head_sha, base_sha, merge_tree_sha, contract_hash}, never the synthetic
 * commit id.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, "..", "..");
export const RUNS_ROOT = ".ci-verify/runs";
export const SNAPSHOT_SCHEMA_VERSION = "1.0.0";

/** Authoritative modes may certify; advisory modes never can. */
export const MODES = {
  default: { authoritative: true, allows_dirty: false },
  committed: { authoritative: true, allows_dirty: true },
  "stash-probe": { authoritative: false, allows_dirty: true },
};

/** Pinned synthetic-commit identity. Changing any value changes every SHA. */
export const SYNTHETIC_IDENTITY = Object.freeze({
  author_name: "ci-verify",
  author_email: "ci-verify@localhost",
  committer_name: "ci-verify",
  committer_email: "ci-verify@localhost",
  timezone: "+0000",
  timestamp_rule: "max(committer_time(base), committer_time(head)) + 1",
  message_template: "ci-verify synthetic merge <base_sha> <head_sha>",
  parent_order: ["base_sha", "head_sha"],
});

/** A frozen terminal state, never a bare Error string. */
export class SnapshotStop extends Error {
  constructor(state, reason, detail = {}) {
    super(`${state}(${reason})`);
    this.name = "SnapshotStop";
    this.state = state;
    this.reason = reason;
    Object.assign(this, detail);
  }
}

const SHA_RE = /^[0-9a-f]{40}$/;

function git(repo, args, options = {}) {
  return execFileSync("git", args, {
    cwd: repo,
    encoding: "utf8",
    env: options.env ?? process.env,
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 64e6,
  }).trim();
}

function gitStatus(repo, args, options = {}) {
  try {
    return { status: 0, stdout: git(repo, args, options), stderr: "" };
  } catch (error) {
    return {
      status: error.status ?? 1,
      stdout: (error.stdout ?? "").toString(),
      stderr: (error.stderr ?? "").toString(),
    };
  }
}

/** Repository identity guard — refuse to operate on an unexpected checkout. */
export function assertRepository(repo) {
  const top = gitStatus(repo, ["rev-parse", "--show-toplevel"]);
  if (top.status !== 0) {
    throw new SnapshotStop("INFRA-FAIL", "NOT_A_REPOSITORY", { repo });
  }
  // DEF-010: compare REAL paths. On macOS `git rev-parse --show-toplevel`
  // returns the physical path (/private/var/...) while a caller may pass the
  // symlinked one (/var/...). Comparing unresolved strings made every
  // temp-directory fixture fail with a spurious REPOSITORY_MISMATCH.
  const actual = realpathSync(top.stdout.trim());
  const expected = realpathSync(path.resolve(repo));
  if (actual !== expected) {
    throw new SnapshotStop("INFRA-FAIL", "REPOSITORY_MISMATCH", {
      expected,
      actual,
    });
  }
  return actual;
}

export function gitVersion(repo = REPO_ROOT) {
  return git(repo, ["--version"]);
}

// --------------------------------------------------------------------------
// P01.T02 — base resolution. Always re-fetched; never inherited from an
// earlier checkpoint. A fetch or resolve failure is an explicit terminal
// state, never a silent fallback to stale state.
// --------------------------------------------------------------------------
export function resolveBase(repo = REPO_ROOT, options = {}) {
  const remote = options.remote ?? "origin";
  const branch = options.branch ?? "main";
  const ref = `${remote}/${branch}`;
  let fetched = false;
  if (options.fetch !== false) {
    const result = gitStatus(repo, ["fetch", remote, branch]);
    if (result.status !== 0) {
      throw new SnapshotStop("INFRA-FAIL", "BASE_FETCH_FAILED", {
        ref,
        stderr: result.stderr.slice(0, 2000),
      });
    }
    fetched = true;
  }
  const resolved = gitStatus(repo, [
    "rev-parse",
    "--verify",
    `${ref}^{commit}`,
  ]);
  if (resolved.status !== 0 || !SHA_RE.test(resolved.stdout.trim())) {
    throw new SnapshotStop("BLOCKED", "BASE_UNRESOLVED", {
      ref,
      stderr: resolved.stderr.slice(0, 2000),
    });
  }
  return { base_sha: resolved.stdout.trim(), base_source: ref, fetched };
}

// --------------------------------------------------------------------------
// P01.T03 — head resolution + dirty-tree policy.
// --------------------------------------------------------------------------
export function resolveHead(repo = REPO_ROOT) {
  const result = gitStatus(repo, ["rev-parse", "--verify", "HEAD^{commit}"]);
  if (result.status !== 0 || !SHA_RE.test(result.stdout.trim())) {
    throw new SnapshotStop("BLOCKED", "HEAD_UNRESOLVED", {
      stderr: result.stderr.slice(0, 2000),
    });
  }
  return result.stdout.trim();
}

export function workingTreeState(repo = REPO_ROOT) {
  const porcelain = gitStatus(repo, ["status", "--porcelain"]);
  if (porcelain.status !== 0) {
    throw new SnapshotStop("INFRA-FAIL", "STATUS_FAILED", {
      stderr: porcelain.stderr.slice(0, 2000),
    });
  }
  const lines = porcelain.stdout.split("\n").filter(Boolean);
  const tracked_modified = lines
    .filter(line => !line.startsWith("??"))
    .map(line => line.slice(3));
  const untracked = lines
    .filter(line => line.startsWith("??"))
    .map(line => line.slice(3));
  return {
    dirty: lines.length > 0,
    tracked_modified,
    untracked,
    entry_count: lines.length,
  };
}

export function assertModeAllowsTree(mode, tree) {
  const policy = MODES[mode];
  if (!policy) throw new SnapshotStop("BLOCKED", "UNKNOWN_MODE", { mode });
  if (tree.dirty && !policy.allows_dirty) {
    throw new SnapshotStop("BLOCKED", "DIRTY_TREE", {
      mode,
      entry_count: tree.entry_count,
      tracked_modified: tree.tracked_modified,
      untracked: tree.untracked,
      remedy:
        "commit the work, or re-run with --committed to certify committed HEAD " +
        "while leaving unrelated working-tree material outside the candidate",
    });
  }
  return policy;
}

// --------------------------------------------------------------------------
// P01.T04 — prospective merge tree. The canonical cross-environment
// comparability object.
// --------------------------------------------------------------------------
export function writeMergeTree(repo, base_sha, head_sha) {
  const result = gitStatus(repo, [
    "merge-tree",
    "--write-tree",
    "--name-only",
    base_sha,
    head_sha,
  ]);
  const lines = result.stdout.split("\n");
  const tree = (lines[0] ?? "").trim();
  if (result.status === 0) {
    if (!SHA_RE.test(tree)) {
      throw new SnapshotStop("INFRA-FAIL", "MERGE_TREE_UNPARSEABLE", {
        stdout: result.stdout.slice(0, 2000),
      });
    }
    return { merge_tree_sha: tree };
  }
  if (result.status === 1) {
    // DEF-012: with --name-only the layout is
    //   0            : <tree oid>
    //   1..blank-1   : conflicted file names
    //   blank        : ""
    //   blank+1..    : informational messages ("Auto-merging", "CONFLICT ...")
    // The first implementation sliced FROM the blank and captured the
    // informational messages as if they were paths.
    const blank = lines.indexOf("", 1);
    const end = blank === -1 ? lines.length : blank;
    const paths = lines
      .slice(1, end)
      .map(line => line.trim())
      .filter(Boolean);
    throw new SnapshotStop("BLOCKED", "MERGE_CONFLICT", {
      base_sha,
      head_sha,
      conflicting_paths: [...new Set(paths)].sort(),
    });
  }
  throw new SnapshotStop("INFRA-FAIL", "MERGE_TREE_FAILED", {
    status: result.status,
    stderr: result.stderr.slice(0, 2000),
  });
}

// --------------------------------------------------------------------------
// P01.T05 — deterministic synthetic merge commit.
// --------------------------------------------------------------------------
export function committerTime(repo, sha) {
  const result = gitStatus(repo, ["show", "-s", "--format=%ct", sha]);
  if (result.status !== 0) {
    throw new SnapshotStop("INFRA-FAIL", "COMMITTER_TIME_FAILED", { sha });
  }
  const value = Number(result.stdout.trim());
  if (!Number.isInteger(value)) {
    throw new SnapshotStop("INFRA-FAIL", "COMMITTER_TIME_UNPARSEABLE", { sha });
  }
  return value;
}

export function syntheticTimestamp(repo, base_sha, head_sha) {
  return (
    Math.max(committerTime(repo, base_sha), committerTime(repo, head_sha)) + 1
  );
}

export function syntheticMessage(base_sha, head_sha) {
  return `ci-verify synthetic merge ${base_sha} ${head_sha}`;
}

/**
 * Build the synthetic merge commit.
 *
 * `metadataOverrides` exists ONLY so P01.NEG05 can prove each pinned dimension
 * is load-bearing. Production callers never pass it, so the production path
 * stays fully pinned.
 */
export function syntheticMergeCommit(repo, input, metadataOverrides = {}) {
  const { base_sha, head_sha, merge_tree_sha } = input;
  for (const [key, value] of Object.entries({
    base_sha,
    head_sha,
    merge_tree_sha,
  })) {
    if (!SHA_RE.test(value ?? "")) {
      throw new SnapshotStop("INFRA-FAIL", "BAD_SHA_INPUT", { key, value });
    }
  }
  const stamp =
    metadataOverrides.timestamp ?? syntheticTimestamp(repo, base_sha, head_sha);
  const date =
    metadataOverrides.date ?? `${stamp} ${SYNTHETIC_IDENTITY.timezone}`;
  const message =
    metadataOverrides.message ?? syntheticMessage(base_sha, head_sha);
  const parents = metadataOverrides.parents ?? [base_sha, head_sha];

  const env = {
    ...process.env,
    GIT_AUTHOR_NAME:
      metadataOverrides.author_name ?? SYNTHETIC_IDENTITY.author_name,
    GIT_AUTHOR_EMAIL:
      metadataOverrides.author_email ?? SYNTHETIC_IDENTITY.author_email,
    GIT_COMMITTER_NAME:
      metadataOverrides.committer_name ?? SYNTHETIC_IDENTITY.committer_name,
    GIT_COMMITTER_EMAIL:
      metadataOverrides.committer_email ?? SYNTHETIC_IDENTITY.committer_email,
    GIT_AUTHOR_DATE: date,
    GIT_COMMITTER_DATE: date,
    // Locale and timezone are pinned so no host setting can leak into the object.
    TZ: "UTC",
    LC_ALL: "C",
  };

  const args = [
    "-c",
    "commit.gpgsign=false",
    "-c",
    "i18n.commitEncoding=UTF-8",
    "commit-tree",
    merge_tree_sha,
  ];
  for (const parent of parents) args.push("-p", parent);
  args.push("-m", message);

  const result = gitStatus(repo, args, { env });
  if (result.status !== 0 || !SHA_RE.test(result.stdout.trim())) {
    throw new SnapshotStop("INFRA-FAIL", "COMMIT_TREE_FAILED", {
      stderr: result.stderr.slice(0, 2000),
    });
  }
  const merge_commit_sha = result.stdout.trim();
  // DEF-011: git DEDUPLICATES identical parents ("duplicate parent ... ignored"),
  // so a degenerate base == head merge stores ONE parent. Read back what was
  // actually written rather than asserting what we asked for.
  const readBack = gitStatus(repo, [
    "rev-list",
    "--parents",
    "-n",
    "1",
    merge_commit_sha,
  ]);
  const parents_effective =
    readBack.status === 0 ? readBack.stdout.trim().split(/\s+/).slice(1) : [];
  return {
    merge_commit_sha,
    synthetic_timestamp: stamp,
    synthetic_date: date,
    message,
    parents_declared: parents,
    parents_effective,
    degenerate: parents_effective.length < parents.length,
  };
}

// --------------------------------------------------------------------------
// P01.T01 / P01.T06 — run layout, worktree, cleanup registration.
// --------------------------------------------------------------------------
const CLEANUP = [];
let signalsWired = false;
/**
 * Set before interrupt-time teardown. An interrupted run must leave NOTHING
 * behind, so it deliberately overrides --keep/--hold: those flags exist to
 * preserve artifacts of a SUCCESSFUL run, and an interrupted run never
 * succeeded.
 */
let interrupted = false;

export function isInterrupted() {
  return interrupted;
}

export function registerCleanup(fn) {
  CLEANUP.push(fn);
  return fn;
}

export function runCleanup() {
  const failures = [];
  while (CLEANUP.length) {
    const fn = CLEANUP.pop();
    try {
      fn();
    } catch (error) {
      failures.push(error.message);
    }
  }
  return failures;
}

export function wireSignals(onExit) {
  if (signalsWired) return;
  signalsWired = true;
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => {
      interrupted = true;
      const failures = runCleanup();
      if (onExit) onExit(signal, failures);
      // Interrupted runs must never look like a pass.
      process.exit(130);
    });
  }
  process.on("uncaughtException", error => {
    runCleanup();
    console.error(`[snapshot] uncaught: ${error.message}`);
    process.exit(1);
  });
}

/** Observational, unique per run. Never feeds a stability-critical hash. */
export function newRunId(seed = {}) {
  const stamp = seed.stamp ?? new Date().toISOString().replace(/[:.]/g, "-");
  const nonce = seed.nonce ?? `${process.pid}-${CLEANUP.length}`;
  return `${stamp}-${nonce}`;
}

export function runPaths(repo, run_id, runsRoot = RUNS_ROOT) {
  const dir = path.join(repo, runsRoot, run_id);
  return {
    dir,
    worktree: path.join(dir, "worktree"),
    snapshot: path.join(dir, "snapshot.json"),
    lifecycle: path.join(dir, "lifecycle.json"),
  };
}

export function listWorktrees(repo = REPO_ROOT) {
  const result = gitStatus(repo, ["worktree", "list", "--porcelain"]);
  if (result.status !== 0) return [];
  return result.stdout
    .split("\n")
    .filter(line => line.startsWith("worktree "))
    .map(line => line.slice("worktree ".length).trim());
}

export function createWorktree(repo, worktreePath, commit) {
  const result = gitStatus(repo, [
    "worktree",
    "add",
    "--detach",
    worktreePath,
    commit,
  ]);
  if (result.status !== 0) {
    throw new SnapshotStop("INFRA-FAIL", "WORKTREE", {
      worktree_path: worktreePath,
      commit,
      stderr: result.stderr.slice(0, 2000),
    });
  }
  return worktreePath;
}

/**
 * Remove a worktree. Scoped hard: refuses any path that is not inside the
 * run root, so a bug here can never reach a developer's files.
 */
export function removeWorktree(repo, worktreePath, runsRoot = RUNS_ROOT) {
  const owned = path.resolve(repo, runsRoot);
  const target = path.resolve(worktreePath);
  if (target !== owned && !target.startsWith(`${owned}${path.sep}`)) {
    throw new SnapshotStop("INFRA-FAIL", "UNOWNED_CLEANUP_PATH", {
      target,
      owned,
    });
  }
  gitStatus(repo, ["worktree", "remove", "--force", target]);
  if (existsSync(target)) rmSync(target, { recursive: true, force: true });
  gitStatus(repo, ["worktree", "prune"]);
}

// --------------------------------------------------------------------------
// P01.T07 — the snapshot artifact.
// --------------------------------------------------------------------------
export function identityDigest(identity) {
  const ordered = {};
  for (const key of Object.keys(identity).sort()) ordered[key] = identity[key];
  return createHash("sha256").update(JSON.stringify(ordered)).digest("hex");
}

export function buildSnapshot(input) {
  const identity = {
    head_sha: input.head_sha,
    base_sha: input.base_sha,
    merge_tree_sha: input.merge_tree_sha,
    merge_commit_sha: input.merge_commit_sha,
    parent_order: [input.base_sha, input.head_sha],
    parents_effective: input.parents_effective ?? [
      input.base_sha,
      input.head_sha,
    ],
    degenerate_merge: input.degenerate ?? false,
    synthetic_identity: SYNTHETIC_IDENTITY,
    synthetic_timestamp: input.synthetic_timestamp,
    synthetic_message: input.message,
  };
  return {
    schema_version: SNAPSHOT_SCHEMA_VERSION,
    mode: input.mode,
    authoritative: MODES[input.mode].authoritative,
    // Reproducibility-critical. Stable for a given {base_sha, head_sha}.
    identity,
    identity_digest: identityDigest(identity),
    // Observational. Deliberately OUTSIDE identity_digest so run-to-run churn
    // can never move a stability-critical value.
    observational: {
      run_id: input.run_id,
      resolved_at: input.resolved_at,
      worktree_path: input.worktree_path,
      git_version: input.git_version,
      base_source: input.base_source,
      base_fetched: input.base_fetched,
      dirty_working_tree: input.dirty_working_tree,
      tracked_modified_count: input.tracked_modified_count,
      untracked_count: input.untracked_count,
    },
    provenance: {
      owner: "scripts/ci/snapshot.mjs",
      note:
        "merge_commit_sha is LOCAL provenance only and is NOT expected to equal " +
        "GitHub's refs/pull/N/merge SHA. Reconciliation compares " +
        "{head_sha, base_sha, merge_tree_sha, contract_hash}.",
    },
  };
}

const REQUIRED_IDENTITY_SHAS = [
  "head_sha",
  "base_sha",
  "merge_tree_sha",
  "merge_commit_sha",
];

export function validateSnapshot(snapshot) {
  const problems = [];
  if (snapshot?.schema_version !== SNAPSHOT_SCHEMA_VERSION) {
    problems.push(`schema_version != ${SNAPSHOT_SCHEMA_VERSION}`);
  }
  if (!MODES[snapshot?.mode]) problems.push(`unknown mode: ${snapshot?.mode}`);
  else if (snapshot.authoritative !== MODES[snapshot.mode].authoritative) {
    problems.push("authoritative flag disagrees with the mode policy");
  }
  for (const key of REQUIRED_IDENTITY_SHAS) {
    if (!SHA_RE.test(snapshot?.identity?.[key] ?? "")) {
      problems.push(`identity.${key} is not a 40-hex sha`);
    }
  }
  const order = snapshot?.identity?.parent_order;
  if (
    !Array.isArray(order) ||
    order.length !== 2 ||
    order[0] !== snapshot?.identity?.base_sha ||
    order[1] !== snapshot?.identity?.head_sha
  ) {
    problems.push("parent_order must be exactly [base_sha, head_sha]");
  }
  const effective = snapshot?.identity?.parents_effective;
  if (!Array.isArray(effective) || effective.length === 0) {
    problems.push("identity.parents_effective missing");
  } else {
    if (!effective.every(sha => order?.includes(sha))) {
      problems.push("parents_effective contains a sha outside parent_order");
    }
    if (effective[0] !== snapshot?.identity?.base_sha) {
      problems.push("parents_effective must start with base_sha");
    }
    const degenerate =
      snapshot?.identity?.base_sha === snapshot?.identity?.head_sha;
    if (degenerate !== (effective.length === 1)) {
      problems.push("degenerate merge disagrees with parents_effective length");
    }
    if (snapshot?.identity?.degenerate_merge !== degenerate) {
      problems.push("identity.degenerate_merge flag is wrong");
    }
  }
  for (const key of [
    "run_id",
    "resolved_at",
    "worktree_path",
    "git_version",
    "base_source",
  ]) {
    if (!snapshot?.observational?.[key]) {
      problems.push(`observational.${key} missing`);
    }
  }
  if (typeof snapshot?.observational?.dirty_working_tree !== "boolean") {
    problems.push("observational.dirty_working_tree must be boolean");
  }
  if (snapshot?.identity_digest !== identityDigest(snapshot?.identity ?? {})) {
    problems.push("identity_digest does not match the identity block");
  }
  if (problems.length) {
    throw new SnapshotStop("BLOCKED", "SNAPSHOT_INVALID", { problems });
  }
  return true;
}

/** Consumers read identity from here — never by shelling out to git. */
export function readSnapshot(snapshotPath) {
  const snapshot = JSON.parse(readFileSync(snapshotPath, "utf8"));
  validateSnapshot(snapshot);
  return snapshot;
}

// --------------------------------------------------------------------------
// Full lifecycle.
// --------------------------------------------------------------------------
export function runSnapshot(options = {}) {
  const repo = assertRepository(options.repo ?? REPO_ROOT);
  const mode = options.mode ?? "default";
  const runsRoot = options.runsRoot ?? RUNS_ROOT;
  if (!MODES[mode]) throw new SnapshotStop("BLOCKED", "UNKNOWN_MODE", { mode });

  const tree = workingTreeState(repo);
  assertModeAllowsTree(mode, tree);

  const head_sha = resolveHead(repo);
  const { base_sha, base_source, fetched } = resolveBase(repo, {
    fetch: options.fetch,
    remote: options.remote,
    branch: options.branch,
  });
  const { merge_tree_sha } = writeMergeTree(repo, base_sha, head_sha);
  const synthetic = syntheticMergeCommit(repo, {
    base_sha,
    head_sha,
    merge_tree_sha,
  });

  const run_id = options.runId ?? newRunId();
  const paths = runPaths(repo, run_id, runsRoot);
  mkdirSync(paths.dir, { recursive: true });

  let worktreeCreated = false;
  const cleanup = registerCleanup(() => {
    if (worktreeCreated) removeWorktree(repo, paths.worktree, runsRoot);
    if ((options.keepRunDir !== true || interrupted) && existsSync(paths.dir)) {
      rmSync(paths.dir, { recursive: true, force: true });
    }
  });

  try {
    createWorktree(repo, paths.worktree, synthetic.merge_commit_sha);
    worktreeCreated = true;

    const snapshot = buildSnapshot({
      mode,
      head_sha,
      base_sha,
      merge_tree_sha,
      merge_commit_sha: synthetic.merge_commit_sha,
      synthetic_timestamp: synthetic.synthetic_timestamp,
      message: synthetic.message,
      parents_effective: synthetic.parents_effective,
      degenerate: synthetic.degenerate,
      run_id,
      resolved_at: new Date().toISOString(),
      worktree_path: path.relative(repo, paths.worktree),
      git_version: gitVersion(repo),
      base_source,
      base_fetched: fetched,
      dirty_working_tree: tree.dirty,
      tracked_modified_count: tree.tracked_modified.length,
      untracked_count: tree.untracked.length,
    });
    validateSnapshot(snapshot);
    writeFileSync(paths.snapshot, `${JSON.stringify(snapshot, null, 2)}\n`);
    writeFileSync(
      paths.lifecycle,
      `${JSON.stringify({ run_id, state: "MATERIALIZED", mode }, null, 2)}\n`
    );
    return { snapshot, paths, cleanup, repo, runsRoot };
  } catch (error) {
    if (worktreeCreated) {
      try {
        removeWorktree(repo, paths.worktree, runsRoot);
      } catch {
        /* teardown best-effort; the caller still sees the original stop */
      }
    }
    if (existsSync(paths.dir))
      rmSync(paths.dir, { recursive: true, force: true });
    const index = CLEANUP.indexOf(cleanup);
    if (index !== -1) CLEANUP.splice(index, 1);
    throw error;
  }
}

export function disposeSnapshot(handle) {
  if (!handle) return;
  const index = CLEANUP.indexOf(handle.cleanup);
  if (index !== -1) CLEANUP.splice(index, 1);
  if (existsSync(handle.paths.worktree)) {
    removeWorktree(handle.repo, handle.paths.worktree, handle.runsRoot);
  }
  if (existsSync(handle.paths.dir)) {
    rmSync(handle.paths.dir, { recursive: true, force: true });
  }
}

// --------------------------------------------------------------------------
// CLI
// --------------------------------------------------------------------------
function main(argv) {
  const mode = argv.includes("--committed")
    ? "committed"
    : argv.includes("--stash-probe")
      ? "stash-probe"
      : "default";
  const keep = argv.includes("--keep");
  const hold = argv.includes("--hold");
  wireSignals((signal, failures) => {
    console.error(
      `[snapshot] ${signal}: teardown ${failures.length ? `FAILED ${failures.join("; ")}` : "complete"}`
    );
  });
  let handle;
  try {
    handle = runSnapshot({ mode, keepRunDir: keep || hold });
  } catch (error) {
    if (error instanceof SnapshotStop) {
      console.error(`[snapshot] ${error.state}(${error.reason})`);
      const { state, reason, name, message, stack, ...detail } = error;
      console.error(JSON.stringify(detail, null, 2));
      process.exit(error.state === "BLOCKED" ? 2 : 3);
    }
    throw error;
  }
  if (hold) {
    // DEF-014: a held run never completes, so it must NEVER publish a
    // certificate. The artifact exists on disk for inspection and is removed
    // by interrupt-time teardown; stdout stays empty.
    console.error("[snapshot] holding for signal");
    setInterval(() => {}, 1000);
    return;
  }
  // Emission is tied to lifecycle COMPLETION, not to construction.
  console.log(JSON.stringify(handle.snapshot, null, 2));
  if (!keep) disposeSnapshot(handle);
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
) {
  main(process.argv.slice(2));
}
