# P07.CP04 — PARITY Test/Data stage checkpoint

**Supersedes CP01/CP02/CP03 for progression.** All preserved unchanged.

## Identity

| Field | Value |
| --- | --- |
| Branch | `feat/ci-verify-control-plane` |
| HEAD (unchanged this turn) | `705c9898eed249136cb02945c3f7cfd2124bda02` |
| `origin/main` NOW | `29a4a97ec15002b596247ec22efc9048e232f147` — **moved** since CP03 |
| Candidate | **cannot be constructed — `BLOCKED(MERGE_CONFLICT)` (DEF-050)** |

## Why P07 cannot re-accept, despite its parity being real

CP03 recorded genuine database parity: a verifier-owned MySQL container pinned
to digest `sha256:b3b90af2…857fd3fb` reporting server version 8.4.11,
migration replay through `0134_widen_unit_probability_precision`, 10 DB test
files and 92 tests passing in P04's serial lane, and zero owned residue.

That evidence is **not withdrawn, but it is now stale-based.** Every piece of
it binds to base `7fa4b3fe`, and `origin/main` has advanced to `29a4a97e`.
Under §21 a moved base makes the candidate stale, and stale evidence cannot
carry an acceptance. Re-measuring requires a candidate, and DEF-050 makes the
candidate unconstructable.

This is the correct outcome rather than a disappointing one: P07's own
`assertFreshBase` discipline exists precisely so that evidence measured
against one base is never quietly credited against another.

## Impact assessment of this turn's changes on P07 evidence (§15)

Three changes touched shared code this turn. Their effect on P07 evidence:

| Change | Affects P07 evidence? |
| --- | --- |
| Termination of eight orphaned CPU-load generators (DEF-049) | **Yes, favourably.** The DB suite ran under that starvation and still passed 92/92, so the recorded result stands; a re-run would only be less contended. |
| `assertFreshBase` no longer resolves `origin/main` (DEF-051) | **Yes, structurally.** This is P07 code. Its negative test was rewritten and passes; the staleness guarantee is preserved and now sourced solely from P01. |
| ASSURANCE fixture symbolic-`HEAD` change (DEF-051) | No. P06-only fixture path. |

None of these alter the MySQL digest, the migration chain, the DB suite
membership, the collection floor, or the environment-failure allowlist. What
invalidates the evidence is the base move, not the code changes.

## Structural guarantees — still verified this turn

Re-run and unchanged: DB-suite discovery finds 6 marker files against the
contract's 10 hardcoded suites with exact registration agreement; the
collection-collapse floor re-derives to **1000** from contract text; the
environment-failure model re-derives to 64 allowlist entries and 17 declared
CI skips; impact-mode selection is refused. The 17-case negative suite passes,
including the rewritten `NEG08`.

## Seven-term ACCEPT(P07)

| Term | Value |
| --- | --- |
| `all_mandatory_closed` | true |
| `all_gates_pass` | **false** — no gate can execute; no candidate |
| `all_checkpoints_recorded` | true |
| `all_authorizations_granted` | **false** — the merge remedy exceeds this turn's commit scope |
| `zero_blocking_open_defects` | **false** — DEF-050 |
| `evidence_complete` | **false** — DB parity evidence binds to the superseded base `7fa4b3fe` |
| `zero_flaky_mandatory` | **not establishable** — the shared `#proof` campaign is blocked |

## Decision

**DO NOT PROCEED**

**Blocking IDs: DEF-050, DEF-047**

No P07 acceptance baseline commit is created. The DB parity work is sound and
needs re-measuring against a current base, not rebuilding.
