// PRX rule display metadata — titles and surface labels ONLY. Nothing in
// the decision path consumes this module: verdicts derive from the rule
// CLASSES in rules.mjs. Split out for the focused blocking-path mutation
// configuration (remediation R8): stryker.blocking.prx.json excludes this
// file under R8's explicit "rule-title metadata" exclusion, while the
// broader exploratory configuration still mutates it (non-gating).
// rules.test.ts pins key-set equality with the RULES registry so the two
// files cannot drift apart.
export const RULE_METADATA = Object.freeze({
  // Commit-message rules
  "PRX-C-SIZE": {
    surface: "commit",
    title: "input within size bound (1 MiB)",
  },
  "PRX-C-SUBJECT": {
    surface: "commit",
    title: "subject present, trimmed, no trailing period, no control chars",
  },
  "PRX-C-PREFIX": {
    surface: "commit",
    title:
      "conventional-commit prefix (measured house convention); exemptions " +
      "require topology or authenticated metadata, never a subject prefix",
  },
  "PRX-C-SEPARATOR": {
    surface: "commit",
    title: "exactly one blank line between subject and body",
  },
  "PRX-C-LENGTH": {
    surface: "commit",
    title: "subject over 72 characters (advisory; measured median is 76.5)",
  },
  "PRX-C-WRAP": {
    surface: "commit",
    title:
      "body line over 72 columns after narrow exemptions (URL token, " +
      "fence content, table row, parsed trailer block)",
  },
  "PRX-C-FENCE": {
    surface: "commit",
    title: "code fences must close (unclosed fence is an error, not warning)",
  },
  "PRX-C-TRAILER": {
    surface: "commit",
    title:
      "formal trailer block grammar: valid keys, non-empty values, no " +
      "duplicate governed keys; Co-Authored-By value grammar is validated " +
      "wherever the trailer appears, governed scope or not",
  },
  "PRX-C-GOV": {
    surface: "commit",
    title:
      "once governed scope is explicitly established (--governed, or the " +
      "commit self-declares via a Run-Id/Evidence trailer): Run-Id and " +
      "Evidence exactly once with validated values, and at least one " +
      "Co-Authored-By present; the ordinary range audit does not decide " +
      "which commits ought to be governed",
  },
  "PRX-C-FIXUP": {
    surface: "commit",
    title: "fixup!/squash! commits must not reach a mainline range",
  },
  "PRX-C-MOOD": {
    surface: "commit",
    title:
      "subject looks indicative (copula heuristic); imperative mood beyond " +
      "this pattern is a reviewer rule, not a machine rule",
  },
  "PRX-C-CONTROL": {
    surface: "commit",
    title:
      "context-sensitive control-character policy over the body: ordinary " +
      "body text rejects control (Cc) code points except TAB plus " +
      "U+2028/U+2029; fenced and valid indented code content rejects only " +
      "NUL; the same policy runs in file, stdin, and range input modes " +
      "(subjects report under PRX-C-SUBJECT)",
  },
  "PRX-C-CONTEXT-UNVERIFIED": {
    surface: "commit",
    title:
      "an exemption was claimed only by unverified context (revert-shaped " +
      "message text or a claimed bot identity); the ordinary prefix result " +
      "stands and this advisory explains why no exemption was granted",
  },

  // PR-body rules
  "PRX-B-SIZE": {
    surface: "body",
    title: "input within size bound (1 MiB)",
  },
  "PRX-B-VISIBLE": {
    surface: "body",
    title: "rendered body has visible content (HTML comments do not count)",
  },
  "PRX-B-SECTION-MISSING": {
    surface: "body",
    title: "a required live-template section is missing",
  },
  "PRX-B-SECTION-DUP": {
    surface: "body",
    title: "a required live-template section appears more than once",
  },
  "PRX-B-SECTION-EMPTY": {
    surface: "body",
    title:
      "a required section has no meaningful visible content (the " +
      'template\'s own "none" convention satisfies content; comments, ' +
      "empty fences, thematic breaks, label-less links, alt-less images, " +
      "and empty lists/tables do not)",
  },
  "PRX-B-ORDER": {
    surface: "body",
    title: "template sections appear in template order",
  },
  "PRX-B-CAPSULE": {
    surface: "body",
    title:
      "identifier capsule, when present: exactly one, first visible block, " +
      "six exact keys once each, valid value grammars, no narrative lines, " +
      "no placeholders",
  },
  "PRX-B-EXT": {
    surface: "body",
    title:
      "extension headings outside the template and its allowlist are " +
      "reported (controlled extension policy)",
  },
  "PRX-B-STRUCTURE": {
    surface: "body",
    title:
      "disguised structure detected in narrative (Unicode bullet, " +
      "blockquoted list, raw-HTML list, entity-encoded dash)",
  },
  "PRX-B-FENCE": {
    surface: "body",
    title:
      "unlabeled fenced block classified as narrative-like; fenced content " +
      "is audited, never invisible",
  },
  "PRX-B-COMMENT": {
    surface: "body",
    title:
      "contract-shaped content found only inside HTML comments (invisible " +
      "when rendered)",
  },
});
