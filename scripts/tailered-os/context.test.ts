// TOS-007 resolver contract. The happy-path fixture is a 1:1 export of the live
// TOS-006 Task row (connector SQL, 2026-08-10), so fixture-green implies parsing
// the real record shape. Every failure mode asserts message CONTENT (what/why/
// fix), and the packet is proven bounded and secret-free.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { describe, it } from "vitest";

import {
  PACKET_SCHEMA_VERSION,
  ResolveError,
  extractNotionId,
  resolve,
} from "./context.mjs";
import { loadControlPlaneManifest } from "../tailered-os-control-plane.mjs";

const FIXTURES = `fixture:${join(__dirname, "fixtures", "tos-007")}`;
const TASK_URL = "https://app.notion.com/p/3b89673313e781e9a2e5c5e703cba8d3";

async function expectFailure(taskUrl: string, source: string, code: string) {
  try {
    await resolve(taskUrl, source);
  } catch (error) {
    assert.ok(error instanceof ResolveError, String(error));
    assert.equal(error.code, code);
    const rendered = error.render();
    assert.match(rendered, /What: /);
    assert.match(rendered, /Why it matters: /);
    assert.match(rendered, /Fix: /);
    return error;
  }
  assert.fail(`expected ${code} failure for ${taskUrl}`);
}

describe("TOS-007 resolver — happy path (live-exported fixture)", () => {
  it("returns a bounded v1 packet with authority, owner, and done-condition", async () => {
    const packet = await resolve(TASK_URL, FIXTURES);
    assert.equal(packet.schema_version, PACKET_SCHEMA_VERSION);
    assert.equal(packet.repository, "tailered-ai/dime-ai");
    assert.equal(packet.task.scope_id, "TOS-006");
    assert.equal(packet.project.canonical, true);
    assert.equal(
      packet.project.id,
      extractNotionId("3b89673313e7814da8a4ccfa9a21c969")
    );
    assert.equal(packet.task.human_owner.length, 1);
    assert.match(packet.next_action, /Execute toward:/);
    assert.ok(packet.forbidden_actions.length >= 5);
    assert.ok(packet.human_gates.length >= 3);
    assert.ok(
      packet.authority.notion_write_default ===
        loadControlPlaneManifest().safety.notionWriteOperationsAuthorized,
      "packet must carry the manifest's standing write default"
    );
    assert.equal(typeof packet.authority.notion_write_default, "boolean");
    const size = JSON.stringify(packet).length;
    assert.ok(size < 8192, `packet must stay bounded (got ${size} bytes)`);
    assert.match(packet.source.mode, /^fixture:/);
    assert.match(packet.generated_at, /^\d{4}-\d{2}-\d{2}T/);
  });

  it("accepts dashed and slugged task URLs", async () => {
    const dashed =
      "https://www.notion.so/tailered/TOS-006-3b896733-13e7-81e9-a2e5-c5e703cba8d3";
    const packet = await resolve(dashed, FIXTURES);
    assert.equal(packet.task.scope_id, "TOS-006");
  });
});

describe("TOS-007 resolver — the named failure modes fail clearly", () => {
  const id = (n: number) =>
    `https://app.notion.com/p/${String(n).padStart(32, "0")}`;

  it("task missing", async () => {
    await expectFailure(id(99), FIXTURES, "task-missing");
  });
  it("task archived", async () => {
    await expectFailure(id(1), FIXTURES, "task-archived");
  });
  it("owner missing — AI agents are never accountable owners", async () => {
    const error = await expectFailure(id(2), FIXTURES, "owner-missing");
    assert.match(error.why, /never accountable owners/);
  });
  it("project id drift names the canonical id and refuses override", async () => {
    const error = await expectFailure(id(3), FIXTURES, "project-id-drift");
    assert.match(error.fix, /3b89673313e7814da8a4ccfa9a21c969/);
    assert.match(error.fix, /not a resolver override/);
  });
  it("malformed scope id", async () => {
    await expectFailure(id(4), FIXTURES, "scope-id-malformed");
  });
  it("missing project relation", async () => {
    await expectFailure(id(5), FIXTURES, "project-relation-missing");
  });
  it("malformed work link", async () => {
    await expectFailure(id(6), FIXTURES, "work-link-malformed");
  });
  it("malformed task URL", async () => {
    await expectFailure("not a url at all", FIXTURES, "task-url-malformed");
  });
  it("api source without a token fails CLOSED as connector-unauthorized", async () => {
    const saved = process.env.NOTION_API_TOKEN;
    delete process.env.NOTION_API_TOKEN;
    try {
      const error = await expectFailure(
        TASK_URL,
        "api",
        "connector-unauthorized"
      );
      assert.match(error.fix, /least-privilege/);
      assert.match(error.fix, /1Password/);
    } finally {
      if (saved !== undefined) process.env.NOTION_API_TOKEN = saved;
    }
  });
  it("unknown source spec", async () => {
    await expectFailure(TASK_URL, "carrier-pigeon", "bad-source");
  });
  it("api mode WITH a token fails explicitly as api-shape-unmapped, never by mis-parsing (FIND-TOS007-0001)", async () => {
    const saved = process.env.NOTION_API_TOKEN;
    process.env.NOTION_API_TOKEN = "test-placeholder-value";
    try {
      const error = await expectFailure(TASK_URL, "api", "api-shape-unmapped");
      assert.match(error.why, /confidently wrong packets/);
      assert.match(error.fix, /Owner-Gate Queue/);
    } finally {
      if (saved === undefined) delete process.env.NOTION_API_TOKEN;
      else process.env.NOTION_API_TOKEN = saved;
    }
  });
  it("JWT- and Slack-shaped values are refused too (FIND-TOS007-0002)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tos007-jwt-"));
    const taskId = "00000000000000000000000000000008";
    // Assembled at runtime (gitleaks scans commit text).
    const jwtish = ["eyJ", "aGVhZGVyIjoidGVzdC1vbmx5In0"].join("");
    writeFileSync(
      join(dir, `task-${taskId}.json`),
      JSON.stringify({
        Name: "JWT smuggler",
        "Scope ID": "TOS-093",
        Status: "Not started",
        Owner: '["user://x"]',
        Project: '["https://www.notion.so/3b89673313e7814da8a4ccfa9a21c969"]',
        "Why It Matters": `bearer ${jwtish}`,
      })
    );
    await expectFailure(
      `https://app.notion.com/p/${taskId}`,
      `fixture:${dir}`,
      "secret-shaped-content"
    );
  });
  it("a credential-shaped value in the record is refused, never packaged", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tos007-secret-"));
    const taskId = "00000000000000000000000000000007";
    // Assembled at runtime so the raw diff never contains a contiguous
    // credential-shaped token (gitleaks scans commit text).
    const uri = ["mysql://svc", "hunter2@db.internal/prod"].join(":");
    writeFileSync(
      join(dir, `task-${taskId}.json`),
      JSON.stringify({
        Name: "Secret smuggler",
        "Scope ID": "TOS-094",
        Status: "Not started",
        Owner: '["user://x"]',
        Project: '["https://www.notion.so/3b89673313e7814da8a4ccfa9a21c969"]',
        "What Done Means": `connect with ${uri}`,
      })
    );
    await expectFailure(
      `https://app.notion.com/p/${taskId}`,
      `fixture:${dir}`,
      "secret-shaped-content"
    );
  });
});
