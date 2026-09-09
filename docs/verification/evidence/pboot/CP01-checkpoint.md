# P-BOOT CHECKPOINT — PB.CP01

| Field | Value |
| --- | --- |
| Branch | `feat/ci-verify-control-plane` (cut from `origin/main`) |
| HEAD / base SHA | `4d644cf47d2ee8a1528e1efd8a79da5ce658d8c6` |
| origin/main SHA | `4d644cf47d2ee8a1528e1efd8a79da5ce658d8c6` |
| Ledger SHA-256 (pre-CP01) | `333a2a69ac3ed7a89c31377c5c9f1e4717d7cef3684505c9ae6310ab0f4dd166` |
| Genesis ledger_impl_sha256 | `690ba34fb1e40871ea1a7d29f0c3afc28ed4ba2b05f81432a11cd9f96687873d` |
| Genesis blueprint_sha256 | `c6fedcf41a842f55786737e2f8cd64c938b2cd626ba3dfb0b5518dcbeb6d139d` |
| Node / pnpm / git | v22.22.0 / 10.33.0 / 2.55.0 |

## Units (MANDATORY only)
- CHECKPOINT: 0/1
- ACCEPTANCE_GATE: 1/1
- NEGATIVE_VALIDATION: 2/2
- TASK: 5/5
- POSITIVE_VALIDATION: 2/2
- TOTAL (excluding PB.CP01, recorded by this checkpoint): 10/11

## Validations performed
- PB.TEST01 seeded-ID census — PASS
- PB.TEST02 render + sha256 conformance — PASS
- PB.NEG01 duplicate ID fails initialization — PASS
- PB.NEG02 missing/extra seed ID fails initialization — PASS
- PB.T01 exit requirement (evidence refusal, illegal transition, DEF-001) — PASS
- Suite total: 20/20, exit 0

## Negative proof that PB.GATE01 can REJECT
| Case | Injected fault | Detector fired | Exit |
| --- | --- | --- | --- |
| 1 | hand-edited canonical JSON | LEDGER_TAMPERED + RENDER_DRIFT | 1 |
| 2 | hand-edited rendered markdown | RENDER_DRIFT | 1 |
| 3 | mutated a recorded evidence artifact | STALE_EVIDENCE | 1 |
| 4 | evidence pointing at a live artifact | EVIDENCE_SELF_REFERENCE | 1 |
| restore | all artifacts returned | VERIFY OK | 0 |

## Defects
- Opened: 1 (DEF-001) · Closed: 1 · Unresolved: 0

## Audit results
- Missing evidence: NONE (10 of 10 recorded units carry a hashed artifact)
- Contract drift: NONE
- Infrastructure failures: NONE
- Inconclusive results: NONE
- Flaky: NONE
- Authorization required: NONE for P-BOOT

## Process note (recorded rather than hidden)
Phase state transitions IN_PROGRESS -> IMPLEMENTED -> TESTING -> AUDITING ->
CHECKPOINT_REVIEW were recorded in order at the close of P-BOOT rather than
incrementally as each stage completed. The unit-level started_at/completed_at
timestamps are accurate; the phase-level history is therefore clustered. From
P00 onward, phase state is advanced as each stage is entered.

## Decision
**PROCEED TO P00**
