// PRX v1.1 PR-body checker — pure library over a CommonMark AST
// (mdast-util-from-markdown, already pinned in the repo lockfile via
// react-markdown). Replaces the rejected v1.0 line-oriented regex scanner
// (SOL-PRX-005): validation happens on rendered structure, HTML comments are
// handled explicitly, and the schema is the LIVE dime-ai template — the 14
// required sections of .github/pull_request_template.md — not the v1.0
// generic seven. The identifier capsule is OPTIONAL (0/10 sampled live PRs
// carry one); when present it is validated strictly.
import { fromMarkdown } from "mdast-util-from-markdown";
import { makeFinding } from "./rules.mjs";

const SIZE_LIMIT = 1024 * 1024;

export const REQUIRED_SECTIONS = Object.freeze([
  "Purpose and scope",
  "Notion context",
  "Linked incident / finding",
  "User-facing behavior changes",
  "Reproduction evidence",
  "Tests",
  "Bundle impact",
  "Database impact",
  "Security impact",
  "Accessibility impact",
  "Deployment and rollback plan",
  "Federation evidence",
  "Authorization",
  "Post-deployment validation",
]);

// Controlled extension policy: headings the live contract itself invites.
const EXTENSION_ALLOWLIST_PREFIXES = Object.freeze(["Evidence record"]);

const CAPSULE_KEYS = Object.freeze([
  "Scope",
  "Run-Id",
  "Base",
  "Head",
  "Ledger",
  "Evidence",
]);
const CAPSULE_LINE_RE = /^([A-Za-z][A-Za-z0-9-]*):[ \t]*(.*)$/;
const PLACEHOLDERS = new Set(["TODO", "TBD", "FIXME", "XXX"]);
const SHA_RE = /^[0-9a-f]{40}$/;
const RUN_ID_RE = /^ONE-[0-9]{8}-[A-Z0-9]+$/;
const SCOPE_RE = /^TOS-[0-9]+$/;
const REF_RE =
  /^(UNKNOWN|run\/ONE-[0-9]{8}-[A-Z0-9]+(\/[A-Za-z0-9._-]+){1,5}|docs\/[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+){0,5})$/;
