# Addendum to P01.CP01 — defect count correction

`P01.CP01` is sealed (its evidence hash is recorded in the ledger), so this
correction is appended rather than edited in.

## What the sealed checkpoint says
> Defects — 7 opened in P01, 7 closed, 0 open
> Ledger total across all phases: 15 defects, 15 closed, 0 open.

## What the canonical ledger actually contains
| Fact | Value |
| --- | --- |
| P01-detected defects | **8** (DEF-009 .. DEF-016) |
| cumulative defects | **16** |
| closed | **16** |
| open | **0** |

## Why the prose was wrong
`DEF-016` was opened *after* `P01.CP01`'s evidence hash had been recorded — it
was raised by reviewing the checkpoint's own unrelated-work claim. The
checkpoint therefore counted 7/15 correctly *as of its own sealing instant*,
and became stale one defect later.

**The canonical ledger was never wrong.** Only the human-readable count in the
sealed document was, and only for the window between CP01 sealing and DEF-016
being recorded.

## Correct figures
`DEF-001..DEF-008` = 8 pre-P01 · `DEF-009..DEF-016` = 8 P01 · cumulative 16,
all closed, zero open. Verified by reading the ledger, not by trusting prose.
