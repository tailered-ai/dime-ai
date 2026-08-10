# AMD-010 rationale — declare P05.CP05

The integration authorization (§31) requires the next permanent append-only
checkpoint after integrating the exact current `origin/main`:
"Create the next checkpoint, expected `P05.CP05`. Do not edit CP01–CP04."

`P05.CP05` is declared as a new permanent MANDATORY checkpoint depending on
`P05.CP02` (the last declared checkpoint unit; CP03 and CP04 were recorded as
ledger checkpoint entries against the CP02 lineage). CP01–CP04 keep their IDs,
statuses, evidence, and recorded decisions unchanged, and every sealed
checkpoint document remains byte-identical.

Additive only. Precedent: AMD-007 (CP02), AMD-006 (P05 units), AMD-005 (P04).
