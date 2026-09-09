# P00.T05 — exact filesystem scope inspected by check-github-actions-security.mjs

Raw output: `raw/T05-actions-security-scope.raw.txt`.

## Observed (from `scanActionsSecurity`, lines 241-253 and 332-341)
| # | Root | Selector | Recursive |
| --- | --- | --- | --- |
| 1 | `.github/workflows` | `*.yml`, `*.yaml` | YES (`filesBelow` recurses, lines 50-64) |
| 2 | `.github/actions` | filename exactly `action.yml` / `action.yaml` | YES |
| 3 | `.github/CODEOWNERS` | single file, security-owners regex | n/a |

A missing directory is tolerated (`ENOENT` returns empty, line 57).
`.github/actions` does not currently exist (P00.T04 census).

## Raw-text scanning behaviour (critical for P05)
Line 264 splits each workflow's **raw source** into job blocks, then line 266
runs `/secrets\.([A-Z0-9_]+)/g` over that raw text. It is not YAML-aware, so a
`secrets.NAME` literal in a **comment** counts as a production-secret
reference and forces `environment: Production` in that job block.

## Invocation surfaces
- `ci.yml:61` (the required `Security Audit` context)
- `feed-responsive-cross-browser.yml:48`
- `pnpm security:actions`

## ANSWER (the P05 fixture-placement policy this unblocks)
Poison fixtures containing `secrets.X`, unpinned `uses:`, or duplicate keys
must **never exist as files** under `.github/workflows/**` or as
`.github/actions/**/action.y(a)ml`, and must not alter `.github/CODEOWNERS`.
Everything outside those three roots is invisible to this gate, so
`scripts/ci/selftest/fixtures/**` (stored as `.patch` files) and
`docs/verification/evidence/**` are safe fixture homes.
