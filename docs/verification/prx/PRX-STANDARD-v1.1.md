# PRX v1.1 — commit and PR communication profile for tailered-ai/dime-ai

Status: REVIEW CANDIDATE, audit mode only. This profile is not a required
check. Graduation beyond audit is an owner action after independent review
(docs/verification/ROLLOUT.md calibration criteria apply).

## 1. Position

PRX is a bounded communication profile for two surfaces: commit messages and
pull-request bodies (plus the PR title, judged with the subject rules). It is
not a PR-execution framework. Execution controls live elsewhere and stay
authoritative: the ruleset `main-protection` (one approval, last-push
approval, thread resolution, merge-only), the ten required checks, CODEOWNERS
review ownership, the merge queue when enabled, test evidence
(01-pr-proof-contract), security scanning (02, 03, 05, gitleaks), dependency
review (06), artifact provenance (11), deployment through Railway on merge to
`main`, rollback per the deploy runbook, and post-deployment validation per
the PR template. PRX adds one thing: deterministic, honest checks on how the
work is described. Its verdict never substitutes for any control above.

## 2. Enforcement classes

Every PRX rule carries exactly one class. The registry
(`scripts/prx/rules.mjs`) is the single source; the classes are:

| Class | Meaning | May block? |
| --- | --- | --- |
| deterministic | machine-provable structure | only in enforcing mode, only if listed in `APPROVED_BLOCKING` |
| advisory | measurable, but live practice diverges or thresholds are owner-tunable | never |
| heuristic | declared approximation of a semantic property | never |
| reviewer | human judgment (e.g. mood beyond the copula pattern, atomicity, evidence quality) | via review, not machine |
| owner | ruleset membership, mode transitions, threshold changes | owner only |

The implementation claims machine enforcement for nothing the code cannot
prove. Imperative mood, one-topic-per-commit, and evidence sufficiency are
reviewer rules; the machine emits at most declared heuristics about them.

## 3. Commit rules

| Rule | Class | Behavior |
| --- | --- | --- |
| PRX-C-SIZE | deterministic | input capped at 1 MiB; over the cap is one finding, never an OOM |
| PRX-C-SUBJECT | deterministic | subject present, trimmed, no trailing period, no control characters |
| PRX-C-PREFIX | deterministic | `type(scope): summary` per measured house convention (48/50); exemptions for merges (parent count), bots (author metadata), and generated reverts (subject shape AND generated body marker) — never a subject prefix alone |
| PRX-C-SEPARATOR | deterministic | exactly one blank line between subject and body (measured 50/50) |
| PRX-C-LENGTH | advisory | subject over 72 characters; measured median is 76.5, so this stays advisory until the owner recalibrates |
| PRX-C-WRAP | advisory | body line over 72 columns after narrow exemptions: the URL token itself, fence content, table rows, the parsed trailer block itself |
| PRX-C-FENCE | deterministic | an unclosed fence is an error |
| PRX-C-TRAILER | deterministic | formal trailer block grammar: the final all-trailer-shaped block parses as trailers; empty values and duplicate governed keys are errors |
| PRX-C-GOV | deterministic | governed commits carry `Run-Id` (ONE-YYYYMMDD-TOKEN), `Evidence` (bounded `run/` or `docs/` reference, or UNKNOWN), and `Co-Authored-By` (`Name <email>`), each validated |
| PRX-C-FIXUP | deterministic | `fixup!`/`squash!` must not reach a mainline range |
| PRX-C-MOOD | heuristic | a copula in the subject description reads as indicative; everything beyond this pattern is a reviewer rule |

Governed scope predicate: a commit is governed when the caller says so
(`--governed`, used by lanes that know their scope) or when the commit
declares itself governed by carrying a `Run-Id` or `Evidence` trailer.
Whether a commit OUGHT to carry the governed trailers is a reviewer rule;
0/50 sampled main commits carry them today, so the mandatory-for-all reading
of v1.0 is rejected as unfit for this repository.

## 4. PR-body rules

The schema is the LIVE template, `.github/pull_request_template.md`: its 14
sections, each exactly once, each with visible content ("none" written
explicitly satisfies content, exactly as the template instructs). Lists,
checkboxes, and tables are allowed everywhere the template allows them; the
template itself requires them in Tests and Authorization. Prose style rules
bind only designated prose (extracted narrative paragraphs), never the
structured fields. Deeper semantics of the Notion block stay owned by the
13-tos-notion-context check; PRX validates section structure only.

