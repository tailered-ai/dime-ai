# AMD-002 — authorized implementation amendment (P02)

Supersedes the hashes authorized by AMD-001. GEN-000 remains byte-unchanged;
this record is append-only.

## Why the implementation changed
`scripts/ci/blueprint.mjs` gained two new permanent unit IDs required by P02
implementation reality:

- **P02.REG01** — pinned-parser regression. Section 13 of the P02 mandate
  requires explicit evidence that `yaml@2.9.0` handles every construct class
  actually present, and that its YAML 1.2 semantics are intentional. Parser
  behaviour discovered accidentally during extraction is not sufficient
  evidence, so the regression needs its own tracked unit.
- **P02.CONF02** — rendered-document conformance. Section 10 requires a test
  preventing stale human documentation from silently disagreeing with the
  machine contract. That is a conformance obligation distinct from
  P02.CONF01 (contract ↔ workflow tree).

Both tests already existed in `scripts/ci/contract.test.ts`; this amendment
gives them permanent ledger identity rather than leaving them untracked.

## What did NOT change
No published ID was renumbered or recycled. `sync` is additive only. Every
previously recorded status, evidence hash, checkpoint and defect is unchanged —
re-verified by `ledger verify` returning zero STALE_EVIDENCE.
