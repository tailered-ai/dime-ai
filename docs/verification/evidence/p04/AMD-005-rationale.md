# AMD-005 rationale — six new P04 unit declarations

The P04 execution authorization (2026-08-10) makes six work products MANDATORY
that the original P04 blueprint block did not declare as units:

| New ID | Kind | Source in the authorization |
| --- | --- | --- |
| `P04.NEG07` | NEGATIVE_VALIDATION | §25 "Add ownership-boundary adversarial tests" — unowned process/tempdir/lock/port/worktree can never be destroyed; traversal and symlink escapes refused; malformed records cannot authorize cleanup |
| `P04.NEG08` | NEGATIVE_VALIDATION | §26 "Add scheduler false-green adversarial tests" — 15 enumerated no-false-green cases |
| `P04.AUD01` | AUDIT | §27 "Audit teardown ownership" — map every cleanup to ownership proof; zero unexplained broad destructive mechanisms |
| `P04.AUD02` | AUDIT | §28 "Audit process/exit-code fidelity" — every spawn path; regression anchor for the piped-`$?` false-PASS class (DEF-007) |
| `P04.AUD03` | AUDIT | §29 "Audit P03 integration" — no parallel taxonomy/summary/registry/parser/ledger |
| `P04.EV01` | EVIDENCE | §11 canonical `executor.jsonl` — a preserved sample from a real mixed-outcome run |

Rules honored:

- ADDITIVE ONLY. No existing P04 unit is renamed, renumbered, reordered, or
  retitled; `P04.GATE01`'s frozen `depends_on` (`CLN01`, `NEG01`, `NEG04`) is
  untouched. The new units are MANDATORY, so `ACCEPT(P04)` requires them
  through the ordinary acceptance algebra without editing frozen exit text.
- GEN-000 stays byte-identical; this amendment authorizes the new
  `blueprint_sha256` append-only, exactly as AMD-002/AMD-003/AMD-004 did.
- `sync` seeds the six records; it can add units, never modify one.

Precedent: AMD-004 (P03's six new IDs), AMD-003 (P02's two new IDs).
