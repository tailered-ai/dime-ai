# AMD-001 — authorized implementation amendment

Supersedes the implementation hashes authorized by GEN-000. GEN-000 itself is
byte-unchanged; this record is append-only.

## Why the implementation changed
| Defect | Change |
| --- | --- |
| DEF-004 | `progress().acceptance_met` replaced by `units_closed_complete`; new `acceptPhase()` implements the full seven-term frozen ACCEPT(P) predicate with per-term breakdown; `flaky` added as a unit field distinct from unit status and from the gate result taxonomy |
| DEF-005 | `BOOLEAN_FLAGS` in `parseArgs`; `verify` now requires a 40-hex `git_head_at_bootstrap`; `resolvedGenesis()` + amendment `genesis_corrections` |
| PB.T06 | `sync` (additive-only unit/decision seeding) and `amend` (this mechanism) |

## Blueprint changes
New permanent IDs only; nothing previously published was renumbered:
PB.T06, PB.TEST03, PB.NEG03, PB.REG01, P00.CP02, DEC-003, DEC-004.

## Genesis correction carried by this amendment
`git_head_at_bootstrap`: `unknown` -> `4d644cf47d2ee8a1528e1efd8a79da5ce658d8c6` (DEF-005).

## Why an amendment rather than re-bootstrapping
`init --force` would have produced a clean tree by DESTROYING the recorded
P-BOOT and P00 execution history — 24 units, their evidence hashes, two
checkpoints, and five defect records. Re-bootstrapping to manufacture a green
verify is precisely the failure mode this control plane exists to prevent.
