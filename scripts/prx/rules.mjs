// PRX v1.1 rule registry — every rule the lane can emit, with its
// enforcement class. The class is the only registry field the decision
// path consumes (level derivation + APPROVED_BLOCKING gating); display
// titles and surface labels live in rule-metadata.mjs, keyed by the same
// ids (rules.test.ts pins the key sets equal). The standard document
// (docs/verification/prx/PRX-STANDARD-v1.1.md) and the source-trace matrix
// (docs/verification/prx/source-trace-matrix.csv) key off these ids; tests
// pin fixtures to exact sets of them. Classes:
//   deterministic — machine-provable structure; may block in enforcing mode
//                   when listed in APPROVED_BLOCKING (modes.mjs)
//   advisory      — measurable but policy-soft (repo practice diverges, or
//                   thresholds are owner-tunable); never blocks
//   heuristic     — declared approximation of a semantic property; never
//                   blocks and never claims certainty
export const RULES = Object.freeze({
  // Commit-message rules
  "PRX-C-SIZE": { class: "deterministic" },
  "PRX-C-SUBJECT": { class: "deterministic" },
  "PRX-C-PREFIX": { class: "deterministic" },
  "PRX-C-SEPARATOR": { class: "deterministic" },
  "PRX-C-LENGTH": { class: "advisory" },
  "PRX-C-WRAP": { class: "advisory" },
  "PRX-C-FENCE": { class: "deterministic" },
  "PRX-C-TRAILER": { class: "deterministic" },
  "PRX-C-GOV": { class: "deterministic" },
  "PRX-C-FIXUP": { class: "deterministic" },
  "PRX-C-MOOD": { class: "heuristic" },

  // PR-body rules (section subcodes per remediation R5: missing,
  // duplicate, and empty are independent blocking conditions)
  "PRX-B-SIZE": { class: "deterministic" },
  "PRX-B-VISIBLE": { class: "deterministic" },
  "PRX-B-SECTION-MISSING": { class: "deterministic" },
  "PRX-B-SECTION-DUP": { class: "deterministic" },
  "PRX-B-SECTION-EMPTY": { class: "deterministic" },
  "PRX-B-ORDER": { class: "advisory" },
  "PRX-B-CAPSULE": { class: "deterministic" },
  "PRX-B-EXT": { class: "advisory" },
  "PRX-B-STRUCTURE": { class: "advisory" },
  "PRX-B-FENCE": { class: "advisory" },
  "PRX-B-COMMENT": { class: "advisory" },
});

export const GOVERNED_TRAILER_KEYS = Object.freeze([
  "Run-Id",
  "Evidence",
  "Co-Authored-By",
]);

// Shared value grammars — single source for both checkers so the commit
// and body surfaces cannot drift apart (review finding: the Evidence
// length cap existed only on the commit side).
export const RUN_ID_RE = /^ONE-[0-9]{8}-[A-Z0-9]+$/;
export const SHA40_RE = /^[0-9a-f]{40}$/;
export const SCOPE_RE = /^TOS-[0-9]+$/;
export const REF_RE =
  /^(UNKNOWN|run\/ONE-[0-9]{8}-[A-Z0-9]+(\/[A-Za-z0-9._-]+){1,5}|docs\/[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+){0,5})$/;
export const REF_MAX_LENGTH = 120;

export function ruleClass(id) {
  const rule = RULES[id];
  if (!rule) throw new Error(`unknown PRX rule id: ${id}`);
  return rule.class;
}

export function makeFinding(rule, message, line) {
  const cls = ruleClass(rule);
  return {
    rule,
    class: cls,
    level: cls === "deterministic" ? "error" : "advisory",
    message,
    ...(line === undefined ? {} : { line }),
  };
}
