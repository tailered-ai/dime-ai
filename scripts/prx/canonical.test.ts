// Module-level tests for the r2 canonicalization primitives. Consumer-level
// coverage (the same behaviors through checkCommit/checkBody and the CLIs)
// lives in commit-check.test.ts, body-check.test.ts, cli.test.ts, and the
// r2 adversarial fixture suite.
import { describe, expect, it } from "vitest";
import {
  byteLength,
  createSanitizedTextScanner,
  canonicalTrailerKey,
  classifyCommitBodyLines,
  controlCharScan,
  createHtmlContainerTracker,
  decodeHtmlEntities,
  evidenceRef,
  exceedsByteLimit,
  isMeaningfulText,
  meaningfulVisibleHtml,
  visibleTextFromHtml,
} from "./lib/canonical.mjs";

const GOV = ["Run-Id", "Evidence", "Co-Authored-By"];

describe("canonicalTrailerKey", () => {
  it("canonicalizes ASCII case variants to the exact governed form", () => {
    expect(canonicalTrailerKey("co-authored-by", GOV)).toEqual({
      original: "co-authored-by",
      canonical: "Co-Authored-By",
      governed: true,
      validKey: true,
    });
    expect(canonicalTrailerKey("RUN-ID", GOV).canonical).toBe("Run-Id");
    expect(canonicalTrailerKey("evidence", GOV).canonical).toBe("Evidence");
  });

  it("preserves the original spelling for diagnostics", () => {
    expect(canonicalTrailerKey("rUn-Id", GOV).original).toBe("rUn-Id");
  });

  it("leaves ungoverned ASCII keys canonical to themselves", () => {
    expect(canonicalTrailerKey("Acked-by", GOV)).toEqual({
      original: "Acked-by",
      canonical: "Acked-by",
      governed: false,
      validKey: true,
    });
  });

  it("never recognizes a non-ASCII lookalike as a governed key", () => {
    // Fullwidth "Run-Id" (U+FF32 etc.) must stay unrecognized — no NFKC,
    // no confusable folding.
    const fullwidth = "\uFF32\uFF55\uFF4E\u002D\uFF29\uFF44";
    const res = canonicalTrailerKey(fullwidth, GOV);
    expect(res.validKey).toBe(false);
    expect(res.governed).toBe(false);
    expect(res.canonical).toBeNull();
  });

  it("rejects keys outside the ASCII trailer-token grammar", () => {
    for (const bad of ["", "9lead", "-lead", "has space", "k\u00E9y"]) {
      expect(canonicalTrailerKey(bad, GOV).validKey).toBe(false);
    }
  });
});

describe("isMeaningfulText", () => {
  it("treats White_Space and format (Cf) code points as empty", () => {
    // U+200B ZWSP, U+200C ZWNJ, U+200D ZWJ, U+2060 WJ, U+00AD SHY,
    // U+FEFF BOM — each alone, and all mixed with ordinary whitespace.
    for (const cp of [
      "\u200B",
      "\u200C",
      "\u200D",
      "\u2060",
      "\u00AD",
      "\uFEFF",
    ]) {
      expect(isMeaningfulText(cp)).toBe(false);
    }
    expect(
      isMeaningfulText(" \t\n\u200B\u200C\u200D\u2060\u00AD\uFEFF\u00A0")
    ).toBe(false);
  });

  it("keeps text meaningful when visible characters accompany format chars", () => {
    expect(isMeaningfulText("a\u200Db")).toBe(true);
    expect(isMeaningfulText("\u200Bx")).toBe(true);
  });

  it("counts ordinary text and punctuation as meaningful", () => {
    expect(isMeaningfulText("none")).toBe(true);
    expect(isMeaningfulText(".")).toBe(true);
  });

  it("rejects non-strings and empty strings", () => {
    expect(isMeaningfulText("")).toBe(false);
    expect(isMeaningfulText(undefined as unknown as string)).toBe(false);
  });
});

