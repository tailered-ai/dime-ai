# PB.T01 — evidence record (immutable observation)

Recorded at seed time on branch `feat/ci-verify-control-plane`, HEAD `4d644cf47d2ee8a1528e1efd8a79da5ce658d8c6`.

## Artifact
| Field | Value |
| --- | --- |
| Path | `scripts/ci/ledger.mjs` |
| SHA-256 at bootstrap | `690ba34fb1e40871ea1a7d29f0c3afc28ed4ba2b05f81432a11cd9f96687873d` |
| Companion | `scripts/ci/blueprint.mjs` SHA-256 `c6fedcf41a842f55786737e2f8cd64c938b2cd626ba3dfb0b5518dcbeb6d139d` |

Subcommand surface: init, start, set, phase, decision, defect, checkpoint,
progress, show, render, verify.

## Exit requirement: "PASS refused without verifiable evidence"
Proven by executable assertions in `scripts/ci/ledger.test.ts`
(suite "PB.T01 exit requirement"), all passing:
- refuses PASS when no evidence is declared -> EVIDENCE_REQUIRED
- refuses PASS when a declared evidence path does not exist -> EVIDENCE_MISSING
- refuses a jump from NOT_STARTED straight to PASS -> ILLEGAL_TRANSITION
- refuses evidence pointing at a live control-plane artifact -> EVIDENCE_SELF_REFERENCE (DEF-001)
- accepts PASS with real, non-empty, hashable evidence (sha256 + byte count recorded)

Full run: `PB-validation-run.txt` (20/20 passed, exit 0).
