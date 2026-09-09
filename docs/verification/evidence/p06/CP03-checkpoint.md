# P06.CP03 — PARITY Static/Security/Supply-Chain checkpoint

**Supersedes CP01/CP02 for progression.** Both are preserved unchanged; CP02's
"DO NOT PROCEED" and its diagnosis-only status remain part of the record.

## Candidate identity

| Field | Value |
| --- | --- |
| Branch | `feat/ci-verify-control-plane` |
| HEAD (unchanged this turn) | `705c9898eed249136cb02945c3f7cfd2124bda02` |
| `origin/main` (re-fetched) | `7fa4b3fe49f67f98e5aaa1fe466862ee3cfa20d9` — unmoved |
| Contract | `400cc0391547435d…` (51 checks) |
| Registry | 47 PARITY entries · 9 required · 5 graduating · runnability 17 LOCAL / 10 LOCAL+TOOL / 20 CI-ONLY |
| Ledger | verifies clean |

Candidate freshness was asserted mechanically: every run refuses with
`STALE_CANDIDATE` unless the worktree's `origin/main` equals the recorded base.

## What changed: the boundary model is now WIRED, not just modelled

CP02 recorded a correct model that was not connected to execution. It is now
the execution path. `runOneGate()` is the single entry point used by **both**
the production roster and the ASSURANCE framework, so a proof can never
exercise a different path than a result.

Per gate the runner now: classifies every contract step as PROVISIONING or
DETECTOR; computes each step's contract-effective working directory and
verifies `actual_cwd == contract_effective_cwd` before interpreting output;
resolves governed tool identity; executes steps individually under GitHub's
own shell semantics; and lifts a verdict from a journal under a frozen
exit-code protocol.

The hard invariant is enforced in `liftVerdict()`: **no PASS and no FAIL
exists unless the journal proves the detector validly began under a verified
cwd.** Everything unprovable fails closed to `INFRA_FAIL`.

## Gate results (all 16 P06-owned gates)

Two full rosters were run under the wired model. The table below is roster
v4; the **final** roster, executed after the last correction, reproduced it
except for `#proof`, which failed on the intermittent described under
DEF-047. That difference is the finding, not a footnote: the same gate, the
same candidate, and the same code produced PASS in one run and FAIL in the
next, on a single test out of 5090.

**Roster v4: 7 of 7 mandatory gates PASS, blocking 0.**
**Final roster: 6 of 7 mandatory PASS, `#proof` FAIL (1 test of 5090).**

Final-roster deltas from the table below: `09-artifact` PASS in 1244.8 s (a
cold image rebuild after the previous run's cleanup removed the cached
layers), and the same three non-mandatory FAILs. Everything else reproduced.

### Final classification — §6

**All 16 P06-owned gates are locally executable: 8 `LOCAL`, 8 `LOCAL+TOOL`,
0 nonlocal.** Of the 7 required gates, 7 are locally executable and 6 carry a
current ASSURANCE proof. The §14 nonlocal audit consequently has **zero
entries** — CP02's 1 SECRET_BOUND + 2 RUNTIME_UNAVAILABLE + 1
ACTION_SEMANTICS_UNREPRODUCED have all been reproduced, the first by a
faithful gitleaks adapter and the rest by the authorized Docker daemon plus
governed trivy/syft adapters.

| Gate | Result |
| --- | --- |
| `01-pr-proof-contract#proof` **(req)** | PASS — 317 files, 5089 tests |
| `01-pr-proof-contract#format-check` | PASS |
| `03-semgrep#advisory` | PASS |
| `03-semgrep#blocking` (grad) | PASS |
| `05-workflow-security#zizmor` **(req)** | PASS |
| `08-contract-and-data-integrity#contracts` **(req)** | PASS |
| `09-artifact-build-and-smoke#artifact` (grad) | PASS |
| `10-ai-eval-critical#deterministic` **(req)** | PASS |
| `ci#build` | PASS |
| `ci#security-audit` **(req)** | PASS |
| `ci#typecheck` **(req)** | PASS |
| `edge-arming-gate#validate` | PASS |
| `gitleaks#gitleaks` **(req)** | PASS (faithful adapter) |
| `12-nightly#full-osv` | FAIL — **CI parity**: red in CI too |
| `12-nightly#full-container-scan` | FAIL — **CI parity**: red in CI too |
| `dime-llm-validation#validate` | FAIL — **pre-existing on `origin/main`** |

