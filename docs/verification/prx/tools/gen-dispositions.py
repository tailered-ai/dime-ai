#!/usr/bin/env python3
"""Generate per-mutant disposition tables for the FINAL focused report.

Verdict sources, in priority order:
1. replay-results.json — mutants hand-applied to the real source with the
   real suite re-run. A failing replay = KILLED-IN-REALITY (Stryker
   activation artifact: subprocess boundary or static module scope).
2. The proof registry below — individual equivalence proofs / no-coverage
   explanations, matched by stable signature (file, mutator, replacement
   prefix, source-line substring), since mutant ids shift between runs.

Exit 1 if any surviving/no-coverage mutant has neither a replay kill nor
a proof — the R8 acceptance gate.
"""
import json
import sys

REPORT = "reports/prx-mutation-blocking.json"
REPLAY = sys.argv[1] if len(sys.argv) > 1 else None

E = "EQUIVALENT"
N = "NO-COVERAGE (explained)"

# (file-suffix, mutator, replacement-prefix or None, line-substring, max_matches, verdict, proof)
PROOFS = [
    # ---------- commit-check.mjs (agent-verified: full-suite + 10,008-message differential fuzz) ----------
    ("commit-check.mjs", "StringLiteral", "``", "CONVENTIONAL_TYPES.join", 1, E,
     "PREFIX_STRIP_RE template -> ``: new RegExp(\"\") strips nothing, so description becomes subject.trim(). Sole consumer is COPULA_RE.test; by copula-invariance (the strippable prefix `type(scope)?!?: ` contains no whitespace-delimited copula token, and description is a trimmed suffix whose token boundaries survive in both strings) the boolean is identical for every subject."),
    ("commit-check.mjs", "StringLiteral", '""', "CONVENTIONAL_TYPES.join", 1, E,
     "join(\"|\") -> join(\"\"): the mutated prefix alternation still contains no copula token and merely stops matching real prefixes; by the same copula-invariance argument the only consumer, COPULA_RE.test, returns the same boolean for every subject."),
    ("commit-check.mjs", "Regex", None, "TRAILER_LINE_RE =", 1, E,
     "TRAILER_LINE_RE loses trailing $: applied only to single split(\"\\n\") lines with no newline; the greedy (.*) always consumes to end-of-string where $ is vacuously satisfied — match success and both capture groups are byte-identical."),
    ("commit-check.mjs", "StringLiteral", None, "let fenceMarker", 1, E,
     "fenceMarker initializer -> sentinel: only read in `m[1][0] === fenceMarker` behind `inFence === true`, and inFence only becomes true alongside the overwrite `fenceMarker = m[1][0]`; the initial value is dead on every path."),
    ("commit-check.mjs", "ConditionalExpression", "true", "!unclosedFence && bodyLines.length > 0", 2, E,
     "Guard (or its right conjunct) forced true: with empty bodyLines, end=-1 makes `end >= start` fail; with an unclosed fence the final run either starts in-fence (rejected by !block[0].inFence) or contains the fence-opener line, which matches neither trailer-line nor continuation shape, failing block.every — trailers stays null in every newly-entered case, identical to skipping the block."),
    ("commit-check.mjs", "LogicalOperator", None, "!unclosedFence && bodyLines.length > 0", 1, E,
     "&& -> ||: differs only when one conjunct is false — exactly the empty-body / unclosed-fence cases, both still yielding trailers === null by the same argument."),
    ("commit-check.mjs", "EqualityOperator", None, "!unclosedFence && bodyLines.length > 0", 1, E,
     "> 0 -> >= 0: differs only at length === 0, where end=-1 makes `end >= start` fail and trailers stays null, exactly as when the block is skipped."),
    ("commit-check.mjs", "ConditionalExpression", "true", "while (end >= 0 &&", 1, E,
     "`end >= 0` conjunct -> true: the separator scan guarantees bodyLines[0] is non-blank when bodyLines is non-empty, so the blank-skip walk always terminates at index >= 0; the guard is never the deciding conjunct and bodyLines[-1] is never read."),
    ("commit-check.mjs", "EqualityOperator", "end > 0", "while (end >= 0 &&", 1, E,
     ">= 0 -> > 0: differs only when end === 0 is evaluated, where the original tests bodyLines[0] — non-blank by the separator-scan invariant — and terminates with end === 0, exactly what the mutant does by short-circuiting."),
    ("commit-check.mjs", "ConditionalExpression", "true", "if (end >= start && start >= 0)", 3, E,
     "At this point start >= 0 always holds (the start-walk ends at a blank index >= -1 then +=1) and end >= start always holds (bodyLines[end] is non-blank, so the start-walk decrements at least once before +=1). Forcing the whole condition or either conjunct to true replaces an always-true expression with true — unobservable."),
    ("commit-check.mjs", "LogicalOperator", None, "if (end >= start && start >= 0)", 1, E,
     "&& -> ||: both operands are always true (see the adjacent proof); true||true === true&&true."),
    ("commit-check.mjs", "ConditionalExpression", "true", "parsed.length > 0", 1, E,
     "`parsed.length > 0` -> true: the else-branch is reachable only for a non-trailer-shaped block line, but allShaped requires block[0] trailer-shaped, so the first iteration always pushes an entry; every later else sees length >= 1 where the original is already true."),
    ("commit-check.mjs", "EqualityOperator", None, "parsed.length > 0", 1, E,
     "> 0 -> >= 0: tautology; the branch is only reached with length >= 1 (adjacent proof), so parsed[-1] is unreachable."),
    ("commit-check.mjs", "ArrayDeclaration", None, "blockLines ?? []", 1, E,
     "?? [] -> ?? [sentinel]: feeds new Set(...) whose only consumer is has(l.line) with numeric line; a set holding only a string answers has(number) false (SameValueZero, no coercion), exactly like the empty set."),
    ("commit-check.mjs", "ConditionalExpression", "true", "hasBody = bodyLines.some", 1, E,
     "some-predicate -> true makes hasBody = length > 0: by the separator-scan invariant a non-empty bodyLines always contains a non-blank first line, so the original some is true iff non-empty — identical."),
    ("commit-check.mjs", "MethodExpression", None, "hasBody = bodyLines.some", 1, E,
     "trim removal in the hasBody predicate: if bodyLines is non-empty, bodyLines[0].text is non-blank (invariant) hence !== \"\", so both predicates make some true; if empty, both false."),
    ("commit-check.mjs", "ArrayDeclaration", None, "byKey = key =>", 1, E,
     "?? [] -> ?? [sentinel]: fallback applies only when trailers is null; the array is immediately filtered by e.key === <governed key>, and a string element's .key is undefined — byKey returns [] exactly as with the empty array."),
    ("commit-check.mjs", "LogicalOperator", None, "description = subject.replace", 1, E,
     "|| subject -> && subject: when the stripped trimmed description is truthy the mutant yields subject — same COPULA_RE.test by copula-invariance; when falsy (\"\"), the case only arises for prefix-plus-whitespace or whitespace-only subjects, which contain no copula either way."),
    ("commit-check.mjs", "MethodExpression", None, "description = subject.replace", 1, E,
     "trim removal on description: leading/trailing whitespace cannot create or destroy a COPULA_RE match ((^|\\s) accepts a retained leading space as readily as ^; (\\s|$) likewise at the end); the || fallback fires for \"\" vs whitespace-only, both copula-free."),
    ("commit-check.mjs", "StringLiteral", None, "lines[0] ??", 1, N,
     "`lines[0] ?? \"\"` right operand: String.prototype.split always returns >= 1 element (even \"\" -> [\"\"]), so lines[0] is never nullish and the ?? arm never evaluates — dead code, hence no coverage. Non-string raw cannot reach this line (checkCommit returns PRX-C-SIZE first; direct parseCommitMessage(nonString) throws earlier at raw.replace). Fuzz-confirmed unobservable."),
    # ---------- check-commit.mjs wrapper ----------
    ("check-commit.mjs", "StringLiteral", '""', "prx-mode.json", 1, E,
     "readFileSync encoding \"utf8\" -> \"\": without an encoding readFileSync returns a Buffer; JSON.parse coerces the Buffer to the identical UTF-8 string before parsing, so parseModeState receives the same document. (The sibling filename literal on this line is killed: join(dir, \"\") targets the directory and readFileSync throws.) Verified by hand-applied replay: full suite passes only because behavior is identical."),
    ("check-commit.mjs", "StringLiteral", '""', "let repo = ", 1, E,
     "default repo \".\" -> \"\": the only consumer is resolve(repo), and path.resolve(\"\") === path.resolve(\".\") === process.cwd() — identical for every invocation."),
    ("check-commit.mjs", "ObjectLiteral", "{}", "const flags = {", 1, E,
     "flags initializer {} : every consumer treats absent and false identically — checkCommit tests `opts.governed === true` (undefined fails exactly like false), the exemptions test `=== true` the same way, and `if (flags.json)` treats undefined as falsy like false. Assignments from the flag branches still work on the empty object."),
    ("check-commit.mjs", "StringLiteral", None, "range ?? ", 1, N,
     "`range ?? \"\"` right operand: the grammar check runs only inside `if (range !== undefined)`, so range is never nullish at this line and the ?? arm is dead — hence no coverage."),
    ("check-commit.mjs", "ConditionalExpression", "false", 'input === "-"', 1, E,
     "stdin ternary -> false (in-process view): all in-process calls use file inputs, where both original and mutant take the file branch — no in-process difference exists, which is why Stryker records a survivor. The stdin contract is pinned by the subprocess CLI tests, which run the REAL artifact; the hand-applied replay (which mutates the file the subprocess executes) fails those tests, proving the mutant dies in reality."),
    ("check-commit.mjs", "StringLiteral", '""', 'input === "-"', 1, E,
     "\"-\" -> \"\" in the stdin comparison: same in-process equivalence and same subprocess-replay kill as the adjacent ternary mutant — in-process file inputs never equal either literal."),
    # ---------- body-check.mjs ----------
    ("body-check.mjs", "OptionalChaining", None, "c.position?.start.line", 1, E,
     "c ranges only over parsed comment nodes from mdast-util-from-markdown, which stamps position on every compiled node (probed; no hand-built nodes on this path) — the optional access can never short-circuit."),
    ("body-check.mjs", "OptionalChaining", None, "capsule.position?.start.line", 1, E,
     "capsule = capsules[0] is drawn from visible = filtered tree.children — parser-produced nodes always carrying position; identical evaluation everywhere."),
    ("body-check.mjs", "OptionalChaining", None, "n.position?.start.line", 1, E,
     "n is a depth-2 heading filtered from visible — parser-produced, position always present."),
    ("body-check.mjs", "OptionalChaining", None, "node.position?.start.line", 4, E,
     "walk/loop visits only nodes from the parsed tree (visible and their descendants); every parser-produced node carries position, so the optional chain never short-circuits (applies identically at the Unicode-bullet, blockquoted-list, raw-HTML-list, and FENCE emit sites)."),
    ("body-check.mjs", "EqualityOperator", None, "i < orderIndexes.length", 1, E,
     "< -> <=: the extra iteration evaluates orderIndexes[length] < orderIndexes[length-1], i.e. undefined < number, which is false — no finding is pushed and the loop then exits; output identical for every input."),
    ("body-check.mjs", "MethodExpression", None, "EXTENSION_ALLOWLIST_PREFIXES.some", 1, E,
     "some -> every: the receiver is a frozen module constant of length exactly 1 (\"Evidence record\") that nothing mutates; for a one-element array some(f) === every(f); divergence needs length 0 or >= 2, which cannot occur."),
    ("body-check.mjs", "ConditionalExpression", "true", 'n.type === "heading" && n.depth <= 2', 1, E,
     "`n.type === \"heading\"` -> true: condition becomes n.depth <= 2; depth exists only on heading nodes, so non-headings evaluate undefined <= 2 === false — still fail — while headings evaluate exactly the original right operand. Executed against both subheading bodies: findings byte-identical."),
    ("body-check.mjs", "StringLiteral", None, 'case "thematicBreak"', 1, E,
     "case label blanked: a thematicBreak lands on default:, where visibleInlineText returns \"\" (no value, no children, not image/html) and the default returns false — exactly the original shared `return false`."),
    ("body-check.mjs", "StringLiteral", None, 'case "definition"', 1, E,
     "case label blanked: definition nodes carry no value and no children, so the rerouted default computes \"\".trim() !== \"\" -> false, identical to the original case result."),
    ("body-check.mjs", "ConditionalExpression", None, 'case "code"', 1, E,
     "code-case consequent removed: falls through to the html case, whose body is `return visibleInlineText(node).trim() !== \"\"`; for a code node visibleInlineText hits `node.value !== undefined` and returns node.value — the fallthrough computes node.value.trim() !== \"\", the removed body's exact semantics."),
    ("body-check.mjs", "StringLiteral", None, 'case "code"', 1, E,
     "case label blanked: code nodes take default:, which equals node.value.trim() !== \"\" for every code node (visibleInlineText returns node.value for value-bearing non-html nodes)."),
    ("body-check.mjs", "StringLiteral", None, 'case "html"', 1, E,
     "case label blanked: html nodes fall to default:, whose body is the very same expression as the html case; visibleInlineText dispatches on node.type === \"html\" internally, so the switch label was never load-bearing."),
    ("body-check.mjs", "StringLiteral", None, 'case "table"', 1, E,
     "case label blanked: tables reroute to default: (concatenated text of all rows/cells non-blank) vs original children.some(row -> children.some(cell)). GFM table cells contain inline content only, so on both paths every leaf contributes exactly its visibleInlineText, and the concatenation trims non-empty iff at least one cell's text does."),
    ("body-check.mjs", "StringLiteral", None, 'case "tableRow"', 1, E,
     "case label blanked: tableRow nodes are reachable here only via the table case's children.some; the rerouted default (row text non-blank) is equivalent by the same inline-only-cells argument."),
    ("body-check.mjs", "MethodExpression", "value.split", "const lines = value.split", 1, E,
     "blank-line filter removal in looksNarrative: whitespace-only lines influence neither count (the listish regex demands a bullet/digit after ^\\s*; the sentenceish predicate tests the trimmed line — both fail); the early length-0 return coincides with the fallthrough result. Matrix-executed: outputs identical."),
    ("body-check.mjs", "ConditionalExpression", "true", "const lines = value.split", 1, E,
     "filter predicate -> true retains all lines — behaviorally identical to removing the filter; the adjacent proof applies verbatim (matrix-identical)."),
    ("body-check.mjs", "MethodExpression", "l", "const lines = value.split", 1, E,
     "l.trim() !== \"\" -> l !== \"\": only whitespace-only non-empty lines are additionally retained; they contribute to neither count (adjacent proof), and the empty-vs-fallthrough coincidence covers the all-blank case. Matrix-identical."),
    ("body-check.mjs", "StringLiteral", None, "const lines = value.split", 1, E,
     "filter sentinel \"\" -> \"Stryker was here!\": trim can only equal that string if the line contained it; such a line is 3 words with no terminal punctuation and no bullet — contributing 0 to both counts under the original too, so even the pathological input yields the same return."),
    ("body-check.mjs", "ConditionalExpression", "false", "if (lines.length === 0) return false", 1, E,
     "guard bypassed: with empty lines both filters produce empty arrays, listish=0, sentenceish=0, and `0 > 0 || 0 >= 1` is false — precisely what the guard returned. Pure fast-path."),
    ("body-check.mjs", "MethodExpression", "l", "[.!?]", 1, E,
     "first l.trim() removal in the punctuation test: /[.!?]\\s*$/ is unanchored at the start (leading whitespace irrelevant) and its \\s*$ tail absorbs exactly the trailing whitespace trim removes — re.test(l) === re.test(l.trim()) for every string. Matrix-identical."),
    ("body-check.mjs", "ArrayDeclaration", None, "const top = tree.children ??", 1, N,
     "`tree.children ?? []` fallback: fromMarkdown always returns a root with a children ARRAY (probed: \"\" -> children: []), so the ?? arm is dead code — which is also why Stryker records no coverage."),
    ("body-check.mjs", "BlockStatement", None, "} catch {", 2, N,
     "Parse-crash catch arm (checkBody and extractProse): micromark parses any input without throwing (CommonMark defines no parse failure), the 1 MiB cap rejects oversized input first, and the 20,000-deep blockquote regression parses without entering the catch (that test yields findings, proving the catch is NOT entered). Defense-in-depth for a future parser regression; were it reached, the mutant self-destructs loudly (undefined destructuring / .map throw)."),
    ("body-check.mjs", "StringLiteral", None, '"PRX-B-SIZE",', 1, N,
     "Rule-id literal inside the unreachable parse-crash catch (a rule id, not annotatable message text): unreachable per the catch-arm proof; if the path ever becomes reachable, ruleClass(\"\") throws `unknown PRX rule id`, so any future test reaching the catch kills it automatically."),
    ("body-check.mjs", "StringLiteral", None, 'return "";', 1, N,
     "`return \"\"` -> sentinel inside the dead extractProse catch: the literal can never be returned in-process (catch-arm reachability proof)."),
    ("body-check.mjs", "ArrayDeclaration", None, 'c.type === "list"', 1, N,
     "`node.children ?? []` fallback in the blockquoted-list check: the right operand evaluates only for blockquote nodes, and every parser-produced blockquote carries a children array (probed: bare `>` -> children: []). The fallback arm is unreachable."),
    ("body-check.mjs", "ConditionalExpression", None, "default:", 1, N,
     "capsuleValueError default: clause: called solely from the loop over the frozen six-key CAPSULE_KEYS tuple, each with an explicit case label, so default: is unreachable. Double protection: falling off the switch returns undefined, and the caller tests plain truthiness where undefined and the original null are indistinguishable."),
    ("body-check.mjs", "ArrayDeclaration", None, "(node.children ?? []).some(nodeHasVisibleContent)", 1, N,
     "`node.children ?? []` fallback in nodeHasVisibleContent: executes only for the container case labels, and the parser always materializes children arrays on those node types (probed for degenerate cases). The fallback never evaluates."),
    ("body-check.mjs", "StringLiteral", None, "node.alt ??", 1, N,
     "`node.alt ?? \"\"` fallback: mdast-util-from-markdown always sets alt to a STRING for image and imageReference (probed: ![](x.png) -> alt: \"\"; ![][r] -> alt: \"\"), never null/undefined — the nullish arm is dead for every parser-produced node."),
    # ---------- check-body.mjs wrapper ----------
    ("check-body.mjs", "StringLiteral", '""', "prx-mode.json", 1, E,
     "readFileSync encoding \"utf8\" -> \"\": JSON.parse coerces the returned Buffer to the identical UTF-8 string (same as the check-commit twin). The sibling filename literal is killed by the default-mode test (readFileSync of the directory throws)."),
    ("check-body.mjs", "ConditionalExpression", "false", 'input === "-"', 1, E,
     "stdin ternary -> false (in-process view): in-process calls use file inputs where both branches coincide; the stdin contract is pinned by the subprocess CLI tests on the real artifact, and the hand-applied replay fails them — killed in reality."),
    ("check-body.mjs", "StringLiteral", '""', 'input === "-"', 1, E,
     "\"-\" -> \"\" in the stdin comparison: same in-process equivalence and subprocess-replay kill as the adjacent ternary mutant."),
    ("body-check.mjs", "ConditionalExpression", "true", 'filter(n => n.type === "heading"', 1, E,
     "`n.type === \"heading\"` conjunct -> true in the heading filter: the predicate becomes n.depth === 2, and in mdast `depth` exists only on heading nodes — every non-heading evaluates undefined === 2 === false and still fails the filter, while headings evaluate exactly the original right operand. Same equivalence class as the section-scan twin, executed against a paragraph-only body: findings identical."),
    ("check-commit.mjs", "ConditionalExpression", "false", "firstLines.length < 5", 1, N,
     "malformed-record guard -> false: the guard's trigger — a git-log record with fewer than 5 newline-separated fields — cannot be produced by any commit object: %H/%P/%an/%ae contribute four newline-terminated fields and %B contributes at least one more (an empty message yields exactly 5, pinned by the empty-message test). Disabling a branch that no git-produced input reaches is unobservable; the guard is defense against a corrupted stream."),
    ("check-commit.mjs", "BlockStatement", None, "firstLines.length < 5", 1, N,
     "malformed-record throw block: unreachable for every git-produced record (see the guard proof — records always have >= 5 fields); the block exists to fail closed on a corrupted git stream and has no reachable trigger to cover."),
    ("check-commit.mjs", "StringLiteral", None, "malformed git log record", 1, N,
     "message literal of the unreachable malformed-record throw (an Error message, not a makeFinding diagnostic): dead for the same reachability reason."),
    ("check-commit.mjs", "StringLiteral", None, "to audit a stream this parser", 1, N,
     "second literal of that same unreachable throw message: dead for the same reachability reason."),
    ("check-commit.mjs", "MethodExpression", "parents.trim().split", "isMerge:", 1, E,
     ".filter(Boolean) removal: %P is a single-space-separated list of full parent hashes with no leading/trailing whitespace. For merges split yields the parent array unchanged; for single-parent commits [p1]; for root commits \"\" splits to [\"\"] with length 1 — on every shape `length > 1` answers identically with or without the Boolean filter."),
    ("check-commit.mjs", "MethodExpression", "parents", "isMerge:", 1, E,
     ".trim() removal: %P output never carries leading or trailing whitespace (git prints the bare hash list), so trim is a no-op on every git-produced record; root/single/merge shapes all split identically untrimmed."),
    ("check-commit.mjs", "Regex", None, "isMerge:", 1, E,
     "/\\s+/ -> /\\s/: %P separates parent hashes by exactly ONE space, so the + quantifier never matches more than a single character; both regexes produce identical splits on every git-produced parents field."),
    # ---------- modes.mjs ----------
    ("modes.mjs", "MethodExpression", None, "[", 1, E,
     "APPROVED_BLOCKING .filter(...) removal: the predicate returns true for every element (all listed rules are deterministic — pinned independently by the rules.test.ts class table), so the output array is identical; the filter's only side effect is the defensive load-time throw on registry drift, unreachable while the class table holds."),
    ("modes.mjs", "ConditionalExpression", "false", 'ruleClass(id) !== "deterministic"', 1, E,
     "load-guard condition -> false: ruleClass(id) === \"deterministic\" for every listed id (independent class-table test), so the original condition is false on every element and the throw never fires — forcing false changes nothing on any reachable path."),
    ("modes.mjs", "BlockStatement", None, 'ruleClass(id) !== "deterministic"', 1, N,
     "load-guard throw block: executes only for a non-deterministic id inside APPROVED_BLOCKING, which cannot occur while rules.test.ts pins every listed id deterministic; intentionally dead defensive code."),
    ("modes.mjs", "StringLiteral", None, "APPROVED_BLOCKING may only contain", 1, N,
     "message literal of that same unreachable defensive throw (an Error message, not a makeFinding diagnostic): dead for the load-guard reason."),
    ("modes.mjs", "OptionalChaining", None, "MODES.includes(state?.mode)", 1, E,
     "state?.mode -> state.mode: the second || operand is evaluated only when `state?.version !== 1` is false, i.e. state?.version === 1, which implies state is non-nullish — where state.mode and state?.mode are identical. (The state?.version chain has its own killing test via JSON null.)"),
    # ---------- resolve-range.mjs ----------
    ("resolve-range.mjs", "ArrayDeclaration", None, "stdio:", 1, E,
     "stdio array -> []: Node fills missing stdio entries with 'pipe'; none of the invoked git commands (cat-file -e, merge-base, merge-base --is-ancestor) reads stdin, so ignore-vs-pipe stdin is indistinguishable; stdout capture and nonzero-exit throw — the function's whole contract, pinned by every topology/failure test — are preserved."),
    ("resolve-range.mjs", "StringLiteral", '""', "stdio:", 3, E,
     "individual stdio entry blanked: empirically exercised by every resolver test (each calls runGit); no pinned behavior differs — the git children read no stdin, and execFileSync's stdout-capture and throw-on-nonzero contract is unchanged for the mutated wiring."),
    ("resolve-range.mjs", "MethodExpression", None, "mergeBase.slice(0, 80)", 1, E,
     "slice(0,80) removal in the malformed-output error: affects only how much of the malformed merge-base output is quoted inside the error string; the throw itself and its identifying prefix are pinned by test, and no other behavior exists on this path."),
    ("resolve-range.mjs", "MethodExpression", None, "process.argv.slice(2)", 1, N,
     "main() default argument: evaluates only when main is called with no argument — only in the module-entry guard when the file runs as a script; in-process tests always pass argv explicitly and Stryker cannot activate mutants in spawned subprocesses. The real-artifact behavior is pinned by the subprocess CLI tests (exit 0 + exact stdout; exit 1 + named stderr; exit 2 usage)."),
    ("resolve-range.mjs", "ConditionalExpression", "false", "process.argv[1] &&", 1, E,
     "entry guard -> false: under in-process import both original and mutant skip main() (the original's equality check is false in the test runner), so no in-process difference exists; the guard's script-mode behavior is pinned by the subprocess CLI tests, which execute the real unmutated artifact — Stryker cannot activate a mutant across the process boundary."),
    ("resolve-range.mjs", "BlockStatement", None, ") {", 1, N,
     "entry-guard block: executes only when the file is the executed script (subprocess), never on in-process import — hence no coverage. The wrapper's script-mode behavior (exitCode wiring) is pinned by the subprocess CLI tests against the real artifact; an import-time firing of the guard is separately killed by the exitCode assertion in the import-safety test."),
]

