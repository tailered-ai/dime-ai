# Addendum to P01.CP01 — precise status of the unrelated working-tree entries

`CP01-checkpoint.md` is immutable once its hash is recorded, so this addendum
is appended rather than editing sealed evidence.

## Claim under test
"Unrelated working-tree entries remained untouched."

## Result: 26 of 27 byte-identical; 1 changed by an EXTERNAL process, not by P01

### (a) `vitest-results.phase-a.json` / `phase-b.json` — UNTOUCHED
They dropped out of `git status` because the frozen P01.T09 pattern now ignores
them. The FILES are byte-identical:

    vitest-results.phase-a.json  958d8efcc2b921b0388c95a3db8a2c40f627c6e5d3c01d5ca74b8a7add1ffceb  (unchanged)
    vitest-results.phase-b.json  8f59efde9284d63d2a618848e4729451e6d9263ca774a14ebb30b99e6ada332b  (unchanged)

Ignoring them was explicitly frozen in P01.T09. Visibility changed; content did
not. Neither file was modified, moved, or deleted.

### (b) `.claude/scripts/bootstrap-gstack.sh` — CHANGED, external cause
    at P01 start : c7421fe28246ffce81d3a0995a03bfcd8bc80771630e00aa125211b714198651
    at checkpoint: b5ad431e72876cceb386990f1df1eb567d00d2a57edd6760145ae4ec9b44a6a1
    mtime        : 2026-08-10 02:07:19 (mid-session)

**P01 performed no write anywhere under `.claude/`.** Every P01 write targeted
`scripts/ci/`, `docs/verification/evidence/p01/`, `.gitignore`, and the ledger
artifacts. The change is attributable to the gstack tooling active in this
session — its skill catalogue appeared in the session context during the same
window, and `bootstrap-gstack.sh` is that tooling's own bootstrap script.

**Disposition:** reported, not adopted. The file is untracked, was NOT staged,
and is NOT in the P01 commit. It remains exactly as the external process left
it. P01 neither reverts nor incorporates it — reverting someone else's file
would itself be an unauthorised mutation of unrelated work.

## Why this is stated rather than smoothed over
The frozen requirement is proof that unrelated entries were preserved. A blanket
"all untouched" would have been false. The accurate claim is: P01 modified none
of them; one was modified by another process; and none entered the commit.
