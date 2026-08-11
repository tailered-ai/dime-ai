# Verification contract — machine-derived

> GENERATED FILE. Do not edit by hand. Rendered from
> `scripts/ci/contract.frozen.json` by `scripts/ci/contract-conformance.mjs render`.
> Rendered-document conformance (P02.CONF02) fails if this file and the
> machine contract disagree.

## What P02 certifies

P02 extraction is the ONLY boundary in the verifier that reads workflow
YAML. Runtime verification consumes `contract.frozen.json` and never parses
`.github/workflows/*.yml`. That isolation is enforced by an audit, not by
convention.

| Field | Value |
| --- | --- |
| schema_version | `1.0.0` |
| parser_version | `yaml@2.9.0` |
| canonicalizer_version | `1.0.0` |
| workflows | 42 |
| jobs / checks | 53 / 53 |
| steps represented | 271 |

## Runnability

Runnability answers: can the LOCAL verifier reproduce this check's
VERIFICATION VALUE? It is not "would every step succeed locally" —
reporting sinks such as artifact and SARIF upload are represented but
excluded from the verdict.

| Class | Count |
| --- | --- |
| `CI-ONLY` | 22 |
| `LOCAL` | 20 |
| `LOCAL+TOOL` | 11 |

## Required status contexts (enforced today)

| Context | Check | Runnability | Tools |
| --- | --- | --- | --- |
| `Security Audit` | `.github/workflows/ci.yml#security-audit` | LOCAL+TOOL | osv-scanner |
| `TypeScript Check` | `.github/workflows/ci.yml#typecheck` | LOCAL | — |
| `Vitest` | `.github/workflows/ci.yml#test` | LOCAL+TOOL | playwright-browsers |
| `Secret Scan (gitleaks)` | `.github/workflows/gitleaks.yml#gitleaks` | LOCAL+TOOL | gitleaks |
| `01-pr-proof-contract` | `.github/workflows/01-pr-proof-contract.yml#proof` | LOCAL+TOOL | playwright-browsers |
| `05-workflow-security` | `.github/workflows/05-workflow-security.yml#zizmor` | LOCAL+TOOL | zizmor |
| `06-dependency-review` | `.github/workflows/06-dependency-review.yml#dependency-review` | CI-ONLY | — |
| `08-contract-and-data-integrity` | `.github/workflows/08-contract-and-data-integrity.yml#contracts` | LOCAL | — |
| `10-ai-eval-critical` | `.github/workflows/10-ai-eval-critical.yml#deterministic` | LOCAL | — |

## Graduating contexts (represented, NOT currently required)

| Context | Check | Runnability |
| --- | --- | --- |
| `02-codeql` | `.github/workflows/02-codeql.yml#analyze` | CI-ONLY |
| `03-semgrep-blocking` | `.github/workflows/03-semgrep.yml#blocking` | LOCAL+TOOL |
| `07-coverage-patch` | `.github/workflows/07-coverage-patch.yml#coverage` | LOCAL |
| `09-artifact-build-and-smoke` | `.github/workflows/09-artifact-build-and-smoke.yml#artifact` | LOCAL+TOOL |
| `11-artifact-attestation` | `.github/workflows/11-artifact-attestation.yml#attest` | CI-ONLY |

## Construct allowlist

Derived from the `yaml@2.9.0` census of the current corpus. There is no
implicit ignored class: an unclassified construct aborts generation with
`CONTRACT_GENERATION_FAILED`.

