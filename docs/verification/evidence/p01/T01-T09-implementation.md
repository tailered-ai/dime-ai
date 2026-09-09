# P01.T01 – P01.T09 — implementation record

| Unit | Deliverable | Where |
| --- | --- | --- |
| T01 | Run layout `.ci-verify/runs/<run_id>/{worktree,snapshot.json,lifecycle.json}`; unique observational `run_id`; deterministic per-run paths; cleanup registered before the worktree exists | `runPaths`, `newRunId`, `registerCleanup`, `wireSignals` |
| T02 | Base fetched and re-resolved from `origin/main` at execution time; fetch failure -> `INFRA-FAIL(BASE_FETCH_FAILED)`, resolve failure -> `BLOCKED(BASE_UNRESOLVED)`; never a silent fallback | `resolveBase` |
| T03 | Head from committed HEAD; `default` blocks a dirty tree, `committed` certifies committed HEAD, `stash-probe` is advisory (`authoritative: false`). Nothing is stashed, cleaned, reset or staged. | `resolveHead`, `workingTreeState`, `assertModeAllowsTree`, `MODES` |
| T04 | `git merge-tree --write-tree --name-only`; conflict -> `BLOCKED(MERGE_CONFLICT)` with exact paths and no synthetic commit | `writeMergeTree` |
| T05 | Deterministic synthetic merge: parents `[base, head]`, `T = max(committer_time)+1`, `ci-verify <ci-verify@localhost>`, `<T> +0000`, fixed message, `TZ=UTC`, `LC_ALL=C`, gpgsign disabled | `syntheticMergeCommit`, `SYNTHETIC_IDENTITY` |
| T06 | Detached worktree at the synthetic merge commit inside the run dir; all later gates run there, never in the developer's tree | `createWorktree`, `removeWorktree` (path-scoped) |
| T07 | Validated `snapshot.json` splitting `identity` (reproducibility-critical, covered by `identity_digest`) from `observational` (run_id, resolved_at, worktree_path, git_version, dirty flags — deliberately OUTSIDE the digest) | `buildSnapshot`, `validateSnapshot`, `identityDigest` |
| T08 | `snapshot.mjs` is the sole owner of SHA resolution; enforced by `provenance-audit.mjs`, not documented only | `readSnapshot`, `provenance-audit.mjs` |
| T09 | Root-anchored ignores: `/.ci-verify/`, `/local-proof-contract.json`, `/vitest-results.phase-{a,b}.json` | `.gitignore` |

## Local provenance boundary (recorded explicitly)
`merge_commit_sha` is LOCAL provenance only. It is **not** expected to equal
GitHub's `refs/pull/N/merge` SHA — GitHub uses its own author, committer and
timestamps. Cross-environment reconciliation compares
`{head_sha, base_sha, merge_tree_sha, contract_hash}`, never the synthetic
commit id. This is asserted in the artifact's `provenance.note`.

## T09 narrow-scope proof
Each new pattern matches only its intended target (`git check-ignore -v`), and
`scripts/ci/snapshot.mjs`, `docs/verification/ci-verify-ledger.json`,
`package.json`, `local-proof-contract.md` and `sub/vitest-results.phase-a.json`
all remain visible — no broad pattern hides a legitimate file.
