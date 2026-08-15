// PRX r2 canonicalization module — the SINGLE source of the shared
// predicate primitives both checkers consume (r2 contract §4: fix the
// class, then the instances). Every emptiness, duplicate, grammar, count,
// wrap, cap, and visibility predicate in commit-check.mjs and
// body-check.mjs routes through this module so a bypass fixed here is
// fixed on every surface at once.
//
// REPOSITORY-AGNOSTIC BY CONTRACT: nothing in this file names a dime-ai
// trailer key, section, template, or reference root. Governed key sets,
// removed-element sets, and reference grammars arrive as configuration;
// the dime-ai values live in the adapter (scripts/prx/rules.mjs). This is
// the forward-compatibility seam for a future packages/prx-policy/ home.
import { Buffer } from "node:buffer";

// ---------------------------------------------------------------------------
// canonicalTrailerKey
// ---------------------------------------------------------------------------

// The ASCII trailer-token grammar (git interpret-trailers key shape). A key
// outside this grammar is never canonicalized: a non-ASCII lookalike stays
// unrecognized rather than folding into a governed key.
export const TRAILER_KEY_RE = /^[A-Za-z][A-Za-z0-9-]*$/;

// Canonicalize a trailer key against a set of governed canonical forms.
// Matching is ASCII case-insensitive ONLY (the grammar above admits ASCII
// letters alone, so toLowerCase performs exactly ASCII case folding — no
// NFKC, no Unicode confusable normalization, by design). The original
// spelling is preserved for diagnostics.
export function canonicalTrailerKey(key, governedKeys) {
  if (typeof key !== "string" || !TRAILER_KEY_RE.test(key)) {
    return { original: key, canonical: null, governed: false, validKey: false };
  }
  const lower = key.toLowerCase();
  for (const canonical of governedKeys) {
    if (canonical.toLowerCase() === lower) {
      return { original: key, canonical, governed: true, validKey: true };
    }
  }
  return { original: key, canonical: key, governed: false, validKey: true };
}

// ---------------------------------------------------------------------------
// meaningfulVisibleText
// ---------------------------------------------------------------------------

// The emptiness decision: a string is meaningful only when it contains at
// least one code point that is neither Unicode White_Space nor a
// format-category (Cf) code point (U+200B/200C/200D/2060/00AD/FEFF and the
// rest of Cf). The ORIGINAL text is never rewritten — ZWJ/ZWNJ stay in any
// text that also carries visible characters; only the yes/no decision
// ignores them.
const MEANINGFUL_RE = /[^\p{White_Space}\p{Cf}]/u;

export function isMeaningfulText(value) {
  return typeof value === "string" && MEANINGFUL_RE.test(value);
}

// Minimal HTML character-reference decoder for the emptiness decision.
// Numeric references decode per WHATWG HTML §13.2.5.80 (out-of-range,
// surrogate, and NUL code points become U+FFFD). Named references decode
// from the closed map below: the five structural entities plus every WHATWG
// named reference whose expansion consists of White_Space and/or Cf code
// points — the exact set that could make rendered-empty content look
// non-empty if left encoded. Unknown named references stay literal, which
// is safe for THIS decision: an undecoded visible reference and its decoded
// visible expansion are both meaningful.
const NAMED_REFERENCES = Object.freeze({
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  Tab: "\t",
  NewLine: "\n",
  nbsp: "\u00A0",
  NonBreakingSpace: "\u00A0",
  shy: "\u00AD",
  ensp: "\u2002",
  emsp: "\u2003",
  emsp13: "\u2004",
  emsp14: "\u2005",
  numsp: "\u2007",
  puncsp: "\u2008",
  thinsp: "\u2009",
  ThinSpace: "\u2009",
  hairsp: "\u200A",
  VeryThinSpace: "\u200A",
  ZeroWidthSpace: "\u200B",
  NegativeVeryThinSpace: "\u200B",
  NegativeThinSpace: "\u200B",
  NegativeMediumSpace: "\u200B",
  NegativeThickSpace: "\u200B",
  zwnj: "\u200C",
  zwj: "\u200D",
  lrm: "\u200E",
  rlm: "\u200F",
  MediumSpace: "\u205F",
  ThickSpace: "\u205F\u200A",
  NoBreak: "\u2060",
  ApplyFunction: "\u2061",
  af: "\u2061",
  InvisibleTimes: "\u2062",
  it: "\u2062",
  InvisibleComma: "\u2063",
  ic: "\u2063",
});

