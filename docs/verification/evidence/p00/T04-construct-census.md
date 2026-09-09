# P00.T04 — GitHub Actions construct census (the P02 parser allowlist input)

Branch `feat/ci-verify-control-plane`, HEAD `4d644cf47d2ee8a1528e1efd8a79da5ce658d8c6`.
Raw output: `raw/T04-census.raw.txt`.

## Method — a REAL parse, not a regex approximation
Every workflow was parsed with **js-yaml 4.3.1**, resolved by explicit path:
`node_modules/.pnpm/js-yaml@4.3.1/node_modules/js-yaml/dist/js-yaml.mjs`.
The census script is reproduced verbatim in `raw/T04-census-script.mjs` and was
run from the session scratchpad, deliberately NOT added to `scripts/ci/` —
authoring contract-extractor files is P02 work, not P00's.

**Parse errors: NONE across all 40 files.** The census is therefore complete
over the parsed document tree, not a text approximation.

### Provenance caveat (recorded, not hidden)
js-yaml is **not a declared dependency**. `package.json` carries it only as a
pnpm *override* for transitive consumers (`"js-yaml": ">=4.3.1 <5.0.0"`), and
`import("js-yaml")` fails with `ERR_MODULE_NOT_FOUND`. PyYAML is likewise
absent. The parse above reached the package through the pnpm store path, which
is a phantom dependency: reproducible today, but removable by any future
install or dependency bump. **P02's extractor cannot be built on this.**
Tracked as **DEF-003**.

## Inventory
| Metric | Value |
| --- | --- |
| Workflow files | **40** |
| Jobs | 51 |
| Steps | 257 |
| Reusable-workflow job calls (`job.uses`) | **0** |
| Local composite actions (`.github/actions`) | **DIRECTORY ABSENT** |
| `uses:` references | 120, **120 SHA-pinned, 0 tag/branch** |
| Explicit step `shell:` | 0 |

## Construct classes the P02 parser MUST support
| Level | Constructs (occurrences) |
| --- | --- |
| Workflow | `jobs` 40, `name` 40, `on` 40, `permissions` 40, `concurrency` 22, `env` 2 |
| Triggers | `workflow_dispatch` 37, `pull_request` 15, `schedule` 14, `merge_group` 10, `push` 8 |
| Job | `runs-on` 51, `steps` 51, `name` 46, `timeout-minutes` 25, `environment` 17, `permissions` 17, `env` 4, `needs` 4, `if` 3, `strategy` 2, `defaults` 1, `services` 1 |
| Step | `name` 185, `run` 137, `uses` 120, `with` 63, `env` 45, `if` 34, `id` 6 |
| Expression roots | `github` 49, `secrets` 30, `inputs` 27, `steps` 15, `vars` 14, `matrix` 6, `success` 1 |

## Constructs the parser does NOT need to support (proven absent)
- Reusable workflow calls (`job.uses`) — 0 occurrences
- Local composite actions — directory absent
- `container:` at job level — 0 occurrences
- Explicit `shell:` at step level — 0 occurrences
- `continue-on-error` — 0 occurrences (consistent with AUDIT.md §3)

## Constructs that DO exist and are easy to miss
- `strategy` (matrices) — 2 jobs
- `services` (the ci.yml MySQL container) — 1 job
- `environment` — 17 jobs (the production-secret contract)
- `defaults` — 1 job
- `merge_group` triggers — 10 files, **inert** (P00.T01: queue not enabled)

## ANSWER
Census complete: 5 workflow-level, 5 trigger, 12 job-level, 7 step-level
construct classes plus 7 expression-context roots, across 40 files / 51 jobs /
257 steps, with zero parse errors. This is P02's allowlist. Anything outside it
must make P02 abort with CONTRACT-GENERATION-FAILED rather than partially
interpret.