| Category | Construct | Classification | Note |
| --- | --- | --- | --- |
| expression_roots | `github` | SUPPORTED | github context |
| expression_roots | `inputs` | SUPPORTED | workflow_dispatch inputs |
| expression_roots | `matrix` | SUPPORTED | matrix context |
| expression_roots | `secrets` | CI_ONLY_BUT_REPRESENTED | repository secrets are structurally unavailable locally |
| expression_roots | `steps` | SUPPORTED | step outputs |
| expression_roots | `success` | SUPPORTED_WITH_EXPLICIT_NORMALIZATION | status FUNCTION success(), not a context; matched by the root regex and classified explicitly |
| expression_roots | `vars` | SUPPORTED | repository variables |
| job_keys | `defaults` | SUPPORTED | default shell / working-directory |
| job_keys | `env` | SUPPORTED | job environment |
| job_keys | `environment` | CI_ONLY_BUT_REPRESENTED | protected GitHub environment; secrets binding |
| job_keys | `if` | SUPPORTED | conditional execution |
| job_keys | `name` | SUPPORTED | job display name; becomes the status context |
| job_keys | `needs` | SUPPORTED | ordered dependency list |
| job_keys | `permissions` | SUPPORTED | job token scope |
| job_keys | `runs-on` | SUPPORTED | runner selection |
| job_keys | `services` | SUPPORTED | service containers |
| job_keys | `steps` | SUPPORTED | ordered step list |
| job_keys | `strategy` | SUPPORTED | matrix expansion |
| job_keys | `timeout-minutes` | SUPPORTED | job timeout |
| step_keys | `env` | SUPPORTED | step environment |
| step_keys | `id` | SUPPORTED | step id for outputs |
| step_keys | `if` | SUPPORTED | conditional execution |
| step_keys | `name` | SUPPORTED | step display name |
| step_keys | `run` | SUPPORTED | shell command; multiline preserved verbatim |
| step_keys | `uses` | SUPPORTED | action reference; SHA pinning enforced elsewhere |
| step_keys | `with` | SUPPORTED | action inputs |
| triggers | `merge_group` | CI_ONLY_BUT_REPRESENTED | merge queue; INERT — queue not enabled (P00.T01) |
| triggers | `pull_request` | SUPPORTED | PR gate; checks out refs/pull/N/merge |
| triggers | `push` | SUPPORTED | post-merge validation |
| triggers | `schedule` | CI_ONLY_BUT_REPRESENTED | cron is GitHub-scheduled; represented, never run locally |
| triggers | `workflow_dispatch` | CI_ONLY_BUT_REPRESENTED | manual GitHub dispatch surface |
| workflow_keys | `concurrency` | SUPPORTED | cancellation group |
| workflow_keys | `env` | SUPPORTED | workflow-level environment |
| workflow_keys | `jobs` | SUPPORTED | job map |
| workflow_keys | `name` | SUPPORTED | workflow display name |
| workflow_keys | `on` | SUPPORTED | trigger map; YAML 1.2 keeps `on` a string key |
| workflow_keys | `permissions` | SUPPORTED | GITHUB_TOKEN scope, security-relevant |

## CI-only capabilities

| Action | Reason it cannot be reproduced locally |
| --- | --- |
| `actions/attest-build-provenance` | requires GitHub OIDC provenance signing |
| `actions/dependency-review-action` | compares PR dependency graphs via the GitHub API |
| `actions/upload-artifact` | GitHub artifact storage |
| `dependabot/fetch-metadata` | reads Dependabot PR metadata from the GitHub API |
| `github/codeql-action/analyze` | CodeQL analysis + alert attribution is GitHub-side |
| `github/codeql-action/init` | CodeQL database creation is a GitHub code-scanning capability |
| `github/codeql-action/upload-sarif` | SARIF upload targets the GitHub Security tab |
| `ossf/scorecard-action` | queries GitHub repository metadata and publishes results |

## Workflow source identities

