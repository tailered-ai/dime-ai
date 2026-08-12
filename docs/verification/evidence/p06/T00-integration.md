# P06/P07 — integration and contract re-derivation evidence

## Integration commit (authorized, NOT a phase acceptance)

| Field | Value |
| --- | --- |
| Merge commit | `4b8ee4cd180d956c88abb9e536493c94d4b2767a` |
| Tree | `9f8587a3002b0742b2eeb63b4e785e74465c3918` |
| Parent 1 (branch) | `705c9898eed249136cb02945c3f7cfd2124bda02` |
| Parent 2 (integrated base) | `29a4a97ec15002b596247ec22efc9048e232f147` |
| Conflicts | exactly one — `pnpm-lock.yaml` |
| Strategy | real merge; no rebase, squash, cherry-pick, or history rewrite |

## Lockfile reconciliation (canonical, not hand-edited)

| Check | Result |
| --- | --- |
| `package.json` | auto-merged cleanly (never in conflict) |
| Basis | upstream `29a4a97e` lockfile |
| Regeneration | `pnpm install --lockfile-only` under governed pnpm 10.33.0 |
| Lockfile before (branch) | `623f2e3fe958d3c8…` |
| Basis (upstream) | `0e75cc198b9291b2…` |
| Reconciled | `aab9301b9ff7cf6c71a5c2cc93c43765097d704a4a2b1e0244a86e28a7d5587e` |
| `yaml` pin | specifier `2.9.0`, version `2.9.0` — exact, no range substituted |
| Conflict markers | 0 |
| `pnpm install --frozen-lockfile --ignore-scripts` | exit 0 |
| Second regeneration | **byte-identical** |
| Importer delta vs upstream basis | exactly `{yaml: 2.9.0}` — nothing removed, nothing else changed |

The applied lockfile SHA matches the artifact proven in the disposable
worktree byte-for-byte, so what landed is exactly what was validated.

## Drift detection proved working before regeneration (§8)

Conformance was run against the integrated tree **before** regenerating
anything, and correctly refused:

```
23 CONTRACT_DRIFT entries — one per workflow upstream changed
```

That is exactly the 23 workflow files `origin/main` touched. Had the old
contract stayed green against changed contract-bearing workflows, that would
have been a HIGH defect in the detector itself; it was not.

## Contract re-derivation (§9/§10)

| Field | Value |
| --- | --- |
| Old contract | `400cc0391547435d…` |
| New contract | `17ab9315240d8be9caddff9d54bcfb706269da49e6103aae15864385693a0c51` |
| Parser | `yaml@2.9.0` (the pinned parser this branch adds) |
| Census | re-derived, not inherited |
| Repeat generation | **byte-identical** |
| New `setup-node` pin `82076278…` | present, 28 occurrences |
| Old pin `49933ea5…` | 0 occurrences |
| Conformance after regeneration | PASS — 40 workflows, 51 checks, 9 required contexts |

## Registry reload (§11)

Re-derived from the new contract, **not** hand-edited:

| Field | Before | After |
| --- | --- | --- |
| PARITY entries | 47 | **47** |
| Required | 9 | **9** |
| Graduating | 5 | **5** |
| Runnability LOCAL / LOCAL+TOOL / CI-ONLY | 17 / 10 / 20 | **17 / 10 / 20** |

Required contexts unchanged: `contracts, dependency-review, deterministic,
gitleaks, proof, security-audit, test, typecheck, zizmor`. No required check
disappeared across the upstream action bump.

## Fresh candidate (§7)

| Field | Value |
| --- | --- |
| `head_sha` | `4b8ee4cd180d956c88abb9e536493c94d4b2767a` |
| `base_sha` | `29a4a97ec15002b596247ec22efc9048e232f147` |
| `merge_tree_sha` | `9f8587a3002b0742b2eeb63b4e785e74465c3918` |
| `merge_commit_sha` | `7a0b53f335bb81a72151042a0130862d827dace1` |
| `degenerate_merge` | false |
| Conflicts | none |

## Isolation regressions (§12)

| Audit | Violations |
| --- | --- |
| P01 provenance | **0** |
| P03 ownership/isolation | **0** |
| P02 runtime-YAML | **0** |

The DEF-051 defect class — a module outside P01 deciding candidate identity —
remains closed. `assertFreshBase` compares two P01-produced values and
resolves no ref of its own.