describe("decodeHtmlEntities", () => {
  it("decodes numeric references in decimal and hex", () => {
    expect(decodeHtmlEntities("&#8203;")).toBe("\u200B");
    expect(decodeHtmlEntities("&#x200C;")).toBe("\u200C");
    expect(decodeHtmlEntities("&#X200D;")).toBe("\u200D");
  });

  it("decodes the named zero-width and whitespace set", () => {
    expect(decodeHtmlEntities("&ZeroWidthSpace;&zwnj;&zwj;&NoBreak;")).toBe(
      "\u200B\u200C\u200D\u2060"
    );
    expect(decodeHtmlEntities("&shy;&nbsp;&thinsp;")).toBe(
      "\u00AD\u00A0\u2009"
    );
  });

  it("replaces out-of-range, surrogate, and NUL references with U+FFFD", () => {
    expect(decodeHtmlEntities("&#0;")).toBe("\uFFFD");
    expect(decodeHtmlEntities("&#xD800;")).toBe("\uFFFD");
    expect(decodeHtmlEntities("&#1114112;")).toBe("\uFFFD");
  });

  it("leaves unknown named references literal (safe for the decision)", () => {
    expect(decodeHtmlEntities("&notareference;")).toBe("&notareference;");
  });
});

describe("visibleTextFromHtml / meaningfulVisibleHtml", () => {
  const REMOVED = ["script", "style"];

  it("removes script and style content entirely, case-insensitive", () => {
    expect(visibleTextFromHtml("<script>var x=1;</script>", REMOVED)).toBe("");
    expect(visibleTextFromHtml("<STYLE>.a{}</STYLE>", REMOVED)).toBe("");
    expect(visibleTextFromHtml("<script type=x>a</script>b", REMOVED)).toBe(
      "b"
    );
  });

  it("an unterminated removed element swallows the rest of the value", () => {
    expect(visibleTextFromHtml("<script>never closed", REMOVED)).toBe("");
  });

  it("keeps text around tags and skips comments", () => {
    expect(visibleTextFromHtml("a<!-- hidden -->b<b>c</b>", REMOVED)).toBe(
      "abc"
    );
  });

  it("split-tag smuggling does not resurrect content", () => {
    // The forward scan never re-concatenates around removed spans; the
    // replace-based-stripping class (incomplete multi-character
    // sanitization) does not apply.
    expect(
      visibleTextFromHtml("<scr<!---->ipt>alert(1)</script>", REMOVED)
    ).toBe("ipt>alert(1)");
  });

  it("comment state persists across chunks of a sanitized-text scan", () => {
    // The parser splits inline HTML into sibling nodes; a comment opened
    // in one chunk must keep dropping text into the next chunk.
    const scanner = createSanitizedTextScanner(REMOVED);
    expect(scanner.feed("a<!-- open")).toBe("a");
    expect(scanner.isInside()).toBe(true);
    expect(scanner.feed("still hidden --> visible")).toBe(" visible");
    expect(scanner.isInside()).toBe(false);
  });

  it("removed-element state persists across chunks", () => {
    const scanner = createSanitizedTextScanner(REMOVED);
    expect(scanner.feed("<script>")).toBe("");
    expect(scanner.isInside()).toBe(true);
    expect(scanner.feed("var hidden = 1;")).toBe("");
    expect(scanner.feed("</script>after")).toBe("after");
    expect(scanner.isInside()).toBe(false);
  });

  it("a self-closing removed element does not swallow following text", () => {
    expect(visibleTextFromHtml("<script/>kept", REMOVED)).toBe("kept");
  });

  it("entity-encoded invisibles inside HTML are empty after decoding", () => {
    expect(
      meaningfulVisibleHtml("<span>&#8203;&nbsp;&zwj;</span>", REMOVED)
        .meaningful
    ).toBe(false);
    expect(
      meaningfulVisibleHtml("<span>&#8203;kept</span>", REMOVED).meaningful
    ).toBe(true);
  });
});