| Workflow | raw sha256 | canonical sha256 |
| --- | --- | --- |
| `01-pr-proof-contract.yml` | `82d494f62bd738f4` | `ab9895ac3c6fce20` |
| `02-codeql.yml` | `420935d9e5bdda30` | `6a26a5eefd1e71a3` |
| `03-semgrep.yml` | `e8f9690f3317c1a3` | `3d24f628dd383fea` |
| `05-workflow-security.yml` | `8ae009b88cbed2e3` | `16e963daa80edd0e` |
| `06-dependency-review.yml` | `d07c7dfbf545a3d1` | `99321a8cb286d806` |
| `07-coverage-patch.yml` | `279534ab67c27b84` | `e1f4e66474e8453b` |
| `08-contract-and-data-integrity.yml` | `3fbb9a310be3d592` | `b602a09c79f266f6` |
| `09-artifact-build-and-smoke.yml` | `16d6f64cf7663d27` | `184a6d189f04b4e7` |
| `10-ai-eval-critical.yml` | `3be89dbd7541e6c6` | `ebb8699b3f36eeab` |
| `11-artifact-attestation.yml` | `4b30e6067e3915df` | `e0d4bfe2bf8ff99a` |
| `12-nightly-verification.yml` | `b30d52e0b8408445` | `60a6720a6c3bd7a2` |
| `13-tos-notion-context.yml` | `9fa213c94feed404` | `04b9661d52b0f3cb` |
| `auto-merge-dependabot.yml` | `cc1fdaa050d8091e` | `55e151f35d3fa254` |
| `ci.yml` | `0cf19f689a4091b7` | `3f80478fa4661ac3` |
| `cron-bet-grade.yml` | `9eeddca74c8c5c96` | `df0cd7873a40af34` |
| `cron-mlb-canonical-refresh.yml` | `4a69c95e1b66065f` | `151981f4f5149841` |
| `cron-mlb-cycle.yml` | `0c6eb0f142de1488` | `c9487082b6ec9834` |
| `cron-mlb-learning-loop.yml` | `d92325a4dd78b0b9` | `49057a1ba96d71e7` |
| `cron-scores.yml` | `f7e4db9c0b2504b1` | `a6f00571e6ca5c57` |
| `cron-stripe-reconcile.yml` | `f3853159e4a178a2` | `8797451b71919384` |
| `cron-vsin-odds.yml` | `28ff39a9bb2a01cd` | `ec21de9d54796eb6` |
| `db-push.yml` | `447d39c96787eda0` | `6ad64831bb369ff1` |
| `db-query.yml` | `35bde1399b158250` | `f74b90ad09c2a084` |
| `db-reconcile-migrations.yml` | `87ab63d7dabf65aa` | `5bc94766b341f71b` |
| `deploy-smoke.yml` | `da5c8b846d5a7ada` | `cca1013ef5f6acfd` |
| `dime-llm-validation.yml` | `8d36ae80ee9d1393` | `ce640ec49b5f7d6d` |
| `edge-arming-gate.yml` | `d0109cc5690a6718` | `387085aaf9a4c96b` |
| `feed-responsive-cross-browser.yml` | `6966686c0ac1ae89` | `2965bcaf41733e6d` |
| `gitleaks.yml` | `b8e8571ffbd69107` | `f21f3cbed277f83d` |
| `os-ledger-append.yml` | `8189b4db128f2689` | `f510ac9d316077ff` |
| `os-observe-crons.yml` | `cee1048a1c830309` | `b76eecadd8df6d8a` |
| `p0-db-verify.yml` | `fb15133f713a4df2` | `16bd85a4969a07f6` |
| `p0-feed-verify.yml` | `391d7845c7cefd21` | `cff13e8b6d3a8a67` |
| `perf-harness.yml` | `5a2b081f3f150ecd` | `b99d5cd39471ff16` |
| `pi-review.yml` | `bc316755d1aa33a8` | `8cfc9665920d1f3f` |
| `railway-p0-control.yml` | `22eae8e44fac7bb5` | `64f96ea0be26cbdf` |
| `refresh-cf-cidrs.yml` | `de2fec9477e0f825` | `f911f56b38474fcc` |
| `security-audit-weekly.yml` | `9fbf6da77dfea382` | `8e47243ea2ed727e` |
| `seed-cfb.yml` | `709959dddd4e0848` | `cfecfc570b0f90e8` |
| `seed-nfl.yml` | `29835145f26688db` | `fc409e0797f8bb0a` |
| `stripe-e2e.yml` | `3d70f0863b4c4ac8` | `6859763df2380ba7` |
| `tailered-os.yml` | `c1bd1b6520bb4c09` | `07f77928e63c4889` |

## Regeneration and failure semantics

```
node scripts/ci/contract-extract.mjs emit --root <candidate-worktree>
node scripts/ci/contract-conformance.mjs verify
node scripts/ci/contract-conformance.mjs render
```

| Condition | Result |
| --- | --- |
| unclassified construct | `CONTRACT_GENERATION_FAILED`, no partial write, prior artifact preserved |
| workflow changed without regeneration | `CONTRACT_DRIFT`, naming the workflow |
| hand-edited `contract.frozen.json` | pin mismatch, `CONTRACT_DRIFT` |
| required context with no mapped check | `REQUIRED_CONTEXT_UNMAPPED`, naming the context |
| runtime module parsing workflow YAML | audit failure, blocks acceptance |
