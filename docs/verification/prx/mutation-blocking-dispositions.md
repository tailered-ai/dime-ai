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

- Mutants generated: 1580 (of which 74 ignored by the explicit diagnostic-text annotations)
- Killed: 1257  |  Timeout (counts as detected): 139
- Survived (Stryker view): 86  |  No coverage (Stryker view): 24
- Of those 110: 35 are replay-KILLED-IN-REALITY (Stryker activation artifacts, each hand-verified), and the rest carry individual equivalence proofs or exact no-coverage explanations below
- Mutation score (detected / valid, Stryker view): 92.70%
- Effective detection including replay-verified kills: 1431/1506 = 95.02%
- Unreviewed survivors: 0  |  Unexplained no-coverage: 0

### scripts/prx/body-check.mjs

| Line | Mutator | Replacement | Stryker status | Verdict | Proof / evidence |
| --- | --- | --- | --- | --- | --- |
| 97 | ArrayDeclaration | `["Stryker was here"]` | NoCoverage | NO-COVERAGE (explained) | `tree.children ?? []` fallback: fromMarkdown always returns a root with a children ARRAY (probed: "" -> children: []), so the ?? arm is dead code — which is also why Stryker records no coverage. |
| 113 | BlockStatement | `{}` | NoCoverage | ARTIFACT (replay-killed) | KILLED-IN-REALITY — hand-applied replay of this mutant fails the real suite. Stryker recorded no kill because the covering tests execute the mutated file in a SPAWNED subprocess, and mutant activation does not cross the process boundary. |
| 116 | StringLiteral | `""` | NoCoverage | ARTIFACT (replay-killed) | KILLED-IN-REALITY — hand-applied replay of this mutant fails the real suite. Stryker recorded a survivor because the mutant sits in module scope (a 'static' mutant) and the vitest runner does not reliably re-execute module scope under in-worker activation. |
| 152 | OptionalChaining | `c.position.start` | Survived | EQUIVALENT | c ranges only over parsed comment nodes from mdast-util-from-markdown, which stamps position on every compiled node (probed; no hand-built nodes on this path) — the optional access can never short-circuit. |
| 180 | OptionalChaining | `capsule.position.start` | Survived | EQUIVALENT | capsule = capsules[0] is drawn from visible = filtered tree.children — parser-produced nodes always carrying position; identical evaluation everywhere. |
| 246 | ConditionalExpression | `true` | Survived | EQUIVALENT | `n.type === "heading"` conjunct -> true in the heading filter: the predicate becomes n.depth === 2, and in mdast `depth` exists only on heading nodes — every non-heading evaluates undefined === 2 === false and still fails the filter, while headings evaluate exactly the original right operand. Same equivalence class as the section-scan twin, executed against a paragraph-only body: findings identical. |
| 250 | OptionalChaining | `n.position.start` | Survived | EQUIVALENT | n is a depth-2 heading filtered from visible — parser-produced, position always present. |
| 298 | EqualityOperator | `i <= orderIndexes.length` | Survived | EQUIVALENT | < -> <=: the extra iteration evaluates orderIndexes[length] < orderIndexes[length-1], i.e. undefined < number, which is false — no finding is pushed and the loop then exits; output identical for every input. |
| 314 | MethodExpression | `EXTENSION_ALLOWLIST_PREFIXES.every(p => ` | Survived | EQUIVALENT | some -> every: the receiver is a frozen module constant of length exactly 1 ("Evidence record") that nothing mutates; for a one-element array some(f) === every(f); divergence needs length 0 or >= 2, which cannot occur. |
| 341 | OptionalChaining | `node.position.start` | Survived | EQUIVALENT | walk/loop visits only nodes from the parsed tree (visible and their descendants); every parser-produced node carries position, so the optional chain never short-circuits (applies identically at the Unicode-bullet, blockquoted-list, raw-HTML-list, and FENCE emit sites). |
| 348 | ArrayDeclaration | `["Stryker was here"]` | NoCoverage | NO-COVERAGE (explained) | `node.children ?? []` fallback in the blockquoted-list check: the right operand evaluates only for blockquote nodes, and every parser-produced blockquote carries a children array (probed: bare `>` -> children: []). The fallback arm is unreachable. |
| 355 | OptionalChaining | `node.position.start` | Survived | EQUIVALENT | walk/loop visits only nodes from the parsed tree (visible and their descendants); every parser-produced node carries position, so the optional chain never short-circuits (applies identically at the Unicode-bullet, blockquoted-list, raw-HTML-list, and FENCE emit sites). |
| 369 | OptionalChaining | `node.position.start` | Survived | EQUIVALENT | walk/loop visits only nodes from the parsed tree (visible and their descendants); every parser-produced node carries position, so the optional chain never short-circuits (applies identically at the Unicode-bullet, blockquoted-list, raw-HTML-list, and FENCE emit sites). |
| 399 | OptionalChaining | `node.position.start` | Survived | EQUIVALENT | walk/loop visits only nodes from the parsed tree (visible and their descendants); every parser-produced node carries position, so the optional chain never short-circuits (applies identically at the Unicode-bullet, blockquoted-list, raw-HTML-list, and FENCE emit sites). |
| 435 | BlockStatement | `{}` | NoCoverage | ARTIFACT (replay-killed) | KILLED-IN-REALITY — hand-applied replay of this mutant fails the real suite. Stryker recorded no kill because the covering tests execute the mutated file in a SPAWNED subprocess, and mutant activation does not cross the process boundary. |
| 436 | StringLiteral | `"Stryker was here!"` | NoCoverage | NO-COVERAGE (explained) | `return ""` -> sentinel inside the dead extractProse catch: the literal can never be returned in-process (catch-arm reachability proof). |
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
| 59 | MethodExpression | `mergeBase` | Survived | EQUIVALENT | slice(0,80) removal in the malformed-output error: affects only how much of the malformed merge-base output is quoted inside the error string; the throw itself and its identifying prefix are pinned by test, and no other behavior exists on this path. |
| 74 | MethodExpression | `process.argv` | NoCoverage | ARTIFACT (replay-killed) | KILLED-IN-REALITY — hand-applied replay of this mutant fails the real suite. Stryker recorded no kill because the covering tests execute the mutated file in a SPAWNED subprocess, and mutant activation does not cross the process boundary. |
| 106 | ConditionalExpression | `false` | Survived | ARTIFACT (replay-killed) | KILLED-IN-REALITY — hand-applied replay of this mutant fails the real suite. Stryker recorded no kill because the covering tests execute the mutated file in a SPAWNED subprocess, and mutant activation does not cross the process boundary. |
| 108 | BlockStatement | `{}` | NoCoverage | ARTIFACT (replay-killed) | KILLED-IN-REALITY — hand-applied replay of this mutant fails the real suite. Stryker recorded no kill because the covering tests execute the mutated file in a SPAWNED subprocess, and mutant activation does not cross the process boundary. |

### scripts/prx/rules.mjs

No surviving or uncovered mutants.
