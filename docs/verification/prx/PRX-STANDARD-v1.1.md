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
| PRX-C-SIZE | deterministic | input capped at 1 MiB counted in UTF-8 BYTES (r2: the UTF-16 unit count undercounted multi-byte input); over the cap is one finding, never an OOM |
| PRX-C-SUBJECT | deterministic | subject present with meaningful visible text (a zero-width-only subject is empty), trimmed, no trailing period, no control characters per the subject context of the r2 control policy (all Cc, DEL, C1, TAB, U+2028/U+2029) |
| PRX-C-PREFIX | deterministic | `type(scope): summary` per measured house convention (48/50); exemptions come only from commit topology (merge parent count) or a verified classification supplied by a trusted caller (`--bot`, `--verified-revert`, or authenticated integration metadata). Message shape and author-claimed identity grant nothing (r2 BYP-C-04/05); a conventional `revert:` subject needs no exemption at all |
| PRX-C-SEPARATOR | deterministic | exactly one blank line between subject and body (measured 50/50) |
| PRX-C-LENGTH | advisory | subject over 72 characters; measured median is 76.5, so this stays advisory until the owner recalibrates |
| PRX-C-WRAP | advisory | body line over 72 columns after narrow exemptions: the URL token itself, fence content, table rows, the parsed trailer block itself |
| PRX-C-FENCE | deterministic | an unclosed fence is an error; fence state is CommonMark-consistent (r2 BYP-C-09): closing markers must be the same character, at least the opening length, and carry nothing but whitespace; a backtick fence's info string may not contain a backtick; markers may be indented up to three spaces |
| PRX-C-TRAILER | deterministic | recognized-trailer grammar is validated wherever the trailer appears in the message (r2 BYP-C-01/02): trailer keys canonicalize ASCII case-insensitively against the governed set (a non-ASCII lookalike key is never recognized), one line-indexed record covers the formal final block AND every recognized governed-key line in ordinary body text (subject, fenced code, and valid indented code excluded), empty values and duplicate governed keys (case-variants included) are errors, a recognized governed trailer outside the formal block is a placement error, and a `Co-Authored-By` value is validated against `Name <email>` wherever it appears — a malformed lone `Co-Authored-By` is a trailer error and does not activate the governed requirements |
| PRX-C-GOV | deterministic | once governed scope is explicitly established: `Run-Id` (ONE-YYYYMMDD-TOKEN) and `Evidence` exactly once with validated values, and at least one `Co-Authored-By` present. Evidence references pass structured segment validation (r2 BYP-C-03): parsed segments, never normalized; dot segments, empty segments, leading slashes, backslashes, control characters, URI schemes, drive-letter prefixes, percent-encoded dots/separators, and Unicode slash lookalikes are rejected; limits are the named constants EVIDENCE_REF_MAX_SEGMENTS (7), EVIDENCE_REF_MAX_BYTES (120, UTF-8), and EVIDENCE_REF_SEGMENT_RE in rules.mjs |
| PRX-C-FIXUP | deterministic | `fixup!`/`squash!` must not reach a mainline range |
| PRX-C-CONTROL | deterministic | r2: one context-sensitive control-character policy over the body, identical in file, stdin, and range input modes (parity-tested): ordinary body text rejects Cc except TAB, plus DEL, C1, and U+2028/U+2029; fenced and valid indented code content follows the code-content policy and rejects only NUL; NUL is rejected in every context |
| PRX-C-CONTEXT-UNVERIFIED | advisory | r2: emitted alongside an ordinary PRX-C-PREFIX result when the only exemption evidence is unverified context (a revert-shaped message or a claimed bot identity); explains why no exemption was granted; never suppresses anything |
| PRX-C-MOOD | heuristic | a copula in the subject description reads as indicative; everything beyond this pattern is a reviewer rule |

Governed scope predicate: a commit is governed when the caller says so
(`--governed`, used by lanes that know their scope) or when the commit
declares itself governed by carrying a `Run-Id` or `Evidence` trailer.
Whether a commit OUGHT to carry the governed trailers is a reviewer rule;
0/50 sampled main commits carry them today, so the mandatory-for-all reading
of v1.0 is rejected as unfit for this repository.

