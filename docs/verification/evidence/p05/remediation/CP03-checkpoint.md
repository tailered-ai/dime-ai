# P05.CP03 — re-checkpoint after DEF-023 / DEF-027 remediation

**Supersedes CP01 and CP02 for progression purposes.** Both are preserved
byte-for-byte (`CP01-checkpoint.md` sha `1a5009ba…`, `CP02-checkpoint.md`
sha `bf3692d4…`).

## Identity

| Field | Value |
| --- | --- |
| Branch | `feat/ci-verify-control-plane` |
| Execution-start HEAD | `8946b13bcebd155d7b6da73511e2778dae4b5e4d` |
| HEAD after commit 1 | `d07a1c3877adb8846330ab06c57652befb5b55ad` (tree `1bf472e8…`, parent `8946b13b…`) |
| `origin/main` at entry | `4d644cf47d2ee8a1528e1efd8a79da5ce658d8c6` |
| `origin/main` NOW | `1c17c5554a75be752307a686b7662fb6b10fb375` — **advanced mid-session** |
| Candidate at entry | head `8946b13b` · base `4d644cf4` · tree `f5cbb144` · merge `40855c3d` · digest `411fdf5a…` |
| Candidate NOW | **cannot be constructed** — `BLOCKED(MERGE_CONFLICT)` |
| zizmor | 1.29.0 · Node v22.22.0 · pnpm 10.33.0 · git 2.55.0 · container runtime unavailable |

## Authorized remediation — both fixes landed and proven

**AMD-008** authorized the Dependabot correction; **AMD-007** declared CP02;
**AMD-009** authorized append-only evidence supersession (DEF-028).

### `auto-merge-dependabot.yml` (DEF-027)

| | |
| --- | --- |
| Before | `if: github.actor == 'dependabot[bot]' && github.event.pull_request.user.login == 'dependabot[bot]'` |
| After | `if: github.event.pull_request.user.login == 'dependabot[bot]'` |
| SHA-256 | `ec503bf7147b…` → `cc1fdaa050d8…` |

Structured comparison proved triggers, permissions, job id, job name, `uses:`
SHA pins, step-level guards, and `--auto --squash` merge flags all unchanged.

### `05-workflow-security.yml` (DEF-023)

SARIF generation retained and demoted to reporting; a second plain-format run
added as the verdict (Option A — the scanner's own exit semantics, no
reimplemented policy). SHA-256 `c40e7194b599…` → `7bf7f454f7fa…`. Job name,
permissions, and pins unchanged.

## Measured behaviour

| Check | Before | After |
| --- | --- | --- |
| Clean-tree `--format plain` | **exit 14** (1 high: `bot-conditions`) | **exit 0**, zero blocking findings |
| Clean-tree `--format sarif` | exit 0 **with** the finding present | exit 0, empty result set |
| Template-injection poison | gate PASSed (could not reject) | **FAIL, exit 14** |
| Restored control | n/a | **PASS, exit 0** |

The full invariant holds: clean → PASS; HIGH poison → detect → enforcement
nonzero → gate FAIL; restored → PASS.

## ASSURANCE — four real gates PROVEN

`assurance.json` sha `0986a75a…`, `final_status: ASSURANCE_GREEN`, 4/4.

| Gate | Fixture | Poison | Reason matched | Control |
| --- | --- | --- | --- | --- |
| `ci.yml#typecheck` | typecheck-ts2322 | FAIL exit 2 | `TS2322` at the poison file | PASS |
| `01-pr-proof-contract.yml#format-check` | format-check-violation | FAIL exit 1 | `[warn]` + `Code style issues found` | PASS |
| `08-contract-and-data-integrity.yml#contracts` | drizzle-meta-stray | FAIL exit 1 | `contains only drizzle-owned artifacts` | PASS |
| `05-workflow-security.yml#zizmor` | workflow-template-injection | **FAIL exit 14** | `error[template-injection]` + poison path | **PASS** |

