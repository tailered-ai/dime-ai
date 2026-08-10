# AMD-006 rationale — five new P05 unit declarations

The P05 execution authorization (2026-08-10) mandates work products beyond
the original P05 blueprint block:

| New ID | Kind | Source in the authorization |
| --- | --- | --- |
| `P05.NEG05` | NEGATIVE_VALIDATION | §17 — WRONG_REASON adversarial validation: a gate failing for a reason other than the intended detector is BROKEN-GATE(WRONG_REASON), never proof |
| `P05.NEG06` | NEGATIVE_VALIDATION | §18 — the 25-case false-assurance adversarial suite (no-op/wrong-file/partial poison, BLOCKED/TIMEOUT/INFRA/INCONCLUSIVE/CI-ONLY results, missing/tampered evidence, duplicate/malformed fixtures, traversal/symlink escapes, poison-surviving cleanup) |
| `P05.NEG07` | NEGATIVE_VALIDATION | §20 — interruption during patch/target/restore/control can never emit a proof and never lets poison escape |
| `P05.TEST04` | POSITIVE_VALIDATION | §23 — determinism: repeated cycles yield identical logical proof semantics; flaky fixtures are never PROVEN |
| `P05.AUD02` | AUDIT | §22 — architectural-isolation audit: no duplicate P01–P04 mechanisms |

Rules honored: ADDITIVE ONLY — no existing P05 unit renamed, renumbered, or
retitled; frozen `depends_on` of GATE01/GATE02/CP01 untouched; GEN-000
byte-identical; `sync` seeds the new records. Precedent: AMD-005 (P04),
AMD-004 (P03), AMD-003 (P02).