### The four previously misleading failures, re-run

| Gate | CP02 verdict | Now | Cause of the earlier verdict |
| --- | --- | --- | --- |
| `ci#security-audit` | FAIL on `sudo: a terminal is required` | **PASS** | provisioning, not the detector; governed osv-scanner satisfies it |
| `full-osv` | FAIL on a curl write error | **FAIL (real)** | the curl was provisioning; the detector now runs and genuinely finds vulnerabilities — same as CI |
| `dime-llm-validation` | FAIL "No pyproject.toml" | **FAIL (real)** | wrong cwd; now runs in `ml/dime-1.0` and the failure is the repository's own pre-existing evidence-chain drift |
| `#proof` | FAIL from "80 credential failures" | **PASS** | skipped provisioning; DEF-033's secret-bound diagnosis was wrong and is corrected in the ledger |

### The three remaining FAILs are truthful, not verifier artifacts

- **`full-osv` / `full-container-scan`** — GitHub nightly run `31380149460`
  reports both jobs `failure`. Local and CI **agree**. Trivy finds 1213
  issues (10 CRITICAL) in the Debian base image. Both gates are non-mandatory.
- **`dime-llm-validation`** — measured differentially against a clean
  `origin/main` worktree: base reports 6 failed / 1201 passed, and the
  candidate's failing-test set is **byte-identical** to base's. Nothing here
  originates in this branch.

## Governed tools

Seven identities, each with a recorded derivation chain
(`docs/verification/evidence/p06/action-sources/DERIVATION.md`): semgrep
1.172.0, zizmor 1.29.0, osv-scanner **2.4.0 and 2.2.4** (two distinct
identities — the PR tier and the nightly tier pin different versions, and
collapsing them would be a silent parity break), gitleaks 8.24.3, trivy
0.70.0, syft 1.42.3. Trivy was acquired **only** through the governed path at
the version the pinned `trivy-action` itself defaults to — never "latest".
Governed installs precede the host on `PATH`, so host gitleaks 8.30.1 cannot
shadow the governed 8.24.3.

## gitleaks — Outcome A, faithful adapter

Derived from the pinned action's own `dist/index.js`: gitleaks 8.24.3 and the
exact `Scan()` argv, including `--redact --exit-code=2 --report-format=sarif`
and `--log-opts=--no-merges --first-parent <base>^..<head>`. The action derives
`baseRef` from `pulls.listCommits data[0]`; locally the identical commit comes
from `git rev-list --reverse --topo-order base..head | head -1` over the same
history. `GITHUB_TOKEN` serves commit enumeration and PR commenting — neither
carries the verdict — and the action's own `BASE_REF` override proves the range
is env-derivable. **No token was supplied and none is needed.**

## Defects

Ten new defects were opened this turn. Eight are verifier defects, each found
by execution, corrected, and retested; two of the eight (DEF-047, DEF-048) are
described below. Three are **candidate findings** recorded but deliberately
NOT fixed, because changing repository rules, ml evidence chains, or
dependencies is outside P06's authorized scope.

The most consequential candidate finding: **`dime-money-float-arithmetic-on-cents`
cannot fire.** Its `patterns` block ANDs a `pattern-either` with
`metavariable-regex` constraints on both `$F` and `$C`; `$C` binds only in the
`parseFloat` branch and `$F` only in the arithmetic branches, so each branch
fails the other's constraint. Isolated proof: the identical rule minus the
`$C` constraint reports 1 finding on `invoice.amountCents * 1.0825`; with it,
0. A blocking ERROR-severity rule guarding billing math is vacuous.

The most consequential verifier defect: **`git apply` silently truncates a
patch to its declared hunk count**, which produced a weaker poison that tripped
a different rule than the one under proof. `arm()` now reconstructs the
intended bytes from the patch's own `+` lines and refuses on mismatch — without
that guard, a truncated poison that happened to still trip its target rule
would have manufactured a false ASSURANCE proof.

## Negative suite (§13) — 39 cases