Coverage over 47 PARITY entries: **PROVEN 4** · UNPROVEN 0 · NOT_YET_MANDATORY
19 · CI_ONLY 20 · NOT_LOCALLY_EXECUTABLE 4 · `cannot_reject` now empty.

## Contract reconciliation

Drift detected **twice**, correctly, before each regeneration
(`05-workflow-security.yml`, then `auto-merge-dependabot.yml`) — preserved as
negative evidence. Regenerated only through the P02 extractor; byte-stable
across repeated emits; `CONTRACT.md` re-rendered; `doc` conformance PASS.
Contract SHA `58087d2a…` → `9e1296b6…` → `b7f132b7…`.

Registry after regeneration: **47 entries, 4 out-of-scope, 9 required, 5
graduating, runnability 17/10/20 — all unchanged**; zizmor entry keeps its
context, `LOCAL+TOOL` runnability, and tool requirement (`step_count` 4 → 5).
DEF-017/DEF-018 anchors green.

## Defects

**29 total, 28 closed, 1 OPEN.**

- **DEF-023 CLOSED** — root cause recorded precisely: zizmor detected
  correctly; the gate's enforcement logic treated scanner process success as
  security success.
- **DEF-027 CLOSED** — root cause is the workflow condition, not the scanner.
  Guard regression 9/9; spoofing the actor can no longer satisfy the guard.
- **DEF-028 CLOSED** (new, mine) — a per-run artifact recorded at a mutable
  path as immutable unit evidence; the stale-evidence guard caught it.
  Fixed by append-only supersession retaining every prior hash.
- **DEF-029 OPEN** — see below.

## The blocker

`origin/main` advanced mid-session (`4d644cf4` → `1c17c555`; 5 commits, 18
workflow files) and now conflicts with this branch in `.gitignore` — both
sides added `.gstack/`. P01 returns `BLOCKED(MERGE_CONFLICT)`, so **no
candidate can be constructed**, 8 P05 tests cannot run, and the proofs above
certify a merge GitHub will no longer evaluate.

Resolving it means integrating 18 unreviewed workflow changes plus a CI action
bump, then re-deriving the contract and re-proving everything. The
authorization says to stop and report rather than expand scope.

## Regression (before the blocker surfaced)

`scripts/` 634 passed / 8 failed — **every failure is `BLOCKED(MERGE_CONFLICT)`
from DEF-029**, none is a defect in P05. `tsc --noEmit` 0 · prettier 0 ·
ledger verify 0 · contract conformance verify/doc/audit 0 · registry fidelity
0 · P01 provenance 0 · P03 audits 0 · P04 audits 0 · P05 audits 0 ·
**check-github-actions-security 0** · federation docs 0 · frozen install 0.

## Residue and unrelated work

Zero poison in live paths · zero marked processes · zero lane locks · zero
orphaned candidates · unrelated working tree 25 entries, fingerprints
byte-identical.

## Files changed

Committed in `d07a1c38`: the two workflows, `contract.frozen.json`,
`contract.sha256`, `CONTRACT.md`, `dependabot-guard.test.ts`.
Uncommitted: the P05 framework, ledger triplet, evidence, fixtures,
`blueprint.mjs` (AMD-007), `ledger.mjs` (AMD-009).

## ACCEPT(P05)

| Term | Value |
| --- | --- |
| `all_mandatory_closed` | true (CP03 closes with this record) |
| `all_gates_pass` | true |
| `all_checkpoints_recorded` | true |
| `all_authorizations_granted` | true |
| `zero_blocking_open_defects` | **false — DEF-029 (HIGH) OPEN** |
| `evidence_complete` | true |
| `zero_flaky_mandatory` | true |

## Decision

**DO NOT PROCEED**

**Blocking IDs: DEF-029**

Both defects this remediation targeted are closed and the fail-closed gate is
proven end-to-end. Acceptance is blocked only by the world moving underneath
the phase: `origin/main` advanced and conflicts, so no candidate exists to
certify against. One authorization — integrate `origin/main` into this branch
— unblocks it, after which the contract is re-derived and the four proofs
re-run against the new candidate.
