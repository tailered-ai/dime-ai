# P05.CP05 — accepted checkpoint after integrating exact current main

**Supersedes CP01–CP04 for progression.** All four remain byte-unchanged.

## Identity

| Field | Value |
| --- | --- |
| Branch | `feat/ci-verify-control-plane` |
| Starting HEAD | `d07a1c3877adb8846330ab06c57652befb5b55ad` |
| **BASE_SHA (pinned, exact)** | `7fa4b3fe49f67f98e5aaa1fe466862ee3cfa20d9` |
| Changed from prior attempt? | **No** — same SHA as CP04; main did not move during this window |
| Integration merge | `942aa0b1eebb04865405a0c946ddf83c484090ed` |
| Merge parents | `d07a1c38` (feature) + `7fa4b3fe` (exact base) — real merge, no rebase/squash |
| Merged tree | `cdf1eb756fcdc5598f5687c643fbdc6f094f0304` |

## Preservation and reconciliation of the four blocking paths

Preservation bundle built **outside** the working tree and verified before any
path was cleared. Manifest `27c38bf1eaa0bd75…` (`PRESERVATION-manifest.json`).

| Path | Pre-clear SHA-256 | vs BASE_SHA | Merged-tree SHA-256 | Info lost |
| --- | --- | --- | --- | --- |
| `.claude/settings.json` | `3ac663cdee5d…` | **identical** | `3ac663cdee5d…` | 0 |
| `.claude/scripts/bootstrap-gstack.sh` | `709c1a75c432…` | **identical** | `709c1a75c432…` | 0 |
| `CLAUDE.md` | `f1daf101d091…` | **identical** | `f1daf101d091…` | 0 |
| `.gitignore` | `a4ad54143406…` | differs by exactly the 4 authorized ci:verify rules | `a4ad54143406…` | 0 |

Lifecycle recorded honestly, not as "untouched":
`LOCAL_UNCOMMITTED/UNTRACKED → PRESERVED → IDENTICAL_UPSTREAM_COMMITTED` for
the three; `LOCAL/FEATURE/UPSTREAM SEMANTIC UNION → MERGE_RESOLVED` for
`.gitignore`.

Cleared path-by-path: `git checkout --` per tracked file; the untracked file
was **relocated into the preservation bundle**, not deleted. No stash, reset,
clean, broad restore, or mass deletion at any point. Other 25 unrelated paths
byte-unchanged throughout.

**information lost = 0 · unauthorized content adopted = 0**

## Conflict set and `.gitignore` union proof

Exactly one conflict, the pre-authorized `.gitignore`. `package.json` and
`pnpm-lock.yaml` auto-merged.

| Check | Result |
| --- | --- |
| Union expected / resolved unique | **121 / 121** |
| Missing rules | **0** |
| Unexpected rules | **0** |
| Duplicate rules | **0** |
| `.gstack/` count | **exactly 1** |
| ci:verify rules preserved | **4/4** |
| Conflict markers remaining | **0** |
| Equals independently validated helper resolution | **yes** |

**Authoritative merged tree `cdf1eb75…` is byte-identical to the
independently validated helper merge** — the branch received a tree that was
reproducibly understood before it landed.

## Fresh P01 candidate

`head_sha 942aa0b1…` · `base_sha 7fa4b3fe…` · `merge_tree_sha cdf1eb75…` ·
`merge_commit_sha bea3a3a0…` · `identity_digest 0260ab79…` · degenerate=false.
`BLOCKED(MERGE_CONFLICT)` eliminated.

## Incoming main delta

