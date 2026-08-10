// TOS-001 authority-manifest enforcement. Style mirrors dime-agent-access.test.ts:
// assert the committed file's literal values, then mutate clones to prove every
// drift detector can actually fail (master-prompt §15 negative-testing standard).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import assert from "node:assert/strict";
import { describe, it } from "vitest";
import {
  CANONICAL,
  CONTROL_PLANE_MANIFEST_PATH,
  loadControlPlaneManifest,
  validateControlPlaneManifest,
} from "./tailered-os-control-plane.mjs";

const repoRoot = join(__dirname, "..");
const clone = () =>
  JSON.parse(readFileSync(CONTROL_PLANE_MANIFEST_PATH, "utf8"));

describe("tailered-os control-plane manifest", () => {
  it("the committed manifest validates and pins the owner-verified identifiers", () => {
    const manifest = loadControlPlaneManifest();
    assert.equal(manifest.github.repository, "tailered-ai/dime-ai");
    assert.equal(manifest.github.taileredOsBoundary, "platform/tailered-os/");
    assert.equal(
      manifest.notion.workspaceRootPage.id,
      CANONICAL.workspaceRootPage
    );
    assert.equal(manifest.notion.workspaceRootPage.name, "Tailered Team Home");
    assert.equal(manifest.notion.databases.tasks.id, CANONICAL.tasks);
    assert.equal(manifest.notion.databases.projects.id, CANONICAL.projects);
    assert.equal(
      manifest.notion.databases.aiSystemsRegistry.id,
      CANONICAL.aiSystemsRegistry
    );
    assert.equal(manifest.safety.notionWriteOperationsAuthorized, false);
  });

  it("unverified identifiers are explicitly marked, never silently trusted", () => {
    const manifest = loadControlPlaneManifest();
    for (const key of [
      "decisions",
      "risks",
      "releases",
      "knowledge",
    ] as const) {
      const node = manifest.notion.databases[key];
      assert.equal(
        node.verified,
        false,
        `${key} has not been re-verified over the connector yet`
      );
      assert.match(node.source, /re-verify/i);
    }
  });

  it("rejects a manifest pointing at the wrong repository", () => {
    const bad = clone();
    bad.github.repository = "tailered-ai/tailered-os";
    assert.throws(
      () => validateControlPlaneManifest(bad),
      /repository drifted/
    );
  });

  it("rejects the stale pre-2026-08-10 root-page naming", () => {
    const bad = clone();
    bad.notion.workspaceRootPage.name = "Dime AI — Operations HQ";
    assert.throws(
      () => validateControlPlaneManifest(bad),
      /Tailered Team Home/
    );
  });

  it("rejects a canonical surface whose id drifts", () => {
    const bad = clone();
    bad.notion.databases.tasks.id = "00000000000000000000000000000000";
    assert.throws(
      () => validateControlPlaneManifest(bad),
      /does not match the owner-verified canonical id/
    );
  });

  it("rejects duplicate Notion ids (mis-pasted identifier)", () => {
    const bad = clone();
    bad.notion.databases.decisions.id = bad.notion.databases.risks.id;
    assert.throws(() => validateControlPlaneManifest(bad), /unique/);
  });

  it("rejects malformed ids, missing verification dates, and credential-shaped values", () => {
    const badHex = clone();
    badHex.notion.databases.knowledge.id = "not-a-notion-id";
    assert.throws(() => validateControlPlaneManifest(badHex), /32-hex/);

    const badDate = clone();
    delete badDate.notion.commandCenter.verifiedOn;
    assert.throws(() => validateControlPlaneManifest(badDate), /verifiedOn/);

    const badSecret = clone();
    // Assembled at runtime so the raw diff never contains a contiguous
    // secret-shaped token (the repo's gitleaks gate scans commit text).
    badSecret.authorityBoundaries.stripe = ["sk_live", "abcdefghijklmnop"].join(
      "_"
    );
    assert.throws(
      () => validateControlPlaneManifest(badSecret),
      /credential-shaped/
    );
  });

  it("rejects a manifest that grants itself write authority", () => {
    const bad = clone();
    bad.safety.notionWriteOperationsAuthorized = true;
    assert.throws(
      () => validateControlPlaneManifest(bad),
      /notionWriteOperationsAuthorized/
    );
  });

  it("rejects injected unknown keys at every level (adversarial-review C2)", () => {
    const lookalike = clone();
    lookalike.notion.commandCenterV2 = {
      name: "Tailered OS Command Center",
      id: "deadbeefdeadbeefdeadbeefdeadbeef",
      verified: true,
      verifiedOn: "2026-08-10",
      source: "attacker",
    };
    assert.throws(() => validateControlPlaneManifest(lookalike), /unknown key/);

    const safetyBypass = clone();
    safetyBypass.safety.notionWriteOperationsAuthorizedV2 = true;
    assert.throws(
      () => validateControlPlaneManifest(safetyBypass),
      /unknown key/
    );

    const topLevel = clone();
    topLevel.permissions = { write: true };
    assert.throws(() => validateControlPlaneManifest(topLevel), /unknown key/);

    const extraDatabase = clone();
    extraDatabase.notion.databases.credentials = clone().notion.databases.tasks;
    assert.throws(
      () => validateControlPlaneManifest(extraDatabase),
      /unknown key/
    );

    const nodeExtra = clone();
    nodeExtra.notion.workspaceRootPage.writeToken = "x";
    assert.throws(() => validateControlPlaneManifest(nodeExtra), /unknown key/);
  });

  it("rejects impossible dates and stray verifiedOn values (adversarial-review I1)", () => {
    const impossible = clone();
    impossible.notion.commandCenter.verifiedOn = "9999-99-99";
    assert.throws(
      () => validateControlPlaneManifest(impossible),
      /calendar date/
    );

    const strayOnUnverified = clone();
    strayOnUnverified.notion.databases.decisions.verifiedOn = "not-a-date";
    assert.throws(
      () => validateControlPlaneManifest(strayOnUnverified),
      /calendar date/
    );
  });

  it("rejects passworded connection URIs (adversarial-review I2)", () => {
    const bad = clone();
    // Assembled at runtime so the raw diff never contains a contiguous
    // credential-shaped URI (the repo's gitleaks gate scans commit text).
    bad.notion.databases.risks.source = [
      "mysql://user",
      "hunter2@db.internal/x",
    ].join(":");
    assert.throws(() => validateControlPlaneManifest(bad), /credential-shaped/);
  });

  it("every Notion id the runbook shows agents matches the manifest (adversarial-review C3)", () => {
    const doc = readFileSync(
      join(repoRoot, "references", "notion-control-plane.md"),
      "utf8"
    );
    const manifest = loadControlPlaneManifest();
    const manifestIds = new Set<string>([
      manifest.notion.workspaceRootPage.id,
      manifest.notion.taileredOsProject.id,
      manifest.notion.commandCenter.id,
      manifest.notion.communicationStandard.id,
      manifest.notion.executionContract.id,
      ...Object.values(manifest.notion.databases).map(
        (node: any) => node.id as string
      ),
    ]);
    const docIds = [...new Set(doc.match(/\b[0-9a-f]{32}\b/g) ?? [])];
    assert.ok(docIds.length >= 8, "runbook lost its canonical-surface ids");
    for (const id of docIds) {
      assert.ok(
        manifestIds.has(id),
        `runbook shows id ${id} that the manifest does not pin — mis-pasted identifier`
      );
    }
    for (const id of Object.values(CANONICAL)) {
      assert.ok(docIds.includes(id), `runbook is missing canonical id ${id}`);
    }
  });

  it("the human runbook names the manifest and the current root page (doc/manifest lockstep)", () => {
    const doc = readFileSync(
      join(repoRoot, "references", "notion-control-plane.md"),
      "utf8"
    );
    assert.match(doc, /config\/tailered-os-control-plane\.v1\.json/);
    assert.match(doc, /Tailered Team Home/);
    assert.doesNotMatch(
      doc,
      /Root page: \*\*\[Dime AI — Operations HQ\]/,
      "runbook still presents the superseded root-page title as current"
    );
  });
});
