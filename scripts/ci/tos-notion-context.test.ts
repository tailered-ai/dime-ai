// TOS-006 contract enforcement. Every rejection path is fixture-proven, and each
// assertion checks the failure-message CONTENT (field name + actionable fix), not
// just that validation failed — an operator must learn the fix from the message
// alone (plan-devex-review F2).
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { describe, it } from "vitest";

import { loadControlPlaneManifest } from "../tailered-os-control-plane.mjs";
import {
  DECISION_CLASSES,
  DEPLOYMENT_CONSEQUENCES,
  evaluate,
  extractNotionId,
  formatReport,
  isTosScoped,
} from "./tos-notion-context.mjs";

const manifest = loadControlPlaneManifest();
const PROJECT_ID = manifest.notion.taileredOsProject.id;
const FIXTURES = join(__dirname, "selftest", "fixtures", "tos-006");
const fixture = (name: string) => readFileSync(join(FIXTURES, name), "utf8");

const SCOPED = ["platform/tailered-os/apps/workshop/src/index.ts"];
const UNSCOPED = ["server/mlbBets.ts", "client/src/pages/Feed.tsx"];

describe("TOS-006 scope predicate", () => {
  it("fires on every declared Tailered OS path and nothing else", () => {
    for (const file of [
      "platform/tailered-os/README.md",
      "config/tailered-os-control-plane.v1.json",
      "scripts/tailered-os-control-plane.mjs",
      "scripts/ci/tos-notion-context.mjs",
      "scripts/one-shot/ledger.mjs",
      "os/one-shot/runs/ONE-20260810-TOS/events.jsonl",
      ".github/workflows/tailered-os.yml",
      ".github/workflows/13-tos-notion-context.yml",
    ]) {
      assert.equal(isTosScoped([file]), true, `${file} must be in scope`);
    }
    for (const file of [
      ...UNSCOPED,
      "os/ledger/LEDGER.md", // token ledger — NOT the one-shot tree
      ".github/workflows/ci.yml",
      "scripts/smoke-deploy.mjs",
    ]) {
      assert.equal(isTosScoped([file]), false, `${file} must be out of scope`);
    }
  });

  it("an unrelated Dime PR is a clean no-op pass", () => {
    const result = evaluate("any body at all", UNSCOPED, manifest);
    assert.deepEqual(result, { inScope: false, errors: [] });
    assert.match(formatReport(result, manifest), /not applicable .*\(pass\)/);
  });
});

describe("Notion id extraction (URL-shape tolerant)", () => {
  it("accepts app.notion.com, notion.so slugs, dashed UUIDs, and bare ids", () => {
    const dashed = `${PROJECT_ID.slice(0, 8)}-${PROJECT_ID.slice(8, 12)}-${PROJECT_ID.slice(12, 16)}-${PROJECT_ID.slice(16, 20)}-${PROJECT_ID.slice(20)}`;
    for (const url of [
      `https://app.notion.com/p/${PROJECT_ID}`,
      `https://www.notion.so/tailered/Tailered-OS-${PROJECT_ID}`,
      `https://www.notion.so/tailered/Tailered-OS-${dashed}?pvs=4`,
      PROJECT_ID,
    ]) {
      assert.equal(extractNotionId(url), PROJECT_ID, url);
    }
    assert.equal(extractNotionId("no id here"), null);
  });
});