| Rule | Class | Behavior |
| --- | --- | --- |
| PRX-B-SIZE | deterministic | 1 MiB cap |
| PRX-B-VISIBLE | deterministic | the rendered body has visible content; HTML comments count for nothing |
| PRX-B-SECTION | deterministic | all 14 live sections, exactly once, non-empty |
| PRX-B-ORDER | advisory | template order |
| PRX-B-CAPSULE | deterministic | the identifier capsule is OPTIONAL; when present: exactly one, first visible block, six exact keys once each (`Scope`, `Run-Id`, `Base`, `Head`, `Ledger`, `Evidence`), strict value grammars, no narrative lines, no placeholders |
| PRX-B-EXT | advisory | unknown depth-2 headings are reported; the engineering-federation evidence record heading is allowlisted |
| PRX-B-STRUCTURE | advisory | detection library for disguised structure: Unicode bullets, blockquoted lists, raw-HTML lists, entity-encoded dashes. Blocking prose-only scopes were removed after repository integration (the live contract requires structure), so these detect and report |
| PRX-B-FENCE | advisory | unlabeled fences that read as narrative are reported; fenced content is audited, never invisible |
| PRX-B-COMMENT | advisory | contract-shaped content that exists only inside HTML comments is reported |

## 5. Style layer — STE-inspired subset

Seven Vale rules under `scripts/prx/vale/styles/PRXSTE/`, invoked only with
`--config` on designated PRX surfaces. This is an STE-INSPIRED SUBSET. It
does not claim ASD-STE100 conformity, it names no official issue or rule
identifiers, and Vale cannot certify ASD-STE100. The 20-word target and
25-word limit apply to every sentence because no instruction/description
classifier ships; both stay non-blocking for exactly that reason. The dash
rule is suggestion-level: em dashes are measured house style, and the
conflict with the unratified "17-field writing system" is recorded in the
law registry for the owner. The style layer is advisory in every mode.

## 6. Uncertainty grammar

Evidence-backed probability, confidence intervals, stated assumptions, and
risk language are valid governed narrative: "the backfill succeeds in 97 of
100 replay runs; the three failures are the known timeout class" needs no
softening. UNKNOWN is for missing or unresolved facts. Vague hedges that
carry no evidence (`should be fine`, `seems to`) are the style findings;
calibrated uncertainty is not. This grammar implements OPERATING-RULES.md
§Claims for PRX surfaces and resolves SOL-PRX-015.

## 7. Rollout modes

`scripts/prx/prx-mode.json` (read from the TRUSTED policy tree, so a PR
cannot flip its own enforcement): `audit` reports only and never blocks;
`advisory` annotates and never blocks; `enforcing` blocks only on
deterministic rules listed in `APPROVED_BLOCKING`. All three are proven by
tests (`scripts/prx/modes.test.ts`, `scripts/prx/cli.test.ts`). Transitions:
audit → advisory is an owner-authorized reviewed change to the mode file;
advisory → enforcing additionally requires the owner ruleset action that
makes `14-prx-communication` a required check, following the ROLLOUT.md
calibration criteria (≥ 20 observations, deterministic false-positive rate
under 5%, one dry-run of the failure mode). Rollback is the reverse edit;
nothing else depends on the mode file.

## 8. Hook decision

No commit-msg hook ships, and no claim that one exists survives from v1.0
(SOL-PRX-016). Measured absence: this repository has no hook infrastructure
(`core.hooksPath` unset, no `.husky/`, no active `.git/hooks`). The local
surfaces are `pnpm prx:commit` and `pnpm prx:body`; CI is the enforcement
point. A future hook would be a separate owner-reviewed proposal with an
idempotent installer, verification, and uninstaller.

## 9. Trusted boundary

See `docs/verification/prx/threat-model.md`. Policy code, rules, fixtures,
Vale configuration, and the Vale binary pins load from the event's base SHA;
PR title, body, commit messages, and head content are data. Bootstrap
honesty: this PR's own run cannot be base-trusted (the policy is not on
`main` yet) and the workflow labels that run UNTRUSTED explicitly. The
residual workflow-file risk (a same-repo PR can edit the workflow itself on
`pull_request` events) is documented as A4 with its bounds; it is one of the
open questions for the graduation decision.

## 10. Known limits

1. Mood checking is one declared copula heuristic; nothing more is claimed.
2. Length and wrap rules stay advisory because measured practice diverges;
   the owner sets thresholds at graduation, with the Phase 0 baselines as
   the evidence.
3. The style layer measures tokens and sentence length, not meaning.
4. Audit mode surfaces findings on most current PRs by construction (2/10
   sampled bodies carry all 14 sections); that visibility is the point of
   the audit phase, and calibration decides what ever blocks.
