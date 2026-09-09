# DEF-004 — closure record

| Field | Value |
| --- | --- |
| Detected by | P00.CP01 |
| Severity | MEDIUM |
| Affected gate | P03.T02 |
| Status | CLOSED |

## Correction implemented (this session, not deferred to P03)
1. `progress().acceptance_met` **removed** and replaced by
   `units_closed_complete` — a name that cannot be mistaken for phase
   acceptance.
2. New `acceptPhase(ledger, phaseId)` implements the FULL frozen seven-term
   `ACCEPT(P)` predicate and returns `{accepted, reasons, terms}` so a caller
   can never collapse a partial result into a green verdict.
3. `flaky` added as a unit FIELD, deliberately not a unit STATUS — preserving
   the separation between unit status (§0.2), the gate result taxonomy (P03),
   and phase state.
4. New CLI `ledger.mjs accept <PHASE>` prints every term and exits non-zero
   when the phase is not acceptable.

## Terms implemented
`all_mandatory_closed` · `all_gates_pass` · `all_checkpoints_recorded` ·
`all_authorizations_granted` · `zero_blocking_open_defects` ·
`evidence_complete` · `zero_flaky_mandatory`

Defect attribution is the UNION of the detecting phase and the affected phase.
Attributing only by `affected_gate` would have let every P00-discovered defect
fall outside P00 and silently unblock the phase that found it — a self-serving
definition, explicitly rejected and covered by a test.

## Targeted retest — PB.TEST03
Complete conjunction returns true with all seven terms true; ADVISORY units are
ignored; an OPEN defect below MEDIUM does not block; a CLOSED defect does not
block; `progress()` no longer exposes `acceptance_met`, and unit closure alone
provably does not imply acceptance.

## Negative retest — PB.NEG03
Seven table-driven cases, one per term. Each breaks exactly ONE term and
asserts (a) `accepted === false`, (b) that term is false, (c) the matching
reason code, and (d) **every other term is still true** — proving the term
alone carried the verdict. Plus cross-phase defect attribution, and the two
DEF-005 regressions.

## Relevant regression — PB.REG01
Full PB suite green (35/35) and `ledger verify` exit 0 against the amended
implementation. PB.TEST01/TEST02/NEG01/NEG02 all still hold.

## Ledger reconciliation
Implementation change authorized append-only by AMD-001. GEN-000 is
byte-unchanged. `verify` compares against the newest amendment.