const REFERENCE_RE =
  /&(?:#[Xx]([0-9A-Fa-f]{1,6})|#([0-9]{1,7})|([A-Za-z][A-Za-z0-9]{1,31}));/g;

export function decodeHtmlEntities(value) {
  return value.replace(REFERENCE_RE, (whole, hex, dec, named) => {
    if (named !== undefined) {
      return NAMED_REFERENCES[named] ?? whole;
    }
    const cp = parseInt(hex ?? dec, hex !== undefined ? 16 : 10);
    if (cp === 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) {
      return "\uFFFD";
    }
    return String.fromCodePoint(cp);
  });
}

// Stateful scanner over a SEQUENCE of raw-HTML chunks: one forward scan
// per chunk that skips comments and tags and keeps everything else —
// never replace-based stripping. Elements named in removedContentElements
// (the sanitizer remove_contents set) lose their ENTIRE content, not just
// their tags; an element or comment opened in one chunk stays open into
// the following chunks (a Markdown parser splits inline HTML into
// separate sibling nodes, so single-chunk scanning alone would resurrect
// the text between an open and its close). An unterminated tag swallows
// the rest of its chunk, matching how an HTML parser treats an
// unterminated construct.
export function createSanitizedTextScanner(removedContentElements) {
  const removed = new Set(
    [...removedContentElements].map(t => t.toLowerCase())
  );
  let insideRemoved = null; // lowercase element name while its content drops
  let insideComment = false;
  return {
    feed(value) {
      let out = "";
      let i = 0;
      while (i < value.length) {
        if (insideComment) {
          const end = value.indexOf("-->", i);
          if (end === -1) return out;
          insideComment = false;
          i = end + 3;
          continue;
        }
        if (insideRemoved) {
          const close = new RegExp(`</${insideRemoved}[\\t\\n\\f\\r ]*>`, "i");
          const m = close.exec(value.slice(i));
          if (!m) return out;
          i += m.index + m[0].length;
          insideRemoved = null;
          continue;
        }
        if (value.startsWith("<!--", i)) {
          const end = value.indexOf("-->", i + 4);
          if (end === -1) {
            insideComment = true;
            return out;
          }
          i = end + 3;
          continue;
        }
        if (value[i] === "<") {
          const tag = value.slice(i).match(/^<\/?([A-Za-z][A-Za-z0-9-]*)/);
          const gt = value.indexOf(">", i + 1);
          if (gt === -1) return out;
          if (
            tag &&
            !tag[0].startsWith("</") &&
            removed.has(tag[1].toLowerCase()) &&
            !value.slice(i, gt + 1).endsWith("/>")
          ) {
            insideRemoved = tag[1].toLowerCase();
            i = gt + 1;
            continue;
          }
          i = gt + 1;
          continue;
        }
        out += value[i];
        i += 1;
      }
      return out;
    },
    isInside() {
      return insideRemoved !== null || insideComment;
    },
  };
}

// Single-value convenience over the scanner (identical semantics for one
// chunk: unterminated removed content or comments swallow the rest).
export function visibleTextFromHtml(value, removedContentElements) {
  return createSanitizedTextScanner(removedContentElements).feed(value);
}

// The full meaningful-visible-text decision for a raw HTML value: extract
// what renders (sanitizer-removed content excluded), decode character
// references, then apply the emptiness decision. Returns the decision AND
// the decoded visible text so callers can keep the text for diagnostics.
export function meaningfulVisibleHtml(value, removedContentElements) {
  const decoded = decodeHtmlEntities(
    visibleTextFromHtml(value, removedContentElements)
  );
  return { decoded, meaningful: isMeaningfulText(decoded) };
}

// ---------------------------------------------------------------------------
// byteLength
// ---------------------------------------------------------------------------

// UTF-8 byte accounting for every size cap (r2: caps counted in UTF-16
// units undercounted multi-byte input by up to 3x).
export function byteLength(value) {
  return Buffer.byteLength(value, "utf8");
}

// Bounded-cost cap check: UTF-8 length is always >= UTF-16 length, so a
// string longer than the limit in UTF-16 units exceeds it in bytes without
// encoding cost.
export function exceedsByteLimit(value, limitBytes) {
  if (value.length > limitBytes) return true;
  return byteLength(value) > limitBytes;
}

// ---------------------------------------------------------------------------
// controlCharScan
// ---------------------------------------------------------------------------

// One explicit, context-sensitive control-character policy. Contexts:
//   "subject"   — rejects every Cc code point (C0, DEL, C1) plus the line
//                 separators U+2028/U+2029 (TAB included: a subject is a
//                 single display line).
//   "body-text" — ordinary commit-body text: as "subject" but TAB is
//                 allowed (indentation and continuation lines).
//   "code"      — fenced/indented code content: only NUL and the
//                 record-corrupting class are rejected; code may carry
//                 tabs, escapes, and other controls by documented policy.
// NUL is rejected in EVERY context: it is the record delimiter of the
// range-mode git stream and corrupts any downstream record format.
const CC_RE = /[\u0000-\u001F\u007F-\u009F]/;
const LINE_SEP_RE = /[\u2028\u2029]/;

export const CONTROL_CONTEXTS = Object.freeze(["subject", "body-text", "code"]);

export function controlCharScan(value, context) {
  if (!CONTROL_CONTEXTS.includes(context)) {
    throw new Error(`unknown control-scan context: ${context}`);
  }
  const violations = [];
  const seen = new Set();
  for (const ch of value) {
    const cp = ch.codePointAt(0);
    if (seen.has(cp)) continue;
    const isNul = cp === 0;
    const isCc = CC_RE.test(ch);
    const isLineSep = LINE_SEP_RE.test(ch);
    let reject;
    if (context === "code") {
      reject = isNul;
    } else if (context === "body-text") {
      reject = (isCc && cp !== 0x09) || isLineSep;
    } else {
      reject = isCc || isLineSep;
    }
    if (reject) {
      seen.add(cp);
      violations.push({
        codePoint: cp,
        label: `U+${cp.toString(16).toUpperCase().padStart(4, "0")}`,
      });
    }
  }
  return violations;
}

// ---------------------------------------------------------------------------
// Fence-state handling (CommonMark-consistent line classifier)
// ---------------------------------------------------------------------------

// Classifies commit-body lines with CommonMark fence semantics (spec 0.31.2
// §4.5 code fences, §4.4 indented code blocks, top-level container context):
//   - opening fence: <=3 spaces indent, >=3 backticks or tildes; a backtick
//     fence's info string may not contain a backtick
//   - closing fence: <=3 spaces indent, same character, length >= opening
//     length, nothing but spaces/tabs after
//   - inside a fence every line (including a shorter or foreign marker) is
//     content
//   - indented code: >=4 columns of indentation (tab stop 4) starting where
//     a paragraph is not open (indented lines directly after a paragraph
//     line are lazy paragraph continuations, not code)
// Returns { kinds, unclosedFence } where kinds[i] is one of
// "blank" | "fence-open" | "fence-close" | "fence-content" |
// "indented-code" | "text".
const FENCE_OPEN_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const FENCE_CLOSE_TAIL_RE = /^[ \t]*$/;

function indentColumns(line) {
  let col = 0;
  for (const ch of line) {
    if (ch === " ") col += 1;
    else if (ch === "\t") col += 4 - (col % 4);
    else break;
  }
  return col;
}

export function classifyCommitBodyLines(lines) {
  const kinds = [];
  let fence = null; // { char, length }
  let paragraphOpen = false;
  for (const line of lines) {
    if (fence) {
      const m = line.match(FENCE_OPEN_RE);
      if (
        m &&
        m[1][0] === fence.char &&
        m[1].length >= fence.length &&
        FENCE_CLOSE_TAIL_RE.test(m[2])
      ) {
        fence = null;
        kinds.push("fence-close");
      } else {
        kinds.push("fence-content");
      }
      continue;
    }
    if (line.trim() === "") {
      paragraphOpen = false;
      kinds.push("blank");
      continue;
    }
    const m = line.match(FENCE_OPEN_RE);
    if (m && !(m[1][0] === "`" && m[2].includes("`"))) {
      fence = { char: m[1][0], length: m[1].length };
      paragraphOpen = false;
      kinds.push("fence-open");
      continue;
    }
    if (indentColumns(line) >= 4 && !paragraphOpen) {
      kinds.push("indented-code");
      continue;
    }
    paragraphOpen = true;
    kinds.push("text");
  }
  return { kinds, unclosedFence: fence !== null };
}

// ---------------------------------------------------------------------------
// evidenceRef
// ---------------------------------------------------------------------------

// Structured reference validation: parse the segments, reject everything
// unsafe, and NEVER normalize an unsafe reference into an accepted one.
// config = {
//   sentinel:  exact string accepted verbatim (or null),
//   roots:     { rootSegment: { firstSegmentRe?, minSegments } },
//   maxSegments, maxBytes, segmentRe,
// }
// Returns { valid, reason } — reason names the FIRST failing check.
const REF_CONTROL_RE = /[\u0000-\u001F\u007F]/;
const REF_PERCENT_RE = /%2e|%2f|%5c/i;
const REF_SLASH_LOOKALIKE_RE =
  /[\u2044\u2215\u2216\u29F8\u29F9\uFE68\uFF0F\uFF3C]/;
const REF_SCHEME_RE = /^[A-Za-z][A-Za-z0-9+.-]*:/;

export function evidenceRef(value, config) {
  if (typeof value !== "string" || value === "") {
    return { valid: false, reason: "empty value" };
  }
  if (config.sentinel !== null && value === config.sentinel) {
    return { valid: true, reason: null };
  }
  if (exceedsByteLimit(value, config.maxBytes)) {
    return {
      valid: false,
      reason: `exceeds ${config.maxBytes} UTF-8 bytes`,
    };
  }
  if (REF_CONTROL_RE.test(value)) {
    return { valid: false, reason: "control character" };
  }
  if (value.includes("\\")) {
    return { valid: false, reason: "backslash separator" };
  }
  if (REF_SLASH_LOOKALIKE_RE.test(value)) {
    return { valid: false, reason: "Unicode slash lookalike" };
  }
  if (REF_PERCENT_RE.test(value)) {
    return { valid: false, reason: "percent-encoded dot or separator" };
  }
  if (/^[A-Za-z]:/.test(value) && !value.includes("/")) {
    return { valid: false, reason: "drive-letter prefix" };
  }
  if (REF_SCHEME_RE.test(value)) {
    return { valid: false, reason: "URI scheme or drive-letter prefix" };
  }
  if (value.startsWith("/")) {
    return { valid: false, reason: "leading slash" };
  }
  const segments = value.split("/");
  for (const seg of segments) {
    if (seg === "") return { valid: false, reason: "empty path segment" };
    if (seg === "." || seg === "..") {
      return { valid: false, reason: "dot segment" };
    }
  }
  if (segments.length > config.maxSegments) {
    return {
      valid: false,
      reason: `deeper than ${config.maxSegments} segments`,
    };
  }
  const root = config.roots[segments[0]];
  if (!root) return { valid: false, reason: "unknown root segment" };
  if (segments.length < root.minSegments) {
    return {
      valid: false,
      reason: `fewer than ${root.minSegments} segments for ${segments[0]}/`,
    };
  }
  let rest = segments.slice(1);
  if (root.firstSegmentRe) {
    if (!root.firstSegmentRe.test(segments[1])) {
      return { valid: false, reason: "invalid first segment for root" };
    }
    rest = segments.slice(2);
  }
  for (const seg of rest) {
    if (!config.segmentRe.test(seg)) {
      return { valid: false, reason: "segment outside the declared grammar" };
    }
  }
  return { valid: true, reason: null };
}

// ---------------------------------------------------------------------------
// Raw-HTML container tracking (source-range exclusion for prose extraction)
// ---------------------------------------------------------------------------

// A Markdown blank line inside a raw-HTML container ends the HTML block, so
// the container's inner text re-enters the tree as ordinary top-level
// paragraphs (the BYP-B-04 mechanism). This tracker follows the open/close
// balance of the configured container elements across the raw-HTML nodes of
// ONE sibling list; while the balance is positive, the intervening sibling
// nodes are inside the container's source range and are excluded from
// prose. Raw-text elements (script/style) are skipped whole so markup
// inside them cannot disturb the balance.
const RAW_TEXT_ELEMENTS = new Set(["script", "style"]);
const TAG_SCAN_RE = /<\/?([A-Za-z][A-Za-z0-9-]*)(?:"[^"]*"|'[^']*'|[^>"'])*>/g;

export function createHtmlContainerTracker(containerTags) {
  const containers = new Set([...containerTags].map(t => t.toLowerCase()));
  let depth = 0;
  return {
    feed(value) {
      let i = 0;
      while (i < value.length) {
        if (value.startsWith("<!--", i)) {
          const end = value.indexOf("-->", i + 4);
          if (end === -1) return;
          i = end + 3;
          continue;
        }
        TAG_SCAN_RE.lastIndex = i;
        const m = TAG_SCAN_RE.exec(value);
        if (!m || m.index !== i) {
          i += 1;
          continue;
        }
        const name = m[1].toLowerCase();
        const isClose = m[0].startsWith("</");
        const isSelfClose = m[0].endsWith("/>");
        i = m.index + m[0].length;
        if (!isClose && RAW_TEXT_ELEMENTS.has(name) && !isSelfClose) {
          const close = new RegExp(`</${name}[\\t\\n\\f\\r ]*>`, "i");
          const c = close.exec(value.slice(i));
          if (!c) return;
          i += c.index + c[0].length;
          continue;
        }
        if (containers.has(name) && !isSelfClose) {
          if (isClose) depth = Math.max(0, depth - 1);
          else depth += 1;
        }
      }
    },
    isInside() {
      return depth > 0;
    },
  };
}
