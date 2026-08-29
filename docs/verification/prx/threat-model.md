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
`github.event.pull_request.base.sha` (or `github.event.merge_group.base_sha`;
on `workflow_dispatch` there is no PR and the checkout falls back to
`github.sha`, the dispatched ref itself — that run only exercises the
canary) into a separate `base/` directory and executes `base/scripts/prx/*`
against the untrusted data. The head checkout
is used only as data (commit messages via `git log`, changed files via
diff against the explicit merge base). `pull_request_target` is not used
anywhere. The workflow's [BOUNDARY] step mirrors
`scripts/prx/policy-source.mjs` in bash — it cannot import a module before
deciding which tree's modules are trusted, so the module is the tested
reference implementation of the selection contract, covered by
`scripts/prx/trusted-boundary.test.ts`, which mutates a simulated
head copy of the checker and proves the selected policy (and therefore the
verdict) does not change.

## Attack classes and dispositions

| # | Attack | Disposition |
| --- | --- | --- |
| A1 | PR replaces `scripts/prx/*` checker code to weaken its own gate | DEFENDED — verdict code comes from `base/` (the event base SHA); head copies are never imported. Regression test: `trusted-boundary.test.ts` |
| A2 | PR replaces fixtures or expected-finding sets in the same change | DEFENDED for the CI verdict (same mechanism as A1). The vitest suite that runs from the head (01-pr-proof-contract) can be edited by a PR, but it is not the PRX verdict; fixture edits are reviewer-visible diffs on CODEOWNERS-listed paths |
| A3 | PR edits `.vale.ini`, styles, or `vale-lock.json` to change style policy | DEFENDED post-merge; BOOTSTRAP CARVE-OUT STATED (r2 BYP-W-01, matching A6/A10) — in trusted mode the Vale config, styles, and lock are read from `base/` and the binary checksum is verified against that trusted lock before execution. During the explicitly UNTRUSTED bootstrap the policy tree IS the head, so all three come from the head and the checksum proves only self-consistency with the head's own lock — not trust. Bounds for that one mode: the style layer is advisory in every mode, the job mounts no secrets, and the run is labeled UNTRUSTED; post-merge runs restore the base-trusted reading |
| A4 | PR edits `14-prx-communication.yml` itself | RESIDUAL, BOUNDED BY A HARD GRADUATION BLOCKER (R6) — for `pull_request` events GitHub executes the workflow file from the PR merge ref, so a same-repo PR can alter the lane's own orchestration. Machine-prevention is impossible without `pull_request_target` (rejected: it would execute with elevated context) or an external policy repo (rejected for v1.1: new infrastructure must earn its existence; this lane is audit-only). Bounds: the lane is NOT a required check; `/.github/` is CODEOWNERS-listed and the diff is reviewer-visible; `merge_group` runs execute the workflow from the queue commit built on protected `main`. **Invariant, not an open question: PRX must not enter enforcing mode and must not become a required status check while the pull-request head controls the workflow file that orchestrates the verdict. Graduation requires a separately reviewed base-controlled orchestration mechanism first — a constrained base workflow, a `workflow_run` design, a GitHub App, or another independently protected mechanism. None of that infrastructure is implemented in v1.1.** |
| A5 | Malicious PR title/body/commit text escapes into shell or expression context | DEFENDED — event text enters steps only via `env:` bindings consumed as data; no `${{ }}` interpolation of title/body inside `run:` scripts; zizmor (pinned 1.29.0) and `scripts/check-github-actions-security.mjs` both scan the workflow |
| A6 | Dependency substitution or install-time code execution at check time | DEFENDED, STATED EXACTLY (R7) — the install is `pnpm -C "$POLICY" install --frozen-lockfile --ignore-scripts`. In trusted mode the policy tree is the base checkout, so the trusted base lockfile governs resolution. During the explicitly UNTRUSTED bootstrap the policy tree IS the head, so the head dependency graph is used — for that one mode only — with lifecycle scripts disabled, no secrets in the job, and the result proving operability only; post-merge runs install the trusted base policy dependency graph. Regression: `scripts/prx/bootstrap-install.test.ts` proves a malicious `postinstall` marker is not created under `--ignore-scripts` (and IS created in the negative control). The parser dependencies (`mdast-util-from-markdown@2.0.2`, `mdast-util-gfm@3.1.0`, `micromark-extension-gfm@3.0.0`) are pinned in the lockfile |
| A7 | Unpinned action or tag-moving upstream | DEFENDED — every action pinned to a full commit SHA with a version comment (repo house pins reused); update path is a deliberate PR through 05-workflow-security |
| A8 | Resource exhaustion via giant or pathologically nested bodies/messages | BOUNDED — job `timeout-minutes` on every job; inputs byte-capped at 1 MiB in UTF-8 bytes (`PRX-C-SIZE`/`PRX-B-SIZE` findings); every post-parse walker is iterative (attacker nesting depth never becomes JS stack depth; r2 extended this from the finding walk to the visibility, section-content, inline-text, and prose traversals); r2 adds a deterministic structural pre-cap — more than `BLOCKQUOTE_DEPTH_CAP = 512` leading blockquote markers on one line degrades to `PRX-B-SIZE` before parsing, identically in every environment (the decision reads only the raw string; the previous parser-overflow degrade varied with the runtime stack budget). The boundary is pinned executable at cap−1 / at-cap / cap+1 by fixtures PC511/PC512/PC513, and the pre-cap's known over-approximation is pinned by PCF600 and disclosed in the change ledger's r3 entry: the scan runs before parsing so it has no fence context, and a >512-marker run inside legitimate fenced code content also degrades to `PRX-B-SIZE`. Residual, stated plainly: the pre-cap covers only the leading-blockquote-marker shape; the byte cap does not bound CommonMark PARSE cost for OTHER pathological shapes — a near-cap deeply nested non-blockquote body can still burn minutes up to the job timeout |
| A9 | Fork PRs | BOUNDED — `pull_request` from forks receives a read-only token and no secrets exist in the lane; base-policy checkout works identically because the base SHA lives in the base repository |
| A10 | Secrets exfiltration | N/A BY CONSTRUCTION — the lane mounts no secrets, sets `permissions: contents: read`, and prints only checker findings. Combined with A6 (R7): even in the untrusted bootstrap, where the head's own dependency graph installs, there is nothing in the job for install-time or check-time code to exfiltrate, and lifecycle scripts are disabled anyway |

