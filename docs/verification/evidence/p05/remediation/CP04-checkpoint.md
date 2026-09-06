# P05.CP04 — integration checkpoint

**Supersedes CP01/CP02/CP03 for progression.** All three preserved
byte-for-byte (`1a5009ba…`, `bf3692d4…`, and CP03 unchanged).

## Identity

| Field | Value |
| --- | --- |
| Branch | `feat/ci-verify-control-plane` |
| HEAD (unchanged this turn) | `d07a1c3877adb8846330ab06c57652befb5b55ad` |
| `origin/main` at last checkpoint | `1c17c5554a75be752307a686b7662fb6b10fb375` |
| `origin/main` NOW | **`7fa4b3fe49f67f98e5aaa1fe466862ee3cfa20d9`** — moved again |
| Validated merge (helper ref) | `7ba00d8ed3d439e03d7548cdc9168d48b9b14224` |
| Merge parents | `d07a1c38` (branch) + `7fa4b3fe` (main) — real merge, no rebase/squash |

`origin/main` advanced **twice** during this program. The stale `1c17c555`
was correctly rejected and the freshly fetched SHA used instead.

## Incoming delta reviewed (`4d644cf4..7fa4b3fe`)

8 commits, 24 files, **18 workflows**:

| Commit | Substance |
| --- | --- |
| `23c00508e` | Dependabot: `pnpm/action-setup` 4.3.0 → 6.0.10 (the 18-workflow touch) |
| `91b13daa1` / `1c17c5554` | PR #495 — deterministic global gstack bootstrap |
| `4ce7f671d` / `7fa4b3fe4` | PR #494 — `react-day-picker` 9.11.1 → 10.0.1 |

Non-workflow: `.claude/scripts/bootstrap-gstack.sh` (added),
`.claude/settings.json`, `CLAUDE.md`, `.gitignore`, `package.json`,
`pnpm-lock.yaml`.

## Dry-run and conflict resolution — done, and proven

Dry run in a **disposable worktree** (developer tree never touched) produced
exactly one conflict — the pre-authorized `.gitignore`. `package.json` and
`pnpm-lock.yaml` auto-merged.

Resolution by exact semantic union:

| Check | Result |
| --- | --- |
| Conflict markers remaining | 0 |
| `.gstack/` entries | exactly **1** |
| ci:verify entries (4 expected) | **4/4** |
| Rule-set union (base ∪ ours ∪ theirs) | 121 rules wanted, **121 present** |
| Missing rules | **none** |
| Unexpected new rules | **none** |
| No reformatting/cleanup | confirmed |

The resolved file is **byte-identical** (`a4ad5414…`) to the developer's
current local `.gitignore` — so the integration loses nothing.

## Effect on the contract and the four proofs — measured

Regenerated in the integrated tree through the canonical P02 extractor:

- conformance correctly reported **`CONTRACT_DRIFT` on all 18 workflows**
  before regeneration (the detector working);
- contract SHA in the integrated tree: `400cc039…`;
- registry: **47 PARITY entries, 9 required, 5 graduating, runnability
  17/10/20 — all unchanged**;
- **all four proven gates keep their exact run-step indices and commands**:

| Gate | Fixture expects | Integrated tree |
| --- | --- | --- |
| `ci.yml#typecheck` | step 4 | `[4] npx tsc --noEmit …` ✓ |
| `01-pr-proof-contract.yml#format-check` | step 4 | `[4] npx prettier --check .` ✓ |
| `08-contract-and-data-integrity.yml#contracts` | step 5 | `[5] npx vitest run scripts/migration-journal-integrity…` ✓ |
| `05-workflow-security.yml#zizmor` | steps 2,4 | `[2] …--format sarif`, `[4] …--format plain` ✓ |

Main's changes are action-SHA bumps that do not alter run-step structure, so
**no fixture would need weakening** — the primary risk of this integration is
retired by evidence.

## The blocker — DEF-030

The validated merge **cannot be placed on the branch**. Git refuses,
atomically:

```
error: Your local changes to the following files would be overwritten by merge:
	.claude/settings.json
	.gitignore
	CLAUDE.md
error: The following untracked working tree files would be overwritten by merge:
	.claude/scripts/bootstrap-gstack.sh
Aborting
```

Four **unrelated, uncommitted** developer paths collide with the incoming
merge. `HEAD` is unchanged and nothing was written.

Why they collide: PR #495 (gstack bootstrap) merged upstream while the
developer still holds the same work uncommitted locally. Proven:

| Path | Local vs `origin/main` |
| --- | --- |
| `.claude/settings.json` | **byte-identical** |
| `CLAUDE.md` | **byte-identical** |
| `.claude/scripts/bootstrap-gstack.sh` | **byte-identical** |
| `.gitignore` | differs only by our own committed ci:verify block — i.e. equals the proven merge resolution |

**No developer content is at risk.** But clearing the collision requires
committing, stashing, or removing their work, and §1 forbids exactly that:
*"halt with an explicit integration blocker rather than forcing the branch
update."*

## Inventory and preservation

99 working-tree entries classified, **zero UNKNOWN**: 29
`UNRELATED_PREEXISTING`, 48 `GENERATED_EVIDENCE`, 21
`P05_AUTHORIZED_UNCOMMITTED` (`INTEGRATION-inventory.json`).

After all integration work: **29/29 unrelated paths byte-unchanged**,
`.gitignore` still `a4ad5414…`, `HEAD` still `d07a1c38`. No stash, reset,
clean, checkout, or staging of unrelated content was used at any point.

## Ledger

Defects **30 total, 28 closed, 2 OPEN**: `DEF-029` (stale candidate —
substantively resolved by this integration but not closable until it lands)
and `DEF-030` (the landing blocker). Amendments AMD-001..AMD-009.

## ACCEPT(P05)

| Term | Value |
| --- | --- |
| `all_mandatory_closed` | true |
| `all_gates_pass` | true |
| `all_checkpoints_recorded` | true |
| `all_authorizations_granted` | true |
| `zero_blocking_open_defects` | **false — DEF-029, DEF-030 OPEN** |
| `evidence_complete` | true |
| `zero_flaky_mandatory` | true |

## Decision

**DO NOT PROCEED**

**Blocking IDs: DEF-029, DEF-030**

The integration itself is done and proven — conflict resolved as an exact
union, contract impact measured, registry counts unchanged, and all four
proofs shown to survive with their fixtures intact. It simply cannot be
placed on the branch while four unrelated files sit uncommitted, and clearing
them is the developer's call, not mine.

**To unblock**, from the repository root:

```
git checkout -- .gitignore .claude/settings.json CLAUDE.md
rm .claude/scripts/bootstrap-gstack.sh
```

All four are provably redundant: three are byte-identical to `origin/main`,
and `.gitignore`'s local content is exactly what the merge produces. Then
`git merge origin/main`, resolve `.gitignore` to the union above (one
`.gstack/`, all four ci:verify entries), and the validated tree at
`integration/main-7fa4b3fe` is reproduced — after which the contract
re-derives and the four proofs re-run against the new candidate.

Note: `origin/main` has moved twice in this session, so the base must be
re-resolved immediately before final acceptance.
