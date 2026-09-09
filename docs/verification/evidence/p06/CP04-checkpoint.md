# P06.CP04 — PARITY Static/Security/Supply-Chain checkpoint

**Supersedes CP01/CP02/CP03 for progression.** All three preserved unchanged.

## Identity

| Field | Value |
| --- | --- |
| Branch | `feat/ci-verify-control-plane` |
| HEAD (unchanged this turn) | `705c9898eed249136cb02945c3f7cfd2124bda02` |
| `origin/main` at CP03 | `7fa4b3fe49f67f98e5aaa1fe466862ee3cfa20d9` |
| `origin/main` NOW | **`29a4a97ec15002b596247ec22efc9048e232f147` — moved** |
| Candidate | **cannot be constructed — `BLOCKED(MERGE_CONFLICT)`** |
| Host | arm64, 8 cores, 8 GB |
| Ledger | verifies clean |

## DEF-047 is solved, and the cause was not in either test

The previous checkpoint recorded the mandatory `#proof` gate as intermittent,
failing three times on three different single tests out of 5,090. The instinct
this program exists to resist is to call that "a flaky suite" and start
adjusting thresholds. Measuring the host first found the actual cause.

**Eight orphaned processes had been saturating all eight cores for 2 days
23 hours.** Their command line reads, in full:

```
# background CPU load
for c in 1 2 3 4 5 6 7 8; do (while :; do :; done) & done
...
kill $LOADPIDS 2>/dev/null; echo done
```

They were deliberate synthetic CPU-load generators, spawned by a **previous
Claude Code session** to test whether a different flaky test failed under
pressure. That script ends by killing them, but its parent died first, so the
eight busy-loops were reparented to `launchd` and never terminated. Host load
average at resumption: **36.9, rising to 58.2** — roughly 5–7× oversubscription,
present during every `#proof` run recorded under DEF-047.

This explains the observations exactly, including the one that looked
strangest. The failures were **not confined to one test**, which is the
signature of resource starvation rather than a race in any single test. A
bcrypt wall-clock bound and a subprocess-startup test are precisely what
breaks when the CPU is six times oversubscribed, and both passed in isolation
because one test still gets scheduled promptly.

Recorded as **DEF-049** (CLOSED). The eight were identified by exact
signature, confirmed orphaned with no output or side effects, and terminated —
SIGTERM was ignored, SIGKILL was required. Load fell from 58.2 to 5.3.

**No test was modified, no threshold widened, no retry added, nothing excluded
or allowlisted.** None of the forbidden stabilizations were needed, because the
defect was in the environment and was fixed at its source.

### Post-remediation evidence

| Measurement | Result |
| --- | --- |
| `observe-crons` isolated | **10 / 10 PASS** |
| Full 5,326-test collection | both previously-failing tests **PASS** |
| bcrypt cost=10, 40 samples, healthy host | min 58 ms · median 60 ms · p95 65 ms · max 86 ms |
| bcrypt headroom vs its own 500 ms bound | **~8×** |

The bcrypt bound is therefore not a contention proxy on a healthy machine, so
the §6 trigger for restructuring it is not met and it was left alone.

## The new blocker: no candidate can be built

`origin/main` advanced to `29a4a97e` while this branch stood still. P01 now
refuses with `BLOCKED(MERGE_CONFLICT)` on `pnpm-lock.yaml`, so **no P06 gate,
no determinism campaign, and no ASSURANCE cycle can execute against a current
base.** Recorded as **DEF-050**.

The collision is narrow and fully characterized. Main brought four dependabot
bumps (framer-motion 12→13, nanoid 5→6, `@types/node` 24→26,
react-resizable-panels 3→4) plus `actions/setup-node` 4.4.0→7.0.0 across 23
workflow files. This branch contributes exactly **one** dependency:
`yaml@2.9.0` — the parser P02's contract extraction is pinned to. Both edit
`pnpm-lock.yaml`; `package.json` auto-merges cleanly.

