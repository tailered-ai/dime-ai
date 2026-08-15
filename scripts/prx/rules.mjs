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
//
// r2: this module is also the dime-ai ADAPTER over the repository-agnostic
// canonicalization primitives in lib/canonical.mjs — the governed key set,
// the evidence-reference grammar, and the shared size cap are configured
// HERE and consumed by both checkers, so the two surfaces cannot drift.
import { canonicalTrailerKey, evidenceRef } from "./lib/canonical.mjs";

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
  // r2: context-sensitive control-character policy over body text
  // (subjects keep reporting under PRX-C-SUBJECT).
  "PRX-C-CONTROL": { class: "deterministic" },
  // r2 (BYP-C-04/05): advisory emitted when an exemption is claimed only
  // by unverified context (message shape or claimed identity); the
  // ordinary prefix result stands and this finding explains why.
  "PRX-C-CONTEXT-UNVERIFIED": { class: "advisory" },

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

// Canonicalize a trailer key against the governed set (ASCII
// case-insensitive; non-ASCII lookalikes stay unrecognized). Every trailer
// predicate in both checkers routes through this single adapter call
// (r2 BYP-C-01: case-variant keys skipped every key check).
export function canonicalGovernedKey(key) {
  return canonicalTrailerKey(key, GOVERNED_TRAILER_KEYS);
}

// Shared value grammars — single source for both checkers so the commit
// and body surfaces cannot drift apart (review finding: the Evidence
// length cap existed only on the commit side).
export const RUN_ID_RE = /^ONE-[0-9]{8}-[A-Z0-9]+$/;
export const SHA40_RE = /^[0-9a-f]{40}$/;
export const SCOPE_RE = /^TOS-[0-9]+$/;

// Shared input size cap, counted in UTF-8 BYTES (r2 BYP-C-06: the v1.1 cap
// counted UTF-16 units and undercounted multi-byte input).
export const INPUT_SIZE_LIMIT_BYTES = 1024 * 1024;

// Evidence/Ledger reference policy (REPOSITORY_POLICY; r2 BYP-C-03). The
// named constants below ARE the declared limits — recorded with rationale
// in source-trace-matrix.csv and pinned by boundary fixtures at each limit
// and at limit+1. Validation is structural (lib/canonical.mjs evidenceRef):
// segments are parsed and unsafe references are rejected, never normalized.
export const EVIDENCE_REF_MAX_SEGMENTS = 7;
export const EVIDENCE_REF_MAX_BYTES = 120;
export const EVIDENCE_REF_SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const EVIDENCE_REF_CONFIG = Object.freeze({
  sentinel: "UNKNOWN",
  maxSegments: EVIDENCE_REF_MAX_SEGMENTS,
  maxBytes: EVIDENCE_REF_MAX_BYTES,
  segmentRe: EVIDENCE_REF_SEGMENT_RE,
  roots: Object.freeze({
    run: Object.freeze({ firstSegmentRe: RUN_ID_RE, minSegments: 3 }),
    docs: Object.freeze({ minSegments: 2 }),
  }),
});

export function validateEvidenceRef(value) {
  return evidenceRef(value, EVIDENCE_REF_CONFIG);
}

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
