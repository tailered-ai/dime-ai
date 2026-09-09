# P01 CHECKPOINT — P01.CP01

| Field | Value |
| --- | --- |
| Branch | `feat/ci-verify-control-plane` |
| Committed HEAD | `f9a35aa281c5ca9d209c7c152cb94da38d80274b` |
| base_sha (freshly re-resolved at P01 execution time) | `4d644cf47d2ee8a1528e1efd8a79da5ce658d8c6` |
| Base equal to the P00-recorded value? | YES — re-fetched and re-resolved, not inherited |
| head_sha | `f9a35aa281c5ca9d209c7c152cb94da38d80274b` |
| merge_tree_sha | `39a6aa38a26fee7b77bec776b4852a0fd36c2fa7` |
| merge_commit_sha (deterministic) | `2101ad875cf26549d6035dd4726416c757351d52` |
| identity_digest | `6d32d9466051ff8d040d7f00ad1b873f7a7b6246e1afae106a9a17386be73b62` |
| Ledger SHA-256 (pre-CP01) | `52c170bd97492c8e984da7381f533dc8cc8692c8553675628478b27a8827abbf` |
| Blueprint SHA-256 | `f2e7328f8871cc9678ee397b1bba9feb293ac885df1036ef4c105b3f68aa56e3` |
| snapshot.mjs SHA-256 | `0bc150db4997e1e2d6ce39efc2a7abec621dbf913651e7b2343acf0e32bf329f` |
| provenance-audit.mjs SHA-256 | `a0d97acfc1680367dd89f6fb97c31def99fddfb7a2f2426eaf7324f81f648577` |
| Node / pnpm / git | v22.22.0 / 10.33.0 / 2.55.0 |

## Parent ordering and deterministic metadata
```
parent_order      = [base_sha, head_sha]      (base FIRST — mirrors refs/pull/N/merge)
parents_effective = ["4d644cf47d2ee8a1528e1efd8a79da5ce658d8c6","f9a35aa281c5ca9d209c7c152cb94da38d80274b"]
degenerate_merge  = false
T                 = max(committer_time(base), committer_time(head)) + 1 = 1786352243
author/committer  = ci-verify <ci-verify@localhost>
dates             = "<T> +0000"   (TZ=UTC, LC_ALL=C, commit.gpgsign=false)
message           = "ci-verify synthetic merge <base_sha> <head_sha>"
```
**merge_commit_sha is LOCAL provenance only.** It is not expected to equal
GitHub's `refs/pull/N/merge` SHA. Reconciliation compares
`{head_sha, base_sha, merge_tree_sha, contract_hash}`.

## Dirty-tree status and the mode used for each live test
Working tree carries **32 entries** (6 tracked-modified, 26 untracked): the 27
unrelated pre-existing entries plus this initiative's in-progress files.

| Live exercise | Mode | Result |
| --- | --- | --- |
| P01.NEG02 A | `default` (bare, authoritative) | `BLOCKED(DIRTY_TREE)` exit 2, 0 bytes on stdout |
| P01.NEG02 B | `--committed` (authoritative) | exit 0, certified committed HEAD only |
| P01.REG01 | `--committed` | 20/20 clean |
| P01.CLN01 | `--committed --hold` | exit 130 after SIGINT |

## Closure counts (MANDATORY)
Tasks 9/9 · Positive 4/4 · Negative 5/5 · Regression 1/1 · Cleanup 1/1 ·
Audit 1/1 · Evidence 2/2 · Gate 1/1 · Checkpoint 1/1 (this document) = **25/25**

## Positive tests
P01.TEST01 ahead-of-main · P01.TEST02 identical-to-base (3 cases) ·
P01.TEST03 schema/provenance (4 cases) · P01.TEST04 determinism.
Suite total **20/20 passed, exit 0**.

## Negative tests and their DECLARED failure reasons
| ID | Declared reason observed |
| --- | --- |
| P01.NEG01 | `BLOCKED(MERGE_CONFLICT)`, `conflicting_paths == ["conflict.txt"]`, no certificate, no worktree leak |
| P01.NEG02 | `BLOCKED(DIRTY_TREE)` live; `--committed` certifies HEAD only; nothing stashed/cleaned/reset |
| P01.NEG03 | `INFRA-FAIL(WORKTREE)` + `UNOWNED_CLEANUP_PATH` guard; registration list unchanged |
| P01.NEG04 | audit `ok=false`, pattern `rev-parse` in the fixture; control restores green |
| P01.NEG05 | all 8 pinned dimensions change `merge_commit_sha`; production path stays pinned |

