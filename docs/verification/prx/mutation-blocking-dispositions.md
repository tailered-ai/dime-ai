# PRX v1.1 — focused blocking-path mutation dispositions (R8)

Configuration: `scripts/prx/stryker.blocking.prx.json` — StrykerJS 9
(vitest runner), mutating exactly the modules whose logic is reachable by
an `APPROVED_BLOCKING` verdict: `commit-check.mjs`, `body-check.mjs`,
`modes.mjs`, `policy-source.mjs`, `resolve-range.mjs`, `rules.mjs`, and
the CLI wrappers `check-commit.mjs` / `check-body.mjs` (added on
internal-review challenge: listCommits and the exit-code wiring are
decision-reachable).
Raw report: `mutation-blocking-results.json` (this directory). The broader
all-file run (`stryker.prx.json`, including `rule-metadata.mjs` display
strings) is EXPLORATORY AND NON-GATING; its report is
`mutation-results.json`.

Scope exclusions, implemented structurally per R8's allowances:

- Rule-title/surface display metadata lives in `rule-metadata.mjs`,
  excluded from the focused `mutate` list (nothing in the decision path
  consumes it; `rules.test.ts` pins key-set equality and an independent
  class table so registry drift cannot hide there).
- Diagnostic finding-message text is excluded via 65 explicit
  `// Stryker disable next-line StringLiteral: diagnostic message text
  (R8 exclusion)` annotations at the exact literal sites (29 in
  commit-check, 36 in body-check). Rule-id literals, key names, node-type
  strings, mode names, regex literals, and every Boolean / conditional /
  comparison / parser / grammar / verdict mutant remain fully enabled.
  On five shared lines (commit-check 139/150/163/169/229-equivalents,
  body-check 96/185/200 pre-format) the rule-id literal shares the
  annotated line, so its mutant is suppressed too; those rule-id mutants
  were KILLED before annotation (an emptied rule id throws
  `unknown PRX rule id` in `ruleClass`), so no live signal was lost.