8 commits integrated: `pnpm/action-setup` 4.3.0→6.0.10 (PR #480), gstack
global bootstrap (PR #495), `react-day-picker` 9.11.1→10.0.1 (PR #494).
18 upstream workflows changed; the diff vs our HEAD shows 20 because it also
contains our two authorized workflow fixes. New action pin
`pnpm/action-setup@0977fd99725f1db4007ccb2928dbb4e90d06cc86` is represented in
the regenerated contract.

## Live governance (read-only)

Ruleset `18701573` "main-protection", enforcement **active**, **9 required
contexts** — unchanged from the documented state. No governance defect.

## Contract and registry

Conformance **failed first** with `CONTRACT_DRIFT` on all **18** upstream
workflows (preserved: `DRIFT-post-integration.txt`) — the detector working.
Regenerated through the canonical P02 extractor only; **byte-stable** across
repeated emits; `CONTRACT.md` re-rendered; doc conformance PASS.

Contract SHA `b7f132b7…` → **`400cc039…`**. Census: 40 workflows, 51 checks,
9 required contexts mapped.

Registry reloaded from the regenerated contract with **zero hand-authored
change**: **47 PARITY / 17 LOCAL / 10 LOCAL+TOOL / 20 CI-ONLY / 9 required /
5 graduating** — identical to prior. Tool requirements intact (zizmor 1,
gitleaks 1, semgrep 2, osv-scanner 2, playwright 3, docker 3, trivy 2).
DEF-017 and DEF-018 anchors PASS.

## Four real gates — all re-executed and rebound

New immutable artifact `remediation/cp05/assurance.json`, SHA
`abf4c803c5151ad7…`, `ASSURANCE_GREEN`, bound to candidate head `942aa0b1`
and base `7fa4b3fe`.

| Gate | Fixture | Poison | Reasons matched | Control |
| --- | --- | --- | --- | --- |
| `ci.yml#typecheck` | typecheck-ts2322 | FAIL | 1/1 | PASS |
| `01-pr-proof-contract.yml#format-check` | format-check-violation | FAIL | 2/2 | PASS |
| `08-contract-and-data-integrity.yml#contracts` | drizzle-meta-stray | FAIL | 1/1 | PASS |
| `05-workflow-security.yml#zizmor` | workflow-template-injection | FAIL | 2/2 | PASS |

Coverage: **PROVEN 4** · UNPROVEN 0 · NOT_YET_MANDATORY 19 · CI_ONLY 20 ·
NOT_LOCALLY_EXECUTABLE 4 · `cannot_reject` **empty**.

Prior artifacts superseded **append-only** (DEF-028 mechanism); every prior
hash retained; no evidence mutated in place.

## DEF-023 / DEF-027 regressions after integration

- Clean integrated tree → zizmor plain enforcement **exit 0**, zero blocking
  findings. Poison → **FAIL** with both detector signatures. Restored → PASS.
- Dependabot guard intact at line 31:
  `if: github.event.pull_request.user.login == 'dependabot[bot]'`; no
  `github.actor`; guard tests **9/9**. Upstream did not reintroduce it.

## Regression — direct exit codes

`scripts/` **642/642, exit 0** (37 files) · `tsc --noEmit` 0 · prettier 0 ·
ledger verify 0 · contract conformance verify/doc/audit 0 · registry fidelity
0 · p03-audit 0 · P01 provenance 0 · p04-audit 0 · p05-audit 0 ·
check-github-actions-security 0 · federation docs 0 · frozen install 0 ·
clean zizmor 0 · dependabot guard 9/9.

## Fresh-base check (§25, after the proof workload)

`git fetch origin` → `origin/main = 7fa4b3fe49f67f98e5aaa1fe466862ee3cfa20d9`
= the proof-bound base. **FRESH** — the proofs certify exactly the state
GitHub would evaluate.

## Ledger

Defects **30 total, 30 CLOSED, 0 OPEN**. The erroneous DEF-030
close→reopen→close sequence is retained in its history, unerased. Amendments
AMD-001..AMD-010. Zero flaky · zero missing evidence · zero contract drift ·
zero infrastructure failures · zero inconclusive · zero poison in live paths ·
zero owned residue.

## P05.GATE01 / P05.GATE02

**GATE01 PASS** — four current, candidate-bound real proofs; no stale, flaky,
or infrastructure-substituted proof counted.
**GATE02 PASS** — the coverage law re-proved on the regenerated contract:
graduated + locally executable + no valid proof → `BROKEN_GATE(UNPROVEN)` →
`VERIFIER_BROKEN`; CI-only never required locally; unavailable tooling never
becomes a fake proof; adding a proof clears it and removing it restores
UNPROVEN.

## ACCEPT(P05)

| Term | Value |
| --- | --- |
| `all_mandatory_closed` | true |
| `all_gates_pass` | true |
| `all_checkpoints_recorded` | true |
| `all_authorizations_granted` | true |
| `zero_blocking_open_defects` | **true** |
| `evidence_complete` | true |
| `zero_flaky_mandatory` | true |

## Decision

**PROCEED TO P06/P07**