## Bootstrap honesty (this PR)

`main` does not yet contain `scripts/prx/`. Until this PR merges, the
base-policy checkout finds no policy and the workflow runs in explicit
**bootstrap-audit** mode: it executes the head's own copy, labels the run
`UNTRUSTED (bootstrap)` in the step summary, and always succeeds. The
base-trusted boundary therefore does NOT govern this PR's own run and no such
claim is made. Two-step activation: (1) this reviewed PR lands the policy on
`main`; (2) later runs load policy from base and are trusted. This is the
honest sequencing SOL-PRX-004 demanded.

What PR #511's own successful run proves, exactly (R10): the workflow was
successfully executed, audit-only, explicitly `UNTRUSTED (bootstrap)`; it is
evidence that the workflow is OPERATIONAL and nothing more. It is NOT
evidence that the base-trusted policy boundary governed PR #511.

Future validation requirement (R10): after PRX exists on protected `main`, a
later pull request must exercise the `trusted (base ref)` path before any
audit-to-advisory graduation, and the workflow summary or check annotation
from that later run must be preserved as evidence. Until then, trusted-path
live validation is `UNKNOWN`.

## Explicit non-uses

- `pull_request_target`: never used.
- Repository secrets: none read.
- Mutable repository variables as integrity source: none; `vale-lock.json`
  in trusted policy is the only integrity source for the Vale binary.
- `vale sync` / external style packages: not used at all in v1.1.