describe("byteLength / exceedsByteLimit", () => {
  it("counts UTF-8 bytes, not UTF-16 units", () => {
    expect(byteLength("abc")).toBe(3);
    expect(byteLength("\u00E9")).toBe(2);
    expect(byteLength("\u20AC")).toBe(3);
    expect(byteLength("\u{1F600}")).toBe(4);
  });

  it("is exact at the limit and at limit+1", () => {
    expect(exceedsByteLimit("a".repeat(10), 10)).toBe(false);
    expect(exceedsByteLimit("a".repeat(11), 10)).toBe(true);
    // 5 two-byte chars = 10 bytes at the limit; 6 = 12 bytes over it.
    expect(exceedsByteLimit("\u00E9".repeat(5), 10)).toBe(false);
    expect(exceedsByteLimit("\u00E9".repeat(6), 10)).toBe(true);
  });
});

describe("controlCharScan", () => {
  it("rejects NUL in every context", () => {
    for (const context of ["subject", "body-text", "code"] as const) {
      const v = controlCharScan("a\u0000b", context);
      expect(v.map(x => x.label)).toEqual(["U+0000"]);
    }
  });

  it("subject rejects TAB, C0, DEL, C1, and U+2028/U+2029", () => {
    expect(controlCharScan("a\tb", "subject").length).toBe(1);
    expect(controlCharScan("a\u0007b", "subject").length).toBe(1);
    expect(controlCharScan("a\u007Fb", "subject").length).toBe(1);
    expect(controlCharScan("a\u0085b", "subject").length).toBe(1);
    expect(controlCharScan("a\u2028b", "subject").length).toBe(1);
    expect(controlCharScan("a\u2029b", "subject").length).toBe(1);
    expect(controlCharScan("plain a-z", "subject")).toEqual([]);
  });

  it("body text allows TAB but rejects the rest of the subject set", () => {
    expect(controlCharScan("a\tb", "body-text")).toEqual([]);
    expect(controlCharScan("a\u001Bb", "body-text").length).toBe(1);
    expect(controlCharScan("a\u2028b", "body-text").length).toBe(1);
  });

  it("code content rejects only NUL", () => {
    expect(controlCharScan("tab\there \u001B[0m esc", "code")).toEqual([]);
    expect(controlCharScan("a\u2028b", "code")).toEqual([]);
    expect(controlCharScan("a\u0000b", "code").length).toBe(1);
  });

  it("reports each offending code point once with a U+ label", () => {
    const v = controlCharScan("\u0007x\u0007y\u001B", "body-text");
    expect(v.map(x => x.label)).toEqual(["U+0007", "U+001B"]);
  });

  it("throws on an unknown context instead of guessing a policy", () => {
    expect(() => controlCharScan("x", "prose" as never)).toThrow(
      /unknown control-scan context/
    );
  });
});

