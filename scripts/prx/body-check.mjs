// PRX v1.1 PR-body checker — pure library over a CommonMark AST
// (mdast-util-from-markdown, already pinned in the repo lockfile via
// react-markdown). Replaces the rejected v1.0 line-oriented regex scanner
// (SOL-PRX-005): validation happens on rendered structure, HTML comments are
// handled explicitly, and the schema is the LIVE dime-ai template — the 14
// required sections of .github/pull_request_template.md — not the v1.0
// generic seven. The identifier capsule is OPTIONAL (0/10 sampled live PRs
// carry one); when present it is validated strictly.
import { fromMarkdown } from "mdast-util-from-markdown";
// GFM fidelity (remediation R4/R5): GitHub renders PR bodies as GFM, so
// tables, task-list checkboxes, footnotes, and autolinks must parse as
// their real node types — without this, table rows land in paragraph nodes
// and leak into the extracted narrative prose. Both packages were already
// in the lockfile via remark-gfm (zero new packages).
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";
import {
  createHtmlContainerTracker,
  createSanitizedTextScanner,
  decodeHtmlEntities,
  exceedsByteLimit,
  isMeaningfulText,
  meaningfulVisibleHtml,
} from "./lib/canonical.mjs";
import {
  HTML_CONTAINER_ELEMENTS,
  INPUT_SIZE_LIMIT_BYTES,
  makeFinding,
  RUN_ID_RE,
  SANITIZER_REMOVED_ELEMENTS,
  SCOPE_RE,
  SHA40_RE,
  validateEvidenceRef,
} from "./rules.mjs";

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
const ENTITY_DASH_RE = /&(mdash|ndash|#8212|#8211|#x2014|#x2013);/i;
const UNICODE_BULLET_RE = /^[•‣▪◦]\s/m;

function isCommentNode(node) {
  if (node.type !== "html") return false;
  const v = node.value.trim();
  return v.startsWith("<!--") && v.endsWith("-->");
}

function inlineText(node) {
  // A hard line break renders as a newline; dropping it would let a
  // Unicode bullet hide behind a break ("line one  \n• two" must still
  // match the line-anchored bullet detector).
  if (node.type === "break") return "\n";
  if (node.value !== undefined && node.type !== "html") return node.value;
  if (!node.children) return "";
  return node.children.map(inlineText).join("");
}

function isCapsuleCandidate(node) {
  // The capsule convention is a BARE fence. A language-labeled fence is
  // never a capsule candidate — otherwise a body that quotes a governed
  // commit message (Run-Id:/Evidence:/Co-Authored-By: trailers) inside a
  // ```text fence would be torn apart by the strict capsule validator
  // (remediation review finding, HIGH). Labeling the fence is also
  // exactly the escape hatch PRX-B-FENCE's own guidance recommends.
  if (node.type !== "code" || node.lang) return false;
  const lines = node.value.split("\n");
  return lines.some(l => {
    const m = l.match(CAPSULE_LINE_RE);
    return m && CAPSULE_KEYS.includes(m[1]);
  });
}

export function parseBody(raw) {
  const tree = fromMarkdown(raw, {
    extensions: [gfm()],
    mdastExtensions: [gfmFromMarkdown()],
  });
  const top = tree.children ?? [];
  const visible = top.filter(n => !isCommentNode(n));
  const comments = top.filter(isCommentNode);
  return { tree, top, visible, comments };
}

export function checkBody(raw, opts = {}) {
  const findings = [];
  if (
    typeof raw !== "string" ||
    exceedsByteLimit(raw, INPUT_SIZE_LIMIT_BYTES)
  ) {
    findings.push(
      // Stryker disable next-line StringLiteral: diagnostic message text (R8 exclusion)
      makeFinding("PRX-B-SIZE", "PR body exceeds the 1 MiB byte bound")
    );
    return findings;
  }
  let parsed;
  try {
    parsed = parseBody(raw);
  } catch {
    findings.push(
      makeFinding(
        "PRX-B-SIZE",
        // Stryker disable next-line StringLiteral: diagnostic message text (R8 exclusion)
        "PR body could not be parsed within resource bounds (pathological " +
          // Stryker disable next-line StringLiteral: diagnostic message text (R8 exclusion)
          "structure); simplify the document"
      )
    );
    return findings;
  }
  const { top, visible, comments } = parsed;

  // PRX-B-VISIBLE — the decision is MEANINGFUL VISIBLE TEXT, not node
  // count (r2 BYP-B-01): a body whose nodes render only comments,
  // zero-width/format code points, whitespace, or sanitizer-removed
  // script/style content still renders as nothing.
  if (!bodyRendersMeaningfulText(visible)) {
    findings.push(
      makeFinding(
        "PRX-B-VISIBLE",
        // Stryker disable next-line StringLiteral: diagnostic message text (R8 exclusion)
        "PR body renders no meaningful visible text once HTML comments " +
          // Stryker disable next-line StringLiteral: diagnostic message text (R8 exclusion)
          "are removed"
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
          // Stryker disable next-line StringLiteral: diagnostic message text (R8 exclusion)
          "contract-shaped content (headings or capsule keys) appears only " +
            // Stryker disable next-line StringLiteral: diagnostic message text (R8 exclusion)
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
        // Stryker disable next-line StringLiteral: diagnostic message text (R8 exclusion)
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
          // Stryker disable next-line StringLiteral: diagnostic message text (R8 exclusion)
          "visible content precedes the identifier capsule (the capsule " +
            // Stryker disable next-line StringLiteral: diagnostic message text (R8 exclusion)
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
            // Stryker disable next-line StringLiteral: diagnostic message text (R8 exclusion)
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
          // Stryker disable next-line StringLiteral: diagnostic message text (R8 exclusion)
          makeFinding("PRX-B-CAPSULE", `capsule key "${key}" is missing`)
        );
        continue;
      }
      if (values.length > 1) {
        findings.push(
          makeFinding(
            "PRX-B-CAPSULE",
            // Stryker disable next-line StringLiteral: diagnostic message text (R8 exclusion)
            `capsule key "${key}" appears ${values.length} times`
          )
        );
      }
      const value = values[0];
      if (value === "") {
        findings.push(
          // Stryker disable next-line StringLiteral: diagnostic message text (R8 exclusion)
          makeFinding("PRX-B-CAPSULE", `capsule key "${key}" has no value`)
        );
        continue;
      }
      if (PLACEHOLDERS.has(value.toUpperCase())) {
        findings.push(
          makeFinding(
            "PRX-B-CAPSULE",
            // Stryker disable next-line StringLiteral: diagnostic message text (R8 exclusion)
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
        // Stryker disable next-line StringLiteral: diagnostic message text (R8 exclusion)
        makeFinding("PRX-B-SECTION-MISSING", `section "${name}" is missing`)
      );
    } else if (matches.length > 1) {
      findings.push(
        makeFinding(
          "PRX-B-SECTION-DUP",
          // Stryker disable next-line StringLiteral: diagnostic message text (R8 exclusion)
          `section "${name}" appears ${matches.length} times ` +
            // Stryker disable next-line StringLiteral: diagnostic message text (R8 exclusion)
            "(exactly once required)",
          matches[1].line
        )
      );
    }
    if (
      matches.length >= 1 &&
      !hasVisibleSectionContent(visible, matches[0].node)
    ) {
      findings.push(
        makeFinding(
          "PRX-B-SECTION-EMPTY",
          // Stryker disable next-line StringLiteral: diagnostic message text (R8 exclusion)
          `section "${name}" has no meaningful visible content; the live ` +
            // Stryker disable next-line StringLiteral: diagnostic message text (R8 exclusion)
            'template requires "none" to be written explicitly where a ' +
            // Stryker disable next-line StringLiteral: diagnostic message text (R8 exclusion)
            "section does not apply",
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
          // Stryker disable next-line StringLiteral: diagnostic message text (R8 exclusion)
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
          // Stryker disable next-line StringLiteral: diagnostic message text (R8 exclusion)
          `extension heading "${h.text}" is outside the template and its ` +
            // Stryker disable next-line StringLiteral: diagnostic message text (R8 exclusion)
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
            // Stryker disable next-line StringLiteral: diagnostic message text (R8 exclusion)
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
          // Stryker disable next-line StringLiteral: diagnostic message text (R8 exclusion)
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
          // Stryker disable next-line StringLiteral: diagnostic message text (R8 exclusion)
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
        // Stryker disable next-line StringLiteral: diagnostic message text (R8 exclusion)
        "entity-encoded dash decodes to punctuation when rendered; write " +
          // Stryker disable next-line StringLiteral: diagnostic message text (R8 exclusion)
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
          // Stryker disable next-line StringLiteral: diagnostic message text (R8 exclusion)
          "unlabeled fenced block reads as narrative or a list; label the " +
            // Stryker disable next-line StringLiteral: diagnostic message text (R8 exclusion)
            "fence (e.g. ```text) or move prose out of it — fenced content " +
            // Stryker disable next-line StringLiteral: diagnostic message text (R8 exclusion)
            "is audited, not exempt",
          node.position?.start.line
        )
      );
    }
  }

  return findings;
}

// Narrative text for the style layer (remediation R4): ONLY designated
// narrative paragraphs, selected by a parent-aware traversal. A paragraph
// nested under any structured container — list, listItem, table, tableRow,
// tableCell, blockquote, code, html, heading, or a definition-like block —
// is structured content, not narrative, and never reaches Vale. The
// identifier capsule and evidence-record YAML are code blocks and are
// excluded the same way; template checkbox fields live inside listItems.
// Entities in real narrative arrive already decoded by the parser.
const PROSE_EXCLUDED_ANCESTORS = new Set([
  "list",
  "listItem",
  "table",
  "tableRow",
  "tableCell",
  "blockquote",
  "code",
  "html",
  "heading",
  "definition",
  "footnoteDefinition",
]);

export function extractProse(raw) {
  if (typeof raw !== "string" || exceedsByteLimit(raw, INPUT_SIZE_LIMIT_BYTES))
    return "";
  let visible;
  try {
    ({ visible } = parseBody(raw));
  } catch {
    return "";
  }
  const out = [];
  // Iterative parent-aware traversal: exclusion is inherited from ANY
  // ancestor, and attacker-controlled nesting depth never becomes JS
  // call-stack depth. Each sibling list carries its own raw-HTML container
  // tracker (r2 BYP-B-04): when a blank line splits a raw container
  // (table, list, blockquote, details, ...) into separate top-level nodes,
  // the siblings between its opening and closing fragments sit inside the
  // container's source range and are excluded from designated prose.
  const frames = [
    {
      nodes: visible,
      i: 0,
      excluded: false,
      tracker: createHtmlContainerTracker(HTML_CONTAINER_ELEMENTS),
    },
  ];
  while (frames.length > 0) {
    const frame = frames[frames.length - 1];
    if (frame.i >= frame.nodes.length) {
      frames.pop();
      continue;
    }
    const node = frame.nodes[frame.i];
    frame.i += 1;
    let excludedHere =
      frame.excluded || PROSE_EXCLUDED_ANCESTORS.has(node.type);
    if (node.type === "html") {
      frame.tracker.feed(node.value);
    } else if (frame.tracker.isInside()) {
      excludedHere = true;
    }
    if (node.type === "paragraph" && !excludedHere) {
      out.push(inlineText(node));
    }
    if (node.children) {
      frames.push({
        nodes: node.children,
        i: 0,
        excluded: excludedHere,
        tracker: createHtmlContainerTracker(HTML_CONTAINER_ELEMENTS),
      });
    }
  }
  return out.join("\n\n");
}

function capsuleValueError(key, value) {
  switch (key) {
    case "Scope":
      return SCOPE_RE.test(value)
        ? null
        : // Stryker disable next-line StringLiteral: diagnostic message text (R8 exclusion)
          `capsule Scope "${truncate(value)}" does not match TOS-<number>`;
    case "Run-Id":
      return RUN_ID_RE.test(value)
        ? null
        : // Stryker disable next-line StringLiteral: diagnostic message text (R8 exclusion)
          `capsule Run-Id "${truncate(value)}" does not match ` +
            // Stryker disable next-line StringLiteral: diagnostic message text (R8 exclusion)
            "ONE-YYYYMMDD-TOKEN";
    case "Base":
    case "Head":
      return SHA40_RE.test(value)
        ? null
        : `capsule ${key} "${truncate(value)}" is not a 40-hex commit SHA`;
    case "Ledger":
    case "Evidence":
      return validateEvidenceRef(value).valid
        ? null
        : // Stryker disable next-line StringLiteral: diagnostic message text (R8 exclusion)
          `capsule ${key} "${truncate(value)}" is not a bounded run/ or ` +
            // Stryker disable next-line StringLiteral: diagnostic message text (R8 exclusion)
            "docs/ reference (or UNKNOWN)";
    default:
      return null;
  }
}

// Body-level visibility (r2): any node whose rendered text is meaningful.
// Unlike the section predicate, a heading's own text counts here — a body
// of only headings still renders those headings.
function bodyRendersMeaningfulText(visible) {
  return visible.some(n => {
    if (n.type === "heading") {
      return isMeaningfulText(visibleInlineText(n));
    }
    return nodeHasVisibleContent(n);
  });
}

// Remediation R5: a section is non-empty only when it contains MEANINGFUL
// rendered text or accepted structured content — node presence is not
// enough. Rejected as content: whitespace, zero-width/format-only text,
// empty fences, thematic breaks, HTML comments and empty HTML,
// sanitizer-removed script/style content, alt-less images, label-less
// links, empty lists/tables, and subheadings with nothing under them
// (r2 BYP-B-01/02: the emptiness decision is isMeaningfulText over the
// decoded rendered text).
function hasVisibleSectionContent(visible, headingNode) {
  const start = visible.indexOf(headingNode);
  for (let i = start + 1; i < visible.length; i += 1) {
    const n = visible[i];
    if (n.type === "heading" && n.depth <= 2) return false;
    if (nodeHasVisibleContent(n)) return true;
  }
  return false;
}

function nodeHasVisibleContent(node) {
  switch (node.type) {
    case "heading": // a heading with no following content is not content
    case "thematicBreak":
    case "definition": // link-reference definitions never render
    case "footnoteDefinition": // renders at document bottom, not in-section
      return false;
    case "code":
      // A populated structured block (evidence YAML, capsule) counts; an
      // empty or zero-width-only fence does not.
      return isMeaningfulText(node.value);
    case "list":
    case "listItem":
    case "table":
    case "tableRow":
    case "blockquote":
      return (node.children ?? []).some(nodeHasVisibleContent);
    default:
      return isMeaningfulText(visibleInlineText(node));
  }
}

// Text a reader actually sees: image alt text counts (where non-empty),
// link labels count, HTML comments, bare tags, and sanitizer-removed
// content (script/style and the rest of the pinned remove_contents set)
// count for nothing. Children are walked SEQUENTIALLY with one stateful
// scanner because the parser splits inline HTML into sibling nodes — a
// removed element opened in one html child must also drop the text
// siblings up to its closing tag. Raw-HTML text is decoded (character
// references) so entity-encoded invisibles cannot masquerade as content;
// Markdown text arrives already decoded by the parser.
function visibleInlineText(node) {
  if (node.type === "image" || node.type === "imageReference") {
    return node.alt ?? "";
  }
  if (node.type === "html") {
    return meaningfulVisibleHtml(node.value, SANITIZER_REMOVED_ELEMENTS)
      .decoded;
  }
  if (node.value !== undefined) return node.value;
  if (!node.children) return "";
  const scanner = createSanitizedTextScanner(SANITIZER_REMOVED_ELEMENTS);
  let out = "";
  for (const child of node.children) {
    if (child.type === "html") {
      out += decodeHtmlEntities(scanner.feed(child.value));
    } else if (!scanner.isInside()) {
      out += visibleInlineText(child);
    }
  }
  return out;
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
  // Iterative on an explicit stack: attacker-controlled nesting depth must
  // not translate into JS call-stack depth (review finding: ~5k nested
  // blockquotes RangeError'd the recursive form well under the byte cap).
  const stack = [...nodes].reverse();
  while (stack.length > 0) {
    const n = stack.pop();
    visit(n);
    if (n.children) {
      for (let i = n.children.length - 1; i >= 0; i -= 1) {
        stack.push(n.children[i]);
      }
    }
  }
}

function truncate(s) {
  return s.length > 60 ? `${s.slice(0, 57)}...` : s;
}
