# AMD-003 — authorized implementation amendment (P02), superseding AMD-002

GEN-000 remains byte-unchanged. This log is append-only: AMD-002 is NOT removed.

## Relationship to AMD-002 (DEF-019)
`AMD-002` claims it authorized the declaration of `P02.REG01` and
`P02.CONF02`. **It did not.** The blueprint edit that step depended on failed
(a stale anchor after prettier reformatting), the batch continued regardless,
and the amendment was written anyway — with identical superseded and new hashes
(`eeea59ca` -> `eeea59ca`), which is the signature of a vacuous entry.

`AMD-002` stands in the log as a matter of record, explained by DEF-019.
`AMD-003` is the amendment that actually corresponds to a landed change.

## What changed, verified before this record was written
`scripts/ci/blueprint.mjs` now declares two new permanent IDs:

- **P02.REG01** — pinned-parser regression over every construct class actually
  present, with YAML 1.1-vs-1.2 semantics asserted explicitly rather than
  discovered accidentally during extraction.
- **P02.CONF02** — rendered-document conformance: `CONTRACT.md` byte-compared
  against a fresh render of `contract.frozen.json`.

Effect confirmed BEFORE recording: `ledger sync` reported
`added 2 unit(s): P02.REG01, P02.CONF02`. No published ID was renumbered or
recycled; `sync` is additive only.

## Process correction carried by this amendment
An amendment must be written only after the change it describes is verified to
have landed. The edit is now asserted against the current file shape, and the
`sync` result is checked, before any amendment is recorded.
