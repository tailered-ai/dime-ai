# T21 — DEF-062: local worker oversubscription vs CI's 4-vCPU profile

Base: `249bf314` · candidates after `114052b3` (DEF-061 fix aboard).

## Failures

Second roster at the 249bf314 candidate: `#proof` FAIL — **2 of 5,398**
tests, both `Error: Test timed out in 15000ms`:

- `scripts/os/contradiction.test.ts :: prints contradiction YES when most cycles are off-goal`
- `scripts/os/observe-crons.test.ts :: excludes a workflow first added after the measured day, and names it`

Both are subprocess-heavy (`scripts/os/*` tests shell out to node CLIs and
git). Both green on main's CI at `249bf314`; both pass isolated locally. A
*different* single test (the DEF-061 closure test) timed out the same way on
the previous roster, and DEF-060 was the same signature under coverage.
Three distinct tests, one signature: the bound trips only under local
full-suite parallelism.

## Root cause — structural, not per-test

`vitest.config.ts` sets no worker cap, so vitest runs one worker per host
core: **8 workers on this 8-core machine**, sharing those cores with the
verifier harness, Docker Desktop, and the OS. CI's `ubuntu-latest` runner
exposes **4 vCPUs**, so CI never runs more than 4 workers on dedicated
cores. Per-worker CPU starvation is therefore a *local-only* phenomenon:
the same suite, same tests, same 15s `testTimeout` are green in CI while
flaky locally. Fixing individual tests (DEF-060, DEF-061) treated genuine
per-test inconsistencies but cannot terminate an unbounded class.

## Remediation — environment fidelity, one place, both phases

The shared step driver (used by every P06 and P07 gate) now injects
`VITEST_MAX_FORKS=4` / `VITEST_MAX_THREADS=4` into detector environments —
normalizing local execution to CI's own worker profile. This is the same
environment-normalization class as the driver's short `TMPDIR` (AF_UNIX)
and PATH construction: the contract's command text remains byte-verbatim,
and contract-declared step env still supersedes the injection.

Nothing was weakened: no timeout widened, no test excluded, no threshold
changed. The suite simply runs with CI's parallelism instead of an
oversubscribed local guess.

The DEF-060/DEF-061 per-test corrections remain in place on their own
merits (a bound inconsistent with the test's own declared subprocess
budget; an import misplaced inside a bounded test body).

## Retest obligation

Closure requires `#proof` PASS (and the full chain green) at the candidate
containing this normalization.
