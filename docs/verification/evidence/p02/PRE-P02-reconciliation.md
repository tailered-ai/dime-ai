# Pre-P02 reconciliation — two P01 bookkeeping items

Performed before P02 left `NOT_STARTED`. Nothing sealed was rewritten.

## Item 1 — defect arithmetic, DERIVED from the canonical ledger

Not assumed from prose. Read directly from `ci-verify-ledger.json`:

| Fact | Value |
| --- | --- |
| total defects | **16** |
| closed | **16** |
| open | **0** |
| detected_by a P01 unit | **8** — DEF-009, DEF-010, DEF-011, DEF-012, DEF-013, DEF-014, DEF-015, DEF-016 |
| detected_by a pre-P01 unit | **8** — DEF-001 .. DEF-008 |

This matches the expected arithmetic exactly (8 + 8 = 16). **The canonical
ledger was never wrong.** The error was confined to prose inside the sealed
`P01.CP01` document, which stated "7 opened in P01" and "15 defects" because
DEF-016 was opened *after* CP01's evidence hash was recorded.

Corrected by the append-only addendum `p01/CP01-addendum-defect-count.md`.
`P01.CP01` itself is left byte-identical: its evidence hash is recorded in the
ledger, and editing it would trip STALE_EVIDENCE and destroy the audit chain.

No new DEF was opened for this: the canonical state was correct, the discrepancy
was already identified by the owner, and the frozen instruction prescribes an
addendum for exactly this case.

## Item 2 — DEF-016 attribution, established by MECHANISM not intent

Claim under test: `.claude/scripts/bootstrap-gstack.sh` was mutated by an
external/concurrent process, not by P01.

### Mechanism (the decisive evidence)
`.claude/settings.json` — itself one of the unrelated modified files — registers
the script as an automatic hook:

    SessionStart -> "${CLAUDE_PROJECT_DIR:-.}/.claude/scripts/bootstrap-gstack.sh"  (timeout 300)

The hook registration is part of the same unrelated gstack change set
(`git diff .claude/settings.json` adds those lines). The script's own header
describes it as a self-managing rehydration hook that clones, builds and
re-installs gstack, and persists configuration via `gstack-config`.
Corroborating runtime state `.gstack/` exists at the repository root (created
2026-08-10 01:20) containing `claude-available.json`.

### Timeline — three distinct content hashes observed
| Observation | SHA-256 | mtime |
| --- | --- | --- |
| P01 start fingerprint | `c7421fe28246ffce81d3a0995a03bfcd8bc80771630e00aa125211b714198651` | before P01 |
| P01.CP01 | `b5ad431e72876cceb386990f1df1eb567d00d2a57edd6760145ae4ec9b44a6a1` | 2026-08-10 02:07:19 |
| P02 baseline | `5df8d80c4783a3833d89cfdc15d65a4cb4afaf489a202542909a280860693147` | 2026-08-10 02:30:26 |

The third mutation occurred **after the P01 commit**, during a window in which
the only operations performed were reads. A file that keeps changing while the
agent performs no writes to it is not being changed by the agent.

### P01's controlled writes, for contrast
`scripts/ci/provenance-audit.mjs` 02:08:47 · `scripts/ci/snapshot.test.ts`
02:14:22 · `.gitignore` 02:15:05 · `scripts/ci/snapshot.mjs` 02:20:19.
Every controlled write lands under `scripts/ci/`, `docs/verification/`, or
`.gitignore`. None under `.claude/`.

### Required assertions
| Assertion | Value | Basis |
| --- | --- | --- |
| P01 adopted/staged/committed unrelated paths | **0** | path is untracked; `git log --all -- <path>` returns nothing; absent from the P01 commit's 24-path list; staged-allowlist guard passed |
| P01-controlled proven writes to unrelated paths | **0** | controlled writes enumerated above; no `.claude/` target |
| externally/concurrently mutated unrelated paths observed | **1** | mechanism (SessionStart hook) + 3 distinct hashes + post-commit read-only mutation |

Attribution is supported by mechanism and repeated observation, not by intent.
DEF-016 remains CLOSED on that basis; no reopen or supersede is required.

### Not reverted
The file is left exactly as the external process wrote it. Reverting another
process's file to make a checkpoint look tidy would itself be an unauthorised
mutation of unrelated work.
