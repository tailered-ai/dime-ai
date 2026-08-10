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
| workflows | 40 |
| jobs / checks | 51 / 51 |
| steps represented | 258 |

## Runnability

Runnability answers: can the LOCAL verifier reproduce this check's
VERIFICATION VALUE? It is not "would every step succeed locally" —
reporting sinks such as artifact and SARIF upload are represented but
excluded from the verdict.

| Class | Count |
| --- | --- |
| `CI-ONLY` | 22 |
| `LOCAL` | 18 |
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
| `01-pr-proof-contract.yml` | `76cdc4b5534f5375` | `7f5fa8b6bee01fed` |
| `02-codeql.yml` | `8368b0ac4e37f06a` | `63f6b6d713029f66` |
| `03-semgrep.yml` | `e8f9690f3317c1a3` | `3d24f628dd383fea` |
| `05-workflow-security.yml` | `7bf7f454f7fa9bb1` | `8a039dc619a6ea94` |
| `06-dependency-review.yml` | `d4c5e5deefeb7b7c` | `89f79e1dbb9b4467` |
| `07-coverage-patch.yml` | `24afae21812686c5` | `f113a26ac11a6dd3` |
| `08-contract-and-data-integrity.yml` | `459978cb3b7a7e38` | `bc6b76db5b2a53a9` |
| `09-artifact-build-and-smoke.yml` | `bc732356b3611ddf` | `b792c10a527cb82e` |
| `10-ai-eval-critical.yml` | `83ed21dd5185b119` | `21f867df5ae0effb` |
| `11-artifact-attestation.yml` | `4b30e6067e3915df` | `e0d4bfe2bf8ff99a` |
| `12-nightly-verification.yml` | `a77a3a33a807ba0e` | `ddc282b454cfde43` |
| `auto-merge-dependabot.yml` | `cc1fdaa050d8091e` | `55e151f35d3fa254` |
| `ci.yml` | `feb30dc96f5ff704` | `027d67e57b47f8d2` |
| `cron-bet-grade.yml` | `9eeddca74c8c5c96` | `df0cd7873a40af34` |
| `cron-mlb-canonical-refresh.yml` | `2cada7ec4243c9d7` | `d588d1f3bc4ed030` |
| `cron-mlb-cycle.yml` | `0c6eb0f142de1488` | `c9487082b6ec9834` |
| `cron-mlb-learning-loop.yml` | `d92325a4dd78b0b9` | `49057a1ba96d71e7` |
| `cron-scores.yml` | `f7e4db9c0b2504b1` | `a6f00571e6ca5c57` |
| `cron-stripe-reconcile.yml` | `f3853159e4a178a2` | `8797451b71919384` |
| `cron-vsin-odds.yml` | `28ff39a9bb2a01cd` | `ec21de9d54796eb6` |
| `db-push.yml` | `14d3c7147929c8e4` | `c7ee244fc825d572` |
| `db-query.yml` | `35bde1399b158250` | `f74b90ad09c2a084` |
| `db-reconcile-migrations.yml` | `5fc912cf0c015fdc` | `cd6ff4ffaf01cd6b` |
| `deploy-smoke.yml` | `cfef81db859b7bfe` | `33372e428098ccb3` |
| `dime-llm-validation.yml` | `8d36ae80ee9d1393` | `ce640ec49b5f7d6d` |
| `edge-arming-gate.yml` | `b31e79bd33c15920` | `e120c2666b263099` |
| `feed-responsive-cross-browser.yml` | `32b1efdb6337c0ed` | `779690b249abd812` |
| `gitleaks.yml` | `b8e8571ffbd69107` | `f21f3cbed277f83d` |
| `os-ledger-append.yml` | `2c327ce38b741615` | `b0efa324a0ec4c57` |
| `os-observe-crons.yml` | `27185963587b61eb` | `e3af47275ce21fe8` |
| `p0-db-verify.yml` | `fb15133f713a4df2` | `16bd85a4969a07f6` |
| `p0-feed-verify.yml` | `391d7845c7cefd21` | `cff13e8b6d3a8a67` |
| `perf-harness.yml` | `5440b716eb96ab36` | `329feb72c4174ca2` |
| `pi-review.yml` | `7594180b93acd86d` | `acf6df90645c74f4` |
| `railway-p0-control.yml` | `22eae8e44fac7bb5` | `64f96ea0be26cbdf` |
| `refresh-cf-cidrs.yml` | `178fb7eb3ad26eea` | `16dff8928ae011ef` |
| `security-audit-weekly.yml` | `713b9bb5c6d5c302` | `77e832b77e23d302` |
| `seed-cfb.yml` | `edcf431d2a73b385` | `0c8b0c75f4606732` |
| `seed-nfl.yml` | `0eb40abf225c52e7` | `46c7271b1ca615e5` |
| `stripe-e2e.yml` | `85e31c1553d14ef5` | `79821c1d0877c50b` |

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