The P06 suite covers the eighteen required classes and more: missing governed
tool → BLOCKED; wrong tool version → refused identity; wrong cwd, missing cwd,
`..` escape and symlink escape → refusal before any verdict; `sudo`
provisioning failure → BLOCKED not FAIL; download provisioning failure →
INFRA_FAIL not FAIL; scanner finding → FAIL; report redirection cannot mask a
detector exit; a fully secret-bound job classifies nonlocal rather than
PASS/FAIL; poison signatures resolve to the exact gate and reason; malformed
detector output fails closed; unresolved `${{ }}` refuses rather than guesses;
a gate with no detector cannot produce a verdict; and — the class that matters
most — PASS/FAIL are structurally impossible without journal-proven detector
execution under a verified cwd.

Two of these were added because live defects demanded them:
`DRV15`/`DRV16` pin GitHub's actual shell semantics after pipefail produced a
false FAIL, and `SPEC03` pins that unproven capability makes provisioning
EXECUTE rather than be assumed.

## Regression run

| Check | Result |
| --- | --- |
| P06 + P07 suites | 56/56 pass |
| `scripts/ci/contract.test.ts` | 31/31 pass |
| Contract conformance | PASS — 40 workflows, 51 checks, 9 required contexts |
| Runtime YAML isolation | 0 violations (3 new declared allowlist entries with reasons) |
| Ledger verify | OK — no tampering, drift, or stale evidence |
| `tsc --noEmit` (working tree, incl. new files) | exit 0 |
| Prettier | all new files conform |

## Seven-term ACCEPT(P06)

| Term | Value |
| --- | --- |
| `all_mandatory_closed` | true |
| `all_gates_pass` | **false** — `#proof` FAIL in the final roster (intermittent) |
| `all_checkpoints_recorded` | true |
| `all_authorizations_granted` | true |
| `zero_blocking_open_defects` | **false** — DEF-047 OPEN (HIGH) |
| `evidence_complete` | true |
| `zero_flaky_mandatory` | **false** |

## Decision

**DO NOT PROCEED**

**Blocking IDs: DEF-047**

`ACCEPT(P06)` fails on two terms, both from the same cause:

- `zero_flaky_mandatory` — **false**. The mandatory `#proof` gate was observed
  failing three separate times, each on a *different* single test out of 5090:
  `scripts/os/observe-crons.test.ts` (twice) and
  `server/updateUserTimeout.test.ts`'s `bcrypt cost=10 completes in < 500ms`.
  It also passed twice. `observe-crons` passes 3/3 in isolation in a
  provisioned candidate, and a bcrypt wall-clock bound is a property of host
  CPU availability rather than of the code — so this is a class of
  timing/contention-sensitive assertions under full-suite load, classified as
  host-environment instability rather than a candidate defect.
- `all_mandatory_proven` — **false**. `#proof` is the one mandatory gate left
  UNPROVEN (ASSURANCE coverage 5/6), because a proof requires a green control
  leg and its control leg is not reliably green.

The tempting move was to re-run until the flake vanished and bank the proof.
That would have satisfied the letter of the ASSURANCE cycle while destroying
its meaning, so the gate stays UNPROVEN and the defect stays open.

## ASSURANCE coverage

**7 of 8 fixtures PROVEN; mandatory local coverage 5 of 6.**

| Fixture | Gate | Verdict |
| --- | --- | --- |
| `p06-typecheck-ts2322` | `ci#typecheck` | PROVEN — TS2322 at step 4 |
| `p06-zizmor-template-injection` | `05-workflow-security#zizmor` | PROVEN — at **step 4**, the enforcement tier, re-verifying the DEF-023 remediation |
| `p06-contracts-migration-mutation` | `08-contract-and-data-integrity#contracts` | PROVEN — committed mutation of an applied migration |
| `p06-security-audit-unpinned-action` | `ci#security-audit` | PROVEN — unpinned action |
| `p06-semgrep-blocking-session-secret` | `03-semgrep#blocking` | PROVEN — `dime-session-secret-fallback` |
| `p06-ai-eval-knowledge-corrupt` | `10-ai-eval-critical#deterministic` | PROVEN — corrupt platform-knowledge artifact |
| `p06-gitleaks-canary` | `gitleaks#gitleaks` | PROVEN — split synthetic canary, joined only inside the candidate |
| `p06-proof-failing-test` | `01-pr-proof-contract#proof` | **BROKEN_GATE(CONTROL_NOT_GREEN)** — DEF-047 |

No P06 acceptance baseline commit is created.
