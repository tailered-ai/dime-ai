# T19 — P07 acceptance evidence (base `43a33c84`, candidate `b81f6a47`)

Same candidate identity and contract (`b594ebd9`) as P06's T19. All runs
serial. Structural derivations from the contract text, not assumptions:
`agreement=true`, collection floor **1000**, db-suites 6 by marker / 10 by
contract list, cross-checked through the canonical registration mechanism.

## REG01 — three consecutive identical runs at the same candidate

| Run | ci.yml#test | 07-coverage-patch#coverage | ci.yml#db-tests | Blocking |
| --- | --- | --- | --- | --- |
| 1 (`T19-acceptance-p07.log`) | PASS 179.5s | PASS 172.6s | PASS 48.0s | 0 |
| 2 (`T19-reg2.log`) | PASS 169.0s | PASS 272.4s | PASS 36.5s | 0 |
| 3 (`T19-reg3.log`) | PASS 215.7s | PASS 204.3s | PASS 35.5s | 0 |

Identical verdict vectors, identical structural outputs, identical MySQL
identity (`8.4.11`, digest `…4bb78d37fe8a23eb857fd3fb`), and zero residue —
each run's uniquely-named container removed with `-fv` (three distinct
container ids recorded in the logs). No retries; every run recorded.

## DB parity (P07.T01/T02/T06, EV03)

Per `T02-db-parity.md` and each run above: digest-bound `mysql:8` →
`8.4.11`, loopback-only 3306 with PORT_OCCUPIED refusal, contract-verbatim
env, contract's own readiness probe, `pnpm db:migrate:reconciled` through
`0134_widen_unit_probability_precision`, then the ten real-database suites
serially: **10 files / 92 tests passed**.

## TEST03 — the same-SHA CI comparison, executed for real

The base `43a33c84` is a main commit with an actual CI run:

| Side | Identity | Result |
| --- | --- | --- |
| CI | "DB Tests" job `93703942390`, run `31467601713`, head SHA exactly `43a33c84`, completed 2026-08-11T07:09:18Z | success — **10 files passed, 92 tests passed** (from the job log) |
| Local | verifier db-tests gate at candidate `b81f6a47` | PASS — **10 files passed, 92 tests passed** (step journal) |

Validity of the comparison: `git diff 43a33c84...HEAD` over the ten
contract-listed db suites, `drizzle/`, and server DB code is **empty** — the
DB surface of the candidate is byte-identical to the base the CI run
executed. Same suites, same migrations, same MySQL major, same command
shape, matching counts and conclusion. P07.GATE01 ("TEST03 demonstrated")
is satisfied by execution, not by deferral.

## Environment-failure gate (T07/EV02) — proven by real fire

The gate is not just wired; it caught a real failure during this window:
DEF-060's coverage-run test failure was surfaced by
`[env-gate] ci-failure: server/strikeoutProps.test.ts::… — CI tolerates zero
test failures` (T18). Zero-tolerance semantics demonstrated live.

## Negative program

`p07.test.ts` — 17 tests green in the acceptance regression (56/56 combined
with P06's suite; 880/880 full scripts phase suite): registration-omission
drift, collection floor (below/at/zero), file-load failures never green,
lane serialization, impact-selection refusal, stale-evidence-base refusal,
occupied-port refusal, migration-blocks-suites, undeclared CI skips
rejected, zero-failure tolerance, truncated-results never green.

## Defect state

No open defect attributes to P07. DEF-060 (the one P07-gate defect found
this window) is CLOSED with retest evidence (T18 + run 1 above).

## Freshness

`origin/main == 43a33c84 == FROZEN_BASE_SHA` — barrier PASS; re-executed
immediately before the acceptance records.
