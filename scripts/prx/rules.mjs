// PRX v1.1 rule registry — every rule the lane can emit, with its
// enforcement class and provenance class. The standard document
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
  "PRX-C-SIZE": {
    class: "deterministic",
    surface: "commit",
    title: "input within size bound (1 MiB)",
  },
  "PRX-C-SUBJECT": {
    class: "deterministic",
    surface: "commit",
    title: "subject present, trimmed, no trailing period, no control chars",
  },
  "PRX-C-PREFIX": {
    class: "deterministic",
    surface: "commit",
    title:
      "conventional-commit prefix (measured house convention); exemptions " +
      "require topology or authenticated metadata, never a subject prefix",
  },
  "PRX-C-SEPARATOR": {
    class: "deterministic",
    surface: "commit",
    title: "exactly one blank line between subject and body",
  },
  "PRX-C-LENGTH": {
    class: "advisory",
    surface: "commit",
    title: "subject over 72 characters (advisory; measured median is 76.5)",
  },
  "PRX-C-WRAP": {
    class: "advisory",
    surface: "commit",
    title:
      "body line over 72 columns after narrow exemptions (URL token, " +
      "fence content, table row, parsed trailer block)",
  },
  "PRX-C-FENCE": {
    class: "deterministic",
    surface: "commit",
    title: "code fences must close (unclosed fence is an error, not warning)",
  },
  "PRX-C-TRAILER": {
    class: "deterministic",
    surface: "commit",
    title:
      "formal trailer block grammar: valid keys, non-empty values, no " +
      "duplicate governed keys",
  },
  "PRX-C-GOV": {
    class: "deterministic",
    surface: "commit",
    title:
      "governed commits carry Run-Id and Evidence exactly once and at " +
      "least one Co-Authored-By, all with validated values",
  },
  "PRX-C-FIXUP": {
    class: "deterministic",
    surface: "commit",
    title: "fixup!/squash! commits must not reach a mainline range",
  },
  "PRX-C-MOOD": {
    class: "heuristic",
    surface: "commit",
    title:
      "subject looks indicative (copula heuristic); imperative mood beyond " +
      "this pattern is a reviewer rule, not a machine rule",
  },

  // PR-body rules
  "PRX-B-SIZE": {
    class: "deterministic",
    surface: "body",
    title: "input within size bound (1 MiB)",
  },
  "PRX-B-VISIBLE": {
    class: "deterministic",
    surface: "body",
    title: "rendered body has visible content (HTML comments do not count)",
  },
  "PRX-B-SECTION": {
    class: "deterministic",
    surface: "body",
    title:
      "every live-template section exactly once with non-empty visible " +
      'content (the template\'s own "none" convention satisfies content)',
  },
  "PRX-B-ORDER": {
    class: "advisory",
    surface: "body",
    title: "template sections appear in template order",
  },
  "PRX-B-CAPSULE": {
    class: "deterministic",
    surface: "body",
    title:
      "identifier capsule, when present: exactly one, first visible block, " +
      "six exact keys once each, valid value grammars, no narrative lines, " +
      "no placeholders",
  },
  "PRX-B-EXT": {
    class: "advisory",
    surface: "body",
    title:
      "extension headings outside the template and its allowlist are " +
      "reported (controlled extension policy)",
  },
  "PRX-B-STRUCTURE": {
    class: "advisory",
    surface: "body",
    title:
      "disguised structure detected in narrative (Unicode bullet, " +
      "blockquoted list, raw-HTML list, entity-encoded dash)",
  },
  "PRX-B-FENCE": {
    class: "advisory",
    surface: "body",
    title:
      "unlabeled fenced block classified as narrative-like; fenced content " +
      "is audited, never invisible",
  },
  "PRX-B-COMMENT": {
    class: "advisory",
    surface: "body",
    title:
      "contract-shaped content found only inside HTML comments (invisible " +
      "when rendered)",
  },
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
