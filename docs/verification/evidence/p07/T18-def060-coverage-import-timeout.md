# T18 — DEF-060: coverage-run test timeout on a heavyweight dynamic import

Base: `43a33c84` · candidate head `e672bb11` · gate
`.github/workflows/07-coverage-patch.yml#coverage` (serial chain, run
`2026-08-11T10-42-03Z`).

## Failure

One test failed inside the v8-coverage-instrumented full suite:
`server/strikeoutProps.test.ts :: appRouter has strikeoutProps router` — the
vitest caret points at the test-function header (the timeout signature), on
`await import("./routers")` under `testTimeout: 15000`.

## Why this is the DEF-047 Cause-C class, not a candidate regression

| Observation | Value |
| --- | --- |
| Same test in `ci.yml#test`, same chain, 4 min earlier | PASS (230.2s run) |
| Same coverage gate at candidates 22b02402 / 7e86ad23 | PASS (183.7s / 189.6s) |
| The failing run's wall time | **317.2s** (~70% slower) |
| Host load during the run (15-min avg at 03:50) | **18.06 on 8 cores** |
| The file isolated under the same coverage invocation | 8.6s total, test PASS |
| Content delta at e672bb11 vs 7e86ad23 | `.gitleaks.toml` + docs + ledger — zero measured code |

`await import("./routers")` loads the entire app-router graph — the heaviest
import in the codebase — inside a 15-second-bounded test, under coverage
instrumentation, in a worker sharing 8 cores with the rest of the parallel
suite and an external load spike (Spotlight indexing the verifier's worktree
churn was observed at ~21% CPU). The bound was measuring CPU availability, not
the property under test ("the router exists and has the strikeoutProps
namespace").

## Remediation — deterministic restructure, nothing weakened

The import moved to a **static top-level import**, the same pattern five other
test files already use for `appRouter` (`appUsers.register.test.ts`,
`appUsers.login.test.ts`, `completeAccountSetup.test.ts`,
`betTrackerLifecycle.db.test.ts`, `loginStatus.test.ts`). Module loading is
not governed by `testTimeout`, so the wall-clock proxy is gone entirely —
stronger than widening the timeout. Every assertion is unchanged: the test
still fails if the router cannot be imported (collection error) or lacks the
namespace.

Isolated verification: 9/9 tests pass, per-test time 5ms (import now 3.82s at
collection); `tsc --noEmit` clean.

`testTimeout: 15000` itself was **not** changed.

## Retest obligation

Closure requires the coverage gate PASS in the next full serial chain at the
candidate containing this fix.
