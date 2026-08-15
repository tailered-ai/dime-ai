# SOL-REVIEW-DIRECTIVE v1.1-r2 — hand-off for the next independent review

Subject: the PRX v1.1-r2 correction-pass candidate in
`tailered-ai/dime-ai`, branch `feat/prx-v1.1-communication-profile`,
PR #511 (DRAFT, audit mode), review bundle
`pr-x-v1.1-r2-review-candidate.zip`.

THIS DOCUMENT IS INFORMATIONAL ONLY. It does not bound, direct, or limit
the independent reviewer's scope in any way; the review mandate comes
from the owner, not from this file. Draft-flip, merge, and graduation
remain owner-gated regardless of anything recorded here.

## Scope of the r2 pass

The second independent review of head
`d98793c21545bd4685151640140dd60c09a6190a` produced the Appendix R
register: BYP-C-01/02 and BYP-B-01/02 (HIGH), BYP-C-03, BYP-B-04,
BYP-C-04/05 (MED), BYP-C-06..09 (LOW, promoted), MUT-01..04 and
BYP-W-01 (evidence integrity), plus the systemic claims-sync item. The
r2 pass closed all of them under one design rule: fix the class, then
the instances. One repository-agnostic canonicalization module
(`scripts/prx/lib/canonical.mjs`) now owns the shared primitives —
trailer-key canonicalization, the meaningful-visible-text decision,
UTF-8 byte caps, the context-sensitive control policy,
CommonMark-consistent fence/indented-code classification, structured
evidence-reference validation, sanitized-text scanning, and raw-HTML
container tracking — and `scripts/prx/rules.mjs` is the dime-ai adapter
that configures them. Per-item register: the r2 section of
`v1.0-to-v1.1-change-ledger.md`. Same-class finds made while wiring
(zero-width subjects, inline-split removed elements, recursive
post-parse walkers, the environment-dependent parser-overflow degrade)
were fixed in the same pass with fixtures.

## Fixture instructions

The 23 Sol fixtures are unchanged and still pinned
(`scripts/prx/adversarial.test.ts`). The 27 r2 fixtures live in
`docs/verification/prx/adversarial-fixtures/r2/` (R2C01–R2C15 commit,
R2B01–R2B12 body), each SHA-256-pinned in `manifest.json` under
`r2_fixtures`, each with an exact expected finding multiset or an
extractProse prose contract (positive controls included so nothing
passes vacuously) in `r2/expected/<ID>.json`; the harness is
`scripts/prx/adversarial-r2.test.ts` and byte integrity is enforced by
`scripts/prx/fixture-integrity.test.ts`. Fixtures carrying control
bytes or megabyte payloads are regenerated deterministically by
`docs/verification/prx/tools/gen-r2-fixtures.mjs`. To run one case by
hand:
`node scripts/prx/check-commit.mjs docs/verification/prx/adversarial-fixtures/r2/commit/R2C01.txt --mode=enforcing`
(exits 1).

## Exact re-run commands (pinned tools)

From a checkout of the head SHA recorded in the bundle's
`closeout/head-sha.txt`, with Node 22 and pnpm 10.33.0 (corepack honors
the packageManager pin):

1. `pnpm install --frozen-lockfile --ignore-scripts`
2. `npx vitest run scripts/prx/` — 13 suites, 479 tests (the r1 set
   plus `canonical.test.ts`, `adversarial-r2.test.ts`, and
   `r2-parity.test.ts`).
3. `npx tsc --noEmit`
4. `npx prettier --check scripts/prx .github/workflows/14-prx-communication.yml .github/workflows/15-prx-mutation.yml package.json`
5. `node scripts/check-github-actions-security.mjs`
6. `zizmor` 1.29.0: `zizmor ./.github/workflows/14-prx-communication.yml`
   and `zizmor ./.github/workflows/15-prx-mutation.yml`
