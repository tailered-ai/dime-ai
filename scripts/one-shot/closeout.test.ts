// Closeout gate enforcement (FIND-LANE0-0003): every blocker path is proven to
// fire, and COMPLETE is proven reachable only when everything is genuinely
// terminal. Same style as ledger.test.ts: real append path in a temp run.
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
} from "node:fs";
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

const DELIVERED_OK = {
  delivered: true,
  authority_plane: "candidate",
  dod_ref: "ledger verifies clean",
  proof: { type: "event" as const, ref: "evt_00001" },
};

function completeHappyRun({ gates = true, gstack = true } = {}) {
  add({ scope_id: "TOS-PROGRAM", event_type: "RUN_STARTED", summary: "start" });
  add({
    scope_id: "TOS-006",
    event_type: "SCOPE_STARTED",
    summary: "start scope",
  });
  add({
    scope_id: "TOS-006",
    event_type: "SCOPE_COMPLETED",
    summary: "done",
    ...DELIVERED_OK,
  });
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
      event_type: "GSTACK_STARTED",
      workflow: "review",
      summary: "review started",
    });
    add({
      scope_id: "TOS-PROGRAM",
      event_type: "GSTACK_COMPLETED",
      workflow: "review",
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
    assert.equal(result.tail_anchor.events_total, 9);
    assert.match(result.tail_anchor.final_event_hash, /^[0-9a-f]{64}$/);
    assert.equal(result.claims.terminal_scopes[0].delivered, true);
    assert.deepEqual(result.claims.legacy_terminalizations, []);
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
    add({
      scope_id: "TOS-006",
      event_type: "SCOPE_COMPLETED",
      summary: "d",
      ...DELIVERED_OK,
    });
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
      event_type: "GSTACK_STARTED",
      workflow: "review",
      summary: "review started",
    });
    add({
      scope_id: "TOS-PROGRAM",
      event_type: "GSTACK_COMPLETED",
      workflow: "review",
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
      head_sha: "0".repeat(40),
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

// ---------------------------------------------------------------------------
// FALSIFICATION RE-BATTERY (Campaign Two acceptance): every bypass the forensic
// audit proved by construction against the v1 kernel must now fail closed.
// Each test names the attack and the Campaign One result it flips.
// ---------------------------------------------------------------------------
describe("falsification re-battery — audited v1 bypasses now fail closed", () => {
  it('ATTACK: "GATED, NOT BUILT" SCOPE_COMPLETED (v1: complete:true) → v2: unappendable without delivered; gated stays non-terminal without decision_ref', () => {
    completeHappyRun({ gates: true, gstack: true });
    // The v1-shaped attack event (no delivered field) cannot even be recorded:
    assert.throws(
      () =>
        add({
          scope_id: "LANE-0",
          event_type: "SCOPE_COMPLETED",
          summary: "GATED, NOT BUILT — nothing was implemented",
        }),
      /delivered is a field, not a vibe/
    );
    // The honest v2 form records, but keeps the run non-terminal:
    add({
      scope_id: "LANE-0",
      event_type: "SCOPE_STARTED",
      summary: "lane started",
    });
    add({
      scope_id: "TOS-006",
      event_type: "SCOPE_COMPLETED",
      summary: "GATED, NOT BUILT",
      delivered: "gated",
      authority_plane: "design",
      dod_ref: "ledger verifies clean",
    });
    const result = closeout(RUN);
    assert.equal(result.complete, false);
    assert.match(
      result.blockers.join("\n"),
      /terminalized as "gated" without a decision_ref/
    );
  });

  it("gated WITH an owner decision_ref counts as terminal", () => {
    completeHappyRun();
    add({
      scope_id: "TOS-006",
      event_type: "SCOPE_COMPLETED",
      summary: "gated by owner decision",
      delivered: "gated",
      authority_plane: "design",
      dod_ref: "ledger verifies clean",
      decision_ref: "https://app.notion.com/p/00000000000000000000000000000000",
    });
    const result = closeout(RUN);
    assert.equal(result.complete, true);
    assert.equal(result.claims.terminal_scopes[0].delivered, "gated");
  });

  it('ATTACK: PR_MERGED with head_sha "not-a-sha-at-all" (v1: complete:true) → v2: rejected at append', () => {
    add({ scope_id: "TOS-PROGRAM", event_type: "RUN_STARTED", summary: "s" });
    assert.throws(
      () =>
        add({
          scope_id: "TOS-006",
          event_type: "PR_MERGED",
          pr: 503,
          head_sha: "not-a-sha-at-all",
          merge_sha: "0".repeat(40),
          summary: "merge",
        }),
      /head_sha as an exact 40-hex commit sha/
    );
    assert.throws(
      () =>
        add({
          scope_id: "TOS-006",
          event_type: "PR_OPENED",
          pr: 503,
          summary: "no sha at all",
        }),
      /head_sha as an exact 40-hex/
    );
    assert.throws(
      () =>
        add({
          scope_id: "TOS-006",
          event_type: "PR_MERGED",
          pr: 503,
          head_sha: "0".repeat(40),
          summary: "no merge sha",
        }),
      /merge_sha as an exact 40-hex/
    );
    assert.throws(
      () =>
        add({
          scope_id: "TOS-006",
          event_type: "CI_STATE_CHANGED",
          summary: "ci without identity",
        }),
      /requires an integer pr number/
    );
  });

  it("ATTACK: dead proof link (v1: no check existed) → v2: blocker names the dead reference", () => {
    add({ scope_id: "TOS-PROGRAM", event_type: "RUN_STARTED", summary: "s" });
    add({ scope_id: "TOS-006", event_type: "SCOPE_STARTED", summary: "s" });
    add({
      scope_id: "TOS-006",
      event_type: "SCOPE_COMPLETED",
      summary: "claims delivery",
      delivered: true,
      authority_plane: "candidate",
      dod_ref: "ledger verifies clean",
      proof: { type: "repo", ref: "does/not/exist.md" },
    });
    add({ scope_id: "TOS-PROGRAM", event_type: "RUN_COMPLETED", summary: "t" });
    const result = closeout(RUN);
    assert.equal(result.complete, false);
    assert.match(
      result.blockers.join("\n"),
      /proof \(repo:does\/not\/exist\.md\) does not resolve/
    );
  });

  it('ATTACK: substring "plan-devex-review" satisfying required "review" (v1: passed) → v2: exact-match fails it', () => {
    add({ scope_id: "TOS-PROGRAM", event_type: "RUN_STARTED", summary: "s" });
    add({
      scope_id: "TOS-PROGRAM",
      event_type: "GSTACK_STARTED",
      workflow: "plan-devex-review",
      summary: "plan-devex-review started",
    });
    add({
      scope_id: "TOS-PROGRAM",
      event_type: "GSTACK_COMPLETED",
      workflow: "plan-devex-review",
      summary: "plan-devex-review complete",
    });
    const result = closeout(RUN);
    assert.match(
      result.blockers.join("\n"),
      /required gstack workflows unaccounted: review/
    );
  });

  it("ATTACK: duplicate idempotency_key (v1: accepted, verify-time flag) → v2: rejected at append", () => {
    add({
      scope_id: "TOS-PROGRAM",
      event_type: "RUN_STARTED",
      summary: "s",
      idempotency_key: "notion:write:tos-005:worklink",
    });
    assert.throws(
      () =>
        add({
          scope_id: "TOS-PROGRAM",
          event_type: "CONTEXT_VERIFIED",
          summary: "dup",
          idempotency_key: "notion:write:tos-005:worklink",
        }),
      /already recorded — the operation this event describes has already happened/
    );
  });

  it("ATTACK: manifest DoD line absent from the pinned directive (v1: no check) → v2: divergence blocker", () => {
    completeHappyRun();
    const dir = join(tmpRoot, RUN);
    writeFileSync(
      join(dir, "directive.md"),
      "# Directive\n\nSuccess criteria: ledger verifies clean\n"
    );
    // Manifest DoD is ["closeout gate proven"] — NOT in that directive text.
    const result = closeout(RUN);
    assert.equal(result.complete, false);
    assert.match(
      result.blockers.join("\n"),
      /definition_of_done diverges from the pinned directive/
    );
    // With the DoD line present verbatim, the blocker clears.
    writeFileSync(
      join(dir, "directive.md"),
      "# Directive\n\n- [ ] closeout gate proven\n"
    );
    assert.equal(closeout(RUN).complete, true);
  });

  it("GSTACK_UNAVAILABLE without an uninvocability reason is rejected (UNAVAILABLE means uninvocable)", () => {
    assert.throws(
      () =>
        add({
          scope_id: "TOS-PROGRAM",
          event_type: "GSTACK_UNAVAILABLE",
          workflow: "codex",
          summary: "skipped",
        }),
      /genuinely uninvocable/
    );
  });

  it("lifecycle completeness: v2 COMPLETED without STARTED fails verify (scope, gstack, subagent)", () => {
    add({
      scope_id: "TOS-006",
      event_type: "SCOPE_COMPLETED",
      summary: "never started",
      delivered: true,
      authority_plane: "candidate",
      dod_ref: "x",
      proof: { type: "event", ref: "evt_00001" },
    });
    add({
      scope_id: "TOS-PROGRAM",
      event_type: "GSTACK_COMPLETED",
      workflow: "health",
      summary: "never started",
    });
    add({
      scope_id: "TOS-PROGRAM",
      event_type: "SUBAGENT_COMPLETED",
      actor: { type: "agent", name: "ghost-agent", role: "reviewer" },
      summary: "never started",
    });
    const result = ledger.verifyRun(RUN);
    assert.equal(result.ok, false);
    const text = result.errors.join("\n");
    assert.match(
      text,
      /SCOPE_COMPLETED for TOS-006 without a prior SCOPE_STARTED/
    );
    assert.match(
      text,
      /GSTACK_COMPLETED for workflow "health" without a prior/
    );
    assert.match(text, /SUBAGENT_COMPLETED for "ghost-agent" without a prior/);
  });

  it("backward verification: a hand-built v1 run still verifies and its legacy terminalizations are surfaced, never blended", () => {
    const dir = join(tmpRoot, RUN);
    const mk = (partial: any, previous: any) => {
      const sequence = (previous?.sequence ?? 0) + 1;
      const event: any = {
        schema_version: 1,
        event_id: `evt_${String(sequence).padStart(5, "0")}`,
        run_id: RUN,
        sequence,
        timestamp: "2099-01-01T00:00:0" + (sequence % 10) + "Z",
        ...partial,
      };
      event.previous_event_hash = previous?.event_hash ?? null;
      event.event_hash = ledger.hashEvent(event, event.previous_event_hash);
      return event;
    };
    const actor = { type: "agent", name: "v1", role: "integration-owner" };
    const e1 = mk(
      {
        scope_id: "TOS-PROGRAM",
        event_type: "RUN_STARTED",
        actor,
        summary: "s",
      },
      null
    );
    const e2 = mk(
      {
        scope_id: "TOS-006",
        event_type: "SCOPE_COMPLETED",
        actor,
        summary: "v1-style terminalization, no delivered field",
      },
      e1
    );
    const e3 = mk(
      {
        scope_id: "TOS-PROGRAM",
        event_type: "RUN_COMPLETED",
        actor,
        summary: "t",
      },
      e2
    );
    writeFileSync(
      join(dir, "events.jsonl"),
      [e1, e2, e3].map(event => JSON.stringify(event)).join("\n") + "\n"
    );
    assert.equal(ledger.verifyRun(RUN).ok, true);
    const result = closeout(RUN);
    assert.deepEqual(result.claims.legacy_terminalizations, ["TOS-006"]);
    assert.equal(result.claims.terminal_scopes[0].delivered, "legacy-v1");
  });

  it("backward verification: the REAL Campaign One run verifies untouched under the v2 kernel", () => {
    const repoRunsRoot = join(__dirname, "..", "..", "os", "one-shot", "runs");
    if (!existsSync(join(repoRunsRoot, "ONE-20260810-TOS"))) return; // not on this checkout
    const saved = process.env.ONE_SHOT_RUNS_ROOT;
    delete process.env.ONE_SHOT_RUNS_ROOT;
    try {
      const result = ledger.verifyRun("ONE-20260810-TOS");
      assert.equal(result.ok, true);
      assert.equal(result.stats.events, 102);
    } finally {
      process.env.ONE_SHOT_RUNS_ROOT = saved;
    }
  });
});
