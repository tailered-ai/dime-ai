# P07.CP01 — PARITY Test/Data Stage checkpoint

## Identity

| Field | Value |
| --- | --- |
| Branch | `feat/ci-verify-control-plane` |
| HEAD | `705c9898eed249136cb02945c3f7cfd2124bda02` |
| BASE_SHA | `7fa4b3fe49f67f98e5aaa1fe466862ee3cfa20d9` |
| P07 candidate | head `705c9898` · base `7fa4b3fe` · tree `b8e2b7c6` · merge `00f9c346` · digest `32f0b8f1b7507647` (independent run id) |

## The blocker (P07.T01)

The contract's DB stage is explicit:

```
ci.yml#db-tests services: {"mysql":{"image":"mysql:8","ports":["3306:3306"],
  "options":"--health-cmd=\"mysqladmin ping -h 127.0.0.1 --silent\" …"}}
env: DATABASE_URL, DB_TESTS, NODE_ENV
```

Measured on this host:

| Probe | Result |
| --- | --- |
| docker binary | present (`/usr/local/bin/docker`) |
| **docker daemon** | **unreachable** — `Cannot connect to the Docker daemon` |
| podman | absent |
| trivy | absent |
| mysqld on 3306 | not listening |
| `DATABASE_URL` | absent |

No verifier-owned, digest-pinned `mysql:8` fixture can be started, so
migration replay and the DB suite cannot execute. The frozen rules forbid the
alternatives: do not fake DB parity, and do not substitute an unrelated local
MySQL daemon without contract permission.

A second, independent constraint: the full non-DB PARITY collection
(`ci.yml#test` → `test:gated:ci`) is secret-bound. The proof gate observed
`passed=5079 failed=80 environmentBound=64`, the failures dominated by
credential-dependent suites. Local PARITY for that stage is not achievable
without CI secrets either (DEF-033).

## Defect

**DEF-034 (HIGH)** — P07 DB parity blocked on container runtime availability.

## What is NOT yet done

Everything downstream of the DB fixture: migration replay, DB-suite
discovery, registration cross-check, non-DB phase, DB serial lane execution,
collection-collapse floor, environment-failure policy, diff-aware gates, the
twelve P07 negatives, and ASSURANCE proofs for newly graduated P07 gates.

Structural work that does NOT need a live database (registration cross-check,
lane-exclusivity proof via P04, collection floor, impact-selection refusal)
remains possible and is the natural next increment once the blocker is
resolved or the phase is re-scoped.

## ACCEPT(P07)

`all_mandatory_closed` false · `zero_blocking_open_defects` false (DEF-034) ·
`evidence_complete` false.

## Decision

**DO NOT PROCEED**

**Blocking IDs: DEF-034** (with DEF-033 constraining the non-DB stage)