7. `gitleaks git --log-opts="<base>..<head>" .` (8.x; base/head in the
   bundle's closeout SHAs)
8. Vale 3.17.1: download and checksum-verify per
   `docs/verification/prx/vale-lock.json`, then
   `./vale --config scripts/prx/vale/.vale.ini <updated docs> docs/verification/prx/vale-controls/*.md`
9. Mutation (focused, per changed module): local full runs are BLOCKED
   on the authoring machine (8 GB; concurrency 8-12 exhausted memory),
   so the runs execute in CI — add the `prx-mutation` label to the PR
   (workflow `15-prx-mutation`, Stryker 9.6.1 exact-pinned,
   `--concurrency 2`, one job per module). Reproduce a single module
   locally with
   `npx stryker run scripts/prx/stryker.blocking.prx.json --mutate scripts/prx/rules.mjs --concurrency 2`
   sized to your machine. Figures and triage:
   `mutation-blocking-dispositions.md` §"r2 focused rerun".

## Mutation-evidence state, honestly scoped

The r1 focused-run figures (92.88% / 95.17%, zero unreviewed survivors)
stand as the HISTORICAL record for head `d98793c2…`; the four
disposition-integrity defects the second review found in that record
(MUT-01..04) are corrected in place with "CORRECTED r2" tags, and the
replay log is reconciled to the final survivor population (109
records). The r2 rerun figures are separate, scoped to the label-gated
CI environment, and triaged BY CLASS rather than to the r1 bar of
individually-proven survivors — that gap is stated in the dispositions
document, not hidden. The `15-prx-mutation` lane re-runs on demand.

## UNKNOWN / BLOCKED register (r2)

1. `pnpm agent:context` remains BLOCKED on this machine ("node
   execution is blocked: independent root-owned provenance is
   unavailable"); repository identity was verified directly
   (`git remote -v`, `git rev-parse --show-toplevel`, `gh repo view`).
2. Local full mutation testing is BLOCKED (memory); the CI matrix is
   the execution surface, and per-module CI runs are the evidence.
3. The `Security Audit` required check FAILS on this PR
   (GHSA-jmr9-qjv8-65gv, extract-zip, no patched version) —
   pre-existing, not introduced by this branch, explicitly out of r2
   scope; its disposition belongs to PREZ. Dependent main-CI jobs skip
   as fallout; `DB Tests` is not executed on this PR. Exact per-check
   conclusions at the final head: the bundle's
   `closeout/final-ci-status.json`.
4. Trusted-path live validation remains UNKNOWN (R10): every run on
   this PR is `UNTRUSTED (bootstrap)` by design.
5. Windows behavior of the checkers is UNKNOWN (macOS + Linux only).
6. GitHub production sanitizer parity is an ASSUMPTION, stated in the
   source-trace matrix (`PRX-B-SANITIZER-REMOVED-CONTENT` row): the
   removed-content element set is pinned to the closest public
   implementation (selma `remove_contents` via html-pipeline), and the
   affected rules are EXTERNAL_ADAPTATION, never EXTERNAL_REQUIREMENT.
   A removed element split across block boundaries by blank lines is
   outside the modeled scope.
7. The r2 mutation residual (class-triaged survivors without individual
   written proofs) is an open follow-up, recorded in
   `mutation-blocking-dispositions.md` §"r2 focused rerun".

## Artifact map

`docs/verification/prx/artifact-map.sha256` is regenerated at r2
packaging time: one SHA-256 per tracked PRX artifact (implementation,
evidence, fixtures, workflows; the map cannot include itself). The
review bundle's `closeout/bundle-inventory.sha256` covers every bundle
member, `closeout/head-sha.txt` and `closeout/base-sha.txt` carry the
full 40-hex SHAs, and the archive sidecars carry the full 64-hex
archive digests.

## Standing constraint

The candidate is a review artifact. Audit mode only; not a required
check; no merge, draft-flip, ruleset change, required-check change,
Notion mutation, Railway mutation, or production deployment occurred in
the r2 pass or is authorized by it. Green tests, a pushed branch, and a
built archive are not merge or graduation authorization. Acceptance
requires a separate independent reviewer session and owner decisions.
