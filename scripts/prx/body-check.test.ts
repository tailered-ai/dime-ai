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

  it("flags a missing section", () => {
    const body = healthy.replace(/## Bundle impact\n\nnone\n/, "");
    const f = checkBody(body);
    expect(f.some(x => x.rule === "PRX-B-SECTION")).toBe(true);
  });

  it("flags a duplicate section as an error", () => {
    const f = checkBody(`${healthy}\n## Tests\n\nAgain.\n`);
    expect(
      f.filter(x => x.rule === "PRX-B-SECTION" && x.level === "error").length
    ).toBe(1);
  });

  it("flags an empty section", () => {
    const body = healthy.replace(
      "## Bundle impact\n\nnone",
      "## Bundle impact"
    );
    const f = checkBody(body);
    expect(f.some(x => x.rule === "PRX-B-SECTION")).toBe(true);
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

describe("prose extraction for the style layer", () => {
  it("decodes entities and skips code/list content", () => {
    const prose = extractProse(
      "## A\n\nNarrative &mdash; here.\n\n```\ncode line\n```\n\n- item\n"
    );
    expect(prose).toContain("Narrative — here.");
    expect(prose).not.toContain("code line");
  });
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
