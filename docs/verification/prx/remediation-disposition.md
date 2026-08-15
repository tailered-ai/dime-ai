# PRX v1.1 remediation disposition — R1 through R11

Independent remediation review verdict on the first pushed candidate:
`CHANGES REQUIRED, 74/100`. This register records the final disposition of
every required item. All corrections landed as additive commits on
`feat/prx-v1.1-communication-profile`; no history rewrite, no force push,
no rebase. PR #511 remains a draft; the lane remains audit-only.

Status vocabulary: the execution contract's Section 4 terms
(BUILT / PARSED / EXECUTED / ADVERSARIALLY_VERIFIED /
REPOSITORY_INTEGRATED / OWNER_ENFORCED / UNKNOWN / BLOCKED).

## R1 — CI reporting corrected

State: REPOSITORY_INTEGRATED. The prior report described all skipped
checks as Dependabot-only. Corrected everywhere to the exact GitHub data:
`Security Audit` FAILS (see R11); the main CI workflow's dependent jobs —
`TypeScript Check`, `Vitest`, `Build & Preview Gate` — are SKIPPED because
their dependency failed; `DB Tests` is SKIPPED and therefore NOT EXECUTED
on this PR; `01-pr-proof-contract` passes separately; independent
workflows report their own results. Changed: the draft PR body, the SOL
directive UNKNOWN register (item 4), this evidence set. The
machine-readable snapshot from the final remediation head is the bundle's
`final-ci-status.json` (a BUNDLE-ONLY closeout artifact captured after the
final push — deliberately not a tracked repository file, since a tracked
copy would be stale the moment any check re-ran). No claim anywhere that
the main CI TypeScript,
Vitest, or build jobs passed, or that DB tests executed.

## R2 — merge-base resolution fails closed

State: ADVERSARIALLY_VERIFIED. The fail-open pattern
`git merge-base "$BASE_SHA" "$HEAD_SHA" || echo "$BASE_SHA"` is removed.
The workflow now verifies both authenticated event SHAs exist
(`git -C head cat-file -e "<sha>^{commit}"`) and calls
`scripts/prx/resolve-range.mjs` — the tested module IS what CI executes,
not a bash mirror. The module validates: both SHAs are full 40-hex ids,
both commits exist, `git merge-base` succeeds, its output is a full 40-hex
SHA, and the merge base is an ancestor of HEAD_SHA. Any failure exits 1
with `::error::` surfaced by the workflow — a red tool failure, never a
substituted range. Regression tests (`scripts/prx/resolve-range.test.ts`):
missing base commit, missing head commit, unrelated histories, malformed
merge-base output (injected git runner), non-ancestor merge base
(injected), ordinary PR topology, merge-group topology, CLI exit codes
0/1/2, import safety.

## R3 — governed-scope circularity removed

State: ADVERSARIALLY_VERIFIED. The honest audit-mode design: (1)
`PRX-C-GOV` validates the complete governed schema only when the caller
supplies `--governed` or the message carries a `Run-Id`/`Evidence`
trailer; (2) the ordinary PR commit-range workflow claims nowhere that it
proves mandatory governed-trailer presence — the range audit's own
diagnostics now print the opt-in scope note; (3) the standard (§3), the
source-trace matrix, the law registry, and the PR body state that PRX
validates governed trailer syntax and completeness once governed scope is
explicitly established, that the ordinary range audit does not
independently determine a commit ought to be governed, and that mandatory
classification remains a reviewer or future-integration concern; (4) any
parsed `Co-Authored-By` is validated wherever it appears — a malformed
lone `Co-Authored-By` produces a deterministic `PRX-C-TRAILER` finding
without activating the Run-Id/Evidence requirements. Fixture coverage
(`commit-check.test.ts`, R3 suite): missing-all with `--governed`; valid
with `--governed`; activation via `Run-Id`; malformed lone
`Co-Authored-By`; valid lone `Co-Authored-By`; mid-body `Co-Authored-By:`
prose line (not a trailer); duplicate `Run-Id`; duplicate `Evidence`;
multiple valid `Co-Authored-By`; malformed `Co-Authored-By` among governed
trailers. Adversarial fixture C02's expected multiset was re-pinned to the
new split (2×GOV + 3×TRAILER + PREFIX; same six findings, same mechanism).

## R4 — narrative-prose extraction is parent-aware

State: ADVERSARIALLY_VERIFIED. `extractProse` now runs an iterative
parent-aware traversal: a paragraph is narrative only if NO ancestor is a
structured container (`list`, `listItem`, `table`, `tableRow`,
`tableCell`, `blockquote`, `code`, `html`, `heading`, `definition`,
`footnoteDefinition`). The parser now speaks GFM
(`mdast-util-gfm@3.1.0` + `micromark-extension-gfm@3.0.0`, both already in
the lockfile via remark-gfm — zero new packages), so tables and task-list
checkboxes parse as their real node types instead of leaking through
paragraphs. The identifier capsule and evidence-record YAML are code
blocks; template checkboxes live under listItems — all excluded by the
same ancestor rule. Tests prove: ordinary narrative included; bullet text,
nested bullet text, loose-list nested paragraphs, checkbox text, table
cells, blockquoted text, code, raw HTML, capsule values, and evidence
YAML all excluded; decoded entities preserved in real narrative; and the
"skips code/list content" test now explicitly asserts the list content is
absent.

