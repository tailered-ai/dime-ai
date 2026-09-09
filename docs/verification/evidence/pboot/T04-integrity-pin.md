# PB.T04 — evidence record (immutable observation)

| Field | Value |
| --- | --- |
| Pin file | `docs/verification/ci-verify-ledger.sha256` |
| Pin contents at seed time | `48d8f5461af629237fe284478484aa0bc3598fb3c668849f457da8c9a494bd63  ci-verify-ledger.json` |
| Recomputed SHA-256 of the ledger JSON at seed time | `48d8f5461af629237fe284478484aa0bc3598fb3c668849f457da8c9a494bd63` |
| Match | TRUE |

The pin is rewritten atomically with the ledger on every `ledger.mjs` write,
so ordinary recorded work never trips LEDGER_TAMPERED; only out-of-band hand
edits do. Detection is proven in `PB-GATE01-negative-proof.txt`.
