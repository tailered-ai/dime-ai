# P06 §14 — nonlocal / CI-only audit

The purpose of this audit is to make absence explicit. For every contract
check P06 does not fully reproduce, it states what CI proves, what the local
verifier proves, what it cannot prove, whether any local fragment still runs,
and why that fragment is not the required verdict.

**No check listed here is counted as an executed PASS anywhere in P06's
summary.** A required GitHub status is the whole job; a passing fragment of it
is not the status.

## Disposition classes in use

| Disposition | Meaning |
| --- | --- |
| `CI_ONLY(GITHUB_API_BASELINE)` | the verdict is computed from GitHub API state — branch protection, required-context lists, PR metadata — with no local equivalent |
| `CI_ONLY(OIDC_ATTESTATION)` | the verdict depends on GitHub's OIDC identity or attestation signing |
| `CI_ONLY(DEPENDENCY_REVIEW_EVENT)` | the verdict comes from GitHub's dependency-review event payload, produced by the platform rather than by any command |
| `NOT_LOCALLY_EXECUTABLE(SECRET_BOUND)` | the verdict requires a repository secret that must never be injected locally |
| `NOT_LOCALLY_EXECUTABLE(RUNTIME_UNAVAILABLE)` | a required runtime is absent on this host |
| `NOT_LOCALLY_EXECUTABLE(ACTION_SEMANTICS_UNREPRODUCED)` | the verdict lives inside a marketplace action for which no faithful adapter exists |

The machine-readable roster with per-gate detail is
`T13-nonlocal-audit.json`, regenerated from the current contract, the measured
capability, the governed tool inventory, and the recorded execution results.

## Final result: the audit is empty

**All 16 P06-owned gates are locally executable — 8 `LOCAL`, 8 `LOCAL+TOOL`,
0 nonlocal.** Every required check now produces a real local verdict, so this
audit has no entries to report. That is the strongest outcome available to it,
and it is worth stating plainly rather than burying: nothing in P06's scope is
left unreproduced, and therefore nothing is being silently taken on trust from
CI.

The classes below remain documented because they are the frozen vocabulary the
audit must use the moment any future contract change reintroduces one.

## What changed since CP02

CP02 classified **1 SECRET_BOUND** gate (`gitleaks`) plus two
`RUNTIME_UNAVAILABLE` (docker-dependent) and one
`ACTION_SEMANTICS_UNREPRODUCED`. All four are now reproduced:

- **`gitleaks`** moved from SECRET_BOUND to a faithful local adapter
  (Outcome A). The token's role in the pinned action is commit enumeration and
  PR commenting; neither carries the verdict, and the action's own `BASE_REF`
  override proves the commit range is env-derivable. No token was supplied.
- **The two docker-dependent gates** (`09-artifact`, `full-container-scan`)
  became executable once the daemon was authorized, using governed trivy
  0.70.0 and syft 1.42.3 adapters derived from the pinned actions' own
  input-to-CLI mappings.

This is the audit's real point: `RUNTIME_UNAVAILABLE` described the **host**,
not the gate, and saying so precisely is what made it fixable.

## Steps that carry no verdict

Recorded per gate so their exclusion is auditable rather than silent:

- `actions/checkout` — candidate materialization; P01 owns it locally.
- `pnpm/action-setup`, `actions/setup-node`, `actions/setup-python`,
  `astral-sh/setup-uv` — toolchain setup; measured capability and the governed
  toolchain own it locally.
- `actions/upload-artifact`, `actions/cache` — CI plumbing.
- `github/codeql-action/upload-sarif` — CI plumbing. It publishes findings to
  GitHub code scanning; the finding itself is produced by the scanner step,
  which **is** reproduced locally. This distinction matters: it is exactly the
  DEF-023 class, where a SARIF-emitting tier exited 0 while the enforcement
  tier was what actually rejected.

## Operational exclusions

Seven contract jobs are locally runnable but probe **live production**
(`p0-feed-verify`, `railway-p0-control`, `refresh-cf-cidrs`,
`os-ledger-append`, `os-observe-crons`, `edge-arming-gate#enforce`,
`dependency-release-age`). They verify the running system, not the candidate,
so they belong to neither P06 nor P07's parity surface. Each carries a written
reason in `scope.mjs` so the exclusion is reviewable rather than assumed.
