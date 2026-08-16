# PRX claims-sync register (r2, systemic item 10)

Purpose: every universal quantifier in the PRX standard, the rule display
metadata, and the threat model is either backed by an enforcement point
plus a negative fixture, or the sentence is narrowed until it is. This
register is permanent and re-runnable; regenerate the hit list with:

```bash
grep -nEi '\b(wherever|always|never|cannot|bounded|visible|all)\b' \
  docs/verification/prx/PRX-STANDARD-v1.1.md \
  scripts/prx/rule-metadata.mjs \
  docs/verification/prx/threat-model.md
```

Run date for this revision: 2026-08-15, over the r3 sources (unchanged
count after the r3 pre-cap reconciliation of threat-model A8). 48 hits.
Hits that are quotations of file paths, rule ids, or option names (for
example "all" inside `--all`-style flag text) do not occur in this
corpus; every hit is classified below. Where several hits state the same
claim, one row covers them and lists every location.

Legend: S = PRX-STANDARD-v1.1.md, M = rule-metadata.mjs,
T = threat-model.md. "Fixture" names an executable negative proof
(fixture id, test name, or both).

| # | Claim (quantifier) | Location(s) | Enforcement point | Fixture / narrowed wording |
| --- | --- | --- | --- | --- |
| 1 | "bounded communication profile" | S §1 (line 9) | No machine claim: "bounded" here scopes the PROFILE's ambitions (two surfaces), not a runtime property | Narrowed by §1's own next sentence ("It is not a PR-execution framework"); no fixture needed — descriptive scope, not an enforcement claim |
| 2 | "Its verdict never substitutes for any control above" | S §1 (line 19) | modes.mjs: the lane exits 0 in audit/advisory; it is not in the required-check list; no ruleset change ships | cli.test.ts exit-code contract (audit exits 0 with findings); REPOSITORY_INTEGRATED status in the ledger; the required-check list is owner-controlled and untouched (verifiable via `gh api` branch protection) |
| 3 | advisory/heuristic classes "never" block | S §2 (lines 29–30), S §7 ("never blocks" twice, line 128–129), M PRX-C-CONTEXT-UNVERIFIED ("never suppresses"), S PRX-C-CONTEXT-UNVERIFIED row (line 53) | modes.mjs resolveVerdict: blocking set is `enforcing` ∩ `error` ∩ APPROVED_BLOCKING; APPROVED_BLOCKING construction throws on any non-deterministic member at module load | modes.test.ts "APPROVED_BLOCKING integrity" (both directions); cli.test.ts advisory-only enforcing run exits 0 |
| 4 | "machine enforcement for nothing the code cannot prove" | S §2 (line 34) | Class registry: heuristic/advisory findings carry level=advisory (makeFinding) | rules.test.ts level-derivation suite; mood finding asserted advisory in commit-check.test.ts |
| 5 | PRX-C-SIZE "never an OOM" | S §3 (line 42) | exceedsByteLimit fast path (length pre-check bounds encoding cost); checkers return one finding before parsing | commit-check.test.ts 1 MiB boundary tests incl. multi-byte (r2); body-check.test.ts byte-cap tests; R2C11 fixture |
| 6 | PRX-C-SUBJECT "all Cc, DEL, C1, TAB, U+2028/U+2029" | S §3 (line 43) | canonical controlCharScan subject context | canonical.test.ts subject-context suite (each class asserted); R2C12 fixture |
| 7 | PRX-C-PREFIX exemptions "only" topology / verified caller; message shape "grants nothing"; "never a subject prefix" | S §3 (line 44), S §10.2, M PRX-C-PREFIX title | checkCommit: exemptFromPrefix reads opts.isMerge / opts.authorIsBot / opts.verifiedRevert only; isRevertShaped feeds only the advisory | R2C09 (forged revert), R2C10 (claimed bot); commit-check.test.ts revert/bot suites; cli.test.ts range-mode bot-claim test (exit 1) |
| 8 | PRX-C-TRAILER "wherever the trailer appears"; lookalike key "never recognized" | S §3 (line 49), M PRX-C-TRAILER title ("wherever the trailer appears") | parseCommitMessage line-indexed trailerRecord (formal block + recognized governed-key lines in ordinary body text); canonicalTrailerKey ASCII-only grammar | R2C01–R2C08 fixtures (case variants, prose tail, non-final block, fence/indented exclusions, single-finding dedup); R2C03 (lookalike); canonical.test.ts lookalike suite |
| 9 | PRX-C-GOV references "never normalized" | S §3 (line 50) | canonical evidenceRef: parse-and-reject only; no rewriting path exists in the function | canonical.test.ts evidenceRef suite (traversal, scheme, percent-encoded, lookalike all REJECTED, none normalized-then-accepted) |
| 10 | PRX-C-CONTROL "identical in file, stdin, and range input modes"; "NUL rejected in every context" | S §3 (line 52), M PRX-C-CONTROL title | The scan runs inside checkCommit, which all three CLI modes share; NUL branch of controlCharScan | r2-parity.test.ts input-mode parity (three real surfaces, identical multisets); canonical.test.ts "rejects NUL in every context" |
| 11 | "mandatory-for-all reading … rejected" | S §3 governed-scope paragraph (line 60) | Narrowed sentence: governed scope is opt-in (caller flag or self-declaration); the audit does not classify | commit-check.test.ts R3 suite; the range CLI prints the governed-scope note (cli.test.ts pins it) |
| 12 | body schema "each with visible content"; PRX-B-VISIBLE "MEANINGFUL visible text"; "all count for nothing" | S §4 (lines 75, 86), M PRX-B-VISIBLE, M PRX-B-SECTION-EMPTY, M PRX-B-CAPSULE ("first visible block") | bodyRendersMeaningfulText + nodeHasVisibleContent over isMeaningfulText / sanitized-scanner decisions | R2B01–R2B07, R2B12 fixtures; body-check.test.ts r2 suite; R5 matrix |
| 13 | SECTION-EMPTY: format chars "never treated as emptiness and never deleted" | S §4 (line 89) | isMeaningfulText tests presence of a non-(White_Space∪Cf) code point; no rewrite of stored text anywhere on the path | R2B04 positive control; canonical.test.ts "keeps text meaningful when visible characters accompany format chars"; extractProse output preserves decoded text (body-check.test.ts) |
| 14 | prose rules "never the structured fields"; PRX-B-FENCE "never invisible" | S §4 (lines 79, 94), M PRX-B-FENCE ("never invisible") | extractProse ancestor exclusion + r2 raw-HTML container tracking; PRX-B-FENCE classifies unlabeled narrative-like fences | R4 prose suite; R2B08–R2B11 prose-contract fixtures; B09 fixture (fence reported, not skipped) |
| 15 | Vale "cannot certify ASD-STE100" | S §5 (line 108) | Narrowed claim ABOUT an external tool, recorded in source-trace rows (NEW_PROPOSAL reclassification, R9) | No machine enforcement possible; the absence of any conformity claim is the enforcement (source-trace matrix rows) |
| 16 | "All three are proven by tests" (modes) | S §7 (line 130) | modes.test.ts + cli.test.ts cover audit/advisory/enforcing | Exit-code contract tests (all three modes, both CLIs) |
| 17 | mode file: "a PR cannot flip its own enforcement" | S §7 (line 128) | Workflow reads prx-mode.json from the selected POLICY tree; trusted mode selects base | trusted-boundary.test.ts (mutated head policy does not change selection); NARROWED for bootstrap: §9 states the bootstrap runs the head copy UNTRUSTED, audit-only |
| 18 | "never a silently substituted range"; bootstrap run "cannot be base-trusted" | S §9 (lines 172–173) | resolve-range.mjs fail-closed contract; workflow labels bootstrap UNTRUSTED | resolve-range.test.ts (missing SHAs, unrelated histories, malformed output, ancestor violation, bounded quote); threat-model Bootstrap honesty section |
| 19 | metadata/registry "cannot drift apart" | M header (line 8) | rules.test.ts pins key-set equality between RULES and RULE_METADATA | rules.test.ts "display metadata stays in lockstep" (fails on any drift) |
| 20 | event text "never executed; reach shells only through env vars" | T actors table (line 24) | Workflow: `env:` bindings for PR title/body; no `${{ }}` interpolation inside `run:` | zizmor + check-github-actions-security over the workflow (validation outputs); A5 row |
| 21 | policy "never from the pull request head" / head copies "never imported" | T boundary (line 32), A1 (line 52) | [BOUNDARY] step selects base when policy exists on base | trusted-boundary.test.ts; NARROWED for bootstrap in the same paragraph and §9 (head copy runs UNTRUSTED, labeled) |
| 22 | "[BOUNDARY] step … cannot import a module before deciding" | T (line 41) | Structural: the selection must precede module loading, so it is mirrored in bash; policy-source.mjs is the tested reference | trusted-boundary.test.ts covers the reference implementation; the mirror is reviewed diff (documented limit, not a machine proof) |
| 23 | A3/A6/A10 bootstrap carve-outs | T A3 (r2), A6, A10 | Trusted mode reads Vale config/styles/lock and dependency graph from base; bootstrap is labeled UNTRUSTED with scripts disabled and no secrets | bootstrap-install.test.ts (marker not created under --ignore-scripts, negative control proves it can be); A3 wording carries the carve-out (r2 BYP-W-01) |
| 24 | A4 residual "BOUNDED BY A HARD GRADUATION BLOCKER" | T A4 (line 55), S §7 | Invariant statement + the lane is not required; graduation is an owner ruleset action | Not machine-enforceable from inside the lane — recorded as an invariant with the §7 blocker; falsifier: PRX appearing in the required-check list while the head controls the workflow file |
| 25 | A8 "BOUNDED"; nesting depth "never becomes JS stack depth"; pre-cap degrade "identically in every environment" | T A8 (line 59) | Byte caps; every post-parse walker iterative; the r2 structural pre-cap (`BLOCKQUOTE_DEPTH_CAP = 512`, body-check.mjs parseBody) throws before parsing on a raw-string-only decision — no environment input exists for the outcome to vary with; checkBody degrades the throw to PRX-B-SIZE | PC511/PC512/PC513 boundary fixtures (cap−1 / at-cap / cap+1, exact multisets) + PCF600 (the disclosed fence over-approximation); body-check.test.ts deep-nesting and exact-boundary tests; the parse-cost residual for other shapes stays in A8 |
| 26 | A9 fork runs "BOUNDED"; base checkout "works identically" | T A9 (line 60) | GitHub token semantics for fork PRs + base SHA lives in the base repo | Not exercisable from this repo's test suite; UNKNOWN until a fork PR exercises the lane — the claim is narrowed by "no secrets exist in the lane" (A10, verified by workflow inspection) |
| 27 | bootstrap workflow "always succeeds" | T bootstrap honesty (line 68) | NARROWED (r2): the bootstrap is audit-only so FINDINGS never fail it, but tool crashes exit non-zero by design (pipefail; canary exit-code demand) | cli.test.ts audit exit-0 with findings; the workflow canary requires exactly 1 in enforcing — a crash (2) fails the step. Wording adjusted here to "always exits 0 on findings; only tool failures are red" — see the narrow note below |
| 28 | "pull_request_target: never used" / "not used at all in v1.1" | T explicit non-uses (lines 87, 91) | Text absence in the workflow file | check-github-actions-security + zizmor runs; `grep -c pull_request_target .github/workflows/14-prx-communication.yml` = 0 (re-runnable) |

## Narrowed wordings applied in r2

1. S §10.2 rewritten (BYP-C-04/05): the old "It can only SUPPRESS the
   prefix finding" quantifier is gone; the new text states the verified
   derivation and the advisory that replaces silent suppression.
2. T A3 narrowed with the bootstrap carve-out (BYP-W-01): "verified
   against the trusted lock" now holds only post-merge, and the
   bootstrap's self-consistency-only checksum is stated.
3. M PRX-C-PREFIX title: "authenticated metadata, never a subject
   prefix" replaced with "verified trusted-caller classification, never
   message shape or a claimed identity" — matching the implementation.
4. T bootstrap "always succeeds" (row 27): read as "findings never fail
   the bootstrap step"; tool crashes remain red. The sentence in the
   threat model is retained with this register as its interpretation
   anchor because the surrounding section already distinguishes
   findings from tool failures.

Rows 1, 15, 22, 24, and 26 are claims that cannot be machine-enforced
from inside this repository; each is either narrowed in place or
recorded with its exact residual and falsifier rather than promoted to
an enforcement claim.
