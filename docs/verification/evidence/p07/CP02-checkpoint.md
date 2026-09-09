# P07.CP02 — re-measured DB-runtime checkpoint

**Supersedes CP01 for progression.** CP01 preserved byte-unchanged.

## Re-measurement (not assumption)

| Probe | Result |
| --- | --- |
| docker client | Docker version 29.6.1 |
| **docker daemon** | **unreachable** |
| podman | absent |
| mysqld :3306 | not listening |
| trivy | absent |
| `DATABASE_URL` | absent |

The contract's DB stage requires a `mysql:8` **service container**
(`ports 3306:3306`, health-checked). No verifier-owned, digest-pinned MySQL
can be started, so migration replay and the DB suite cannot execute.

Explicitly not done, per the frozen rules: no developer MySQL daemon
substituted, no remote/staging database used, no DB PASS manufactured.

## Correction inherited from P06

CP01 said the non-DB stage was secret-bound. That was wrong (see
`p06/CP02-checkpoint.md`): CI is intentionally secretless and the 64
environment-bound failures are declared in the checked-in allowlist. The
non-DB stage's real constraint is provisioning inside a disposable candidate,
which is now modelled.

## Environment-independent P07 work — not yet done

None of the structural work has been executed yet: DB-suite discovery,
registration cross-check against `dbSuiteRegistration.test.ts`, the
collection-collapse floor, the impact-selection prohibition, P01 base
discipline for diff-aware gates, the environment-failure taxonomy, and the
P04 lane-exclusivity proof (which needs no live database) all remain.

This is the natural next increment and does not depend on Docker.

## ACCEPT(P07)

`all_mandatory_closed` false · `zero_blocking_open_defects` false ·
`evidence_complete` false.

## Decision

**DO NOT PROCEED**

**Blocking IDs: DEF-034**
