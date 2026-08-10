// Closeout gate enforcement (FIND-LANE0-0003): every blocker path is proven to
// fire, and COMPLETE is proven reachable only when everything is genuinely
// terminal. Same style as ledger.test.ts: real append path in a temp run.
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "vitest";

import * as ledger from "./ledger.mjs";
import { closeout, deriveMetrics } from "./closeout.mjs";

const RUN = "ONE-20990101-TEST";
const MANIFEST = {
  schema_version: 1,
  run_id: RUN,
  program: "Tailered OS",
  scope_id: "TOS-PROGRAM",
  canonical_task: "https://app.notion.com/p/3b89673313e781eb8382e16d156d0ced",
  repository: "tailered-ai/dime-ai",
  base_sha: "5a9b657579c62df004b47980dd14ead7108d7577",
  started_at: "2099-01-01T00:00:00Z",
  human_owner: "PREZ",
  risk_class: "high",
  authorization_profile: "test",
  deployment_policy: "none",
  heartbeat_cadence: "per transition",
  required_gates: ["G0", "G3", "G4"],
  required_gstack: ["review"],
  definition_of_done: ["closeout gate proven"],
  non_goals: ["false COMPLETE"],
  scopes: ["TOS-PROGRAM", "TOS-006", "LANE-0"],
};

const ACTOR = { type: "agent", name: "Fable 5", role: "integration-owner" };
let tmpRoot: string;
beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "one-shot-closeout-"));
  process.env.ONE_SHOT_RUNS_ROOT = tmpRoot;
  mkdirSync(join(tmpRoot, RUN), { recursive: true });
  writeFileSync(
    join(tmpRoot, RUN, "run-manifest.json"),
    JSON.stringify(MANIFEST)
  );
});

const add = (partial: object) =>
  ledger.appendEvent(RUN, { actor: ACTOR, ...partial });

function completeHappyRun({ gates = true, gstack = true } = {}) {
  add({ scope_id: "TOS-PROGRAM", event_type: "RUN_STARTED", summary: "start" });
  add({
    scope_id: "TOS-006",
    event_type: "SCOPE_STARTED",
    summary: "start scope",
  });
  add({ scope_id: "TOS-006", event_type: "SCOPE_COMPLETED", summary: "done" });
  if (gates) {
    for (const gate of MANIFEST.required_gates) {
      add({
        scope_id: "TOS-PROGRAM",
        event_type: "GATE_EVALUATED",
        gate,
        gate_status: "PASS",
        summary: `${gate} evaluated`,
      });
    }
  }
  if (gstack) {
    add({
      scope_id: "TOS-PROGRAM",
      event_type: "GSTACK_COMPLETED",
      summary: "review workflow complete: PASS",
    });
  }
  add({
    scope_id: "TOS-PROGRAM",
    event_type: "RUN_COMPLETED",
    summary: "terminal",
  });
}

