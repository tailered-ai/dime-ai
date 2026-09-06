# Addendum to P00.CP01 — DEF-004 (found after the checkpoint was sealed)

CP01-checkpoint.md is immutable once its hash is recorded, so this addendum is
appended rather than editing sealed evidence.

## What was observed
After recording P00.CP01, `node scripts/ci/ledger.mjs progress P00` reported:

    "closed": 13, "total": 13, "acceptance_met": true

while the phase is genuinely NOT acceptable (DEF-002 HIGH and DEF-003 MEDIUM
are OPEN, and the phase state is OWNER_DECISION_REQUIRED).

## Why this is a defect, not a nuance
`progress()` implements only the unit-closure term of the frozen acceptance
algebra:

    ACCEPT(P) <=> all MANDATORY closed
               AND every GATE* = PASS
               AND every CP* recorded with evidence hashes
               AND every AUTH* granted
               AND zero OPEN defects severity >= MEDIUM attributed to P
               AND evidence completeness = 100%
               AND zero FLAKY in MANDATORY units

A field named `acceptance_met` that returns `true` on the first term alone is a
misleading green — precisely the failure mode this control plane exists to
prevent. It did NOT alter the P00 decision, which was taken from the full
predicate by hand and recorded as DO NOT PROCEED.

## Disposition
Fixing it means changing `scripts/ci/ledger.mjs` after genesis GEN-000 sealed
its hash, which will legitimately trip `LEDGER_IMPL_DRIFT` on the next
`verify`. That is the tamper-evidence mechanism working as designed, not a
regression. The correct place to absorb both the fix and the drift is
**P03.T02** ("class-to-terminal-state reduction"), which owns the full
predicate. It is therefore NOT fixed here.

Interim rule for any reader: `acceptance_met` in `progress` output means
"all MANDATORY units are closed", nothing more. Phase acceptance is the
`state` field on the phase record, and P00's is OWNER_DECISION_REQUIRED.

## Decision impact
NONE. P00.CP01 remains **DO NOT PROCEED**, blocking IDs DEF-002, DEF-003.
