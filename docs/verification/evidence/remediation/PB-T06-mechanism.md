# PB.T06 — append-only amendment + additive sync mechanism

## Why it exists
Correcting DEF-004 and DEF-005 required editing `scripts/ci/ledger.mjs` and
`scripts/ci/blueprint.mjs` AFTER genesis GEN-000 had sealed their hashes. Two
options existed:

- `init --force` — would have produced a clean `verify` by DESTROYING the
  recorded P-BOOT and P00 execution history (24 units, their evidence hashes,
  two checkpoints, five defect records). Manufacturing a green result by
  deleting the evidence is the exact failure mode this control plane exists to
  prevent. **Rejected.**
- An append-only amendment. **Chosen.**

## `amend`
Appends an `AMD-NNN` record carrying the superseded hashes, the new hashes, the
reason, the defect IDs, and optional `genesis_corrections`. `verify` compares
the implementation against the NEWEST amendment (`authorizedHashes`), falling
back to GEN-000 when the log is empty. GEN-000 is never rewritten, so the whole
chain from bootstrap stays auditable — including the original DEF-005 error
value, which remains visible as `from: "unknown"`.

## `sync`
ADDITIVE ONLY. Seeds units and decisions newly declared in the blueprint at
`NOT_STARTED`; it never modifies or removes an existing record, and it refuses
to add a phase. `assertSeedComplete` still runs afterwards, so an undeclared
extra unit remains an error.

## Proof it behaved additively
Before sync: 249 units. After sync: 254 units (`PB.T06`, `PB.TEST03`,
`PB.NEG03`, `PB.REG01`, `P00.CP02`) and 4 decisions (`DEC-003`, `DEC-004`
added). Every previously recorded status, evidence hash, checkpoint, and defect
survived unchanged — confirmed by re-verifying all recorded evidence hashes
(`verify` exit 0, zero STALE_EVIDENCE).

## Negative coverage
`PB.NEG03` covers the DEF-005 genesis-correction path: GEN-000 keeps its
original value while `resolvedGenesis()` returns the corrected one, and
`authorizedHashes()` reports the amendment as the source.