The remedy was **proven in a disposable worktree without touching the branch**:
merge `origin/main`, resolve `pnpm-lock.yaml` by taking main's copy, then
regenerate with `pnpm install --lockfile-only`. Verified outcome — zero
conflict markers, our `yaml 2.9.0` pin preserved, and
`pnpm install --frozen-lockfile` exits 0 against the result.

It was not applied because applying it means an integration merge commit on
the branch, and this turn's commit policy scopes commits to P06-authorized and
P07-authorized files upon phase acceptance.

Note also that the contract will need re-deriving once the merge lands: main
changed the `setup-node` pin in 23 workflows, which the frozen contract does
not yet reflect.

## A regression this turn's own discipline caught

Running the full cross-phase audit surfaced defects in the modules added last
turn — **56** P03 workflow-path violations and **8** P01 provenance
violations, in two phases that were already ACCEPTED. Recorded as **DEF-051**
(CLOSED).

The serious half was not the missing allowlist entries. `run-gates.mjs` and
`run-p07.mjs` each resolved `git rev-parse origin/main` themselves to check
candidate freshness. P01 is the sole resolver of branch provenance, and a
second module quietly deciding what the base is, is exactly the defect class
DEF-025 recorded earlier in this program.

It was fixed at the root rather than exempted. `assertFreshBase` now compares
two values P01 already produced — the base recorded in reused evidence against
the base of the freshly built candidate — which is the real staleness question
and needs no ref resolution at all. The two remaining `rev-parse HEAD` calls in
the ASSURANCE fixture were replaced with the symbolic ref `HEAD`, which git
resolves inside the disposable candidate and is exactly equivalent. Only the
genuinely descriptive cases — modules that *name* contract check IDs — received
documented allowlist entries.

Result: P03 violations 56 → 0, P01 provenance violations 8 → 0, and the
affected suites pass with `P07.NEG08` rewritten to the new contract.

## Open defect reconciliation (§16)

| ID | Severity | Disposition |
| --- | --- | --- |
| DEF-044 | MEDIUM | **Re-proven this turn.** The money rule still cannot fire: identical rule minus the `$C` constraint reports 1 finding, with it 0. A blocking ERROR-severity rule over billing math remains vacuous. Fixing `.semgrep/` rules is outside P06's authorized scope. |
| DEF-045 | MEDIUM | Unchanged; requires a candidate to re-measure against the new base. |
| DEF-046 | LOW | Nightly/AUDIT tier, non-blocking for the merge contract. Deliberately kept separate. |
| DEF-047 | HIGH | Root cause established and remediated (DEF-049). **Still OPEN** — closure requires the 5-run determinism campaign, which needs the candidate DEF-050 blocks. |
| DEF-049 | HIGH | **CLOSED** — load generators terminated, retested. |
| DEF-050 | HIGH | **OPEN** — candidate unconstructable. |
| DEF-051 | MEDIUM | **CLOSED** — audit violations fixed at the root. |
| DEF-052 | MEDIUM | **OPEN, candidate finding.** The bcrypt test hardcodes cost 10 in its own call, so it verifies nothing about the five production hashing sites. Not changed: altering a test to fix an environment defect is the dishonest stabilization this program forbids. |

## Seven-term ACCEPT(P06)

| Term | Value |
| --- | --- |
| `all_mandatory_closed` | true |
| `all_gates_pass` | **false** — no gate can execute; no candidate |
| `all_checkpoints_recorded` | true |
| `all_authorizations_granted` | **false** — the merge remedy exceeds this turn's commit scope |
| `zero_blocking_open_defects` | **false** — DEF-047, DEF-050 |
| `evidence_complete` | **false** — all P06 evidence binds to the superseded base `7fa4b3fe` |
| `zero_flaky_mandatory` | **not yet establishable** — campaign blocked |

## Decision

**DO NOT PROCEED**

**Blocking IDs: DEF-050, DEF-047**

DEF-050 is the gating one and it is not a verification failure — it is the
ordinary consequence of a branch falling behind a moving main. DEF-047 is now
a solved problem awaiting the proof run it needs a candidate to perform.

No P06 acceptance baseline commit is created.