describe("classifyCommitBodyLines (CommonMark-consistent)", () => {
  it("classifies fences, content, indented code, lazy continuation, text", () => {
    const { kinds, unclosedFence } = classifyCommitBodyLines([
      "intro para",
      "",
      "```js",
      "code here",
      "~~~",
      "```",
      "",
      "    indented after blank",
      "para line",
      "    lazy continuation",
    ]);
    expect(kinds).toEqual([
      "text",
      "blank",
      "fence-open",
      "fence-content",
      "fence-content",
      "fence-close",
      "blank",
      "indented-code",
      "text",
      "text",
    ]);
    expect(unclosedFence).toBe(false);
  });

  it("requires a closing fence at least as long as the opener", () => {
    const shorter = classifyCommitBodyLines(["`````", "content", "```"]);
    expect(shorter.unclosedFence).toBe(true);
    const longer = classifyCommitBodyLines(["```", "content", "``````"]);
    expect(longer.unclosedFence).toBe(false);
    expect(longer.kinds[2]).toBe("fence-close");
  });

  it("a closing marker with trailing text is content, not a close", () => {
    const r = classifyCommitBodyLines(["```", "content", "```yy"]);
    expect(r.kinds[2]).toBe("fence-content");
    expect(r.unclosedFence).toBe(true);
  });

  it("allows up to three leading spaces on fence markers", () => {
    const r = classifyCommitBodyLines(["  ```", "x", "   ```"]);
    expect(r.kinds).toEqual(["fence-open", "fence-content", "fence-close"]);
  });

  it("a four-space-indented marker is code, never a fence", () => {
    const r = classifyCommitBodyLines(["", "    ```", "    x"]);
    expect(r.kinds).toEqual(["blank", "indented-code", "indented-code"]);
    expect(r.unclosedFence).toBe(false);
  });

  it("a backtick info string containing a backtick is not an opener", () => {
    const r = classifyCommitBodyLines(["``` `bad` info"]);
    expect(r.kinds).toEqual(["text"]);
    // The tilde form permits backticks in its info string.
    const t = classifyCommitBodyLines(["~~~ `ok` info", "x"]);
    expect(t.kinds).toEqual(["fence-open", "fence-content"]);
  });

  it("a tilde marker inside a backtick fence stays content", () => {
    const r = classifyCommitBodyLines(["```", "~~~", "```"]);
    expect(r.kinds).toEqual(["fence-open", "fence-content", "fence-close"]);
  });

  it("tabs expand at four-column stops for the indent decision", () => {
    const r = classifyCommitBodyLines(["", "\tindented by tab"]);
    expect(r.kinds).toEqual(["blank", "indented-code"]);
  });
});

