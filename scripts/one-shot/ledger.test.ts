// One-shot ledger enforcement. Style mirrors tailered-os-control-plane.test.ts:
// exercise the real append/verify path in a temp run, then mutate to prove every
// integrity detector can actually fail (§43 negative-testing standard).
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "vitest";

import * as ledger from "./ledger.mjs";

const BASE_MANIFEST = {
  schema_version: 1,
  run_id: "ONE-20990101-TEST",
  program: "Tailered OS",
  scope_id: "TOS-PROGRAM",
  canonical_task: "https://app.notion.com/p/3b89673313e781eb8382e16d156d0ced",
  repository: "tailered-ai/dime-ai",
  base_sha: "5a9b657579c62df004b47980dd14ead7108d7577",
  started_at: "2099-01-01T00:00:00Z",
  human_owner: "PREZ",
  risk_class: "high",
  authorization_profile: "campaign-directive-v2",
  deployment_policy: "production-gated",
  heartbeat_cadence: "every gate/PR/CI/finding/owner-gate/scope transition",
  required_gates: ["G0", "G3", "G4"],
  required_gstack: ["review", "health", "cso"],
  definition_of_done: ["ledger verifies clean"],
  non_goals: ["Dime product behavior changes"],
  scopes: ["TOS-PROGRAM", "TOS-006", "LANE-0"],
};

// Point the module's runs root at a fresh temp dir per test via the env
// override the module exposes for exactly this purpose.
let tmpRoot: string;
beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "one-shot-ledger-"));
  process.env.ONE_SHOT_RUNS_ROOT = tmpRoot;
});

function paths(runId = BASE_MANIFEST.run_id) {
  return {
    dir: join(tmpRoot, runId),
    manifest: join(tmpRoot, runId, "run-manifest.json"),
    events: join(tmpRoot, runId, "events.jsonl"),
  };
}