describe("closeout gate — every blocker path fires (negative controls)", () => {
  it("COMPLETE is reachable only on a genuinely terminal run", () => {
    completeHappyRun();
    const result = closeout(RUN);
    assert.deepEqual(result.blockers, []);
    assert.equal(result.complete, true);
    assert.equal(result.tail_anchor.events_total, 8);
    assert.match(result.tail_anchor.final_event_hash, /^[0-9a-f]{64}$/);
  });

  it("blocks when a required gate was never evaluated (gstack-review HIGH)", () => {
    completeHappyRun({ gates: false });
    const result = closeout(RUN);
    assert.equal(result.complete, false);
    assert.match(
      result.blockers.join("\n"),
      /required gates never evaluated: G0, G3, G4/
    );
  });

  it("blocks on a FAILed required gate and unblocks only via re-evaluation", () => {
    completeHappyRun();
    add({
      scope_id: "TOS-006",
      event_type: "GATE_EVALUATED",
      gate: "G4",
      gate_status: "FAIL",
      summary: "negative test regressed",
    });
    assert.match(
      closeout(RUN).blockers.join("\n"),
      /required gates not terminal-PASS: G4=FAIL/
    );
    add({
      scope_id: "TOS-006",
      event_type: "GATE_EVALUATED",
      gate: "G4",
      gate_status: "PASS",
      summary: "re-evaluated after remediation",
    });
    assert.equal(closeout(RUN).complete, true);
  });

  it("blocks when a required gstack workflow is unaccounted", () => {
    completeHappyRun({ gstack: false });
    const result = closeout(RUN);
    assert.equal(result.complete, false);
    assert.match(
      result.blockers.join("\n"),
      /required gstack workflows unaccounted: review/
    );
  });

  it("blocks on a non-terminal required scope", () => {
    add({
      scope_id: "TOS-PROGRAM",
      event_type: "RUN_STARTED",
      summary: "start",
    });
    add({
      scope_id: "TOS-PROGRAM",
      event_type: "RUN_COMPLETED",
      summary: "end",
    });
    const result = closeout(RUN);
    assert.equal(result.complete, false);
    assert.match(
      result.blockers.join("\n"),
      /required scopes not terminal: TOS-006/
    );
  });

  it("blocks on an unresolved finding of ANY severity", () => {
    completeHappyRun();
    add({
      scope_id: "TOS-006",
      event_type: "FINDING_OPENED",
      finding: "FIND-TOS006-0001",
      severity: "low",
      summary: "open finding",
    });
    const result = closeout(RUN);
    assert.equal(result.complete, false);
    assert.match(result.blockers.join("\n"), /1 finding\(s\) not CLOSED/);
  });

  it("unblocks once the finding closes", () => {
    completeHappyRun();
    add({
      scope_id: "TOS-006",
      event_type: "FINDING_OPENED",
      finding: "FIND-TOS006-0001",
      severity: "high",
      summary: "open",
    });
    add({
      scope_id: "TOS-006",
      event_type: "FINDING_CLOSED",
      finding: "FIND-TOS006-0001",
      summary: "closed with proof",
    });
    assert.equal(closeout(RUN).complete, true);
  });

  it("blocks on an OPEN owner gate", () => {
    completeHappyRun();
    add({
      scope_id: "TOS-PROGRAM",
      event_type: "OWNER_GATE_CREATED",
      summary: "gate",
      owner_gate: {
        id: "OG-001",
        decision: "decide",
        owner: "PREZ",
        state: "OPEN",
      },
    });
    const result = closeout(RUN);
    assert.equal(result.complete, false);
    assert.match(result.blockers.join("\n"), /1 owner gate\(s\) OPEN: OG-001/);
  });

  it("blocks on Notion writes committed without re-read verification", () => {
    completeHappyRun();
    add({
      scope_id: "TOS-006",
      event_type: "NOTION_WRITE_COMMITTED",
      summary: "wrote",
    });
    const result = closeout(RUN);
    assert.equal(result.complete, false);
    assert.match(
      result.blockers.join("\n"),
      /without a recorded re-read verification/
    );
  });

  it("blocks without a terminal run event even when nothing else blocks", () => {
    add({
      scope_id: "TOS-PROGRAM",
      event_type: "RUN_STARTED",
      summary: "start",
    });
    add({ scope_id: "TOS-006", event_type: "SCOPE_STARTED", summary: "s" });
    add({ scope_id: "TOS-006", event_type: "SCOPE_COMPLETED", summary: "d" });
    for (const gate of MANIFEST.required_gates) {
      add({
        scope_id: "TOS-PROGRAM",
        event_type: "GATE_EVALUATED",
        gate,
        gate_status: "PASS",
        summary: `${gate} evaluated`,
      });
    }
    add({
      scope_id: "TOS-PROGRAM",
      event_type: "GSTACK_COMPLETED",
      summary: "review workflow complete: PASS",
    });
    const result = closeout(RUN);
    assert.deepEqual(result.blockers, []);
    assert.equal(result.terminal_run_event_recorded, false);
    assert.equal(result.complete, false);
  });

  it("blocks on ledger integrity violations (tampered line)", () => {
    completeHappyRun();
    const eventsFile = join(tmpRoot, RUN, "events.jsonl");
    const lines = readFileSync(eventsFile, "utf8").trim().split("\n");
    const tampered = JSON.parse(lines[1]);
    tampered.summary = "rewritten";
    lines[1] = JSON.stringify(tampered);
    writeFileSync(eventsFile, lines.join("\n") + "\n");
    const result = closeout(RUN);
    assert.equal(result.complete, false);
    assert.match(result.blockers.join("\n"), /ledger integrity/);
  });

  it("tail truncation escapes verify but contradicts the recorded tail anchor", () => {
    completeHappyRun();
    const before = closeout(RUN);
    assert.equal(before.complete, true);
    const eventsFile = join(tmpRoot, RUN, "events.jsonl");
    const lines = readFileSync(eventsFile, "utf8").trim().split("\n");
    writeFileSync(eventsFile, lines.slice(0, -1).join("\n") + "\n");
    // The known limit: the shorter chain still verifies...
    assert.equal(ledger.verifyRun(RUN).ok, true);
    // ...but the anchor no longer matches what was recorded out-of-band.
    const after = closeout(RUN);
    assert.notEqual(
      after.tail_anchor?.events_total,
      before.tail_anchor.events_total
    );
    assert.notEqual(
      after.tail_anchor?.final_event_hash,
      before.tail_anchor.final_event_hash
    );
  });
});

describe("metrics derivation", () => {
  it("counts scopes, findings, cycles, owner gates, and PRs mechanically", () => {
    completeHappyRun();
    add({
      scope_id: "TOS-006",
      event_type: "FINDING_OPENED",
      finding: "FIND-TOS006-0002",
      severity: "critical",
      summary: "c",
    });
    add({
      scope_id: "TOS-006",
      event_type: "FINDING_REMEDIATED",
      finding: "FIND-TOS006-0002",
      summary: "r",
    });
    add({
      scope_id: "TOS-006",
      event_type: "FINDING_CLOSED",
      finding: "FIND-TOS006-0002",
      summary: "x",
    });
    add({
      scope_id: "TOS-006",
      event_type: "PR_OPENED",
      pr: 504,
      summary: "pr",
    });
    const metrics = deriveMetrics(RUN);
    assert.equal(metrics.scopes_completed, 1);
    assert.equal(metrics.critical_findings, 1);
    assert.equal(metrics.findings_open, 0);
    assert.equal(metrics.remediation_cycles, 1);
    assert.deepEqual(metrics.prs_touched, [504]);
  });
});
