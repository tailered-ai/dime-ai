# P07.T02 — verifier-owned database parity

`ci.yml#db-tests` declares a MySQL **service container**. Until the Docker
daemon was authorized and started, that gate was not reproducible at all, and
DEF-034 recorded it truthfully rather than substituting a developer database,
pointing at a remote one, or manufacturing a PASS.

## Docker daemon

| Field | Value |
| --- | --- |
| Client | 29.6.1 |
| Server | 29.6.1 (Docker Desktop) |
| Architecture | aarch64 |
| Start mechanism | `open -a Docker` (the already-installed app; no configuration modified) |

No prune, no removal of developer containers, images, networks, or volumes.

## Service identity — digest-bound, not tag-bound

The contract names the mutable tag `mysql:8`. A tag is a moving pointer, so
the evidence binds to the immutable digest resolved at execution time:

| Field | Value |
| --- | --- |
| Contract tag | `mysql:8` |
| Resolved digest | `mysql@sha256:…4bb78d37fe8a23eb857fd3fb` (recorded in full in `p07-records.json`) |
| Server version reported by the running container | **8.4.11** |
| Architecture | arm64 |
| Env | `MYSQL_ALLOW_EMPTY_PASSWORD=1`, `MYSQL_DATABASE=dime_test` — verbatim from the contract |
| Port | `127.0.0.1:3306:3306` — bound to loopback only, strictly narrower than CI's mapping |
| Readiness | the contract's own `mysqladmin ping -h 127.0.0.1 --silent`, 5s interval, 20 retries |
| Ready after | 10 806 ms |

CI's service version was not changed; the local service reproduces it.

## Ownership

The container carries a unique verifier name and a `ci-verify-owner` label
bound to the run marker. Teardown re-reads that label and refuses to remove
any container whose owner does not match. Port 3306 is probed first: if
**anything** already listens there the run refuses with `PORT_OCCUPIED`
rather than reuse or kill it — a developer database is never touched.

## Migration replay

`pnpm db:migrate:reconciled` ran against the fresh database and completed the
immutable chain through `0134_widen_unit_probability_precision`, ending with
`journal and canonical table reached 0134_widen_unit_probability_precision`.
Because the driver stops at the first failing step, a migration failure would
have blocked the suites rather than running them against partial state — that
ordering is proven by P07.NEG11.

## DB suite execution

Run in P04's serial `db-serial` lane with the contract's own
`--no-file-parallelism`, from the contract's own hardcoded file list:

```
Test Files  10 passed (10)
      Tests  92 passed (92)
```

## Residue

The first run left **one anonymous volume**: `mysql:8` declares
`/var/lib/mysql` as a VOLUME, and `docker rm -f` does not remove a container's
anonymous volumes. That is owned residue and therefore an ownership-law
violation, recorded as a defect and corrected to `docker rm -fv`, which is
scoped to the container's own volumes — named and developer volumes are never
touched and nothing is ever pruned. The stranded volume was removed by exact
id, its ownership proven by the run's own before/after inventory delta.
