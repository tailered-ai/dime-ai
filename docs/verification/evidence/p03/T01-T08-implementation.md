# P03.T01 – P03.T08 — implementation record

| Unit | Deliverable |
| --- | --- |
| T01 | `result.mjs`: the 12 frozen gate statuses as one authoritative, versioned schema. External hyphenated spellings (`CI-ONLY`, `INFRA-FAIL`, `CONTRACT-DRIFT`, `BROKEN-GATE`) are accepted/produced at exactly ONE boundary (`normalizeStatus` / `externalStatus`); variants never proliferate internally. Validation rejects unknown statuses, invalid classes, negative durations, malformed attempts, a non-zero exit on PASS, an exit code on `CI_ONLY`, a missing reason on any non-green status, and a PASS whose history contains a failure. |
| T02 | Class-to-terminal reduction keeping four vocabularies separate (unit status / gate result / phase state / system terminal). Severity ordering makes aggregation incapable of downgrading `CONTRACT_DRIFT` or `BROKEN_GATE`. The DEF-004 seven-term `acceptPhase()` is untouched — P03 adds a reporting axis, it does not weaken acceptance. |
| T03 | `registry.mjs` PARITY registry derived EXCLUSIVELY from `contract.frozen.json`, whose SHA is verified against its pin before any entry is built. Deep-frozen: append/delete/replace/reclassify all throw. An upstream contract defect (duplicate id, invalid runnability, CI-ONLY without reason) RAISES rather than being repaired locally. |
| T04 | HARDENING scaffold: schema, duplicate-ID rejection, class validation, deterministic ordering, and correct empty behaviour. Deliberately unpopulated — P09 owns deploy-order, schema-type-drift, knip and a11y. |
| T05 | `reporter.mjs` append-only JSONL. Each record is validated before write; duplicate `gate_id` is refused rather than overwritten; truncated or malformed streams raise instead of being partially summarized. |
| T06 | Six-class summary rendering ALL classes always, with every status column present even at zero, mandatory/advisory split, evidence completeness, blocking state and reasons. Pure — it never mutates results. |
| T07 | Ledger integration via an ADDITIVE `migrate` (adds `gate_results`, `result_schema_version`; preserves every existing value). `recordGateResult` is append-only and refuses duplicates. `systemTerminal` reduces gate results on an axis separate from phase acceptance. No reseed/reset path was used. |
| T08 | Render integration: a six-class gate-result section generated from canonical JSON, so the rendered ledger cannot express a green state absent from the JSON. |

## Boundary preserved
`workflow YAML -> P02 extractor -> contract.frozen.json -> P03+ runtime`.
P03 never parses YAML, never re-discovers checks from `.github/workflows`, never
hand-authors PARITY membership, and never overrides a P02 classification.
Proven by P03.AUD02.

## Registry facts
PARITY 47 entries (9 required, 5 graduating); 4 contract checks out of PARITY
scope because their status context is dynamic (an expression), recorded
explicitly rather than invented. Runnability inherited from the contract:
LOCAL 17, LOCAL+TOOL 10, CI-ONLY 20.
