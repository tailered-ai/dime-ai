import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { checkBody, extractProse, REQUIRED_SECTIONS } from "./body-check.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) =>
  readFileSync(join(HERE, "fixtures/body", name), "utf8");
const rules = (findings: { rule: string }[]) =>
  findings.map(f => f.rule).sort();

const healthy = fixture("healthy.md");

describe("healthy bodies", () => {
  it("full live-template body with capsule is clean", () => {
    expect(checkBody(healthy)).toEqual([]);
  });

  it("capsule is optional: live-template body without one is clean", () => {
    expect(checkBody(fixture("healthy-no-capsule.md"))).toEqual([]);
  });

  it("lists, checkboxes, and tables are allowed structure", () => {
    const withTable = healthy.replace(
      "## Post-deployment validation\n\nnone",
      "## Post-deployment validation\n\n| check | result |\n| --- | --- |\n| smoke | pass |"
    );
    expect(checkBody(withTable)).toEqual([]);
  });
});

describe("live-template section schema", () => {
  it("validates the 14 sections of .github/pull_request_template.md", () => {
    expect(REQUIRED_SECTIONS.length).toBe(14);
  });

  it("flags a missing section with the MISSING subcode", () => {
    const body = healthy.replace(/## Bundle impact\n\nnone\n/, "");
    const f = checkBody(body);
    expect(f.some(x => x.rule === "PRX-B-SECTION-MISSING")).toBe(true);
    expect(f.some(x => x.rule === "PRX-B-SECTION-DUP")).toBe(false);
  });

  it("flags a duplicate section with the DUP subcode", () => {
    const f = checkBody(`${healthy}\n## Tests\n\nAgain.\n`);
    expect(
      f.filter(x => x.rule === "PRX-B-SECTION-DUP" && x.level === "error")
        .length
    ).toBe(1);
    expect(f.some(x => x.rule === "PRX-B-SECTION-MISSING")).toBe(false);
  });

  it("flags an empty section with the EMPTY subcode", () => {
    const body = healthy.replace(
      "## Bundle impact\n\nnone",
      "## Bundle impact"
    );
    const f = checkBody(body);
    expect(f.some(x => x.rule === "PRX-B-SECTION-EMPTY")).toBe(true);
  });

  it("out-of-order sections are advisory, not errors", () => {
    const body = healthy
      .replace("## Notion context\n\nnone\n\n", "")
      .concat("\n## Notion context\n\nnone\n");
    const f = checkBody(body);
    const order = f.filter(x => x.rule === "PRX-B-ORDER");
    expect(order.length).toBe(1);
    expect(order[0].level).toBe("advisory");
  });

  it("the engineering-federation evidence heading is an allowed extension", () => {
    const f = checkBody(
      `${healthy}\n## Evidence record (engineering-federation §21.3)\n\nrecord: filled\n`
    );
    expect(f.filter(x => x.rule === "PRX-B-EXT")).toEqual([]);
  });
});

describe("capsule schema (strict when present)", () => {
  it("rejects two capsules", () => {
    const capsule = healthy.slice(0, healthy.indexOf("```\n", 4) + 4);
    const f = checkBody(capsule + healthy);
    expect(f.some(x => x.rule === "PRX-B-CAPSULE")).toBe(true);
  });

  it("rejects an unknown key as a non-key line", () => {
    const body = healthy.replace(
      "Evidence: UNKNOWN",
      "Evidence: UNKNOWN\nSurprise: extra"
    );
    const f = checkBody(body);
    expect(f.some(x => x.rule === "PRX-B-CAPSULE")).toBe(true);
  });

  it("enforces the size bound", () => {
    expect(rules(checkBody("x".repeat(1024 * 1024 + 1)))).toEqual([
      "PRX-B-SIZE",
    ]);
  });
});

describe("prose extraction for the style layer (R4: parent-aware)", () => {
  it("decodes entities and skips code/list content", () => {
    const prose = extractProse(
      "## A\n\nNarrative &mdash; here.\n\n```\ncode line\n```\n\n- item\n"
    );
    expect(prose).toContain("Narrative — here.");
    expect(prose).not.toContain("code line");
    // The list item's text must be absent, not merely the code text.
    expect(prose).not.toContain("item");
  });

  it("includes ordinary narrative paragraphs and preserves decoded entities", () => {
    const prose = extractProse(
      "## Purpose and scope\n\nFirst narrative sentence.\n\nSecond &amp; third."
    );
    expect(prose).toContain("First narrative sentence.");
    expect(prose).toContain("Second & third.");
  });

  it("excludes bullet text and NESTED bullet text", () => {
    const prose = extractProse(
      "Narrative stays.\n\n- top bullet text\n  - nested bullet text\n\n" +
        "- outer item\n\n  paragraph nested inside a loose list item\n"
    );
    expect(prose).toContain("Narrative stays.");
    expect(prose).not.toContain("top bullet text");
    expect(prose).not.toContain("nested bullet text");
    expect(prose).not.toContain("paragraph nested inside a loose list item");
  });

  it("excludes checkbox (task-list) text", () => {
    const prose = extractProse(
      "Narrative stays.\n\n- [ ] CI green checkbox field\n- [x] Owner authorized\n"
    );
    expect(prose).not.toContain("CI green checkbox field");
    expect(prose).not.toContain("Owner authorized");
  });

  it("excludes table cells", () => {
    const prose = extractProse(
      "Narrative stays.\n\n| header cell | other |\n| --- | --- |\n| body cell text | more |\n"
    );
    expect(prose).toContain("Narrative stays.");
    expect(prose).not.toContain("header cell");
    expect(prose).not.toContain("body cell text");
  });

  it("excludes blockquoted text", () => {
    const prose = extractProse(
      "Narrative stays.\n\n> quoted sentence that is not narrative.\n"
    );
    expect(prose).not.toContain("quoted sentence");
  });

  it("excludes raw HTML", () => {
    const prose = extractProse(
      "Narrative stays.\n\n<div>html block sentence.</div>\n"
    );
    expect(prose).not.toContain("html block sentence");
  });

  it("excludes capsule values and evidence-record YAML blocks", () => {
    const prose = extractProse(
      "```\nScope: TOS-123\nRun-Id: ONE-20260812-PRX\n```\n\nNarrative stays.\n\n" +
        "```yaml\noutcome: shipped\nverification: full\n```\n"
    );
    expect(prose).toContain("Narrative stays.");
    expect(prose).not.toContain("TOS-123");
    expect(prose).not.toContain("outcome: shipped");
  });
});

describe("meaningful visible section content (R5)", () => {
  const withSection = (content: string) =>
    healthy.replace(
      "## Bundle impact\n\nnone",
      `## Bundle impact\n\n${content}`
    );
  const emptyFor = (content: string) =>
    checkBody(withSection(content)).filter(
      x => x.rule === "PRX-B-SECTION-EMPTY"
    );

  const rejected: Array<[string, string]> = [
    ["whitespace-only HTML entity of nothing", "<!-- filled later -->"],
    ["an empty fenced block", "```\n```"],
    ["a thematic break", "***"],
    ["empty HTML", "<div></div>"],
    ["an image with empty alternative text", "![](evidence.png)"],
    ["a link with no visible label", "[](https://example.com)"],
    ["an empty list item", "-"],
    ["an empty table", "|  |  |\n| --- | --- |\n|  |  |"],
    ["a subheading with no following content", "### details"],
  ];
  for (const [label, content] of rejected) {
    it(`rejects ${label}`, () => {
      expect(emptyFor(content).length).toBe(1);
    });
  }

  const accepted: Array<[string, string]> = [
    ["visible prose", "Real content here."],
    ["the exact permitted none convention", "none"],
    ["a non-empty list", "- one real item"],
    ["a non-empty checklist", "- [ ] pending item"],
    ["a non-empty table", "| a | b |\n| --- | --- |\n| c | d |"],
    ["a visible link label", "[evidence run](https://example.com/run)"],
    ["a visible image alternative text", "![feed screenshot](feed.png)"],
    ["a populated structured evidence block", "```yaml\noutcome: shipped\n```"],
  ];
  for (const [label, content] of accepted) {
    it(`accepts ${label}`, () => {
      expect(emptyFor(content)).toEqual([]);
    });
  }
});

describe("mutation-hardening (targeted survivor kills)", () => {
  it("accepts a body at exactly the 1 MiB bound", () => {
    const padded = healthy + "x".repeat(1024 * 1024 - healthy.length);
    const f = checkBody(padded);
    expect(f.some(x => x.rule === "PRX-B-SIZE")).toBe(false);
  });

  it("an HTML block with visible text after the comment is NOT a comment", () => {
    const f = checkBody("<!-- note --> visible tail\n");
    expect(f.some(x => x.rule === "PRX-B-VISIBLE")).toBe(false);
  });

  it("depth-3 subheadings are not sections and not extensions", () => {
    const body = healthy.replace(
      "## Post-deployment validation\n\nnone",
      "## Post-deployment validation\n\nnone\n\n### sub-detail\n\nMore."
    );
    expect(checkBody(body)).toEqual([]);
  });

  it("moving the FIRST template section to the end still trips order", () => {
    const body = healthy
      .replace(
        "## Purpose and scope\n\nAdd the PRX audit lane fixture body.\n\n",
        ""
      )
      .concat("\n## Purpose and scope\n\nMoved to the end.\n");
    const f = checkBody(body);
    expect(f.some(x => x.rule === "PRX-B-ORDER")).toBe(true);
  });

  it("nested plain lists are allowed structure, not disguised structure", () => {
    const body = healthy.replace(
      "- Added/changed tests: none",
      "- Added/changed tests:\n  - none listed"
    );
    expect(checkBody(body)).toEqual([]);
  });

  it("HTML inside a labeled code fence is code, not a rendered list", () => {
    const body = healthy.replace(
      "## Post-deployment validation\n\nnone",
      "## Post-deployment validation\n\n```html\n<ul><li>sample</li></ul>\n```"
    );
    const f = checkBody(body);
    expect(f.some(x => x.rule === "PRX-B-STRUCTURE")).toBe(false);
  });

  it("extractProse returns empty for oversized input and text at the bound", () => {
    expect(extractProse("y".repeat(1024 * 1024 + 1))).toBe("");
    const atBound = "words here" + " pad".repeat(10);
    expect(extractProse(atBound)).toContain("words here");
  });
});

describe("entity-dash alternatives (gstack completeness pass)", () => {
  for (const entity of [
    "&ndash;",
    "&#8212;",
    "&#8211;",
    "&#x2014;",
    "&#x2013;",
  ]) {
    it(`detects ${entity}`, () => {
      const f = checkBody(`${healthy}\nAn encoded ${entity} dash.\n`);
      expect(f.some(x => x.rule === "PRX-B-STRUCTURE")).toBe(true);
    });
  }
});

describe("review-pass regressions", () => {
  it("deep blockquote nesting yields a finding, never a crash", () => {
    const f = checkBody(">".repeat(20000));
    expect(Array.isArray(f)).toBe(true);
    expect(f.length).toBeGreaterThan(0);
  });

  it("extractProse survives deep nesting", () => {
    expect(typeof extractProse(">".repeat(20000))).toBe("string");
  });

  it("capsule Evidence over the shared length cap fails even if shaped", () => {
    const long = `docs/${"a/".repeat(2)}${"b".repeat(120)}`;
    const body = healthy.replace("Evidence: UNKNOWN", `Evidence: ${long}`);
    const f = checkBody(body);
    expect(f.some(x => x.rule === "PRX-B-CAPSULE")).toBe(true);
  });

  it("REQUIRED_SECTIONS matches the live PR template exactly (drift guard)", () => {
    const template = readFileSync(
      join(HERE, "../../.github/pull_request_template.md"),
      "utf8"
    );
    const headings = [...template.matchAll(/^## (.+)$/gm)].map(m => m[1]);
    expect(headings).toEqual([...REQUIRED_SECTIONS]);
  });
});

describe("mutation-hardening round 3 (R8 survivors)", () => {
  it("an HTML comment with trailing whitespace is still a comment", () => {
    const f = checkBody("<!-- note --> ");
    expect(f.some(x => x.rule === "PRX-B-VISIBLE")).toBe(true);
  });

  it("an HTML block ending in a comment but starting with markup is NOT a comment", () => {
    const f = checkBody("<div>hello</div><!-- t -->");
    expect(f.some(x => x.rule === "PRX-B-VISIBLE")).toBe(false);
  });

  it("an inline HTML comment inside a section heading does not change its text", () => {
    const body = healthy.replace("## Tests", "## Tests<!-- note -->");
    expect(checkBody(body)).toEqual([]);
  });

  it("extractProse: exact text — images add nothing, inline joins are seamless, paragraphs join with blank lines", () => {
    expect(extractProse("![alt text](x.png)")).toBe("");
    expect(extractProse("Hello **world** now.")).toBe("Hello world now.");
    expect(extractProse("One a.\n\nTwo b.")).toBe("One a.\n\nTwo b.");
  });

  it("footnote definitions are not section content and footnote references carry no visible text", () => {
    const body = healthy.replace(
      "## Bundle impact\n\nnone",
      "## Bundle impact\n\n[^1]\n\n[^1]: note text here."
    );
    const empt = checkBody(body).filter(x => x.rule === "PRX-B-SECTION-EMPTY");
    expect(empt.length).toBe(1);
  });

  it("a benign HTML comment (no heading, no line-anchored capsule key) is not flagged", () => {
    expect(
      checkBody(healthy + "\n<!-- tail## note microScope: lens -->\n")
    ).toEqual([]);
  });

  it("a heading-only comment (no capsule keys) trips PRX-B-COMMENT", () => {
    const f = checkBody(healthy + "\n<!--\n## Hidden heading\n-->\n");
    expect(f.some(x => x.rule === "PRX-B-COMMENT")).toBe(true);
  });

  it("blank and whitespace-only capsule lines are ignored", () => {
    const body = healthy.replace("Scope: TOS-123\n", "Scope: TOS-123\n\n \n");
    expect(checkBody(body)).toEqual([]);
  });

  it("capsule values are compared trimmed (trailing whitespace tolerated)", () => {
    const body = healthy.replace("Scope: TOS-123\n", "Scope: TOS-123 \n");
    expect(checkBody(body)).toEqual([]);
  });

  it("a missing capsule key reports 'is missing', not a grammar error", () => {
    const body = healthy.replace("Ledger: UNKNOWN\n", "");
    const f = checkBody(body).filter(x => x.rule === "PRX-B-CAPSULE");
    expect(f.length).toBe(1);
    expect(f[0].message).toContain('capsule key "Ledger" is missing');
  });

  it("an empty capsule value reports 'has no value', not a grammar error", () => {
    const body = healthy.replace("Ledger: UNKNOWN", "Ledger:");
    const f = checkBody(body).filter(x => x.rule === "PRX-B-CAPSULE");
    expect(f.length).toBe(1);
    expect(f[0].message).toContain("has no value");
  });

  it("a placeholder capsule value reports the placeholder, not a grammar error", () => {
    const body = healthy.replace("Scope: TOS-123", "Scope: TBD");
    const f = checkBody(body).filter(x => x.rule === "PRX-B-CAPSULE");
    expect(f.length).toBe(1);
    expect(f[0].message).toContain('carries the placeholder "TBD"');
  });

  it("heading text is trimmed after entity decoding", () => {
    expect(checkBody(healthy.replace("## Tests", "## Tests&#32;"))).toEqual([]);
  });

  it("an adjacent duplicate of the final section is DUP but never ORDER", () => {
    const f = checkBody(`${healthy}\n## Post-deployment validation\n\nagain\n`);
    expect(rules(f)).toEqual(["PRX-B-SECTION-DUP"]);
  });

  it("a labeled fence containing narrative prose is not flagged", () => {
    const body = healthy.replace(
      "## Bundle impact\n\nnone",
      "## Bundle impact\n\n```text\nThis prose sentence has many words in it.\n```"
    );
    expect(checkBody(body)).toEqual([]);
  });

  it("capsule grammar is enforced per key: Scope, Run-Id, Ledger, and the shared length bound", () => {
    const trips = (from: string, to: string) =>
      checkBody(healthy.replace(from, to)).some(
        x => x.rule === "PRX-B-CAPSULE"
      );
    expect(trips("Scope: TOS-123", "Scope: not-a-scope")).toBe(true);
    expect(trips("Run-Id: ONE-20260812-PRX", "Run-Id: BAD-ID")).toBe(true);
    expect(trips("Ledger: UNKNOWN", "Ledger: nope!")).toBe(true);
    const atBound = healthy.replace(
      "Evidence: UNKNOWN",
      `Evidence: docs/${"a".repeat(115)}`
    );
    expect(checkBody(atBound)).toEqual([]);
  });

  it("content after a depth-3 subheading still fills the section", () => {
    const body = healthy.replace(
      "## Bundle impact\n\nnone",
      "## Bundle impact\n\n### details\n\nReal text under sub."
    );
    expect(checkBody(body)).toEqual([]);
  });

  it("a whitespace-only fenced block is not section content", () => {
    const body = healthy.replace(
      "## Bundle impact\n\nnone",
      "## Bundle impact\n\n```\n  \n```"
    );
    expect(rules(checkBody(body))).toEqual(["PRX-B-SECTION-EMPTY"]);
  });

  it("raw HTML with visible text fills a section", () => {
    const body = healthy.replace(
      "## Bundle impact\n\nnone",
      "## Bundle impact\n\n<div>Real text</div>"
    );
    expect(checkBody(body)).toEqual([]);
  });

  it("raw HTML whose visible text is only whitespace is not content", () => {
    const body = healthy.replace(
      "## Bundle impact\n\nnone",
      "## Bundle impact\n\n<div> </div>"
    );
    expect(rules(checkBody(body))).toEqual(["PRX-B-SECTION-EMPTY"]);
  });

  it("a list item containing only a subheading is not meaningful content", () => {
    const body = healthy.replace(
      "## Bundle impact\n\nnone",
      "## Bundle impact\n\n- ### h"
    );
    expect(rules(checkBody(body))).toEqual(["PRX-B-SECTION-EMPTY"]);
  });

  it("a blockquote containing only a subheading is not meaningful content", () => {
    const body = healthy.replace(
      "## Bundle impact\n\nnone",
      "## Bundle impact\n\n> ### h"
    );
    expect(rules(checkBody(body))).toEqual(["PRX-B-SECTION-EMPTY"]);
  });

  it("a paragraph that decodes to only whitespace is not content", () => {
    const body = healthy.replace(
      "## Bundle impact\n\nnone",
      "## Bundle impact\n\n&#32;"
    );
    expect(rules(checkBody(body))).toEqual(["PRX-B-SECTION-EMPTY"]);
  });

  it("image REFERENCE alt text counts as visible content", () => {
    const body = healthy.replace(
      "## Bundle impact\n\nnone",
      "## Bundle impact\n\n![ref alt][r]\n\n[r]: https://example.com"
    );
    expect(checkBody(body)).toEqual([]);
  });

  it("an HTML comment containing '>' inside an HTML block is fully invisible", () => {
    const body = healthy.replace(
      "## Bundle impact\n\nnone",
      "## Bundle impact\n\n<div></div><!-- >text -->"
    );
    expect(rules(checkBody(body))).toEqual(["PRX-B-SECTION-EMPTY"]);
  });

  it("adjacent label-less links are still empty content", () => {
    const body = healthy.replace(
      "## Bundle impact\n\nnone",
      "## Bundle impact\n\n[](https://a.example)[](https://b.example)"
    );
    expect(rules(checkBody(body))).toEqual(["PRX-B-SECTION-EMPTY"]);
  });

  it("an empty unlabeled fence is empty content but never narrative", () => {
    const body = healthy.replace(
      "## Bundle impact\n\nnone",
      "## Bundle impact\n\n```\n```"
    );
    expect(rules(checkBody(body))).toEqual(["PRX-B-SECTION-EMPTY"]);
  });

  it("an unlabeled fence of bullet lines trips PRX-B-FENCE", () => {
    const body = healthy.replace(
      "## Bundle impact\n\nnone",
      "## Bundle impact\n\n```\n- alpha\n- beta\n```"
    );
    expect(checkBody(body).some(x => x.rule === "PRX-B-FENCE")).toBe(true);
  });

  it("an unlabeled fence of multi-digit ordered items trips PRX-B-FENCE", () => {
    const body = healthy.replace(
      "## Bundle impact\n\nnone",
      "## Bundle impact\n\n```\n12. twelve here\n13. thirteen here\n```"
    );
    expect(checkBody(body).some(x => x.rule === "PRX-B-FENCE")).toBe(true);
  });

  it("an unlabeled fence of plain non-narrative lines is not flagged", () => {
    const body = healthy.replace(
      "## Bundle impact\n\nnone",
      "## Bundle impact\n\n```\nx = 1\nword - dash\nab- c\nnote. done\nfour plain words here\ne.g. four words here maybe\nupgrade to version v1.0\n   Three word sentence.\nup  and  down.\n```"
    );
    expect(checkBody(body)).toEqual([]);
  });

  it("an unlabeled fence holding a four-word sentence trips PRX-B-FENCE", () => {
    const body = healthy.replace(
      "## Bundle impact\n\nnone",
      "## Bundle impact\n\n```\nExactly four words total.\n```"
    );
    expect(checkBody(body).some(x => x.rule === "PRX-B-FENCE")).toBe(true);
  });

  it("a list nested two blockquotes deep is still detected as structure", () => {
    const f = checkBody(healthy + "\n> > - hidden item\n");
    expect(f.some(x => x.rule === "PRX-B-STRUCTURE")).toBe(true);
  });

  it("non-string input is bounced by the size/type guard, fast", () => {
    // Deterministic, sub-millisecond kill for the size-guard conditional:
    // without the guard, null reaches raw.length and throws.
    expect(rules(checkBody(null as unknown as string))).toEqual(["PRX-B-SIZE"]);
  });

  it("only depth-2 HEADINGS enter the section index", () => {
    // A paragraph-only body must yield exactly the 14 missing-section
    // errors — a corrupted heading filter would surface the paragraph as
    // an extension heading (PRX-B-EXT) alongside them.
    const f = checkBody("Just a paragraph.");
    expect(f.filter(x => x.rule === "PRX-B-EXT")).toEqual([]);
    expect(f.filter(x => x.rule === "PRX-B-SECTION-MISSING").length).toBe(14);
  });

  it("non-key capsule lines are quoted verbatim up to 60 chars and truncated beyond", () => {
    const body = healthy.replace(
      "Evidence: UNKNOWN",
      `Evidence: UNKNOWN\nSurprise: extra\n${"Z".repeat(80)}\n${"Y".repeat(60)}`
    );
    const msgs = checkBody(body)
      .filter(x => x.rule === "PRX-B-CAPSULE")
      .map(x => x.message);
    expect(msgs.some(m => m.includes('non-key line: "Surprise: extra"'))).toBe(
      true
    );
    expect(msgs.some(m => m.includes(`${"Z".repeat(57)}...`))).toBe(true);
    expect(msgs.every(m => !m.includes("Z".repeat(58)))).toBe(true);
    expect(msgs.some(m => m.includes(`"${"Y".repeat(60)}"`))).toBe(true);
  });
});

describe("focused-review fixes (capsule labeling + hard breaks)", () => {
  it("a LABELED fence quoting a governed commit is never a capsule candidate", () => {
    // Quoting `git log` output of a governed commit (with its mandated
    // trailers) inside a ```text fence must not be torn apart by the
    // strict capsule validator (review finding, HIGH).
    const quoted =
      "```text\nfeat(x): ship the thing\n\nWhy.\n\nRun-Id: ONE-20260812-PRX\n" +
      "Evidence: UNKNOWN\nCo-Authored-By: A B <a@b.co>\n```";
    const body = healthy.replace(
      "## Reproduction evidence\n\nnone",
      `## Reproduction evidence\n\n${quoted}`
    );
    const f = checkBody(body);
    expect(f.filter(x => x.rule === "PRX-B-CAPSULE")).toEqual([]);
  });

  it("the real capsule (a BARE fence) is still validated strictly", () => {
    const body = healthy.replace("Scope: TOS-123", "Scope: junk");
    expect(checkBody(body).some(x => x.rule === "PRX-B-CAPSULE")).toBe(true);
  });

  it("a Unicode bullet after a hard line break is still detected", () => {
    const f = checkBody(`${healthy}\nline one  \n• bullet two\n`);
    expect(f.some(x => x.rule === "PRX-B-STRUCTURE")).toBe(true);
  });
});
