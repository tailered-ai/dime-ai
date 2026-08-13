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

## Remediation pass (CHANGES REQUIRED, 74/100)

A first independent remediation review returned CHANGES REQUIRED with
eleven items, R1–R11, all closed on this branch in additive commits (no
history rewrite). The register with per-item dispositions is
`docs/verification/prx/remediation-disposition.md`; the change ledger's
"v1.1 remediation pass" section carries the same content in ledger form.
Headlines: fail-closed merge-base resolution (R2, `resolve-range.mjs`);
the governed-scope circularity removed and Co-Authored-By validated
wherever it appears (R3); parent-aware narrative-prose extraction with GFM
fidelity (R4); meaningful-visible-content section validation with
MISSING/DUP/EMPTY subcodes (R5); the A4 workflow-file residual converted
into a hard graduation invariant (R6); bootstrap installs run
`--ignore-scripts` with a marker-file regression proof (R7); a focused
blocking-path mutation configuration with per-mutant dispositions (R8);
provenance reclassifications — no external adaptation without an exact
source (R9); bootstrap-run language corrected to operability-evidence-only
(R10); and the pre-existing Security Audit failure recorded exactly and
held as a separate owner disposition (R11).

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
2. `npx vitest run scripts/prx/` — the PRX suites (10 files, 303 tests:
   unit, modes, CLI (subprocess + in-process), trusted boundary,
   fail-closed range resolution, bootstrap `--ignore-scripts`,
   fixture-manifest integrity, registry class table, and the 23
   adversarial fixtures).
3. `npx tsc --noEmit` (repo strict gate; NODE_OPTIONS=--max-old-space-size=6144).
4. `npx prettier --check scripts/prx .github/workflows/14-prx-communication.yml package.json`
5. `node scripts/check-github-actions-security.mjs`
6. `uvx zizmor==1.29.0 --min-severity high --format plain .github/workflows/14-prx-communication.yml`
7. Mutation, two configurations (R8): the GATE-RELEVANT focused
   blocking-path run
   `npx -y -p @stryker-mutator/core@9 -p @stryker-mutator/vitest-runner@9 stryker run scripts/prx/stryker.blocking.prx.json`
   (per-mutant dispositions in `mutation-blocking-dispositions.md`), and
   the broader EXPLORATORY, NON-GATING run
   `npx -y -p @stryker-mutator/core@9 -p @stryker-mutator/vitest-runner@9 stryker run scripts/prx/stryker.prx.json`
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

The shipped suite is 10 files / 303 tests (all passing from the final
tree; raw output in the bundle's `test-output/`). Mutation evidence is
two-tier (R8): the GATE-RELEVANT focused blocking-path run over the eight
decision-path modules, with per-mutant dispositions — zero unreviewed
survivors, zero unexplained no-coverage mutants, individual equivalence
proofs, and empirical replay evidence for Stryker activation artifacts —
in `mutation-blocking-dispositions.md` (raw report:
`mutation-blocking-results.json`); and the broader EXPLORATORY, NON-GATING
run including display metadata in `mutation-results.json`. Two measurement
caveats, stated plainly: in-process V8 coverage cannot see the CLI
wrappers' subprocess integration tests, and StrykerJS cannot activate
mutants across a process boundary or reliably re-execute module scope —
both classes are dispositioned with hand-applied replay runs of the real
suite, not waved off.

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
4. CI state is recorded exactly in the bundle's `final-ci-status.json`
   (R1). On this PR the `Security Audit` required check FAILS (pre-existing
   OSV database event, see the R11 register in
   `remediation-disposition.md`), and the main CI workflow's dependent
   jobs — TypeScript Check, Vitest, Build & Preview Gate — are SKIPPED
   because their dependency failed; `DB Tests` is SKIPPED and therefore
   NOT EXECUTED on this PR. `01-pr-proof-contract` passes separately.
   Local equivalents that could run are recorded in the evidence files;
   DB-bound Vitest suites are not runnable locally (no CI secrets) by repo
   law; the PRX suites run fully.
5. Windows behavior of the checkers is UNKNOWN (macOS + Linux only).
6. In-process V8 coverage cannot see the CLI wrappers' subprocess
   integration tests; wrapper coverage is proven by cli.test.ts behavior,
   not by the coverage percentage.
7. ASD-STE100 fidelity is intentionally OUT OF SCOPE: the style layer is an
   STE-inspired subset and claims nothing more (R9: the STE-inspired rules
   are classified NEW_PROPOSAL — no exact ASD issue or rule identifier is
   claimed).
8. Trusted-path live validation is UNKNOWN (R10): PR #511's own run is
   `UNTRUSTED (bootstrap)` by design and proves operability only. After
   PRX exists on protected `main`, a later PR must exercise the
   `trusted (base ref)` path — and its workflow summary must be preserved
   as evidence — before any audit-to-advisory graduation.

## Open questions for the reviewer

1. RESOLVED AS AN INVARIANT (R6), no longer a question: PRX must not enter
   enforcing mode and must not become a required status check while the
   pull-request head controls the workflow file that orchestrates the
   verdict (threat-model A4). Graduation requires a separately reviewed
   base-controlled orchestration mechanism — a constrained base workflow, a
   `workflow_run` design, a GitHub App, or another independently protected
   mechanism — none of which is implemented in v1.1. What remains open for
   review is only WHICH mechanism to adopt, not whether one is required.
2. Is the governed-scope predicate (opt-in via trailer presence or caller
   flag) the right v1.1 line, given 0/50 measured governed commits on main?
   The ordinary range audit does not classify commits as governed (R3);
   mandatory classification stays a reviewer/future-integration concern.
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
