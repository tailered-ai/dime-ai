# T22 — P06+P07 acceptance evidence at the second freeze window (base `249bf314`)

Supplements (does not replace) T19: the first window's complete verification
at `43a33c84` reached both seven-term predicates TRUE, but main advanced to
`249bf314` (PRs #509/#510) before the acceptance record, the barrier refused,
and DEF-056 was reopened. This document binds the SAME acceptance to the new
base after integration commit `61369e77` and remediations `114052b3`
(DEF-061) and `77594d5a` (DEF-062).

## Why the first window's records carry over

`git diff 43a33c84..249bf314` touches **zero** verification-surface inputs:
no `.github/workflows/**`, no `pnpm-lock.yaml`/`package.json`, no `server/`,
no `drizzle/`, no `scripts/ci/**`. The frozen contract regenerates
byte-identical (`b594ebd9`; conformance PASS before and after integration).
The 53 blueprint-unit records and defect dispositions therefore remain
semantically valid; what required re-execution — and got it — is the full
gate chain at the new candidate.

## The class the new base's tests exposed, and its terminal fix

The merge added 305 collected tests (TOS-009). Three distinct
subprocess-heavy tests then tripped the 15s `testTimeout` across two
rosters while green in CI and isolated locally:

| Defect | Test | Fix |
| --- | --- | --- |
| DEF-061 | dime-authentication-closure (30s inner subprocess budget vs 15s outer bound) | explicit 120s on the two tests with that profile |
| DEF-062 | os/contradiction + os/observe-crons | **structural**: driver injects `VITEST_MAX_FORKS=4`/`VITEST_MAX_THREADS=4` — CI's ubuntu-latest runs ≤4 workers on dedicated vCPUs; locally vitest ran 8 workers on 8 shared cores. Environment normalization; command text verbatim; nothing weakened |

One docker-buildkit blink (EOF listing workers) cost a roster attempt —
infrastructure, recorded in `roster-249b-2-dockertransient.log`, daemon
verified healthy before relaunch.

## The green chain at `249bf314` (all serial)

| Stage | Result | Log |
| --- | --- | --- |
| Roster (18 gates) | 14 PASS · 3 advisory base-FAIL (DEF-045/046) · 1 correct BLOCK · **blocking 0** · reconciles=true · `#proof` PASS · tailered-os PASS 42.3s · gitleaks PASS | `T22-acceptance-roster.log` |
| ASSURANCE | **8/8 PROVEN**, mandatory local coverage 6/6 | `T22-acceptance-assurance.log` |
| P07 | 3/3 PASS — test 214.3s · coverage 163.7s · db-tests 26.8s (10 files/92 tests, MySQL 8.4.11 digest-bound, zero residue) | `T22-acceptance-p07.log` |

An interrupted ASSURANCE attempt (harness restart at 3/8) left zero residue
(working tree clean, no owned containers) and was rerun from the top.

## Cross-phase regression at this candidate

Recorded in the acceptance checkpoint: negatives 56/56, full scripts suite,
prettier, `ledger verify`, conformance verify + yaml audit, p03-audit,
p05-audit, `tsc --noEmit` — results appended by the regression run of this
window (see checkpoint evidence).

## P07 same-SHA and REG01 currency

The DB surface (ten contract-listed suites, `drizzle/`, server DB code) is
byte-identical from `43a33c84` through `249bf314` to this candidate — the
T19 TEST03 same-SHA comparison (CI job `93703942390`: 10/92 == local 10/92)
and the three-run REG01 series remain valid, and this window's db-tests
reproduces 10/92 again.

## Freshness

Barrier executed immediately before the acceptance records:
`origin/main == 249bf314 == FROZEN_BASE_SHA` (result recorded in the
checkpoint decision).
