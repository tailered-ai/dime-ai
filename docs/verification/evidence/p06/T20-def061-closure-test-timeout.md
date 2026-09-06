# T20 — DEF-061: closure-test timeout at the 249bf314 candidate

Base: `249bf314` (second freeze window) · integration commit `61369e77` ·
first roster at the new candidate.

## Failure

`01-pr-proof-contract#proof` FAIL (315.8s): exactly **1 of 5,398** tests —
`scripts/dime-authentication-closure.test.ts :: authentication bundle
generation is deterministic and closes local imports` —
`Error: Test timed out in 15000ms`. Main's own Vitest check at `249bf314` is
**success**; the test passes isolated locally (14/14 in 2.5s).

## Why this is the DEF-060 class again, with the defect written in the test's own code

The test copies `process.execPath` (the ~110MB node binary) into a temp
candidate and runs bundle-generation subprocesses whose own `execFile` budget
is **30 seconds** (`timeout: 30_000`, line ~429) — an inner allowance that
already exceeds the 15s outer `testTimeout`. The bound is only satisfiable
when the machine is fast enough that the declared budget is never needed:
under full-suite parallelism — now heavier by 305 newly merged TOS-009 tests,
including the 2,236-line lifecycle-writer suite — the slice crossed 15s.
The bound measured CPU/IO availability, not the property (determinism +
import closure).

## Remediation — consistency, not widening

Both tests in the file with this work profile (`copyFile(process.execPath…)`
+ bundle-generation subprocesses: lines 362 and 479) received an explicit
vitest timeout of **120_000**, consistent with the subprocess budgets the
test itself declares. Every assertion is unchanged; the suite still fails on
any determinism or closure violation, on any subprocess failure, and after
120s of genuine hang. The global `testTimeout: 15000` was **not** changed.

Isolated verification: 14/14 PASS (2.99s); `tsc --noEmit` clean.

## Retest obligation

Closure requires `#proof` PASS in the full serial chain at the candidate
containing this fix.
