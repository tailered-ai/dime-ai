# SOL-REVIEW-DIRECTIVE v1.1 — independent review request for PRX v1.1

Reviewer: 5.6 Sol. Subject: the PRX v1.1 review candidate in
`tailered-ai/dime-ai`, branch `feat/prx-v1.1-communication-profile`, shipped
as one draft pull request in audit mode plus the review bundle
`pr-x-v1.1-review-candidate.zip`.

## Scope and verdict requested

Judge whether PRX v1.1 resolves the twenty v1.0 findings (verdict REJECT,
27/100) well enough to keep as an audit-mode lane and to start ROLLOUT.md
calibration. Requested outputs: verdict (ACCEPT-FOR-AUDIT / REVISE /
REJECT), scored findings SOL-PRX-101 onward with exact evidence, and the
required corrections stated as requirements. Rollout beyond audit remains
owner-gated regardless of verdict; nothing in this candidate changes the
ruleset, the required checks, or production.

## Internal review pass

The final diff went through a four-dimension adversarially-verified review
plus the repo's pre-landing checklist before submission; 17 confirmed
findings (2 high) were all fixed with regression tests. The register is in
the change ledger's "v1.1 internal review pass" section — read it first,
it names the exact defect classes that were caught and closed.

## What changed (one paragraph)

v1.1 is a rebuild, not a patch: the schema is the live dime-ai PR template
(14 sections), not a competing one; the body checker is a CommonMark AST
parser (mdast-util-from-markdown 2.0.2, already in the lockfile); the commit
checker is a structural parser with formal trailers and narrow exemption
spans; all 23 Sol bypasses are permanent fixtures pinned to exact finding
multisets; the CI verdict loads policy from the event base SHA with an
explicit UNTRUSTED bootstrap for this first PR; every action is SHA-pinned;
Vale 3.17.1 is checksum-locked with repo-local STE-inspired styles and no
`vale sync`; rollout modes audit/advisory/enforcing are implemented and
tested with the mode state committed in the trusted tree; every rule carries
an enforcement class and a provenance class; the unlocatable Tailered laws
stay PROPOSED in the law registry.

## Exact re-run commands (pinned tools)

From a checkout of the branch head SHA recorded below, with Node 22 and
pnpm 10.33.0 (`corepack` honors the packageManager pin):

1. `pnpm install --frozen-lockfile`
2. `npx vitest run scripts/prx/` — the PRX suites (7 files, 128 tests:
   unit, modes, CLI, trusted boundary, fixture-manifest integrity, and the
   23 adversarial fixtures).
3. `npx tsc --noEmit` (repo strict gate; NODE_OPTIONS=--max-old-space-size=6144).
4. `npx prettier --check scripts/prx .github/workflows/14-prx-communication.yml package.json`
5. `node scripts/check-github-actions-security.mjs`
6. `uvx zizmor==1.29.0 --min-severity high --format plain .github/workflows/14-prx-communication.yml`
7. Mutation: `npx -y -p @stryker-mutator/core@9 -p @stryker-mutator/vitest-runner@9 stryker run scripts/prx/stryker.prx.json`
8. Vale (macOS arm64; Linux asset in the lock):
   download per `docs/verification/prx/vale-lock.json`, verify the SHA-256,
   then `./vale --config scripts/prx/vale/.vale.ini docs/verification/prx/PRX-STANDARD-v1.1.md docs/verification/prx/vale-controls/*.md`

## Fixture execution

`scripts/prx/adversarial.test.ts` loads every fixture from
`docs/verification/prx/adversarial-fixtures/{commit,body}/` with its exact
expected multiset from `expected/<ID>.json`; a missing finding, an extra
finding, or an empty result fails. To run one case by hand:
`node scripts/prx/check-commit.mjs docs/verification/prx/adversarial-fixtures/commit/C08.txt --mode=enforcing`
(exits 1). Scaffold adaptations are recorded per fixture and in the change
ledger's adaptation section.

## Measured coverage and mutation state

Vitest (V8, in-process) on the pure libraries: body-check.mjs 90.07% branch
at 81 tests, raised by the mutation-hardening round; commit-check.mjs
93.91% branch; modes.mjs 92.85%; final numbers for the shipped test count
are in the bundle's `test-output/coverage-prx.txt`. The CLI wrappers show
low in-process numbers BY DESIGN: they are exercised as subprocesses in
`cli.test.ts` (register 6 above). Mutation: 64.49% total (730/371/32),
classes and proofs in `mutation-results.json`.

## UNKNOWN / BLOCKED register

1. `pnpm agent:context` is BLOCKED on this machine (fails closed:
   "node execution is blocked: independent root-owned provenance is
   unavailable"); repository identity was verified directly instead
   (target-repository-snapshot.json).
2. The v1.0 archive and the Sol v1.0 evidence bundle are ABSENT from the
   workspace; the execution contract's embedded appendices were used as the
   authoritative evidence (their checksums could therefore not be
   re-verified locally).
3. The cause of the local-vs-CI zizmor adjudication difference on the
   PRE-EXISTING auto-merge-dependabot.yml high finding is UNKNOWN (local
   run is offline-mode); the new workflow itself has zero findings.
4. Whether GitHub's 01/05/06/08/10/13 required checks pass on the PR is
   determined by CI after push; local equivalents that could run are
   recorded in the evidence files. DB-bound Vitest suites are not runnable
   locally (no CI secrets) by repo law; the PRX suites run fully.
5. Windows behavior of the checkers is UNKNOWN (macOS + Linux only).
6. In-process V8 coverage cannot see the CLI wrappers' subprocess
   integration tests; wrapper coverage is proven by cli.test.ts behavior,
   not by the coverage percentage.
7. ASD-STE100 fidelity is intentionally OUT OF SCOPE: the style layer is an
   STE-inspired subset and claims nothing more.

## Open questions for the reviewer

1. Threat-model A4: for `pull_request` events GitHub executes the workflow
   FILE from the head; base-trusted policy defends checker/fixtures/config
   but not the workflow itself. Is the documented bound (audit-only now;
   CODEOWNERS + required-review at graduation; merge_group re-run) an
   acceptable residual, or should graduation require an external policy
   repository?
2. Is the governed-scope predicate (opt-in via trailer presence or caller
   flag) the right v1.1 line, given 0/50 measured governed commits on main?
3. Should PRX-C-PREFIX stay in APPROVED_BLOCKING for a future enforcing
   mode, given 2/50 measured non-conforming human commits?

## Artifact map

SHA-256 values for every evidence artifact and implementation file are in
`docs/verification/prx/artifact-map.sha256` (generated at packaging time;
the review bundle's inventory covers the bundle itself). The bundle
contains: implementation (`scripts/prx/**`, the workflow, package.json and
lockfile diffs), all Section 14 evidence artifacts, the adversarial
fixtures, test/mutation/coverage output, the Vale lock and raw output, the
workflow-security output, the draft PR body, and the exact base and head
SHAs.

## Standing constraint

The candidate is a review artifact. Audit mode only; not a required check;
no merge, ruleset change, Notion mutation, Railway mutation, or production
deployment occurred or is authorized by this PR. Rollout beyond audit is an
owner decision after this review.
