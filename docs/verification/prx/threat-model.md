# PRX v1.1 threat model — trusted CI boundary

Scope: the PRX communication-profile lane (`scripts/prx/`,
`.github/workflows/14-prx-communication.yml`, `docs/verification/prx/`) in
`tailered-ai/dime-ai`. Written before implementation per the v1.1 execution
contract §8.1, in response to SOL-PRX-004 and SOL-PRX-009.

## Assets

1. The PRX verdict (step summary, annotations, and — after owner-gated
   graduation only — a required-check conclusion).
2. The Actions token (kept `contents: read`, no secrets in the lane).
3. The integrity of trusted policy code: checker libraries, rule registry,
   fixtures, Vale configuration, and `vale-lock.json` pins.
4. Reviewer attention (a falsely green audit lane wastes it; a noisy one
   erodes it).

## Actors and trust levels

| Actor | Trust | Notes |
| --- | --- | --- |
| Base branch (`main`) content at the event's recorded base SHA | TRUSTED | protected by ruleset `main-protection` (1 approval, last-push approval, thread resolution, required checks) |
| PR head content (files, package manifests, configs, fixtures) | UNTRUSTED | may be authored by an agent or any contributor |
| PR title, body, commit messages | UNTRUSTED DATA | inputs to be judged, never executed; reach shells only through env vars |
| GitHub event payload SHAs | TRUSTED METADATA | authenticated by GitHub, used to select refs |
| Third-party actions | PINNED | full commit SHA + version comment, per the repo's 05-workflow-security contract |
| Vale binary and styles | PINNED | exact release asset + SHA-256 committed in `vale-lock.json`; download fails closed on mismatch; no `vale sync`, no external style package |

## The boundary

**Policy code that produces the verdict is loaded from the trusted base ref,
never from the pull request head.** The workflow checks out
`github.event.pull_request.base.sha` (or `github.event.merge_group.base_sha`)
into a separate `trusted-policy/` directory and executes
`trusted-policy/scripts/prx/*` against the untrusted data. The head checkout
is used only as data (commit messages via `git log`, changed files via
diff against the explicit merge base). `pull_request_target` is not used
anywhere. Selection logic lives in `scripts/prx/policy-source.mjs` and is
covered by `scripts/prx/trusted-boundary.test.ts`, which mutates a simulated
head copy of the checker and proves the selected policy (and therefore the
verdict) does not change.

## Attack classes and dispositions

| # | Attack | Disposition |
| --- | --- | --- |
| A1 | PR replaces `scripts/prx/*` checker code to weaken its own gate | DEFENDED — verdict code comes from `trusted-policy/` (base SHA); head copies are never imported. Regression test: `trusted-boundary.test.ts` |
| A2 | PR replaces fixtures or expected-finding sets in the same change | DEFENDED for the CI verdict (same mechanism as A1). The vitest suite that runs from the head (01-pr-proof-contract) can be edited by a PR, but it is not the PRX verdict; fixture edits are reviewer-visible diffs on CODEOWNERS-listed paths |
| A3 | PR edits `.vale.ini`, styles, or `vale-lock.json` to change style policy | DEFENDED — Vale config, styles, and lock are read from `trusted-policy/`; the binary checksum is verified against the trusted lock before execution |
| A4 | PR edits `14-prx-communication.yml` itself | RESIDUAL, DOCUMENTED — for `pull_request` events GitHub executes the workflow file from the PR merge ref, so a same-repo PR can alter the lane's own orchestration. Machine-prevention is impossible without `pull_request_target` (rejected: it would execute with elevated context) or an external policy repo (rejected for v1.1: new infrastructure must earn its existence; this lane is audit-only). Bounds: the lane is NOT a required check in this PR; `/.github/` is CODEOWNERS-listed and the diff is reviewer-visible; `merge_group` runs execute the workflow from the queue commit built on protected `main`; graduation to required is an owner ruleset action that should weigh this residual (recorded in SOL-REVIEW-DIRECTIVE-v1.1.md open questions) |
| A5 | Malicious PR title/body/commit text escapes into shell or expression context | DEFENDED — event text enters steps only via `env:` bindings consumed as data; no `${{ }}` interpolation of title/body inside `run:` scripts; zizmor (pinned 1.29.0) and `scripts/check-github-actions-security.mjs` both scan the workflow |
| A6 | Dependency substitution at check time | DEFENDED — `pnpm install --frozen-lockfile` against the TRUSTED base lockfile inside `trusted-policy/`; the head lockfile is never installed by this lane. The one parser dependency (`mdast-util-from-markdown@2.0.2`) is already pinned in the base lockfile |
| A7 | Unpinned action or tag-moving upstream | DEFENDED — every action pinned to a full commit SHA with a version comment (repo house pins reused); update path is a deliberate PR through 05-workflow-security |
| A8 | Resource exhaustion via giant bodies/messages | BOUNDED — job `timeout-minutes` on every job; checker inputs capped (1 MiB per document) with an explicit `PRX-SIZE` finding rather than an OOM |
| A9 | Fork PRs | BOUNDED — `pull_request` from forks receives a read-only token and no secrets exist in the lane; base-policy checkout works identically because the base SHA lives in the base repository |
| A10 | Secrets exfiltration | N/A BY CONSTRUCTION — the lane mounts no secrets, sets `permissions: contents: read`, and prints only checker findings |

## Bootstrap honesty (this PR)

`main` does not yet contain `scripts/prx/`. Until this PR merges, the
base-policy checkout finds no policy and the workflow runs in explicit
**bootstrap-audit** mode: it executes the head's own copy, labels the run
`UNTRUSTED (bootstrap)` in the step summary, and always succeeds. The
base-trusted boundary therefore does NOT govern this PR's own run and no such
claim is made. Two-step activation: (1) this reviewed PR lands the policy on
`main`; (2) later runs load policy from base and are trusted. This is the
honest sequencing SOL-PRX-004 demanded.

## Explicit non-uses

- `pull_request_target`: never used.
- Repository secrets: none read.
- Mutable repository variables as integrity source: none; `vale-lock.json`
  in trusted policy is the only integrity source for the Vale binary.
- `vale sync` / external style packages: not used at all in v1.1.