describe("evidenceRef", () => {
  const CFG = {
    sentinel: "UNKNOWN",
    maxSegments: 7,
    maxBytes: 120,
    segmentRe: /^[A-Za-z0-9][A-Za-z0-9._-]*$/,
    roots: {
      run: { firstSegmentRe: /^ONE-[0-9]{8}-[A-Z0-9]+$/, minSegments: 3 },
      docs: { minSegments: 2 },
    },
  };
  const reject = (value: string, reason: RegExp) => {
    const r = evidenceRef(value, CFG);
    expect(r.valid).toBe(false);
    expect(r.reason).toMatch(reason);
  };

  it("accepts the sentinel and well-formed run/ and docs/ references", () => {
    expect(evidenceRef("UNKNOWN", CFG).valid).toBe(true);
    expect(evidenceRef("run/ONE-20260814-R2/report.json", CFG).valid).toBe(
      true
    );
    expect(
      evidenceRef("docs/verification/prx/threat-model.md", CFG).valid
    ).toBe(true);
  });

  it("rejects traversal dot segments without normalizing", () => {
    reject("run/ONE-20260814-R2/../../../etc/passwd", /dot segment/);
    reject("docs/./x", /dot segment/);
  });

  it("rejects empty segments, leading slash, and backslash", () => {
    reject("docs//x", /empty path segment/);
    reject("docs/x/", /empty path segment/);
    reject("/etc/passwd", /leading slash/);
    reject("docs\\x", /backslash/);
  });

  it("rejects URI schemes and drive-letter prefixes", () => {
    reject("file:///etc/passwd", /URI scheme/);
    reject("https://example.com/x", /URI scheme/);
    // Exact reason strings: the slash-less form takes the drive-letter
    // branch, the slashed form falls through to the scheme branch. Both
    // go through `reject`, so the VERDICT is asserted alongside the
    // reason. A reason-only oracle here (the shape this test carried
    // between mutation run 1 and run 2) let the `valid: false -> true`
    // mutant on the drive-letter return live: the reason string is
    // unchanged by it, so only the verdict assertion can kill it. Same
    // weak-oracle class as MUT-01 (r3 Gap A).
    reject("C:evil", /^drive-letter prefix$/);
    reject("c:/evil", /^URI scheme or drive-letter prefix$/);
  });

  it("rejects percent-encoded dots and separators", () => {
    reject("docs/%2e%2e/x", /percent-encoded/);
    reject("docs/a%2Fb", /percent-encoded/);
    reject("docs/a%5cb", /percent-encoded/);
  });

  it("rejects NUL, control characters, and Unicode slash lookalikes", () => {
    reject("docs/a\u0000b", /control character/);
    reject("docs/a\u001Fb", /control character/);
    reject("docs/a\u2044b", /lookalike/);
    reject("docs/a\u2215b", /lookalike/);
    reject("docs/a\uFF0Fb", /lookalike/);
  });

  it("is exact at the segment-depth limit and limit+1", () => {
    expect(evidenceRef("docs/a/b/c/d/e/f", CFG).valid).toBe(true);
    reject("docs/a/b/c/d/e/f/g", /deeper than 7 segments/);
  });

  it("is exact at the byte limit and limit+1, counted in UTF-8", () => {
    expect(evidenceRef(`docs/${"a".repeat(115)}`, CFG).valid).toBe(true);
    reject(`docs/${"a".repeat(116)}`, /120 UTF-8 bytes/);
    // 58 two-byte chars: 121 bytes but only 63 UTF-16 units — the UTF-16
    // cap this replaced would have admitted it into the grammar check.
    reject(`docs/${"\u00E9".repeat(58)}`, /120 UTF-8 bytes/);
  });

  it("enforces per-root minimum depth and the first-segment grammar", () => {
    reject("run/ONE-20260814-R2", /fewer than 3 segments/);
    reject("docs", /fewer than 2 segments/);
    reject("run/one-bad-id/x", /invalid first segment/);
    reject("evidence/x", /unknown root segment/);
  });

  it("rejects segments outside the declared ASCII-safe grammar", () => {
    reject("docs/.hidden", /outside the declared grammar/);
    reject("docs/-flag", /outside the declared grammar/);
    reject("docs/sp ace", /outside the declared grammar/);
    reject("docs/caf\u00E9", /outside the declared grammar/);
  });

  it("rejects empty and non-string values", () => {
    reject("", /empty value/);
    expect(evidenceRef(null as unknown as string, CFG).valid).toBe(false);
  });
});

describe("createHtmlContainerTracker", () => {
  const TAGS = [
    "table",
    "thead",
    "tbody",
    "tfoot",
    "tr",
    "th",
    "td",
    "ul",
    "ol",
    "li",
    "blockquote",
    "pre",
    "code",
    "details",
    "summary",
  ];

  it("tracks open container depth across separate raw-HTML chunks", () => {
    const t = createHtmlContainerTracker(TAGS);
    expect(t.isInside()).toBe(false);
    t.feed("<table><tr><td>");
    expect(t.isInside()).toBe(true);
    t.feed("</td></tr>");
    expect(t.isInside()).toBe(true);
    t.feed("</table>");
    expect(t.isInside()).toBe(false);
  });

  it("ignores tags inside comments and raw-text elements", () => {
    const t = createHtmlContainerTracker(TAGS);
    t.feed("<!-- <table> -->");
    expect(t.isInside()).toBe(false);
    t.feed('<script>var a = "<ul>";</script>');
    expect(t.isInside()).toBe(false);
  });

  it("treats self-closing containers as balanced", () => {
    const t = createHtmlContainerTracker(TAGS);
    t.feed("<td/>");
    expect(t.isInside()).toBe(false);
  });

  it("never goes below zero on stray close tags", () => {
    const t = createHtmlContainerTracker(TAGS);
    t.feed("</table></td>");
    expect(t.isInside()).toBe(false);
    t.feed("<ul>");
    expect(t.isInside()).toBe(true);
  });

  it("handles attribute values containing angle brackets", () => {
    const t = createHtmlContainerTracker(TAGS);
    t.feed('<td title="a > b">');
    expect(t.isInside()).toBe(true);
  });
});