function initTestRun(manifest = BASE_MANIFEST) {
  const { dir, manifest: manifestPath } = paths(manifest.run_id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
}

const EVENT = {
  scope_id: "LANE-0",
  event_type: "RUN_STARTED" as const,
  actor: { type: "agent", name: "Fable 5", role: "integration-owner" },
  summary: "Campaign started.",
};

describe("one-shot ledger", () => {
  it("appends hash-chained events and verifies clean", () => {
    initTestRun();
    const first = ledger.appendEvent(BASE_MANIFEST.run_id, EVENT);
    const second = ledger.appendEvent(BASE_MANIFEST.run_id, {
      ...EVENT,
      event_type: "CONTEXT_VERIFIED",
      summary: "Live state matches supplied state.",
    });
    assert.equal(first.sequence, 1);
    assert.equal(second.sequence, 2);
    assert.equal(second.previous_event_hash, first.event_hash);
    const result = ledger.verifyRun(BASE_MANIFEST.run_id);
    assert.deepEqual(result.errors, []);
    assert.equal(result.ok, true);
    assert.equal(result.stats.events, 2);
  });

  it("rejects an unknown event type — the vocabulary is controlled", () => {
    initTestRun();
    assert.throws(
      () =>
        ledger.appendEvent(BASE_MANIFEST.run_id, {
          ...EVENT,
          event_type: "STUFF_HAPPENED",
        }),
      /unknown event_type/
    );
  });

  it("rejects a scope_id outside the manifest's declared set", () => {
    initTestRun();
    assert.throws(
      () =>
        ledger.appendEvent(BASE_MANIFEST.run_id, {
          ...EVENT,
          scope_id: "TOS-999",
        }),
      /not in the manifest's declared scope set/
    );
  });

  it("rejects credential-shaped content — secrets never enter the ledger", () => {
    initTestRun();
    // Assembled at runtime so the raw diff never contains a contiguous
    // secret-shaped token (the repo's gitleaks gate scans commit text).
    const secretish = ["sk_live", "abcdefghijklmnop"].join("_");
    assert.throws(
      () =>
        ledger.appendEvent(BASE_MANIFEST.run_id, {
          ...EVENT,
          summary: `key ${secretish}`,
        }),
      /credential-shaped/
    );
    const uri = ["mysql://user", "hunter2@db.internal/x"].join(":");
    assert.throws(
      () =>
        ledger.appendEvent(BASE_MANIFEST.run_id, { ...EVENT, summary: uri }),
      /credential-shaped/
    );
  });

  it("detects post-append tampering: content edit, deleted line, reordered lines", () => {
    initTestRun();
    ledger.appendEvent(BASE_MANIFEST.run_id, EVENT);
    ledger.appendEvent(BASE_MANIFEST.run_id, {
      ...EVENT,
      event_type: "CONTEXT_VERIFIED",
      summary: "ok",
    });
    ledger.appendEvent(BASE_MANIFEST.run_id, {
      ...EVENT,
      event_type: "SCOPE_STARTED",
      scope_id: "TOS-006",
      summary: "start",
    });
    const { events } = paths();
    const clean = readFileSync(events, "utf8");
    const lines = clean.trim().split("\n");

    // Content edit: reword a committed summary.
    const tampered = JSON.parse(lines[1]);
    tampered.summary = "rewritten history";
    writeFileSync(
      events,
      [lines[0], JSON.stringify(tampered), lines[2]].join("\n") + "\n"
    );
    assert.match(
      ledger.verifyRun(BASE_MANIFEST.run_id).errors.join("\n"),
      /event_hash mismatch/
    );

    // Deleted line: drop the middle event.
    writeFileSync(events, [lines[0], lines[2]].join("\n") + "\n");
    const dropped = ledger.verifyRun(BASE_MANIFEST.run_id);
    assert.equal(dropped.ok, false);
    assert.match(dropped.errors.join("\n"), /sequence|previous_event_hash/);

    // Reordered lines.
    writeFileSync(events, [lines[1], lines[0], lines[2]].join("\n") + "\n");
    assert.equal(ledger.verifyRun(BASE_MANIFEST.run_id).ok, false);

    writeFileSync(events, clean);
    assert.equal(ledger.verifyRun(BASE_MANIFEST.run_id).ok, true);
  });

  it("rejects owner-gate and finding lifecycle violations", () => {
    initTestRun();
    ledger.appendEvent(BASE_MANIFEST.run_id, EVENT);
    // Resolving a gate that was never created must fail verification.
    ledger.appendEvent(BASE_MANIFEST.run_id, {
      ...EVENT,
      event_type: "OWNER_GATE_RESOLVED",
      summary: "resolved from nowhere",
      owner_gate: {
        id: "OG-007",
        decision: "merge PR",
        owner: "PREZ",
        state: "ANSWERED",
      },
    });
    assert.match(
      ledger.verifyRun(BASE_MANIFEST.run_id).errors.join("\n"),
      /OG-007 that was never created/
    );
  });

  it("requires severity on FINDING_OPENED and a well-formed finding id", () => {
    initTestRun();
    assert.throws(
      () =>
        ledger.appendEvent(BASE_MANIFEST.run_id, {
          ...EVENT,
          event_type: "FINDING_OPENED",
          finding: "not-an-id",
          severity: "high",
          summary: "x",
        }),
      /FIND-<SCOPE>-NNNN/
    );
    assert.throws(
      () =>
        ledger.appendEvent(BASE_MANIFEST.run_id, {
          ...EVENT,
          event_type: "FINDING_OPENED",
          finding: "FIND-TOS006-0001",
          summary: "x",
        }),
      /requires a severity/
    );
  });

  it("GATE_EVALUATED requires a gate and a legal status", () => {
    initTestRun();
    assert.throws(
      () =>
        ledger.appendEvent(BASE_MANIFEST.run_id, {
          ...EVENT,
          event_type: "GATE_EVALUATED",
          summary: "g3",
        }),
      /requires a gate/
    );
    assert.throws(
      () =>
        ledger.appendEvent(BASE_MANIFEST.run_id, {
          ...EVENT,
          event_type: "GATE_EVALUATED",
          gate: "G3",
          gate_status: "MAYBE",
          summary: "g3",
        }),
      /gate_status/
    );
  });

  it("duplicate idempotency keys are detected at verify time", () => {
    initTestRun();
    ledger.appendEvent(BASE_MANIFEST.run_id, {
      ...EVENT,
      idempotency_key: "github:pr:496:opened",
    });
    ledger.appendEvent(BASE_MANIFEST.run_id, {
      ...EVENT,
      event_type: "CONTEXT_VERIFIED",
      summary: "dup",
      idempotency_key: "github:pr:496:opened",
    });
    assert.match(
      ledger.verifyRun(BASE_MANIFEST.run_id).errors.join("\n"),
      /duplicate idempotency_key/
    );
  });

  it("the run manifest is immutable — a second init refuses", () => {
    initTestRun();
    assert.throws(() => ledger.initRun(BASE_MANIFEST), /already exists/);
  });

  it("rejects a manifest with a malformed run id, base sha, or secret", () => {
    assert.throws(
      () => ledger.validateManifest({ ...BASE_MANIFEST, run_id: "RUN1" }),
      /run_id/
    );
    assert.throws(
      () => ledger.validateManifest({ ...BASE_MANIFEST, base_sha: "abc" }),
      /base_sha/
    );
    const secretish = ["ghp", "A".repeat(20)].join("_");
    assert.throws(
      () =>
        ledger.validateManifest({
          ...BASE_MANIFEST,
          authorization_profile: secretish,
        }),
      /credential-shaped/
    );
  });

  it("derives status mechanically: blocked lanes, open findings, PRs, completion", () => {
    initTestRun();
    ledger.appendEvent(BASE_MANIFEST.run_id, {
      ...EVENT,
      event_type: "SCOPE_STARTED",
      scope_id: "TOS-006",
      summary: "start",
    });
    ledger.appendEvent(BASE_MANIFEST.run_id, {
      ...EVENT,
      event_type: "FINDING_OPENED",
      scope_id: "TOS-006",
      finding: "FIND-TOS006-0001",
      severity: "critical",
      summary: "validator accepts junk",
    });
    ledger.appendEvent(BASE_MANIFEST.run_id, {
      ...EVENT,
      event_type: "PR_OPENED",
      scope_id: "TOS-006",
      pr: 510,
      head_sha: "0".repeat(40),
      summary: "PR opened",
    });
    ledger.appendEvent(BASE_MANIFEST.run_id, {
      ...EVENT,
      event_type: "SCOPE_BLOCKED",
      scope_id: "TOS-006",
      summary: "waiting on CI",
    });
    const status = ledger.deriveStatus(BASE_MANIFEST.run_id);
    assert.deepEqual(status.blocked_lanes, [
      { scope: "TOS-006", cause: "waiting on CI" },
    ]);
    assert.equal(status.open_criticals.length, 1);
    assert.deepEqual(status.active_prs, [
      { pr: 510, state: "PR_OPENED", head: "0".repeat(40) },
    ]);
    assert.match(
      status.program_completion,
      /0 of 1 declared TOS scopes terminal/
    );
  });
});

describe("canonicalize depth coverage (FIND-LANE0-0001)", () => {
  it("a NESTED key named event_hash stays inside integrity coverage", () => {
    process.env.ONE_SHOT_RUNS_ROOT = mkdtempSync(
      join(tmpdir(), "one-shot-nested-")
    );
    const dir = join(process.env.ONE_SHOT_RUNS_ROOT, BASE_MANIFEST.run_id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "run-manifest.json"),
      JSON.stringify(BASE_MANIFEST)
    );
    ledger.appendEvent(BASE_MANIFEST.run_id, {
      ...EVENT,
      evidence: [{ type: "ledger", ref: "evt_00001", event_hash: "cafe" }],
    });
    const eventsFile = join(dir, "events.jsonl");
    const line = JSON.parse(readFileSync(eventsFile, "utf8").trim());
    line.evidence[0].event_hash = "beef"; // tamper with the NESTED field
    writeFileSync(eventsFile, JSON.stringify(line) + "\n");
    const result = ledger.verifyRun(BASE_MANIFEST.run_id);
    assert.equal(result.ok, false);
    assert.match(result.errors.join("\n"), /event_hash mismatch/);
  });
});
