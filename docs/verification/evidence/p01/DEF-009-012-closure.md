# DEF-009 .. DEF-012 — closure record (all found by P01's own validations)

Every one of these was surfaced by the P01 test suite on its first run. That is
the suite working as intended: none reached a recorded PASS.

## DEF-009 — provenance audit raised a false violation on prose (MEDIUM)
**Root cause.** The audit text-matched `origin/main` inside `blueprint.mjs`,
where the string appears in the P-BOOT entry checklist ("…cut from
origin/main"). A declarative registry cannot resolve a SHA, so this was noise.
**Correction.** Added `invokesSubprocess()`: identity patterns are violations
only in modules that can actually invoke a subprocess. Modules that cannot are
classified `declaration-only` and reported as notes. Comments are stripped
first. Limitation stated in code: a fully dynamic command string would evade
detection.
**Retest.** `provenance-audit` exits 0; `blueprint.mjs` appears as a
`declaration-only` note; the NEG04 fixture still fails the audit.

## DEF-010 — REPOSITORY_MISMATCH on every temp-directory fixture (HIGH)
**Root cause.** `assertRepository` compared `path.resolve()` strings. On macOS
`git rev-parse --show-toplevel` returns the physical path
(`/private/var/folders/...`) while callers pass the symlinked one
(`/var/folders/...`), so every fixture repo was rejected as a different
repository.
**Correction.** Compare `realpathSync()` on both sides.
**Retest.** TEST01, TEST03 and the dirty-tree fixture all pass.

## DEF-011 — degenerate merge misrepresented (MEDIUM)
**Root cause.** When `base_sha === head_sha`, `git commit-tree -p X -p X`
emits "duplicate parent … ignored" and stores ONE parent. The snapshot declared
`parent_order: [base, head]` with no record of what git actually wrote.
**Correction.** Read the parents back from the created object and record
`parents_effective` and `degenerate_merge` alongside the declared
`parent_order`. `validateSnapshot` now rejects a snapshot whose degenerate flag
disagrees with the stored parents.
**Retest.** TEST02 asserts the collapse explicitly; a tampered degenerate flag
is rejected.

## DEF-012 — conflict parser captured informational messages (HIGH)
**Root cause.** With `--name-only`, `git merge-tree --write-tree` emits
`<tree>` on line 0, the conflicted file NAMES immediately after, then a blank
line, then informational text. The first parser sliced FROM the blank line, so
`conflicting_paths` returned `["Auto-merging conflict.txt", "CONFLICT
(content): …"]` instead of `["conflict.txt"]` — the exact paths a caller needs.
**Correction.** Slice `lines.slice(1, firstBlankIndexAfterLine0)`.
**Retest.** NEG01 asserts `conflicting_paths === ["conflict.txt"]` and that no
snapshot is emitted and no worktree leaks.