describe("r3 blocking-path survivors (mutation run 2 residual)", () => {
  const REMOVED = ["script", "style"];

  it("the five structural entities decode to their visible characters", () => {
    // Blanking any of these in NAMED_REFERENCES makes the decoded
    // expansion empty, so raw HTML whose rendered text is exactly one
    // escaped character is scored as rendering nothing and PRX-B-VISIBLE
    // / PRX-B-SECTION-EMPTY (both APPROVED_BLOCKING) start firing on a
    // body that does render.
    expect(decodeHtmlEntities("a&amp;b")).toBe("a&b");
    expect(decodeHtmlEntities("&lt;")).toBe("<");
    expect(decodeHtmlEntities("&gt;")).toBe(">");
    expect(decodeHtmlEntities("&quot;")).toBe('"');
    expect(decodeHtmlEntities("&apos;")).toBe("'");
    for (const e of ["amp", "lt", "gt", "quot", "apos"]) {
      expect(isMeaningfulText(decodeHtmlEntities(`&${e};`))).toBe(true);
    }
  });

  it("only the surrogate block decodes to the replacement character", () => {
    // The `cp <= 0xdfff` conjunct bounds the U+FFFD arm. Widened, every
    // code point above the surrogate block becomes U+FFFD — including
    // U+FEFF, which is a format character that must stay INVISIBLE to
    // the emptiness decision. A zero-width body would then look
    // meaningful and PRX-B-VISIBLE would stop firing.
    expect(decodeHtmlEntities("&#xFEFF;")).toBe("\uFEFF");
    expect(isMeaningfulText(decodeHtmlEntities("&#xFEFF;"))).toBe(false);
    expect(decodeHtmlEntities("&#xD800;")).toBe("\uFFFD");
    expect(decodeHtmlEntities("&#x1F600;")).toBe("\u{1F600}");
  });

  it("an unterminated comment keeps swallowing across chunks", () => {
    // The parser splits inline HTML into sibling nodes, so comment state
    // must survive between feeds. If the not-found branch stops
    // returning early, hidden comment text is resurrected as visible.
    const s = createSanitizedTextScanner(REMOVED);
    expect(s.feed("a<!-- open")).toBe("a");
    expect(s.feed("still hidden")).toBe("");
    expect(s.isInside()).toBe(true);
  });

  it("a removed element closes case-insensitively", () => {
    // insideRemoved is stored lowercase; without the "i" flag on the
    // close regex a mixed-case closing tag never ends the span and the
    // scanner swallows the rest of the chunk.
    expect(visibleTextFromHtml("<script>x</SCRIPT>kept", REMOVED)).toBe("kept");
  });

  it("the tag probe reads from the scan position, anchored", () => {
    // slice(i) keeps the probe aligned with the cursor: without it every
    // tag after the first is identified by the chunk's FIRST tag name,
    // and script content leaks out as visible text. The ^ anchor keeps
    // the offset and the identity in sync: without it a bare "<" makes
    // the probe adopt a tag from later in the chunk and open a removed
    // span at the wrong offset, dropping text that really renders.
    expect(visibleTextFromHtml("x<script>a</script>", REMOVED)).toBe("x");
    expect(visibleTextFromHtml("<3 <script>evil</script>", REMOVED)).toBe(
      "evil"
    );
  });

  it("a stray angle bracket and a stray close tag are handled", () => {
    // The `tag && !startsWith("</")` guard carries two obligations: do
    // not dereference a failed probe, and never let a CLOSING tag open a
    // removed span. Losing either drops visible text or throws out of
    // checkBody.
    expect(visibleTextFromHtml("a < b>", REMOVED)).toBe("a ");
    expect(visibleTextFromHtml("</script>text", REMOVED)).toBe("text");
  });
});
