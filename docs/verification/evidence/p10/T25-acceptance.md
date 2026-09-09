# T25 — P10 certificate acceptance evidence

Base `249bf314` · contract `b594ebd9`. P10 aggregates proof; it invented no
new verification.

## The machine (`scripts/ci/p10/certificate.mjs`)

`issue` refuses unless: every preceding phase (PB, P00–P09) is ACCEPTED; all
mandatory units outside P10 are closed; zero flaky mandatory; zero open
MEDIUM+ defects lacking a graduation-queue disposition; the graduation
enforcement hook holds; the tracked tree is clean; the ledger matches its
pin. `verify` re-derives EVERY binding from disk in a fresh process:
staleness first and cheaply (a moved base is NOT_COMPARABLE, never a parity
mismatch), then dirty-tree, then field-by-field voids with `verifier_hash`
ahead of `head_sha` (the more specific void first).

Bindings: head/base/merge-tree shas · lockfile sha256 · contract sha256 ·
verifier hash (content hash over every tracked `scripts/ci/**` file) ·
toolchain (node, pnpm, platform, the DEF-062 worker profile, 9 governed tool
identities) · cleanroom identities (Dockerfile base digests, MySQL fixture) ·
ASSURANCE artifact sha256 · ledger sha256 + pin · execution history.

## First issuance + independent verification

`ISSUED` `f14af9207baf…` at the pre-acceptance HEAD; an independent `verify`
process re-derived every binding from disk and returned **VALID** (TEST03).
Certificate lifecycle law: a certificate never survives its own acceptance
commit — the operative certificate is always issued from the final HEAD (the
`ci:verify:pr` rehearsal exercises exactly this).

## The eight negatives (`T25-negatives.log` + worktree sandboxes)

| NEG | Forced condition | Verdict |
| --- | --- | --- |
| NEG01 | tracked file touched | VOID(head_sha, DIRTY_TRACKED_FILES) |
| NEG02 | origin/main moved (override to the real prior base) | NOT_COMPARABLE(STALE_BASE) — first draft CRASHED here deriving a merge tree against the moved base; staleness now precedes derivation |
| NEG03 | `scripts/ci/**` edited (the fix commit itself) | VOID(verifier_hash) |
| NEG04 | a mandatory unit marked flaky (doctored sandbox) | REFUSED FLAKY_MANDATORY |
| NEG05 | a mandatory unit forced NOT_STARTED | REFUSED UNITS_OPEN |
| NEG06/08 | P09 forced to TESTING | REFUSED PHASE_NOT_ACCEPTED: **P09**, named |
| NEG07 | ledger bytes changed, pin stale | REFUSED LEDGER_TAMPERED |

## T04 — remote reconciliation found REAL drift (DEF-065)

Live ruleset (18701573): **10** required contexts; classic protection ABSENT.
The program's snapshot records **9** — `13-tos-notion-context` was added
mid-program by the TOS-009 work. The added check is credential-bound
(NOT_LOCALLY_EXECUTABLE, the T13 nonlocal class, exactly like
dependency-review), so no local-parity verdict changes; PRs additionally
need it green in CI. Recorded as DEF-065 (LOW, queue-dispositioned);
snapshot refresh rides the next contract re-derivation.

## T05/TEST02 — one real PR, field-for-field

PR #510: locally computed `git merge-tree --write-tree 44c13742 759000a9` =
`e67d0af39842…` == the tree of CI's actual merge commit `249bf314` —
**exact match**, comparing merge_tree_sha and never merge_commit_sha
(`T25-reconciliation.json`).

## T07/AUTH01 — the opt-in pre-push hook

`install-hook` writes a pre-push that runs `verify` — an explicit per-clone
developer action; NEVER auto-installed, trivially removable. Authorization
covers availability (built and documented); activation remains individual
opt-in. This program did not install it anywhere.

## T08 — /eng-loop evidence record

This document plus the reconciliation artifacts constitute the evidence
record; the engineering-federation record template's terminal outcome for
this change is ACCEPTED-with-evidence (the full record set lives under
`docs/verification/`).