Method: iterative runs with two empirical instruments. Round 1 (before hardening) scored 72.17% with 300
survivors + 66 no-coverage. Every one of those 366 mutants was classified
by empirical re-application (mutants patched into a sandbox copy and run
against proposed tests; equivalence claims additionally checked by a
10,008-message differential fuzz for commit-check and a machine-evaluated
predicate matrix for body-check's looksNarrative family). The
classification produced the annotation sites, 100+ new killing assertions
across `commit-check.test.ts`, `body-check.test.ts`, `modes.test.ts`,
`trusted-boundary.test.ts`, and `resolve-range.test.ts`, and the
individual equivalence proofs below. Later rounds verified the result after each hardening batch; the final
report is the last run over the final sources. Because StrykerJS cannot
activate mutants across a process boundary (subprocess CLI tests) and
does not reliably re-execute module scope (static mutants), every
remaining survivor was ALSO hand-applied to the real source with the
real suite re-run (`replay-mutants` log in the bundle): a replayed
failure is recorded as KILLED-IN-REALITY with the artifact class named,
and only replay-passing mutants remain as true survivors requiring an
equivalence proof.

## Acceptance criteria (R8) — met

- Zero unreviewed survivors: every surviving mutant appears in the proof
  table below.
- Zero unexplained no-coverage mutants: every no-coverage mutant appears
  in the no-coverage table with the exact reason its path cannot execute
  in-process (dead defensive arm, or subprocess-only wrapper code that
  Stryker cannot activate across a process boundary — those paths are
  pinned by the subprocess CLI tests, which run the REAL artifact).
- Every equivalent mutant has an individual written proof tied to file,
  line, operator, and logical implication (below).
- Every deterministic blocking condition has a direct negative test that
  fails when the condition is removed (the adversarial fixture suite pins
  exact finding multisets per rule; the R8 hardening added boundary and
  anchor tests for every surviving comparison/regex/guard mutant that was
  killable).

Mutation evidence CANNOT authorize enforcement. It removes one technical
blocker from a future owner decision; the mode stays audit and the
required-check set is untouched.
## Final focused result

These figures are the r1 HISTORICAL record, taken over the sources at
head d98793c21545bd4685151640140dd60c09a6190a. The r2 correction pass
changed the decision-path sources; r2 mutation figures come from the
label-gated GitHub Actions rerun over the changed modules and are
reported separately in the r2 ledger — they do not overwrite this block.

- Mutants generated: 1605 (of which 74 ignored by the explicit diagnostic-text annotations)
- Killed: 1269  |  Timeout (counts as detected): 153
- Survived (Stryker view): 85  |  No coverage (Stryker view): 24
- Of those 109: 35 are replay-KILLED-IN-REALITY (Stryker activation artifacts, each hand-verified), and the rest carry individual equivalence proofs or exact no-coverage explanations below
- Mutation score (detected / valid, Stryker view): 92.88%
- Effective detection including replay-verified kills: 1457/1531 = 95.17%
- Unreviewed survivors: 0  |  Unexplained no-coverage: 0

## r2 corrections (MUT-01..04) — disposition-integrity findings from the second independent review

All four accepted; the corrected rows below are edited in place and
tagged "CORRECTED r2".

- **MUT-01** — body-check.mjs:436 claimed the extractProse catch could
  "never be returned in-process". FALSE: `extractProse(">".repeat(20000))`
  reaches the catch in-process (reproduced before any r2 edit). The
  mutant was a WEAK-ORACLE survivor (the r1 test asserted only
  `typeof`); r2 strengthens the assertion to the exact value, which
  kills it. Catch reachability additionally became DETERMINISTIC in r2:
  the original reproduction depended on where the parser's recursion
  overflowed (it varied with the runtime stack budget — the same input
  parsed cleanly under Stryker's workers), so a structural pre-cap
  (blockquote depth 512 per line) now throws before parsing,
  identically everywhere. Row corrected.
- **MUT-02** — three replay-artifact rows carried misattributed
  mechanism labels: body-check 113 and 435 blamed the subprocess
  boundary and body-check 116 blamed static module scope (and called
  its NoCoverage status a "survivor"). All three sites are catch arms
  reachable IN-PROCESS by the deep-nesting tests; the real Stryker
  artifact is per-test coverage attribution of catch arms under
  in-worker activation. Rows corrected.
- **MUT-03** — resolve-range.mjs:59 (`slice(0, 80)` removal) was
  labeled EQUIVALENT although the mutant changes the emitted
  diagnostic's content and length (unbounded quotation of malformed
  merge-base output). Reclassified NOT EQUIVALENT; a bounded-quote
  assertion was added and negative-tested against the applied mutant.
  Row corrected.
- **MUT-04** — the replay log disagreed with the final report in three
  ways, reconciled on 2026-08-14: (1) entries 598 and 599
  (body-check.mjs:581/582) recorded `status: "Survived",
  replayKilled: false` — TRUE-SURVIVOR claims with no equivalence
  proofs — although the FINAL `mutation-blocking-results.json` records
  both as Killed; they came from a superseded pre-final round and are
  removed. (2) Mutant 213 (body-check.mjs:246, Survived in the final
  report) had never been replayed, so the Method section's
  "every remaining survivor was ALSO hand-applied" claim was false by
  one; it was replayed on 2026-08-14 against the archived r1 tree at
  d98793c21545bd4685151640140dd60c09a6190a and is a TRUE-SURVIVOR
  (suite passes), consistent with its written equivalence proof; its
  record is added. (3) The record count now matches the final
  survivor+no-coverage population exactly: 109 entries, body-check 32
  (previously 110 and 33 — the drift the review's "8-vs-9" pointer
  flagged; the per-file counts, not a line count, were the mismatched
  pair).

### scripts/prx/body-check.mjs

| Line | Mutator | Replacement | Stryker status | Verdict | Proof / evidence |
| --- | --- | --- | --- | --- | --- |
| 97 | ArrayDeclaration | `["Stryker was here"]` | NoCoverage | NO-COVERAGE (explained) | `tree.children ?? []` fallback: fromMarkdown always returns a root with a children ARRAY (probed: "" -> children: []), so the ?? arm is dead code — which is also why Stryker records no coverage. |
| 113 | BlockStatement | `{}` | NoCoverage | ARTIFACT (replay-killed) | KILLED-IN-REALITY — hand-applied replay fails the real suite (the deep-blockquote test reaches checkBody's parse-failure catch IN-PROCESS; the emptied catch lets execution fall through to a TypeError). CORRECTED r2 (MUT-02): the prior mechanism label blamed the subprocess boundary — wrong; the true artifact is Stryker/vitest failing to attribute per-test coverage to the catch arm under in-worker activation, so the mutant was scheduled against no tests. |
| 116 | StringLiteral | `""` | NoCoverage | ARTIFACT (replay-killed) | KILLED-IN-REALITY — hand-applied replay fails the real suite (blanking the rule id makes makeFinding throw `unknown PRX rule id` on the in-process-reachable catch path). CORRECTED r2 (MUT-02): the prior text claimed "Stryker recorded a survivor ... module scope" — wrong on both counts; the recorded status is NoCoverage and the line sits inside checkBody's catch, not module scope. Same catch-arm coverage-attribution artifact as line 113. |
| 152 | OptionalChaining | `c.position.start` | Survived | EQUIVALENT | c ranges only over parsed comment nodes from mdast-util-from-markdown, which stamps position on every compiled node (probed; no hand-built nodes on this path) — the optional access can never short-circuit. |
| 180 | OptionalChaining | `capsule.position.start` | Survived | EQUIVALENT | capsule = capsules[0] is drawn from visible = filtered tree.children — parser-produced nodes always carrying position; identical evaluation everywhere. |
| 246 | ConditionalExpression | `true` | Survived | EQUIVALENT | `n.type === "heading"` conjunct -> true in the heading filter: the predicate becomes n.depth === 2, and in mdast `depth` exists only on heading nodes — every non-heading evaluates undefined === 2 === false and still fails the filter, while headings evaluate exactly the original right operand. Same equivalence class as the section-scan twin, executed against a paragraph-only body: findings identical. |
| 250 | OptionalChaining | `n.position.start` | Survived | EQUIVALENT | n is a depth-2 heading filtered from visible — parser-produced, position always present. |
| 314 | MethodExpression | `EXTENSION_ALLOWLIST_PREFIXES.every(p => ` | Survived | EQUIVALENT | some -> every: the receiver is a frozen module constant of length exactly 1 ("Evidence record") that nothing mutates; for a one-element array some(f) === every(f); divergence needs length 0 or >= 2, which cannot occur. |
| 341 | OptionalChaining | `node.position.start` | Survived | EQUIVALENT | walk/loop visits only nodes from the parsed tree (visible and their descendants); every parser-produced node carries position, so the optional chain never short-circuits (applies identically at the Unicode-bullet, blockquoted-list, raw-HTML-list, and FENCE emit sites). |
| 348 | ArrayDeclaration | `["Stryker was here"]` | NoCoverage | NO-COVERAGE (explained) | `node.children ?? []` fallback in the blockquoted-list check: the right operand evaluates only for blockquote nodes, and every parser-produced blockquote carries a children array (probed: bare `>` -> children: []). The fallback arm is unreachable. |
| 355 | OptionalChaining | `node.position.start` | Survived | EQUIVALENT | walk/loop visits only nodes from the parsed tree (visible and their descendants); every parser-produced node carries position, so the optional chain never short-circuits (applies identically at the Unicode-bullet, blockquoted-list, raw-HTML-list, and FENCE emit sites). |
| 369 | OptionalChaining | `node.position.start` | Survived | EQUIVALENT | walk/loop visits only nodes from the parsed tree (visible and their descendants); every parser-produced node carries position, so the optional chain never short-circuits (applies identically at the Unicode-bullet, blockquoted-list, raw-HTML-list, and FENCE emit sites). |
| 399 | OptionalChaining | `node.position.start` | Survived | EQUIVALENT | walk/loop visits only nodes from the parsed tree (visible and their descendants); every parser-produced node carries position, so the optional chain never short-circuits (applies identically at the Unicode-bullet, blockquoted-list, raw-HTML-list, and FENCE emit sites). |
| 435 | BlockStatement | `{}` | NoCoverage | ARTIFACT (replay-killed) | KILLED-IN-REALITY — hand-applied replay fails the real suite (the deep-nesting test reaches extractProse's catch IN-PROCESS; the emptied catch falls through to a TypeError on the undefined parse result). CORRECTED r2 (MUT-02): the prior subprocess-boundary label was wrong — the artifact is catch-arm coverage attribution, as at line 113. |
| 436 | StringLiteral | `"Stryker was here!"` | NoCoverage | WEAK-ORACLE, killed by r2 test | CORRECTED r2 (MUT-01): the prior claim — "the literal can never be returned in-process (catch-arm reachability proof)" — was FALSE. `extractProse(">".repeat(20000))` throws inside the parser and returns through this catch IN-PROCESS, so the sentinel IS returned; the mutant survived the replay because the r1 oracle asserted only `typeof === "string"`. Reclassified from NO-COVERAGE (explained) to WEAK-ORACLE; body-check.test.ts now asserts the exact value (`toBe("")`), which kills the sentinel. To be confirmed as a plain kill in the r2 label-gated rerun. |
| 485 | ConditionalExpression | `default:` | NoCoverage | NO-COVERAGE (explained) | capsuleValueError default: clause: called solely from the loop over the frozen six-key CAPSULE_KEYS tuple, each with an explicit case label, so default: is unreachable. Double protection: falling off the switch returns undefined, and the caller tests plain truthiness where undefined and the original null are indistinguishable. |
| 499 | ConditionalExpression | `true` | Survived | EQUIVALENT | `n.type === "heading"` -> true: condition becomes n.depth <= 2; depth exists only on heading nodes, so non-headings evaluate undefined <= 2 === false — still fail — while headings evaluate exactly the original right operand. Executed against both subheading bodies: findings byte-identical. |
| 508 | StringLiteral | `""` | Survived | EQUIVALENT | case label blanked: a thematicBreak lands on default:, where visibleInlineText returns "" (no value, no children, not image/html) and the default returns false — exactly the original shared `return false`. |
| 509 | StringLiteral | `""` | Survived | EQUIVALENT | case label blanked: definition nodes carry no value and no children, so the rerouted default computes "".trim() !== "" -> false, identical to the original case result. |
| 512 | ConditionalExpression | `case "code":` | Survived | EQUIVALENT | code-case consequent removed: falls through to the html case, whose body is `return visibleInlineText(node).trim() !== ""`; for a code node visibleInlineText hits `node.value !== undefined` and returns node.value — the fallthrough computes node.value.trim() !== "", the removed body's exact semantics. |
| 512 | StringLiteral | `""` | Survived | EQUIVALENT | case label blanked: code nodes take default:, which equals node.value.trim() !== "" for every code node (visibleInlineText returns node.value for value-bearing non-html nodes). |
| 516 | StringLiteral | `""` | Survived | EQUIVALENT | case label blanked: html nodes fall to default:, whose body is the very same expression as the html case; visibleInlineText dispatches on node.type === "html" internally, so the switch label was never load-bearing. |
| 520 | StringLiteral | `""` | Survived | EQUIVALENT | case label blanked: tables reroute to default: (concatenated text of all rows/cells non-blank) vs original children.some(row -> children.some(cell)). GFM table cells contain inline content only, so on both paths every leaf contributes exactly its visibleInlineText, and the concatenation trims non-empty iff at least one cell's text does. |
| 521 | StringLiteral | `""` | Survived | EQUIVALENT | case label blanked: tableRow nodes are reachable here only via the table case's children.some; the rerouted default (row text non-blank) is equivalent by the same inline-only-cells argument. |
| 523 | ArrayDeclaration | `["Stryker was here"]` | NoCoverage | NO-COVERAGE (explained) | `node.children ?? []` fallback in nodeHasVisibleContent: executes only for the container case labels, and the parser always materializes children arrays on those node types (probed for degenerate cases). The fallback never evaluates. |
| 533 | StringLiteral | `"Stryker was here!"` | NoCoverage | NO-COVERAGE (explained) | `node.alt ?? ""` fallback: mdast-util-from-markdown always sets alt to a STRING for image and imageReference (probed: ![](x.png) -> alt: ""; ![][r] -> alt: ""), never null/undefined — the nullish arm is dead for every parser-produced node. |
| 544 | MethodExpression | `value.split("\n")` | Survived | EQUIVALENT | blank-line filter removal in looksNarrative: whitespace-only lines influence neither count (the listish regex demands a bullet/digit after ^\s*; the sentenceish predicate tests the trimmed line — both fail); the early length-0 return coincides with the fallthrough result. Matrix-executed: outputs identical. |
| 544 | ConditionalExpression | `true` | Survived | EQUIVALENT | filter predicate -> true retains all lines — behaviorally identical to removing the filter; the adjacent proof applies verbatim (matrix-identical). |
| 544 | MethodExpression | `l` | Survived | EQUIVALENT | l.trim() !== "" -> l !== "": only whitespace-only non-empty lines are additionally retained; they contribute to neither count (adjacent proof), and the empty-vs-fallthrough coincidence covers the all-blank case. Matrix-identical. |
| 544 | StringLiteral | `"Stryker was here!"` | Survived | EQUIVALENT | filter sentinel "" -> "Stryker was here!": trim can only equal that string if the line contained it; such a line is 3 words with no terminal punctuation and no bullet — contributing 0 to both counts under the original too, so even the pathological input yields the same return. |
| 545 | ConditionalExpression | `false` | Survived | EQUIVALENT | guard bypassed: with empty lines both filters produce empty arrays, listish=0, sentenceish=0, and `0 > 0 \|\| 0 >= 1` is false — precisely what the guard returned. Pure fast-path. |
| 548 | MethodExpression | `l` | Survived | EQUIVALENT | first l.trim() removal in the punctuation test: /[.!?]\s*$/ is unanchored at the start (leading whitespace irrelevant) and its \s*$ tail absorbs exactly the trailing whitespace trim removes — re.test(l) === re.test(l.trim()) for every string. Matrix-identical. |

### scripts/prx/check-body.mjs

| Line | Mutator | Replacement | Stryker status | Verdict | Proof / evidence |
| --- | --- | --- | --- | --- | --- |
| 19 | StringLiteral | `""` | Survived | EQUIVALENT | readFileSync encoding "utf8" -> "": JSON.parse coerces the returned Buffer to the identical UTF-8 string (same as the check-commit twin). The sibling filename literal is killed by the default-mode test (readFileSync of the directory throws). |
| 23 | MethodExpression | `process.argv` | NoCoverage | ARTIFACT (replay-killed) | KILLED-IN-REALITY — hand-applied replay of this mutant fails the real suite. Stryker recorded no kill because the covering tests execute the mutated file in a SPAWNED subprocess, and mutant activation does not cross the process boundary. |
| 50 | ConditionalExpression | `false` | Survived | ARTIFACT (replay-killed) | KILLED-IN-REALITY — hand-applied replay of this mutant fails the real suite. Stryker recorded no kill because the covering tests execute the mutated file in a SPAWNED subprocess, and mutant activation does not cross the process boundary. |
| 50 | StringLiteral | `""` | Survived | ARTIFACT (replay-killed) | KILLED-IN-REALITY — hand-applied replay of this mutant fails the real suite. Stryker recorded no kill because the covering tests execute the mutated file in a SPAWNED subprocess, and mutant activation does not cross the process boundary. |
| 51 | StringLiteral | `""` | NoCoverage | ARTIFACT (replay-killed) | KILLED-IN-REALITY — hand-applied replay of this mutant fails the real suite. Stryker recorded no kill because the covering tests execute the mutated file in a SPAWNED subprocess, and mutant activation does not cross the process boundary. |
| 83 | ConditionalExpression | `false` | Survived | ARTIFACT (replay-killed) | KILLED-IN-REALITY — hand-applied replay of this mutant fails the real suite. Stryker recorded no kill because the covering tests execute the mutated file in a SPAWNED subprocess, and mutant activation does not cross the process boundary. |
| 85 | BlockStatement | `{}` | NoCoverage | ARTIFACT (replay-killed) | KILLED-IN-REALITY — hand-applied replay of this mutant fails the real suite. Stryker recorded no kill because the covering tests execute the mutated file in a SPAWNED subprocess, and mutant activation does not cross the process boundary. |

### scripts/prx/check-commit.mjs

| Line | Mutator | Replacement | Stryker status | Verdict | Proof / evidence |
| --- | --- | --- | --- | --- | --- |
| 23 | StringLiteral | `""` | Survived | EQUIVALENT | readFileSync encoding "utf8" -> "": without an encoding readFileSync returns a Buffer; JSON.parse coerces the Buffer to the identical UTF-8 string before parsing, so parseModeState receives the same document. (The sibling filename literal on this line is killed: join(dir, "") targets the directory and readFileSync throws.) Verified by hand-applied replay: full suite passes only because behavior is identical. |
| 43 | ConditionalExpression | `false` | Survived | NO-COVERAGE (explained) | malformed-record guard -> false: the guard's trigger — a git-log record with fewer than 5 newline-separated fields — cannot be produced by any commit object: %H/%P/%an/%ae contribute four newline-terminated fields and %B contributes at least one more (an empty message yields exactly 5, pinned by the empty-message test). Disabling a branch that no git-produced input reaches is unobservable; the guard is defense against a corrupted stream. |
| 43 | BlockStatement | `{}` | NoCoverage | NO-COVERAGE (explained) | malformed-record throw block: unreachable for every git-produced record (see the guard proof — records always have >= 5 fields); the block exists to fail closed on a corrupted git stream and has no reachable trigger to cover. |
| 45 | StringLiteral | `''` | NoCoverage | NO-COVERAGE (explained) | message literal of the unreachable malformed-record throw (an Error message, not a makeFinding diagnostic): dead for the same reachability reason. |
| 46 | StringLiteral | `""` | NoCoverage | NO-COVERAGE (explained) | second literal of that same unreachable throw message: dead for the same reachability reason. |
| 53 | MethodExpression | `parents.trim().split(/\s+/)` | Survived | EQUIVALENT | .filter(Boolean) removal: %P is a single-space-separated list of full parent hashes with no leading/trailing whitespace. For merges split yields the parent array unchanged; for single-parent commits [p1]; for root commits "" splits to [""] with length 1 — on every shape `length > 1` answers identically with or without the Boolean filter. |
| 53 | MethodExpression | `parents` | Survived | EQUIVALENT | .trim() removal: %P output never carries leading or trailing whitespace (git prints the bare hash list), so trim is a no-op on every git-produced record; root/single/merge shapes all split identically untrimmed. |
| 53 | Regex | `/\s/` | Survived | EQUIVALENT | /\s+/ -> /\s/: %P separates parent hashes by exactly ONE space, so the + quantifier never matches more than a single character; both regexes produce identical splits on every git-produced parents field. |
| 77 | MethodExpression | `process.argv` | NoCoverage | ARTIFACT (replay-killed) | KILLED-IN-REALITY — hand-applied replay of this mutant fails the real suite. Stryker recorded no kill because the covering tests execute the mutated file in a SPAWNED subprocess, and mutant activation does not cross the process boundary. |
| 79 | ObjectLiteral | `{}` | Survived | EQUIVALENT | flags initializer {} : every consumer treats absent and false identically — checkCommit tests `opts.governed === true` (undefined fails exactly like false), the exemptions test `=== true` the same way, and `if (flags.json)` treats undefined as falsy like false. Assignments from the flag branches still work on the empty object. |
| 82 | StringLiteral | `""` | Survived | EQUIVALENT | default repo "." -> "": the only consumer is resolve(repo), and path.resolve("") === path.resolve(".") === process.cwd() — identical for every invocation. |
| 103 | StringLiteral | `"Stryker was here!"` | NoCoverage | NO-COVERAGE (explained) | `range ?? ""` right operand: the grammar check runs only inside `if (range !== undefined)`, so range is never nullish at this line and the ?? arm is dead — hence no coverage. |
| 125 | ConditionalExpression | `false` | Survived | ARTIFACT (replay-killed) | KILLED-IN-REALITY — hand-applied replay of this mutant fails the real suite. Stryker recorded no kill because the covering tests execute the mutated file in a SPAWNED subprocess, and mutant activation does not cross the process boundary. |
| 125 | StringLiteral | `""` | Survived | ARTIFACT (replay-killed) | KILLED-IN-REALITY — hand-applied replay of this mutant fails the real suite. Stryker recorded no kill because the covering tests execute the mutated file in a SPAWNED subprocess, and mutant activation does not cross the process boundary. |
| 126 | StringLiteral | `""` | NoCoverage | ARTIFACT (replay-killed) | KILLED-IN-REALITY — hand-applied replay of this mutant fails the real suite. Stryker recorded no kill because the covering tests execute the mutated file in a SPAWNED subprocess, and mutant activation does not cross the process boundary. |
| 176 | ConditionalExpression | `false` | Survived | ARTIFACT (replay-killed) | KILLED-IN-REALITY — hand-applied replay of this mutant fails the real suite. Stryker recorded no kill because the covering tests execute the mutated file in a SPAWNED subprocess, and mutant activation does not cross the process boundary. |
| 178 | BlockStatement | `{}` | NoCoverage | ARTIFACT (replay-killed) | KILLED-IN-REALITY — hand-applied replay of this mutant fails the real suite. Stryker recorded no kill because the covering tests execute the mutated file in a SPAWNED subprocess, and mutant activation does not cross the process boundary. |

### scripts/prx/commit-check.mjs

| Line | Mutator | Replacement | Stryker status | Verdict | Proof / evidence |
| --- | --- | --- | --- | --- | --- |
| 36 | StringLiteral | `''` | Survived | EQUIVALENT | PREFIX_STRIP_RE template -> ``: new RegExp("") strips nothing, so description becomes subject.trim(). Sole consumer is COPULA_RE.test; by copula-invariance (the strippable prefix `type(scope)?!?: ` contains no whitespace-delimited copula token, and description is a trimmed suffix whose token boundaries survive in both strings) the boolean is identical for every subject. |
| 36 | StringLiteral | `""` | Survived | EQUIVALENT | join("\|") -> join(""): the mutated prefix alternation still contains no copula token and merely stops matching real prefixes; by the same copula-invariance argument the only consumer, COPULA_RE.test, returns the same boolean for every subject. |
| 42 | Regex | `/^([A-Za-z][A-Za-z0-9-]*):[ \t]*(.*)/` | Survived | EQUIVALENT | TRAILER_LINE_RE loses trailing $: applied only to single split("\n") lines with no newline; the greedy (.*) always consumes to end-of-string where $ is vacuously satisfied — match success and both capture groups are byte-identical. |
| 54 | StringLiteral | `"Stryker was here!"` | NoCoverage | NO-COVERAGE (explained) | `lines[0] ?? ""` right operand: String.prototype.split always returns >= 1 element (even "" -> [""]), so lines[0] is never nullish and the ?? arm never evaluates — dead code, hence no coverage. Non-string raw cannot reach this line (checkCommit returns PRX-C-SIZE first; direct parseCommitMessage(nonString) throws earlier at raw.replace). Fuzz-confirmed unobservable. |
| 68 | StringLiteral | `"Stryker was here!"` | Survived | EQUIVALENT | fenceMarker initializer -> sentinel: only read in `m[1][0] === fenceMarker` behind `inFence === true`, and inFence only becomes true alongside the overwrite `fenceMarker = m[1][0]`; the initial value is dead on every path. |
| 92 | ConditionalExpression | `true` | Survived | EQUIVALENT | Guard (or its right conjunct) forced true: with empty bodyLines, end=-1 makes `end >= start` fail; with an unclosed fence the final run either starts in-fence (rejected by !block[0].inFence) or contains the fence-opener line, which matches neither trailer-line nor continuation shape, failing block.every — trailers stays null in every newly-entered case, identical to skipping the block. |
| 92 | LogicalOperator | `!unclosedFence \|\| bodyLines.length > 0` | Survived | EQUIVALENT | && -> \|\|: differs only when one conjunct is false — exactly the empty-body / unclosed-fence cases, both still yielding trailers === null by the same argument. |
| 92 | ConditionalExpression | `true` | Survived | EQUIVALENT | Guard (or its right conjunct) forced true: with empty bodyLines, end=-1 makes `end >= start` fail; with an unclosed fence the final run either starts in-fence (rejected by !block[0].inFence) or contains the fence-opener line, which matches neither trailer-line nor continuation shape, failing block.every — trailers stays null in every newly-entered case, identical to skipping the block. |
| 92 | EqualityOperator | `bodyLines.length >= 0` | Survived | EQUIVALENT | > 0 -> >= 0: differs only at length === 0, where end=-1 makes `end >= start` fail and trailers stays null, exactly as when the block is skipped. |
| 94 | ConditionalExpression | `true` | Survived | EQUIVALENT | `end >= 0` conjunct -> true: the separator scan guarantees bodyLines[0] is non-blank when bodyLines is non-empty, so the blank-skip walk always terminates at index >= 0; the guard is never the deciding conjunct and bodyLines[-1] is never read. |
| 94 | EqualityOperator | `end > 0` | Survived | EQUIVALENT | >= 0 -> > 0: differs only when end === 0 is evaluated, where the original tests bodyLines[0] — non-blank by the separator-scan invariant — and terminates with end === 0, exactly what the mutant does by short-circuiting. |
| 98 | ConditionalExpression | `true` | Survived | EQUIVALENT | At this point start >= 0 always holds (the start-walk ends at a blank index >= -1 then +=1) and end >= start always holds (bodyLines[end] is non-blank, so the start-walk decrements at least once before +=1). Forcing the whole condition or either conjunct to true replaces an always-true expression with true — unobservable. |
| 98 | LogicalOperator | `end >= start \|\| start >= 0` | Survived | EQUIVALENT | && -> \|\|: both operands are always true (see the adjacent proof); true\|\|true === true&&true. |
| 98 | ConditionalExpression | `true` | Survived | EQUIVALENT | At this point start >= 0 always holds (the start-walk ends at a blank index >= -1 then +=1) and end >= start always holds (bodyLines[end] is non-blank, so the start-walk decrements at least once before +=1). Forcing the whole condition or either conjunct to true replaces an always-true expression with true — unobservable. |
| 98 | ConditionalExpression | `true` | Survived | EQUIVALENT | At this point start >= 0 always holds (the start-walk ends at a blank index >= -1 then +=1) and end >= start always holds (bodyLines[end] is non-blank, so the start-walk decrements at least once before +=1). Forcing the whole condition or either conjunct to true replaces an always-true expression with true — unobservable. |
| 113 | ConditionalExpression | `true` | Survived | EQUIVALENT | `parsed.length > 0` -> true: the else-branch is reachable only for a non-trailer-shaped block line, but allShaped requires block[0] trailer-shaped, so the first iteration always pushes an entry; every later else sees length >= 1 where the original is already true. |
| 113 | EqualityOperator | `parsed.length >= 0` | Survived | EQUIVALENT | > 0 -> >= 0: tautology; the branch is only reached with length >= 1 (adjacent proof), so parsed[-1] is unreachable. |
| 132 | ArrayDeclaration | `["Stryker was here"]` | Survived | EQUIVALENT | ?? [] -> ?? [sentinel]: feeds new Set(...) whose only consumer is has(l.line) with numeric line; a set holding only a string answers has(number) false (SameValueZero, no coercion), exactly like the empty set. |
| 147 | ConditionalExpression | `true` | Survived | EQUIVALENT | some-predicate -> true makes hasBody = length > 0: by the separator-scan invariant a non-empty bodyLines always contains a non-blank first line, so the original some is true iff non-empty — identical. |
| 147 | MethodExpression | `l.text` | Survived | EQUIVALENT | trim removal in the hasBody predicate: if bodyLines is non-empty, bodyLines[0].text is non-blank (invariant) hence !== "", so both predicates make some true; if empty, both false. |
| 322 | ArrayDeclaration | `["Stryker was here"]` | Survived | EQUIVALENT | ?? [] -> ?? [sentinel]: fallback applies only when trailers is null; the array is immediately filtered by e.key === <governed key>, and a string element's .key is undefined — byKey returns [] exactly as with the empty array. |
| 384 | LogicalOperator | `subject.replace(PREFIX_STRIP_RE, "").tri` | Survived | EQUIVALENT | \|\| subject -> && subject: when the stripped trimmed description is truthy the mutant yields subject — same COPULA_RE.test by copula-invariance; when falsy (""), the case only arises for prefix-plus-whitespace or whitespace-only subjects, which contain no copula either way. |
| 384 | MethodExpression | `subject.replace(PREFIX_STRIP_RE, "")` | Survived | EQUIVALENT | trim removal on description: leading/trailing whitespace cannot create or destroy a COPULA_RE match ((^\|\s) accepts a retained leading space as readily as ^; (\s\|$) likewise at the end); the \|\| fallback fires for "" vs whitespace-only, both copula-free. |

### scripts/prx/modes.mjs

| Line | Mutator | Replacement | Stryker status | Verdict | Proof / evidence |
| --- | --- | --- | --- | --- | --- |
| 16 | MethodExpression | `["PRX-C-SIZE", "PRX-C-SUBJECT", "PRX-C-P` | Survived | EQUIVALENT | APPROVED_BLOCKING .filter(...) removal: the predicate returns true for every element (all listed rules are deterministic — pinned independently by the rules.test.ts class table), so the output array is identical; the filter's only side effect is the defensive load-time throw on registry drift, unreachable while the class table holds. |
| 17 | StringLiteral | `""` | Survived | ARTIFACT (replay-killed) | KILLED-IN-REALITY — hand-applied replay of this mutant fails the real suite. Stryker recorded a survivor because the mutant sits in module scope (a 'static' mutant) and the vitest runner does not reliably re-execute module scope under in-worker activation. |
| 18 | StringLiteral | `""` | Survived | ARTIFACT (replay-killed) | KILLED-IN-REALITY — hand-applied replay of this mutant fails the real suite. Stryker recorded a survivor because the mutant sits in module scope (a 'static' mutant) and the vitest runner does not reliably re-execute module scope under in-worker activation. |
| 19 | StringLiteral | `""` | Survived | ARTIFACT (replay-killed) | KILLED-IN-REALITY — hand-applied replay of this mutant fails the real suite. Stryker recorded a survivor because the mutant sits in module scope (a 'static' mutant) and the vitest runner does not reliably re-execute module scope under in-worker activation. |
| 20 | StringLiteral | `""` | Survived | ARTIFACT (replay-killed) | KILLED-IN-REALITY — hand-applied replay of this mutant fails the real suite. Stryker recorded a survivor because the mutant sits in module scope (a 'static' mutant) and the vitest runner does not reliably re-execute module scope under in-worker activation. |
| 21 | StringLiteral | `""` | Survived | ARTIFACT (replay-killed) | KILLED-IN-REALITY — hand-applied replay of this mutant fails the real suite. Stryker recorded a survivor because the mutant sits in module scope (a 'static' mutant) and the vitest runner does not reliably re-execute module scope under in-worker activation. |
| 22 | StringLiteral | `""` | Survived | ARTIFACT (replay-killed) | KILLED-IN-REALITY — hand-applied replay of this mutant fails the real suite. Stryker recorded a survivor because the mutant sits in module scope (a 'static' mutant) and the vitest runner does not reliably re-execute module scope under in-worker activation. |
| 23 | StringLiteral | `""` | Survived | ARTIFACT (replay-killed) | KILLED-IN-REALITY — hand-applied replay of this mutant fails the real suite. Stryker recorded a survivor because the mutant sits in module scope (a 'static' mutant) and the vitest runner does not reliably re-execute module scope under in-worker activation. |
| 24 | StringLiteral | `""` | Survived | ARTIFACT (replay-killed) | KILLED-IN-REALITY — hand-applied replay of this mutant fails the real suite. Stryker recorded a survivor because the mutant sits in module scope (a 'static' mutant) and the vitest runner does not reliably re-execute module scope under in-worker activation. |
| 25 | StringLiteral | `""` | Survived | ARTIFACT (replay-killed) | KILLED-IN-REALITY — hand-applied replay of this mutant fails the real suite. Stryker recorded a survivor because the mutant sits in module scope (a 'static' mutant) and the vitest runner does not reliably re-execute module scope under in-worker activation. |
| 26 | StringLiteral | `""` | Survived | ARTIFACT (replay-killed) | KILLED-IN-REALITY — hand-applied replay of this mutant fails the real suite. Stryker recorded a survivor because the mutant sits in module scope (a 'static' mutant) and the vitest runner does not reliably re-execute module scope under in-worker activation. |
| 27 | StringLiteral | `""` | Survived | ARTIFACT (replay-killed) | KILLED-IN-REALITY — hand-applied replay of this mutant fails the real suite. Stryker recorded a survivor because the mutant sits in module scope (a 'static' mutant) and the vitest runner does not reliably re-execute module scope under in-worker activation. |
| 28 | StringLiteral | `""` | Survived | ARTIFACT (replay-killed) | KILLED-IN-REALITY — hand-applied replay of this mutant fails the real suite. Stryker recorded a survivor because the mutant sits in module scope (a 'static' mutant) and the vitest runner does not reliably re-execute module scope under in-worker activation. |
| 29 | StringLiteral | `""` | Survived | ARTIFACT (replay-killed) | KILLED-IN-REALITY — hand-applied replay of this mutant fails the real suite. Stryker recorded a survivor because the mutant sits in module scope (a 'static' mutant) and the vitest runner does not reliably re-execute module scope under in-worker activation. |
| 30 | StringLiteral | `""` | Survived | ARTIFACT (replay-killed) | KILLED-IN-REALITY — hand-applied replay of this mutant fails the real suite. Stryker recorded a survivor because the mutant sits in module scope (a 'static' mutant) and the vitest runner does not reliably re-execute module scope under in-worker activation. |
| 32 | ConditionalExpression | `true` | Survived | ARTIFACT (replay-killed) | KILLED-IN-REALITY — hand-applied replay of this mutant fails the real suite. Stryker recorded a survivor because the mutant sits in module scope (a 'static' mutant) and the vitest runner does not reliably re-execute module scope under in-worker activation. |
| 32 | ConditionalExpression | `false` | Survived | EQUIVALENT | load-guard condition -> false: ruleClass(id) === "deterministic" for every listed id (independent class-table test), so the original condition is false on every element and the throw never fires — forcing false changes nothing on any reachable path. |
| 32 | EqualityOperator | `ruleClass(id) === "deterministic"` | Survived | ARTIFACT (replay-killed) | KILLED-IN-REALITY — hand-applied replay of this mutant fails the real suite. Stryker recorded a survivor because the mutant sits in module scope (a 'static' mutant) and the vitest runner does not reliably re-execute module scope under in-worker activation. |
| 32 | StringLiteral | `""` | Survived | ARTIFACT (replay-killed) | KILLED-IN-REALITY — hand-applied replay of this mutant fails the real suite. Stryker recorded a survivor because the mutant sits in module scope (a 'static' mutant) and the vitest runner does not reliably re-execute module scope under in-worker activation. |
| 32 | BlockStatement | `{}` | NoCoverage | NO-COVERAGE (explained) | load-guard throw block: executes only for a non-deterministic id inside APPROVED_BLOCKING, which cannot occur while rules.test.ts pins every listed id deterministic; intentionally dead defensive code. |
| 34 | StringLiteral | `''` | NoCoverage | NO-COVERAGE (explained) | message literal of that same unreachable defensive throw (an Error message, not a makeFinding diagnostic): dead for the load-guard reason. |
| 49 | OptionalChaining | `state.mode` | Survived | EQUIVALENT | state?.mode -> state.mode: the second \|\| operand is evaluated only when `state?.version !== 1` is false, i.e. state?.version === 1, which implies state is non-nullish — where state.mode and state?.mode are identical. (The state?.version chain has its own killing test via JSON null.) |

### scripts/prx/policy-source.mjs

No surviving or uncovered mutants.

### scripts/prx/resolve-range.mjs

| Line | Mutator | Replacement | Stryker status | Verdict | Proof / evidence |
| --- | --- | --- | --- | --- | --- |
| 16 | ArrayDeclaration | `[]` | Survived | EQUIVALENT | stdio array -> []: Node fills missing stdio entries with 'pipe'; none of the invoked git commands (cat-file -e, merge-base, merge-base --is-ancestor) reads stdin, so ignore-vs-pipe stdin is indistinguishable; stdout capture and nonzero-exit throw — the function's whole contract, pinned by every topology/failure test — are preserved. |
| 16 | StringLiteral | `""` | Survived | EQUIVALENT | individual stdio entry blanked: empirically exercised by every resolver test (each calls runGit); no pinned behavior differs — the git children read no stdin, and execFileSync's stdout-capture and throw-on-nonzero contract is unchanged for the mutated wiring. |
| 16 | StringLiteral | `""` | Survived | EQUIVALENT | individual stdio entry blanked: empirically exercised by every resolver test (each calls runGit); no pinned behavior differs — the git children read no stdin, and execFileSync's stdout-capture and throw-on-nonzero contract is unchanged for the mutated wiring. |
| 16 | StringLiteral | `""` | Survived | EQUIVALENT | individual stdio entry blanked: empirically exercised by every resolver test (each calls runGit); no pinned behavior differs — the git children read no stdin, and execFileSync's stdout-capture and throw-on-nonzero contract is unchanged for the mutated wiring. |
| 59 | MethodExpression | `mergeBase` | Survived | NOT EQUIVALENT, killed by r2 test | CORRECTED r2 (MUT-03): the prior EQUIVALENT label was wrong — removing slice(0, 80) observably changes the diagnostic (unbounded attacker-controlled merge-base output quoted into the error instead of an 80-character prefix). A mutant that changes emitted output is a survivor with a weak oracle, not an equivalent. resolve-range.test.ts now asserts the exact 80-character bound (negative-tested: the assertion fails with the mutant applied). |
| 74 | MethodExpression | `process.argv` | NoCoverage | ARTIFACT (replay-killed) | KILLED-IN-REALITY — hand-applied replay of this mutant fails the real suite. Stryker recorded no kill because the covering tests execute the mutated file in a SPAWNED subprocess, and mutant activation does not cross the process boundary. |
| 106 | ConditionalExpression | `false` | Survived | ARTIFACT (replay-killed) | KILLED-IN-REALITY — hand-applied replay of this mutant fails the real suite. Stryker recorded no kill because the covering tests execute the mutated file in a SPAWNED subprocess, and mutant activation does not cross the process boundary. |
| 108 | BlockStatement | `{}` | NoCoverage | ARTIFACT (replay-killed) | KILLED-IN-REALITY — hand-applied replay of this mutant fails the real suite. Stryker recorded no kill because the covering tests execute the mutated file in a SPAWNED subprocess, and mutant activation does not cross the process boundary. |

### scripts/prx/rules.mjs

No surviving or uncovered mutants.

## r2 focused rerun (label-gated CI matrix, Stryker 9.6.1)

Environment and scope, stated exactly: local full mutation runs are
BLOCKED on the r2 machine (memory exhaustion at Stryker concurrency
8-12 on 8 GB physical), so the r2 contract moved the focused runs to
the label-gated GitHub Actions matrix `15-prx-mutation` (one job per
r2-changed decision-path module, `--concurrency 2`, ubuntu-latest,
Stryker 9.6.1 exact-pinned, frozen lockfile, lifecycle scripts
disabled). First rerun: workflow run 31859979909 on head
a436f28abe85f6874b599fe1ba747c3a4edff5c5, all six jobs `success`
(native GitHub conclusions); raw per-module reports and logs ship in
the review bundle's `test-output/`. These figures are SEPARATE from
the r1 historical block above and are scoped to that head and that
environment.

| Module | Valid mutants | Killed | Timeout | Survived | No coverage | Score |
| --- | --- | --- | --- | --- | --- | --- |
| scripts/prx/lib/canonical.mjs | 589 | 483 | 13 | 85 | 8 | 84.21% |
| scripts/prx/commit-check.mjs | 445 | 395 | 1 | 46 | 3 | 88.99% |
| scripts/prx/body-check.mjs | 629 | 537 | 19 | 64 | 9 | 88.39% |
| scripts/prx/check-commit.mjs | 185 | 163 | 1 | 13 | 8 | 88.65% |
| scripts/prx/rules.mjs | 124 | 99 | 0 | 25 | 0 | 79.84% |
| scripts/prx/modes.mjs | 66 | 43 | 0 | 21 | 2 | 65.15% |
| Aggregate (six per-module runs) | 2038 | 1720 | 34 | 254 | 30 | 86.06% |

Survivor triage of the 284 surviving/no-coverage mutants, by class:

1. **Literal-class (128: StringLiteral 119, ObjectLiteral 3,
   ArrayDeclaration 6).** Dominated by diagnostic message fragments and
   configuration data in NEW r2 code (canonical reason strings, the
   sanitizer/container element lists, the rerun's own workflow-visible
   strings). The r1 pass suppressed this class with explicit
   `// Stryker disable next-line StringLiteral` annotations at the
   literal sites; much of the new r2 code does not carry those
   annotations yet, so the class appears as survivors instead of
   Ignored. Post-run hardening killed the highest-value members
   structurally instead of annotating: the FULL sanitizer removed-set
   and container-set element lists are now each pinned by per-element
   tests, the APPROVED_BLOCKING list is pinned by an independent
   exact-set copy plus a blocks-in-enforcing test per rule, and the
   shared grammar anchors (RUN_ID_RE / SHA40_RE / SCOPE_RE) are pinned
   at both ends. Annotating the remaining diagnostic fragments is
   recorded follow-up work, not silently waved off.
2. **r1-carried equivalence classes (recurring spans, line numbers
   shifted).** The r1 proof table above covers these mechanisms
   verbatim where the code is unchanged: parser-position
   OptionalChaining (8), the looksNarrative filter family, the
   final-trailer-block guard tautologies, the CAPSULE/TRAILER
   line-regex `$`-anchor vacuity, the wrapper subprocess/module-scope
   activation artifacts in check-commit.mjs/check-body.mjs, and the
   malformed-git-record defensive guard. The carried proofs are
   identified by original-span text, not line numbers.
3. **Post-run targeted kills (new tests in this pass).** Added after
   run 1 and verified locally: out-of-block governed record integrity
   (governed flag, value trimming, empty values), ungoverned duplicate
   keys draw no governed count, control-finding code-point labels and
   context wording, context-advisory claim wording, revert-shape
   advisory absence without the marker, `--verified-revert` CLI flag
   behavior, sanitized-scanner cross-chunk comment/element state,
   self-closing removed elements, exact drive-letter reason, and the
   evidence-ref adapter root config (run first-segment grammar,
   per-root minimum depth).
4. **Residual register.** Every remaining survivor is enumerated with
   file, line, mutator, and replacement in the bundle's raw per-module
   JSON reports. The residual is dominated by reason-string granularity
   in `evidenceRef` (verdict-equivalent mutants that only reroute WHICH
   rejection reason fires first), scanner index arithmetic whose
   divergence requires inputs the tag grammar excludes, and the
   defensive-arm classes above. HONEST SCOPING: the r2 rerun does NOT
   yet reproduce the r1 bar of zero unreviewed survivors with
   individual written proofs; the class triage above plus the raw
   registers are the r2 disposition, and the label-gated lane re-runs
   on demand (re-add the `prx-mutation` label) so the next pass can
   extend the per-mutant table over the residual.

A second rerun on the final r2 head (after the post-run kills landed)
is triggered by re-adding the label; its native conclusions and raw
reports are captured in the review bundle alongside run 1's.
