# P04 entry record — Executor Core

Recorded before any P04 implementation work.

## Execution baseline

| Field | Value |
| --- | --- |
| Branch | `feat/ci-verify-control-plane` |
| Execution-start HEAD | `1fa8e2153809261da6b426dce2e31ba650b8866a` |
| HEAD tree | `394b9559640995085b2607bda2fcca83479fddb0` |
| HEAD parent | `0576e8bb888188a9a9ea7a3b2f364941cd95a64b` |
| `origin/main` (fetched at entry) | `4d644cf47d2ee8a1528e1efd8a79da5ce658d8c6` |
| Ledger sha256 (disk == pin) | `a059ce295be800bc2ca01fc8e41f1e7018174e72dbc3ce4031aaef6ed951b089` |
| Contract sha256 (disk == pin) | `58087d2a8262064658cac283703777dce60e414f323fbb5f8b54fb6885e172d5` |
| Blueprint sha256 (at entry, pre-AMD) | `423ccd3169000118bb876e1f0cfe99d5756fbf53c957d325ab6268e9cb45866d` |
| PARITY registry | 47 entries from the frozen contract (LOCAL 17 / LOCAL+TOOL 10 / CI-ONLY 20; required 9, graduating 5) |
| Node | v22.22.0 |
| pnpm | 10.33.0 |
| git | 2.55.0 |
| Container runtime | docker: unavailable; podman: unavailable |
| Defect state at entry | 20 total, 20 closed, 0 open |
| Amendments at entry | AMD-001..AMD-004 |
| Phase states at entry | PB/P00/P01/P02/P03 ACCEPTED (re-verified `accept` exit 0 for all five); P04 NOT_STARTED |
| Ledger verify at entry | exit 0 |

## Fresh P04 candidate (P01 snapshot machinery, `--committed` mode)

| Field | Value |
| --- | --- |
| `head_sha` | `1fa8e2153809261da6b426dce2e31ba650b8866a` |
| `base_sha` | `4d644cf47d2ee8a1528e1efd8a79da5ce658d8c6` |
| `merge_tree_sha` | `394b9559640995085b2607bda2fcca83479fddb0` |
| `merge_commit_sha` | `f03b6db328b7164fd554ddbf21e126638c1a3d4d` |
| `identity_digest` | `a9a86c6b41532ae98222d0b9b5b920c4b930061bbfc076f0c2f4948d1ccc8418` |
| Determinism | identity_digest reproduced byte-identically across two independent runs |
| Note | `merge_tree_sha` equals HEAD's tree because `base_sha` is an ancestor of HEAD (no divergence on `origin/main` since branch cut). `degenerate_merge=false`; parents are distinct. |

P03's snapshot certified `head=0576e8bb…` and is superseded. All P04 execution
evidence binds to identity digest `a9a86c6b…`.

## Entry condition: container runtime

The frozen P04 entry reads: "Container runtime available, or
HERMETIC:UNENFORCED explicitly accepted."

Docker and podman are both unavailable on this host (verified at entry, exit
codes captured in the session record). **HERMETIC:UNENFORCED is explicitly
accepted for P04.** Consequences, per the frozen architecture:

- the executor must DETECT and truthfully report enforcement mode, never claim
  `HERMETIC:ENFORCED` on this host;
- a mandatory gate declaring `network: deny` executed here must produce
  `INCONCLUSIVE`, never `PASS` (P04.NEG04 proves this);
- nothing in P04 simulates enforcement by unsetting proxy variables or by
  documenting intent.

This acceptance is scoped to P04 executor development. P08 CLEANROOM keeps its
own entry conditions and is not weakened by this record.

## Unrelated working-tree inventory

25 entries fingerprinted at entry (SHA-256 per file; aggregate per directory)
in `unrelated-fingerprint-start.txt`. P04 claims no authority over any of them.
Known standing observation: `.claude/scripts/bootstrap-gstack.sh` is untracked
and self-mutated by its own SessionStart hook in past sessions; it is observed,
never adopted.