const ENTITY_DASH_RE = /&(mdash|ndash|#8212|#8211|#x2014|#x2013);/i;
const UNICODE_BULLET_RE = /^[•‣▪◦]\s/m;

function isCommentNode(node) {
  if (node.type !== "html") return false;
  const v = node.value.trim();
  return v.startsWith("<!--") && v.endsWith("-->");
}

function inlineText(node) {
  if (node.value !== undefined && node.type !== "html") return node.value;
  if (!node.children) return "";
  return node.children.map(inlineText).join("");
}

function isCapsuleCandidate(node) {
  if (node.type !== "code") return false;
  const lines = node.value.split("\n");
  return lines.some(l => {
    const m = l.match(CAPSULE_LINE_RE);
    return m && CAPSULE_KEYS.includes(m[1]);
  });
}

export function parseBody(raw) {
  const tree = fromMarkdown(raw);
  const top = tree.children ?? [];
  const visible = top.filter(n => !isCommentNode(n));
  const comments = top.filter(isCommentNode);
  return { tree, top, visible, comments };
}

export function checkBody(raw, opts = {}) {
  const findings = [];
  if (typeof raw !== "string" || raw.length > SIZE_LIMIT) {
    findings.push(makeFinding("PRX-B-SIZE", "PR body exceeds the 1 MiB bound"));
    return findings;
  }
  const { top, visible, comments } = parseBody(raw);

  // PRX-B-VISIBLE — an all-comment (or empty) body renders as nothing.
  if (visible.length === 0) {
    findings.push(
      makeFinding(
        "PRX-B-VISIBLE",
        "PR body has no visible content once HTML comments are removed"
      )
    );
  }

  // PRX-B-COMMENT — contract-shaped content hidden in comments is invisible
  // when rendered and satisfies nothing.
  for (const c of comments) {
    if (
      /^##\s/m.test(c.value) ||
      /^(Scope|Run-Id|Base|Head|Ledger|Evidence):/m.test(c.value)
    ) {
      findings.push(
        makeFinding(
          "PRX-B-COMMENT",
          "contract-shaped content (headings or capsule keys) appears only " +
            "inside an HTML comment",
          c.position?.start.line
        )
      );
      break;
    }
  }

  // ---- Identifier capsule (optional; strict when present) ----
  const capsules = visible.filter(isCapsuleCandidate);
  if (capsules.length > 1) {
    findings.push(
      makeFinding(
        "PRX-B-CAPSULE",
        `found ${capsules.length} identifier capsules (at most one allowed)`
      )
    );
  }
  if (capsules.length >= 1) {
    const capsule = capsules[0];
    if (visible[0] !== capsule) {
      findings.push(
        makeFinding(
          "PRX-B-CAPSULE",
          "visible content precedes the identifier capsule (the capsule " +
            "must be the first visible block)",
          capsule.position?.start.line
        )
      );
    }
    const seen = new Map();
    for (const rawLine of capsule.value.split("\n")) {
      if (rawLine.trim() === "") continue;
      const m = rawLine.match(CAPSULE_LINE_RE);
      if (!m || !CAPSULE_KEYS.includes(m[1])) {
        findings.push(
          makeFinding(
            "PRX-B-CAPSULE",
            `capsule contains a non-key line: "${truncate(rawLine)}"`
          )
        );
        continue;
      }
      const [, key, value] = m;
      seen.set(key, (seen.get(key) ?? []).concat(value.trim()));
    }
    for (const key of CAPSULE_KEYS) {
      const values = seen.get(key) ?? [];
      if (values.length === 0) {
        findings.push(
          makeFinding("PRX-B-CAPSULE", `capsule key "${key}" is missing`)
        );
        continue;
      }
      if (values.length > 1) {
        findings.push(
          makeFinding(
            "PRX-B-CAPSULE",
            `capsule key "${key}" appears ${values.length} times`
          )
        );
      }
      const value = values[0];
      if (value === "") {
        findings.push(
          makeFinding("PRX-B-CAPSULE", `capsule key "${key}" has no value`)
        );
        continue;
      }
      if (PLACEHOLDERS.has(value.toUpperCase())) {
        findings.push(
          makeFinding(
            "PRX-B-CAPSULE",
            `capsule key "${key}" carries the placeholder "${value}"`
          )
        );
        continue;
      }
      const grammarError = capsuleValueError(key, value);
      if (grammarError) {
        findings.push(makeFinding("PRX-B-CAPSULE", grammarError));
      }
    }
  }

  // ---- Required live-template sections ----
  const headings = visible
    .filter(n => n.type === "heading" && n.depth === 2)
    .map(n => ({
      node: n,
      text: inlineText(n).trim(),
      line: n.position?.start.line,
    }));
  const requiredLower = REQUIRED_SECTIONS.map(s => s.toLowerCase());

  for (const [i, name] of REQUIRED_SECTIONS.entries()) {
    const matches = headings.filter(
      h => h.text.toLowerCase() === requiredLower[i]
    );
    if (matches.length === 0) {
      findings.push(
        makeFinding("PRX-B-SECTION", `section "${name}" is missing`)
      );
    } else if (matches.length > 1) {
      findings.push(
        makeFinding(
          "PRX-B-SECTION",
          `section "${name}" appears ${matches.length} times ` +
            "(exactly once required)",
          matches[1].line
        )
      );
    }
    if (matches.length >= 1 && sectionIsEmpty(visible, matches[0].node)) {
      findings.push(
        makeFinding(
          "PRX-B-SECTION",
          `section "${name}" is empty; the live template requires "none" ` +
            "to be written explicitly where a section does not apply",
          matches[0].line
        )
      );
    }
  }

  // PRX-B-ORDER (advisory) — template order.
  const orderIndexes = headings
    .map(h => requiredLower.indexOf(h.text.toLowerCase()))
    .filter(i => i >= 0);
  for (let i = 1; i < orderIndexes.length; i += 1) {
    if (orderIndexes[i] < orderIndexes[i - 1]) {
      findings.push(
        makeFinding(
          "PRX-B-ORDER",
          "template sections appear out of template order"
        )
      );
      break;
    }
  }

  // PRX-B-EXT (advisory) — controlled extension-heading policy.
  for (const h of headings) {
    const isRequired = requiredLower.includes(h.text.toLowerCase());
    const isAllowed = EXTENSION_ALLOWLIST_PREFIXES.some(p =>
      h.text.startsWith(p)
    );
    if (!isRequired && !isAllowed) {
      findings.push(
        makeFinding(
          "PRX-B-EXT",
          `extension heading "${h.text}" is outside the template and its ` +
            "allowlist",
          h.line
        )
      );
    }
  }

  // ---- Structure-detection library (advisory; Sol B05–B08 mechanisms) ----
  walk(visible, node => {
    if (node.type === "paragraph") {
      const text = inlineText(node);
      if (UNICODE_BULLET_RE.test(text)) {
        findings.push(
          makeFinding(
            "PRX-B-STRUCTURE",
            "Unicode bullet renders as a list item in narrative",
            node.position?.start.line
          )
        );
      }
    }
    if (
      node.type === "blockquote" &&
      (node.children ?? []).some(c => c.type === "list")
    ) {
      findings.push(
        makeFinding(
          "PRX-B-STRUCTURE",
          "blockquoted list still renders as a list",
          node.position?.start.line
        )
      );
    }
    if (
      node.type === "html" &&
      !isCommentNode(node) &&
      /<(ul|ol|li)\b/i.test(node.value)
    ) {
      findings.push(
        makeFinding(
          "PRX-B-STRUCTURE",
          "raw HTML list renders as a list",
          node.position?.start.line
        )
      );
    }
  });
  if (ENTITY_DASH_RE.test(raw)) {
    findings.push(
      makeFinding(
        "PRX-B-STRUCTURE",
        "entity-encoded dash decodes to punctuation when rendered; write " +
          "the character itself so audits see what readers see"
      )
    );
  }

  // PRX-B-FENCE (advisory) — fenced content is classified, never invisible.
  for (const node of visible) {
    if (node.type !== "code" || isCapsuleCandidate(node)) continue;
    if (!node.lang && looksNarrative(node.value)) {
      findings.push(
        makeFinding(
          "PRX-B-FENCE",
          "unlabeled fenced block reads as narrative or a list; label the " +
            "fence (e.g. ```text) or move prose out of it — fenced content " +
            "is audited, not exempt",
          node.position?.start.line
        )
      );
    }
  }

  return findings;
}

// Narrative text for the style layer: paragraph text of visible,
// non-code content, with entities already decoded by the parser.
export function extractProse(raw) {
  if (typeof raw !== "string" || raw.length > SIZE_LIMIT) return "";
  const { visible } = parseBody(raw);
  const out = [];
  walk(visible, node => {
    if (node.type === "paragraph") out.push(inlineText(node));
  });
  return out.join("\n\n");
}

function capsuleValueError(key, value) {
  switch (key) {
    case "Scope":
      return SCOPE_RE.test(value)
        ? null
        : `capsule Scope "${truncate(value)}" does not match TOS-<number>`;
    case "Run-Id":
      return RUN_ID_RE.test(value)
        ? null
        : `capsule Run-Id "${truncate(value)}" does not match ` +
            "ONE-YYYYMMDD-TOKEN";
    case "Base":
    case "Head":
      return SHA_RE.test(value)
        ? null
        : `capsule ${key} "${truncate(value)}" is not a 40-hex commit SHA`;
    case "Ledger":
    case "Evidence":
      return REF_RE.test(value)
        ? null
        : `capsule ${key} "${truncate(value)}" is not a bounded run/ or ` +
            "docs/ reference (or UNKNOWN)";
    default:
      return null;
  }
}

function sectionIsEmpty(visible, headingNode) {
  const start = visible.indexOf(headingNode);
  for (let i = start + 1; i < visible.length; i += 1) {
    const n = visible[i];
    if (n.type === "heading" && n.depth <= 2) return true;
    if (n.type === "heading") continue;
    return false;
  }
  return true;
}

function looksNarrative(value) {
  const lines = value.split("\n").filter(l => l.trim() !== "");
  if (lines.length === 0) return false;
  const listish = lines.filter(l => /^\s*([-*+]|\d+[.)])\s/.test(l)).length;
  const sentenceish = lines.filter(
    l => /[.!?]\s*$/.test(l.trim()) && l.trim().split(/\s+/).length >= 4
  ).length;
  return listish > 0 || sentenceish >= 1;
}

function walk(nodes, visit) {
  for (const n of nodes) {
    visit(n);
    if (n.children) walk(n.children, visit);
  }
}

function truncate(s) {
  return s.length > 60 ? `${s.slice(0, 57)}...` : s;
}
