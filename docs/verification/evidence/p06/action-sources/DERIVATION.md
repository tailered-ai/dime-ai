# P06 governed-tool derivation chains

Every external tool a P06 gate depends on resolves to an exact identity
derived from this repository's own CI configuration. Nothing is "latest";
nothing is a silently-substituted developer-global copy. Where a version
lives inside a pinned marketplace action rather than in a workflow, the
action source was fetched at its pinned commit and read directly — the
fetched bytes are hashed in `SOURCES.sha256` beside this file.

| Tool | Version | Derivation chain |
| --- | --- | --- |
| semgrep | 1.172.0 | `03-semgrep.yml` workflow env `SEMGREP_VERSION` |
| zizmor | 1.29.0 | `05-workflow-security.yml` workflow env `ZIZMOR_VERSION` |
| osv-scanner (security-audit) | 2.4.0 | release URL inside `ci.yml#security-audit`'s provisioning step |
| osv-scanner (full-osv) | 2.2.4 | release URL inside `12-nightly-verification.yml#full-osv`'s provisioning step |
| gitleaks | 8.24.3 | `gitleaks.yml` → `gitleaks-action@e0c47f4f` → `dist/index.js`: `GITLEAKS_VERSION \|\| "8.24.3"` |
| trivy | 0.70.0 | `09`/`12` workflows → `trivy-action@ed142fd` → `action.yaml` input `version` default `v0.70.0` |
| syft | 1.42.3 | `09-artifact` → `sbom-action@e22c389` → `dist/index.cjs` constant `VERSION7 = v1.42.3` |

**Two osv-scanner identities, deliberately.** The PR-tier gate and the
nightly gate pin *different* versions. Collapsing them to one would be a
silent parity break, so they are separate governed identities with separate
verifier-owned installs.

## Resolution policy

1. A verifier-owned install whose recorded provenance still hash-verifies is
   reused.
2. A host binary is used only when its `--version` output matches the derived
   version **exactly**; that recognition is recorded with the binary's path
   and sha256, so it is an identity-verified decision rather than a silent
   substitution.
3. Otherwise the exact release asset for this platform is downloaded and
   verified against the project's published checksums file where one exists
   (gitleaks, trivy, syft do; osv-scanner does not — its first-fetch measured
   sha256 is recorded with that caveat explicit).
4. Anything else leaves the tool UNRESOLVED and every gate needing it BLOCKED.

Governed downloads are placed ahead of the host on `PATH`, so a newer host
copy can never shadow a governed identity — the live case being host gitleaks
8.30.1 versus the governed 8.24.3.

## Adapter equivalence

Three verdict-bearing marketplace actions are reproduced by adapters derived
from the pinned action sources, not from guesswork:

- **trivy-action** maps its `with:` inputs onto trivy CLI flags one-for-one;
  the adapter passes the workflow's own inputs verbatim.
- **sbom-action** runs syft against the image with the declared format and
  output; `upload-artifact: false` in this workflow, so generation is the
  whole verdict.
- **gitleaks-action** — the adapter uses the dist bundle's exact `Scan()`
  argv, including `--redact --exit-code=2 --report-format=sarif` and the
  `--log-opts=--no-merges --first-parent <base>^..<head>` range. The action
  derives `baseRef` from `pulls.listCommits` `data[0]`; locally the identical
  commit comes from `git rev-list --reverse --topo-order base..head | head -1`
  over the same history. `GITHUB_TOKEN`'s role there is commit enumeration and
  PR commenting — neither carries the verdict — and the action's own
  `BASE_REF` override proves the range is env-derivable without the API.

## Steps that carry no verdict

`actions/checkout`, `pnpm/action-setup`, `actions/setup-node`,
`actions/setup-python`, `astral-sh/setup-uv` are candidate materialization and
toolchain setup, owned locally by P01 and measured capability.
`actions/upload-artifact`, `actions/cache`, and
`github/codeql-action/upload-sarif` are CI plumbing: the finding they publish
is produced by a scanner step that IS reproduced locally.