Stated without circularity (R3): PRX validates governed trailer syntax and
completeness once governed scope is explicitly established. The ordinary CI
range audit supplies no `--governed` flag and therefore does not
independently determine that a commit ought to be governed — a commit
missing every governed trailer is not identified as governed by that audit,
and the ordinary PR workflow does not claim to prove mandatory
governed-trailer presence. Mandatory governed-scope classification remains
a reviewer or future-integration concern.

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
| PRX-B-SIZE | deterministic | 1 MiB cap counted in UTF-8 bytes (r2) |
| PRX-B-VISIBLE | deterministic | the rendered body has MEANINGFUL visible text, not merely nodes (r2 BYP-B-01): HTML comments, whitespace, zero-width/format-class code points (raw or entity-encoded), and sanitizer-removed script/style content all count for nothing |
| PRX-B-SECTION-MISSING | deterministic | each of the 14 live sections is present (R5 subcode) |
| PRX-B-SECTION-DUP | deterministic | each live section appears exactly once (R5 subcode) |
| PRX-B-SECTION-EMPTY | deterministic | each live section carries meaningful visible content: visible prose, the explicit `none`, a non-empty list/checklist/table, a labeled link, alt-texted image evidence, or a populated structured block. The emptiness decision ignores Unicode White_Space and format-category (Cf) code points, raw or entity-encoded (r2 BYP-B-01), and excludes the content of elements GitHub's sanitizer removes whole — at minimum `<script>` and `<style>` (r2 BYP-B-02). Whitespace, empty fences, thematic breaks, comments/empty HTML, alt-less images, label-less links, empty lists/tables, and bare subheadings satisfy nothing (R5). Format characters accompanying visible text are never treated as emptiness and never deleted from the text |
| PRX-B-ORDER | advisory | template order |
| PRX-B-CAPSULE | deterministic | the identifier capsule is OPTIONAL; when present: exactly one, first visible block, six exact keys once each (`Scope`, `Run-Id`, `Base`, `Head`, `Ledger`, `Evidence`), strict value grammars, no narrative lines, no placeholders |
| PRX-B-EXT | advisory | unknown depth-2 headings are reported; the engineering-federation evidence record heading is allowlisted |
| PRX-B-STRUCTURE | advisory | detection library for disguised structure: Unicode bullets, blockquoted lists, raw-HTML lists, entity-encoded dashes. Blocking prose-only scopes were removed after repository integration (the live contract requires structure), so these detect and report |
| PRX-B-FENCE | advisory | unlabeled fences that read as narrative are reported; fenced content is audited, never invisible |
| PRX-B-COMMENT | advisory | contract-shaped content that exists only inside HTML comments is reported |

## 5. Style layer — STE-inspired subset

Seven Vale rules under `scripts/prx/vale/styles/PRXSTE/`, invoked only with
`--config` on designated PRX surfaces. The designated prose input comes
from `extractProse`, which excludes structured ancestors AND (r2
BYP-B-04) the source ranges of raw-HTML containers — `table`, `thead`,
`tbody`, `tfoot`, `tr`, `th`, `td`, `ul`, `ol`, `li`, `blockquote`,
`pre`, `code`, `details`, `summary` — including the case where blank
lines split a container's contents into top-level paragraphs. This is an
STE-INSPIRED SUBSET. It
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

HARD GRADUATION BLOCKER (R6, an invariant of this standard, not an open
question): **PRX must not enter enforcing mode and must not become a
required status check while the pull-request head controls the workflow
file that orchestrates the verdict.** Graduation therefore requires a
separately reviewed base-controlled orchestration mechanism first — a
constrained base workflow, a `workflow_run` design, a GitHub App, or
another independently protected mechanism. v1.1 deliberately does not
implement that infrastructure; until it exists and is reviewed, audit and
advisory are the ceiling.

Trusted-path precondition (R10): before any audit → advisory transition, a
post-merge pull request must have exercised the `trusted (base ref)` path
and its workflow summary or check annotation must be preserved as
evidence. Until then, trusted-path live validation is UNKNOWN — the
bootstrap run on PR #511 proved only that the workflow is operational.

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
PR title, body, commit messages, and head content are data. The audit range
is resolved fail-closed by `scripts/prx/resolve-range.mjs` (R2): both
authenticated event SHAs must exist, the merge base must be a full 40-hex
SHA and an ancestor of the head, and any failure is a red tool failure —
never a silently substituted range. Bootstrap honesty: this PR's own run
cannot be base-trusted (the policy is not on `main` yet); the workflow
labels that run UNTRUSTED explicitly, and its success is evidence of
operability only, not evidence that the boundary governed the run (R10).
The residual workflow-file risk (a same-repo PR can edit the workflow
itself on `pull_request` events) is documented as A4 and bounded by the §7
hard graduation blocker: no enforcing mode and no required-check status
while the head controls the workflow file.

## 10. Known limits

1. Mood checking is one declared copula heuristic; nothing more is claimed.
2. Exemption derivation (r2 BYP-C-04/05). Merge status is derived from
   the commit parent count — topology, not text. A revert exemption is
   applied only when a trusted caller supplies a verified revert
   classification (`--verified-revert`); message shape alone is never
   sufficient, and verification must either prove the commit reverses
   the referenced commit or come through a separately ratified
   repository mechanism — no such mechanism exists yet, so the ordinary
   CI range audit never grants a revert exemption. A conventional
   `revert:` subject remains valid without any exemption. A bot
   exemption is applied only from a trusted GitHub identity signal tied
   to the specific commit (the CLI `--bot` assertion by a trusted
   caller); Git author name or email, a `[bot]` suffix, `github.actor`
   alone, and commit-message text are not authenticated bot evidence,
   and range mode passes the author-claimed identity through ONLY as an
   unverified signal. When verified context is unavailable, nothing is
   silently suppressed: the ordinary prefix result applies and the
   advisory `PRX-C-CONTEXT-UNVERIFIED` finding states why no exemption
   was granted.
3. Length and wrap rules stay advisory because measured practice diverges;
   the owner sets thresholds at graduation, with the Phase 0 baselines as
   the evidence.
4. The style layer measures tokens and sentence length, not meaning.
5. Audit mode surfaces findings on most current PRs by construction (2/10
   sampled bodies carry all 14 sections); that visibility is the point of
   the audit phase, and calibration decides what ever blocks.
6. Sanitizer parity (r2 BYP-B-02). GitHub's production sanitizer is not
   itself public, so the removed-content element set is pinned to the
   closest public implementation (github/html-pipeline's
   SanitizationFilter) and the affected rules are classified
   EXTERNAL_ADAPTATION, not EXTERNAL_REQUIREMENT, in the source-trace
   matrix, with the parity assumption stated there and executable
   fixtures preserving the modeled behavior.
