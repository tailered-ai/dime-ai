# AMD-004 — authorized implementation amendment (P03)

Supersedes the hashes authorized by AMD-003. GEN-000 remains byte-unchanged;
the log is append-only.

## Verified BEFORE this record was written (the AMD-002 -> AMD-003 lesson)
Both changes were confirmed to have landed before any amendment was recorded:

- `ledger migrate` reported `added 2 key(s): gate_results, result_schema_version`
- `ledger sync` reported `added 6 unit(s): P03.TEST03, P03.AUD01, P03.AUD02,
  P03.CONF01, P03.EV01, P03.EV02`

An amendment is never written on the assumption that its predecessor step
succeeded.

## What changed

### `scripts/ci/ledger.mjs` (P03.T07 / P03.T08)
- `gate_results` (append-only) and `result_schema_version` added to the ledger
  schema. Gate RESULTS are a separate vocabulary from unit STATUS and are never
  converted into one another.
- `migrate` subcommand: ADDITIVE ONLY. It adds top-level keys a newer schema
  requires and preserves every existing value. No reseed, reset or
  reinitialize path was used; PB/P00/P01/P02 records, evidence hashes, sealed
  checkpoints, decisions, defects and amendments are byte-preserved.
- `recordGateResult` refuses a duplicate `gate_id` rather than overwriting —
  overwriting is precisely how an earlier failure disappears.
- `systemTerminal` reduces recorded results to a SYSTEM TERMINAL state, kept
  distinct from `acceptPhase()` (blueprint units). Neither substitutes for the
  other.
- Render gains a six-class gate-result section, generated from canonical JSON,
  in which every class appears even when empty.

### `scripts/ci/blueprint.mjs`
Six new permanent IDs, required by the P03 mandate:
`P03.TEST03` (false-green adversarial suite), `P03.AUD01` (contract-to-registry
fidelity), `P03.AUD02` (runtime YAML isolation), `P03.CONF01` (ledger render
conformance), `P03.EV01`, `P03.EV02`.

No published ID was renumbered or recycled; `sync` is additive only.

## What did NOT change
`acceptPhase()` retains the full seven-term ACCEPT(P) predicate established
under DEF-004. P03 adds a reporting axis; it does not weaken acceptance.