## R5 — meaningful visible section content

State: ADVERSARIALLY_VERIFIED. Node-presence validation replaced by
`hasVisibleSectionContent`: a required section is non-empty only when it
contains meaningful rendered text or accepted structured content.
Rejected (each with a test): whitespace-only, HTML comments, empty fenced
blocks, thematic breaks, empty HTML, images with empty/missing alt text,
links with no visible label, empty lists, empty tables, subheadings with
no following content. Accepted (each with a test): visible prose, the
exact `none` convention, non-empty lists, non-empty checklists, non-empty
tables, visible link labels, visible image alt text, populated structured
evidence blocks. Distinct subcodes replace the broad id in the registry
and in `APPROVED_BLOCKING`: `PRX-B-SECTION-MISSING`, `PRX-B-SECTION-DUP`,
`PRX-B-SECTION-EMPTY`. Expected finding sets B03 (14×EMPTY), B04 (DUP),
and B10 (14×MISSING) re-pinned; fixture bytes unchanged, so the manifest
pins are untouched.

## R6 — workflow-file residual is a hard graduation blocker

State: REPOSITORY_INTEGRATED. The rollout contract changed from an open
question to an invariant, recorded in `PRX-STANDARD-v1.1.md` (§7, §9),
`threat-model.md` (A4), `SOL-REVIEW-DIRECTIVE-v1.1.md` (resolved question
1 + remediation section), the workflow header comment, the change ledger,
and the draft PR body's residual limitations:

> PRX must not enter enforcing mode and must not become a required status
> check while the pull-request head controls the workflow file that
> orchestrates the verdict.

Graduation requires a separately reviewed base-controlled orchestration
mechanism (constrained base workflow, `workflow_run` design, GitHub App,
or another independently protected mechanism). That infrastructure is
deliberately NOT implemented in this remediation. The repo-wide
`docs/verification/ROLLOUT.md` is outside the PRX edit scope; the
invariant binds PRX through the PRX standard, which governs this lane.

## R7 — no lifecycle-script execution during bootstrap

State: ADVERSARIALLY_VERIFIED. The install step is now
`pnpm -C "$POLICY" install --frozen-lockfile --ignore-scripts` in every
mode (a PRX-scoped smaller install was considered and rejected for this
pass: it would need a separate manifest/lockfile pair — broader repository
change than the flag). Threat-model A6/A10 state the exact bootstrap
behavior: the head dependency graph is used only during the explicitly
untrusted audit bootstrap; lifecycle scripts are disabled; no secrets
exist in the job; the result proves operability only; post-merge runs
install the trusted base policy dependency graph. No claim that the head
package/lockfile is never installed. Regression
(`bootstrap-install.test.ts`): a package fixture whose `postinstall`
writes a marker — marker NOT created under `--ignore-scripts`; negative
control with a fresh `node_modules` and no flag proves the marker CAN
appear.

## R8 — blocking-path mutation evidence

State: EXECUTED + ADVERSARIALLY_VERIFIED (per-mutant). A focused
configuration (`scripts/prx/stryker.blocking.prx.json`) mutates exactly
the libraries and decisions reachable by `APPROVED_BLOCKING` — the eight
decision-path modules: `commit-check.mjs`, `body-check.mjs`, `modes.mjs`,
`policy-source.mjs`, `resolve-range.mjs`, `rules.mjs`, and (added on
internal-review challenge, since `listCommits` and the exit-code wiring
are decision-reachable) the CLI wrappers `check-commit.mjs` and
`check-body.mjs`. Display metadata (rule titles, surface labels) was
split into `rule-metadata.mjs` — excluded from the focused run under
R8's rule-title-metadata exclusion by FILE BOUNDARY, not by survivor
hand-waving — with `rules.test.ts` pinning key-set equality and an
independent class table so no class value can drift. Diagnostic message
text is excluded via explicit, reasoned
`// Stryker disable next-line StringLiteral` annotations at the exact
finding-message sites; Boolean, conditional, comparison, parser, grammar
(regex), and verdict logic remain fully mutated. Two measurement-tool
limits are handled with EMPIRICAL evidence rather than assertions:
StrykerJS cannot activate a mutant across a process boundary (subprocess
CLI tests) and does not reliably re-execute module scope (static
mutants), so every survivor in those classes was hand-applied to the real
source and the real suite re-run — the replay log ships in the bundle,
and a replayed suite failure is recorded as KILLED-IN-REALITY with the
artifact class named. Results, dispositions, and the acceptance evidence
(zero unreviewed survivors, zero unexplained no-coverage mutants,
individual equivalence proofs, direct negative tests for every
deterministic blocking condition) are in
`mutation-blocking-dispositions.md` with the raw JSON at
`mutation-blocking-results.json`. The broader all-file run (including
metadata and message strings) is kept as EXPLORATORY, NON-GATING evidence
in `mutation-results.json`. Mutation evidence cannot authorize
enforcement; it only removes a technical blocker from future owner
consideration.