## 20-run regression (P01.REG01)
20/20 iterations, each tracked individually. Worktree delta 0, run-dir delta 0
on **every** iteration — no averaging. Distinct `merge_commit_sha` across 20
runs: **1**. Distinct `identity_digest`: **1**.

## SIGINT cleanup (P01.CLN01)
Interrupted after worktree creation. Exit **130**. Worktree removed,
registration pruned (backlog 0), run dir removed, stdout bytes **0**
(DEF-014), working-tree status fingerprint identical before and after.

## Provenance-bypass audit (P01.AUD01)
Static + behavioural, exit 0. 6 files scanned: allowlisted 2 (with written
reasons), declaration-only 2, test 1, implementation 1. Comments stripped;
files classified rather than lumped. `blueprint.mjs` reported as a
declaration-only NOTE, not a violation (DEF-009).

## Worktree / resource residue
Pre-existing baseline **39** registrations from earlier sessions on unrelated
branches (nothing prunable). Deltas after every exercise: worktrees 0,
run dirs 0, stash 0. `.ci-verify/runs` empty.

## Defects — 7 opened in P01, 7 closed, 0 open
| ID | Sev | Detected by | Resolution |
| --- | --- | --- | --- |
| DEF-009 | MEDIUM | P01.AUD01 | False violation on prose; `invokesSubprocess` precondition + declaration-only class |
| DEF-010 | HIGH | P01.TEST01 | `realpathSync` both sides (macOS /var vs /private/var) |
| DEF-011 | MEDIUM | P01.TEST02 | git dedupes identical parents; record `parents_effective` + `degenerate_merge` |
| DEF-012 | HIGH | P01.NEG01 | Conflict parser sliced FROM the blank instead of BEFORE it |
| DEF-013 | MEDIUM | P01.NEG02 | Evidence asserted absolute resource baselines instead of measured deltas |
| DEF-014 | HIGH | P01.CLN01 | Interrupted run had emitted a certificate on stdout |
| DEF-015 | LOW | P01.GATE01 | False FAIL: prettier given `.gitignore` |

Ledger total across all phases: **15 defects, 15 closed, 0 open.**

## Audit results
| Check | Result |
| --- | --- |
| Missing evidence | NONE |
| Contract drift | NONE (`ledger verify` exit 0) |
| Infrastructure failures | NONE |
| Flaky / inconclusive | NONE |
| Unrelated dependency conditions | NOT encountered — P01 never invokes pnpm install or gitleaks |

## Commands executed and direct exit codes
`ledger verify` 0 · P01 suite 0 (20/20) · PB suite 0 (35/35) ·
`vitest run scripts/` 0 (32 files, 448 tests) · `tsc --noEmit` 0 ·
`prettier --check scripts/ci/` 0 · `provenance-audit` 0 ·
`check-github-actions-security` 0 · `check-federation-docs` 0 ·
`snapshot.mjs` (dirty, default) 2 · `snapshot.mjs --committed` 0 ·
`snapshot.mjs --committed --hold` + SIGINT 130.

## Unrelated working-tree entries untouched
Fingerprint captured before any P01 change: `raw/unrelated-fingerprint-before.txt`
(32 hashed entries). Re-verified at checkpoint — see `raw/unrelated-fingerprint-after.txt`.

## Files changed by P01
```
 M .gitignore
 M docs/verification/CI-VERIFY-EXECUTION-LEDGER.md
 M docs/verification/ci-verify-ledger.json
 M docs/verification/ci-verify-ledger.sha256
?? docs/verification/evidence/p01/
?? scripts/ci/provenance-audit.mjs
?? scripts/ci/snapshot.mjs
?? scripts/ci/snapshot.test.ts
```

## ACCEPT(P01) — term by term
```
{
  "phase": "P01",
  "accepted": false,
  "reasons": [
    "UNITS_NOT_CLOSED: P01.CP01",
    "CHECKPOINT_NOT_RECORDED: P01.CP01"
  ],
  "terms": {
    "all_mandatory_closed": false,
    "all_gates_pass": true,
    "all_checkpoints_recorded": false,
    "all_authorizations_granted": true,
    "zero_blocking_open_defects": true,
    "evidence_complete": true,
    "zero_flaky_mandatory": true
  }
}
```
The sole outstanding reason is `P01.CP01`, recorded by this document.

## Decision
**PROCEED TO P02**