describe("TOS-006 contract on scoped PRs (fixture-driven)", () => {
  it("valid.txt passes", () => {
    const result = evaluate(fixture("valid.txt"), SCOPED, manifest);
    assert.deepEqual(result.errors, []);
    assert.match(formatReport(result, manifest), /PASS/);
  });

  it("valid-dashed-notion-so.txt passes (real pasted URL shapes)", () => {
    const result = evaluate(
      fixture("valid-dashed-notion-so.txt"),
      SCOPED,
      manifest
    );
    assert.deepEqual(result.errors, []);
  });

  const REJECTIONS: Array<[string, RegExp, RegExp]> = [
    [
      "missing-section.txt",
      /no "## Notion context" section/,
      /add the section below to the PR description/,
    ],
    [
      "missing-project.txt",
      /"Project" is missing/,
      /config\/tailered-os-control-plane\.v1\.json/,
    ],
    [
      "wrong-project-id.txt",
      /not the canonical Tailered OS project/,
      /canonical project \(id [0-9a-f]{32}/,
    ],
    [
      "missing-task.txt",
      /"Task" is missing or does not contain a valid Notion page/,
      /copy its link/,
    ],
    [
      "task-is-project.txt",
      /the Task URL is the PROJECT page/,
      /direct URL of the individual Task/,
    ],
    [
      "bad-scope-id.txt",
      /"Scope ID" is "TOS-6", which is not a valid TOS scope id/,
      /Scope ID: TOS-###/,
    ],
    ["missing-owner.txt", /"Human owner" is missing/, /accountable person/],
    ["machine-owner.txt", /names a machine actor/, /never accountable owners/],
    ["none-owner.txt", /"Human owner" is missing/, /accountable person/],
    [
      "bad-decision-class.txt",
      /"Decision class" is "urgent"; expected one of: routine \| material \| owner-gated/,
      /Decision class: routine/,
    ],
    [
      "missing-deployment.txt",
      /"Deployment consequence" is missing/,
      /Deployment consequence: none/,
    ],
    ["unfilled-template.txt", /"Project" is missing/, /add "- Project:/],
  ];

  for (const [name, whatPattern, fixPattern] of REJECTIONS) {
    it(`${name} fails and the message teaches the fix`, () => {
      const result = evaluate(fixture(name), SCOPED, manifest);
      assert.ok(result.errors.length > 0, "must reject");
      const report = formatReport(result, manifest);
      assert.match(report, whatPattern);
      assert.match(report, fixPattern);
      assert.match(report, /A compliant block looks like:/);
      assert.match(report, /config\/tailered-os-control-plane\.v1\.json/);
    });
  }

  it("a body failing several fields reports ALL of them at once", () => {
    const result = evaluate(fixture("many-failures.txt"), SCOPED, manifest);
    assert.ok(
      result.errors.length >= 4,
      `expected >=4 errors, got ${result.errors.length}`
    );
    const fields = result.errors.map(error => error.field);
    for (const field of ["Task", "Scope ID", "Human owner", "Decision class"]) {
      assert.ok(fields.includes(field), `missing ${field} in ${fields}`);
    }
  });

  it("vocabulary constants stay closed sets", () => {
    assert.deepEqual(DECISION_CLASSES, ["routine", "material", "owner-gated"]);
    assert.deepEqual(DEPLOYMENT_CONSEQUENCES, [
      "none",
      "dime-runtime",
      "tailered-os-runtime",
    ]);
  });

  it("every rejection fixture on disk is exercised by this suite", () => {
    const onDisk = readdirSync(FIXTURES).filter(name => name.endsWith(".txt"));
    const exercised = new Set([
      "valid.txt",
      "valid-dashed-notion-so.txt",
      "many-failures.txt",
      ...REJECTIONS.map(([name]) => name),
    ]);
    for (const name of onDisk) {
      assert.ok(exercised.has(name), `fixture ${name} is not exercised`);
    }
    assert.equal(onDisk.length, exercised.size, "fixture set drifted");
  });
});

describe("CLI (the exact interface the workflow calls)", () => {
  const run = (body: string, files: string[]) => {
    const dir = join(__dirname, "selftest", "fixtures", "tos-006");
    try {
      const stdout = execFileSync(
        "node",
        [
          join(__dirname, "tos-notion-context.mjs"),
          "--body-file",
          join(dir, body),
          "--changed-files",
          join(dir, files[0]),
        ],
        { encoding: "utf8" }
      );
      return { code: 0, stdout };
    } catch (error: any) {
      return { code: error.status, stdout: String(error.stdout) };
    }
  };

  it("exit 0 on valid scoped body; exit 1 with teaching output on invalid", () => {
    const pass = run("valid.txt", ["changed-scoped.list"]);
    assert.equal(pass.code, 0);
    assert.match(pass.stdout, /PASS/);
    const failResult = run("missing-owner.txt", ["changed-scoped.list"]);
    assert.equal(failResult.code, 1);
    assert.match(failResult.stdout, /Human owner/);
    assert.match(failResult.stdout, /Fix:/);
    const noop = run("missing-owner.txt", ["changed-unscoped.list"]);
    assert.equal(noop.code, 0);
    assert.match(noop.stdout, /not applicable/);
  });
});