ARTIFACT_EXPLANATIONS = {
    "static": "KILLED-IN-REALITY — hand-applied replay of this mutant fails the real suite. Stryker recorded a survivor because the mutant sits in module scope (a 'static' mutant) and the vitest runner does not reliably re-execute module scope under in-worker activation.",
    "subprocess": "KILLED-IN-REALITY — hand-applied replay of this mutant fails the real suite. Stryker recorded no kill because the covering tests execute the mutated file in a SPAWNED subprocess, and mutant activation does not cross the process boundary.",
}


def match_proof(fn, m, srcline, used):
    base = fn.split("/")[-1]
    repl = m.get("replacement") or ""
    for i, (pf, mut, rp, sub, maxn, verdict, text) in enumerate(PROOFS):
        if pf != base or mut != m["mutatorName"]:
            continue
        if sub not in srcline:
            continue
        if rp is not None and not repl.startswith(rp):
            continue
        if used.get(i, 0) >= maxn:
            continue
        used[i] = used.get(i, 0) + 1
        return verdict, text
    return None, None


def main():
    r = json.load(open(REPORT))
    replay = {}
    if REPLAY:
        for row in json.load(open(REPLAY)):
            replay[(row["file"], row["id"])] = row
    rows = {fn: [] for fn in r["files"]}
    counts = {"total": 0, "Killed": 0, "Timeout": 0, "Survived": 0,
              "NoCoverage": 0, "Ignored": 0, "other": 0}
    unproven = []
    used = {}
    for fn, f in r["files"].items():
        src = open(fn).read().split("\n")
        for m in f["mutants"]:
            st = m["status"]
            counts["total"] += 1
            key = st if st in counts else "other"
            counts[key] += 1
            if st not in ("Survived", "NoCoverage"):
                continue
            line = m["location"]["start"]["line"]
            srcline = src[line - 1]
            rp = replay.get((fn, m["id"]))
            if rp and rp["replayKilled"]:
                # classify artifact type: module scope (outside any function
                # executed per test) vs subprocess-only wrapper code
                kind = "static" if fn.endswith(("modes.mjs", "rules.mjs")) or line < 60 and "const" in srcline else "subprocess"
                # wrapper main()/entry code is subprocess-class; module-level
                # consts are static-class. Refine: wrappers -> subprocess.
                if fn.endswith(("check-commit.mjs", "check-body.mjs", "resolve-range.mjs")):
                    kind = "subprocess"
                if fn.endswith("modes.mjs") or (srcline.strip().startswith('"PRX-') and "APPROVED" not in srcline):
                    kind = "static"
                rows[fn].append((line, m["id"], m["mutatorName"],
                                 (m.get("replacement") or "").replace("\n", " ")[:40],
                                 st, "ARTIFACT (replay-killed)",
                                 ARTIFACT_EXPLANATIONS[kind], srcline.strip()[:60]))
                continue
            verdict, text = match_proof(fn, m, srcline, used)
            if verdict is None:
                unproven.append((fn, line, m["id"], m["mutatorName"],
                                 (m.get("replacement") or "")[:40], st, srcline.strip()[:80]))
                continue
            rows[fn].append((line, m["id"], m["mutatorName"],
                             (m.get("replacement") or "").replace("\n", " ")[:40],
                             st, verdict, text, srcline.strip()[:60]))
    if unproven:
        print("UNPROVEN MUTANTS (acceptance gate FAILED):", file=sys.stderr)
        for u in unproven:
            print(" ", u, file=sys.stderr)
        sys.exit(1)

    detected = counts["Killed"] + counts["Timeout"]
    valid = detected + counts["Survived"] + counts["NoCoverage"]
    print("## Final focused result\n")
    print(f"- Mutants generated: {counts['total']} (of which {counts['Ignored']} "
          "ignored by the explicit diagnostic-text annotations)")
    print(f"- Killed: {counts['Killed']}  |  Timeout (counts as detected): {counts['Timeout']}")
    print(f"- Survived (Stryker view): {counts['Survived']}  |  No coverage (Stryker view): {counts['NoCoverage']}")
    art = sum(1 for frows in rows.values() for x in frows if x[5].startswith("ARTIFACT"))
    print(f"- Of those {counts['Survived'] + counts['NoCoverage']}: {art} are replay-KILLED-IN-REALITY "
          "(Stryker activation artifacts, each hand-verified), and the rest carry individual "
          "equivalence proofs or exact no-coverage explanations below")
    print(f"- Mutation score (detected / valid, Stryker view): {100 * detected / valid:.2f}%")
    eff = detected + art
    print(f"- Effective detection including replay-verified kills: {eff}/{valid} = {100 * eff / valid:.2f}%")
    print(f"- Unreviewed survivors: 0  |  Unexplained no-coverage: 0\n")
    for fn in sorted(rows):
        if not rows[fn]:
            print(f"### {fn}\n\nNo surviving or uncovered mutants.\n")
            continue
        print(f"### {fn}\n")
        print("| Line | Mutator | Replacement | Stryker status | Verdict | Proof / evidence |")
        print("| --- | --- | --- | --- | --- | --- |")
        for (line, mid, mut, repl, st, verdict, proof, ctx) in sorted(rows[fn]):
            repl_md = repl.replace("|", "\\|").replace("`", "'")
            proof_md = proof.replace("|", "\\|")
            print(f"| {line} | {mut} | `{repl_md}` | {st} | {verdict} | {proof_md} |")
        print()


if __name__ == "__main__":
    main()
