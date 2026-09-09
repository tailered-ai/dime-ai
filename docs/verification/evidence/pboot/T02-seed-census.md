# PB.T02 — evidence record (immutable observation)

Ledger seeded from `scripts/ci/blueprint.mjs` at HEAD `4d644cf47d2ee8a1528e1efd8a79da5ce658d8c6`.

| Field | Value |
| --- | --- |
| Ledger path | `docs/verification/ci-verify-ledger.json` |
| SHA-256 at seed time | `48d8f5461af629237fe284478484aa0bc3598fb3c668849f457da8c9a494bd63` |
| Units seeded | 249 |
| Phases | 12 |
| MANDATORY units | 247 |
| ADVISORY units | 2 |
| All at NOT_STARTED | true |

## Per-phase unit census
| Phase | Units | MANDATORY | ADVISORY |
| --- | --- | --- | --- |
| `PB` | 11 | 11 | 0 |
| `P00` | 13 | 13 | 0 |
| `P01` | 25 | 25 | 0 |
| `P02` | 21 | 21 | 0 |
| `P03` | 18 | 18 | 0 |
| `P04` | 24 | 24 | 0 |
| `P05` | 20 | 20 | 0 |
| `P06` | 29 | 29 | 0 |
| `P07` | 25 | 24 | 1 |
| `P08` | 24 | 23 | 1 |
| `P09` | 17 | 17 | 0 |
| `P10` | 22 | 22 | 0 |

Uniqueness and completeness are enforced in code by `assertBlueprintUnique`
(PB.NEG01) and `assertSeedComplete` (PB.NEG02); both are exercised in
`PB-validation-run.txt`.