## R9 — provenance classifications corrected

State: REPOSITORY_INTEGRATED. Every `EXTERNAL_REQUIREMENT` /
`EXTERNAL_ADAPTATION` row was re-audited. Reclassified to `NEW_PROPOSAL`
(no exact source revision/section/rule identifier existed):
`PRXSTE.NoLitotes`, `PRXSTE.SentenceLengthTarget`,
`PRXSTE.SentenceLengthLimit` (generic STE-inspired principles; the
"STE-inspired subset" label is preserved and no ASD-STE100 conformity or
certification is claimed), and `PRXSTE.Filler` (the prior Google-style
citation named no exact section). Kept with exact sources:
the Beams rows (named rule numbers at a lawful public URL),
`git interpret-trailers` / `git rebase --autosquash` (named doc
sections), and `PRXSTE.PlainWords` (named word-list entries:
`utilize`→`use`, `prior to`→`before`). Both CSVs regenerated and machine-validated
(uniform column counts, parseable).

## R10 — bootstrap-validation language corrected

State: REPOSITORY_INTEGRATED. All completion language now states exactly:
the PRX workflow run on PR #511 was successfully executed, audit-only,
explicitly `UNTRUSTED (bootstrap)`, is evidence the workflow is
operational, and is NOT evidence that the base-trusted policy boundary
governed PR #511. Future validation requirement recorded in the standard
(§7) and the SOL directive (UNKNOWN register 8): after PRX exists on
protected `main`, a later PR must exercise the `trusted (base ref)` path
before any audit-to-advisory graduation, and that run's workflow summary
or check annotation must be preserved as evidence. Until then,
trusted-path live validation is `UNKNOWN`.

## R11 — the OSV finding stays separate and exact

State: BLOCKED — separate PREZ security disposition required. Not touched
in this remediation: no `osv-scanner.toml` edit, no Playwright or
extract-zip change, no dependency override. Exact advisory facts
(GitHub Advisory API + the failing run on this PR's branch):

- Advisory: `GHSA-jmr9-qjv8-65gv` — "extract-zip unvalidated symlink path
  traversal".
- Severity: HIGH, CVSS 8.1.
- Affected: npm `extract-zip` `<= 2.0.1` (a Playwright transitive).
- Patched version: **none exists** (`first_patched_version: null`), so an
  update cannot fix it today; the owner's options are an
  ignore-with-reason in `osv-scanner.toml` or removing/replacing the
  dependent chain.
- Advisory updated: 2026-08-12T19:22:04Z (GitHub), after `main`'s last
  green Security Audit run (2026-08-11T22:29Z) on this PR's exact base
  SHA — which is why the same lockfile bytes now fail.
- This PR's lockfile change did NOT introduce the package: the
  `extract-zip` entries are byte-identical to `main`; the PR's whole
  lockfile diff is the importer references to the already-present
  `mdast-util-from-markdown`, `mdast-util-gfm`, and
  `micromark-extension-gfm`.
- Resulting check state on this PR: `Security Audit` = FAILURE (a
  required check — the required checks are NOT green); dependent main-CI
  jobs `TypeScript Check`, `Vitest`, `Build & Preview Gate` = SKIPPED;
  `DB Tests` = SKIPPED (not executed). Exact per-check data:
  `final-ci-status.json` in the review bundle.

---

## r2 correction pass addendum (2026-08-14)

A second independent review of the remediated head
d98793c21545bd4685151640140dd60c09a6190a produced the Appendix R
finding register (BYP-C-01..09, BYP-B-01..04, MUT-01..04, BYP-W-01,
plus the systemic claims-sync item). The r2 correction pass closed all
of them in additive commits on the same branch — no history rewrite, no
force push, no rebase; PR #511 remains a draft and the lane remains
audit-only. The per-item register, the same-class finds, and the
deliberate behavior changes are recorded in the r2 section of
`v1.0-to-v1.1-change-ledger.md`; the corrected mutation dispositions
carry inline "CORRECTED r2" tags plus a dedicated r2 corrections
section; the reviewer hand-off is `SOL-REVIEW-DIRECTIVE-v1.1-r2.md`.
The R1–R11 dispositions above stand unchanged as the r1 historical
record, except where the r2 documents explicitly correct them
(MUT-01..04 against the R8 mutation record).
