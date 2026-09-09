# P07.CP03 — PARITY Test/Data stage checkpoint

**Supersedes CP01/CP02 for progression.** Both preserved unchanged, including
CP02's DO-NOT-PROCEED on DEF-034.

## Candidate identity

| Field | Value |
| --- | --- |
| Branch | `feat/ci-verify-control-plane` |
| HEAD (unchanged this turn) | `705c9898eed249136cb02945c3f7cfd2124bda02` |
| `origin/main` | `7fa4b3fe49f67f98e5aaa1fe466862ee3cfa20d9` — unmoved |
| Contract | `400cc0391547435d…` |

Base discipline is mechanical: `assertFreshBase()` refuses any run whose
candidate `origin/main` differs from the recorded base, so a diff-aware gate
can never quietly measure against a moved target.

## Docker daemon (authorized action)

Started with `open -a Docker` — the already-installed application, no
configuration modified. Client 29.6.1 / Server 29.6.1 (Docker Desktop),
aarch64. **Nothing pruned**; developer containers, images, networks and
volumes were inventoried before and after and left untouched.

## MySQL service identity — digest-bound

The contract names the mutable tag `mysql:8`. Evidence binds to the immutable
digest resolved at execution, not the tag:

| Field | Value |
| --- | --- |
| Contract tag | `mysql:8` |
| Digest | `sha256:…4bb78d37fe8a23eb857fd3fb` |
| Server version | **8.4.11** |
| Env / port / health | `MYSQL_ALLOW_EMPTY_PASSWORD=1`, `MYSQL_DATABASE=dime_test`, `127.0.0.1:3306`, the contract's own `mysqladmin ping` at 5s × 20 |
| Ready after | ~10.8 s |

CI's service version was not changed. Port 3306 is probed first: anything
already listening causes a refusal, never a reuse — a developer database is
never substituted, and no remote/production database was ever contacted.

## Migration replay and DB suites

`pnpm db:migrate:reconciled` replayed the immutable chain on the fresh
database through `0134_widen_unit_probability_precision`. Only then did the
suites run, in P04's serial lane with the contract's own
`--no-file-parallelism`:

```
Test Files  10 passed (10)
      Tests  92 passed (92)
```

Migration-before-suites ordering is not a convention here but a proven
property: P07.NEG11 shows the driver stops at the first failing step, so a
failed migration blocks the suites instead of running them against partial
state.

## Structural guarantees (environment-independent)

| Item | Result |
| --- | --- |
| DB-suite discovery (canonical `*.db.test.ts` marker) | 6 marker files |
| Contract's hardcoded DB list | 10 suites |
| Registration cross-check vs `dbSuiteRegistration.test.ts`'s own mechanism | exact agreement, 0 problems |
| Collection-collapse floor | **1000**, re-derived from contract text (not assumed) |
| Environment-failure model | 64 allowlist entries · 17 declared CI skips, re-derived from source |
| Impact-mode selection | refused — `assertNoImpactSelection` rejects `--changed/--related/--onlyChanged/--findRelatedTests` |

The 64 environment-bound cases match the count DEF-033 originally
mis-attributed to secret starvation; they are the repository's declared,
intentional design.

## Negative suite — 17 cases, all passing

Includes: registration omission → drift; collection below floor / zero
collection → FAIL via the **contract's own shell fragment**; pre-test load
failure → never green; scheduler serializes two DB acquisitions (measured
intervals, non-overlapping); impact selection refused; stale base rejected;
occupied 3306 → refusal rather than substitution; a failing earlier step
blocks later steps; undeclared CI skip rejected; truncated results JSON cannot
summarize green.

## Ownership and residue

The owned container carries a `ci-verify-owner` label bound to the run marker,
and teardown re-reads that label before removing anything. The first run
exposed a real violation — `docker rm -f` leaves a container's **anonymous**
volume behind, and `mysql:8` declares one for `/var/lib/mysql`. Recorded as
DEF-040, corrected to `docker rm -fv` (scoped to the owned container only),
and re-proven: `new_containers: []`, `new_volumes: []`.

## Same-SHA CI comparison

No CI run exists for this exact candidate identity, and nothing was pushed to
create one: **NOT_YET_AVAILABLE**. Absence of remote evidence is neither a
PASS nor, by the frozen rules, a blocker.

## Decision

**DO NOT PROCEED**

**Blocking IDs: DEF-034 (pending final re-verification), DEF-047**

DB parity itself succeeded on real infrastructure — digest-bound service,
migration replay, 10/10 suites, 92/92 tests, zero residue — which is what
DEF-034 required. Two things keep P07 from accepting:

1. **DEF-047** — the same host-load instability that blocks P06 affects the
   shared test surface, so `zero_flaky_mandatory` cannot be asserted for the
   test/data stage either.
2. A final confirming run under the corrected provisioning authority was still
   executing when this checkpoint was recorded; DEF-034 is not closed on a
   result that has not been re-observed under the final code.

No P07 acceptance baseline commit is created.
