// TOS-009 lifecycle engine — §36/§37 enforcement battery. Same standard as the
// sibling suites: drive the real applyEvent/foldLifecycle path and prove every
// refusal class actually fires; a lifecycle automation that cannot refuse is a
// rubber stamp, not a control.
import assert from "node:assert/strict";
import { describe, it } from "vitest";

import {
  FAILURE_CLASSES,
  LIFECYCLE_STATES,
  TRANSITIONS,
  LifecycleError,
  applyEvent,
  assertLiveNotionAuthority,
  foldLifecycle,
  initialState,
  nextAction,
  planMutation,
  verifyReplay,
} from "./lifecycle.mjs";
import { loadControlPlaneManifest } from "../tailered-os-control-plane.mjs";

const TASK = "3b89673313e7815aafcaeaebc32ea8ff";
const HEAD = "a".repeat(40);
const MERGE = "b".repeat(40);

const ev = (type: string, evidence: any = {}, extra: any = {}) => ({
  event_key: extra.event_key ?? `${type}-${JSON.stringify(evidence).length}`,
  task_id: TASK,
  type,
  actor: extra.actor ?? "machine",
  at: extra.at ?? "2026-08-11T00:00:00Z",
  evidence,
  ...(extra.expected_generation !== undefined
    ? { expected_generation: extra.expected_generation }
    : {}),
});

// The full observed happy path, evidence at every step.
const HAPPY: any[] = [
  ev("work_started", {
    packet_ref: "context-packet-evt_00001",
    work_link: "https://github.com/tailered-ai/dime-ai/tree/feat/x",
  }),
  ev("pr_opened", { pr_number: 496, head_sha: HEAD }),
  ev(
    "checks_observed",
    { head_sha: HEAD, check_rollup: "success" },
    { event_key: "checks-green" }
  ),
  ev("review_requested", { review_ref: "review-request-1" }),
  ev(
    "approval_observed",
    {
      reviewer: "PREZ",
      review_id: "R-1",
      review_state: "APPROVED",
      observed_via: "gh api pulls/496/reviews",
    },
    { actor: "human" }
  ),
  ev(
    "merge_observed",
    { merge_sha: MERGE, observed_via: "gh pr view 496" },
    { actor: "human" }
  ),
  ev("deploy_consequence_recorded", {
    deploy_decision: "no-deploy",
    consequence_ref: "railway-image-excludes-platform",
  }),
  ev("post_merge_verified", { evidence_ref: "post-merge-report-1" }),
  ev("learning_captured", { learning_ref: "learning-1" }),
];

function foldHappy(upTo = HAPPY.length) {
  return foldLifecycle(HAPPY.slice(0, upTo), TASK);
}

describe("TOS-009 §36 — the happy path is evidence-driven, never inferred", () => {
  it("folds Ready → … → Verified with one record per applied event", () => {
    const { state, records, refusals } = foldHappy();
    assert.deepEqual(refusals, []);
    assert.equal(state.state, "Verified");
    assert.equal(state.generation, HAPPY.length);
    assert.equal(records.length, HAPPY.length);
    assert.equal(state.merge_sha, MERGE);
    assert.equal(state.deploy_decision, "no-deploy");
    assert.equal(state.learning_ref, "learning-1");
    // Each record is evidence-linked and names its authority.
    for (const record of records) {
      assert.ok(record.event_key);
      assert.ok(record.trigger);
      assert.ok(["machine", "human"].includes(record.authority));
    }
  });

  it("state vocabulary and transition table are closed", () => {
    assert.equal(LIFECYCLE_STATES.length, 9);
    for (const t of TRANSITIONS) {
      assert.ok(
        t.from === "*" || LIFECYCLE_STATES.includes(t.from),
        `unknown from ${t.from}`
      );
      assert.ok(["machine", "human"].includes(t.authority));
    }
    const result = applyEvent(
      initialState(TASK),
      ev("task_teleported", { anything: "x" })
    );
    assert.equal(result.ok, false);
    assert.equal(result.failure_class, "malformed_input");
    assert.match(result.detail, /transition table is closed/);
  });

  it("nextAction marks human-authority stages as human (approval, merge, deploy decision)", () => {
    const review = foldHappy(4).state;
    assert.equal(review.state, "Review");
    assert.equal(nextAction(review).authority, "human");
    const approval = foldHappy(5).state;
    assert.equal(nextAction(approval).authority, "human");
    const merged = foldHappy(6).state;
    assert.equal(nextAction(merged).authority, "human"); // deploy decision
  });
});

describe("TOS-009 §37 — every failure class fires visibly", () => {
  it("duplicate event: idempotent no-op, same state, no second record", () => {
    const { state } = foldHappy(2);
    const result = applyEvent(state, HAPPY[1]); // pr_opened again
    assert.equal(result.ok, true);
    assert.equal(result.duplicate, true);
    assert.equal(result.failure_class, "duplicate_event");
    assert.equal(result.record, null);
    assert.equal(result.state, state); // exact same object back
  });

  it("event reorder: refused loudly, naming the expected from-state", () => {
    const result = applyEvent(initialState(TASK), HAPPY[1]); // pr_opened at Ready
    assert.equal(result.ok, false);
    assert.equal(result.failure_class, "event_reorder");
    assert.match(result.detail, /expects task .* in state "Executing"/);
    assert.match(result.detail, /never silently reordered/);
  });

  it("replay: deterministic fold; a tampered claimed state is replay_divergence", () => {
    const first = foldHappy();
    const second = foldHappy();
    assert.equal(JSON.stringify(first.state), JSON.stringify(second.state));
    assert.equal(verifyReplay(HAPPY, first.state, TASK).ok, true);
    const tampered = { ...first.state, state: "Merged", generation: 4 };
    const result = verifyReplay(HAPPY, tampered, TASK);
    assert.equal(result.ok, false);
    assert.equal(result.failure_class, "replay_divergence");
  });

  it("missing Work Link relation refuses as missing_relation (and non-URL links too)", () => {
    const noLink = applyEvent(
      initialState(TASK),
      ev("work_started", { packet_ref: "p" })
    );
    assert.equal(noLink.failure_class, "missing_relation");
    const badLink = applyEvent(
      initialState(TASK),
      ev("work_started", { packet_ref: "p", work_link: "not-a-url" })
    );
    assert.equal(badLink.failure_class, "missing_relation");
  });

  it("missing/malformed PR evidence refuses (missing_pr, malformed sha)", () => {
    const { state } = foldHappy(1);
    const noPr = applyEvent(state, ev("pr_opened", { head_sha: HEAD }));
    assert.equal(noPr.failure_class, "missing_pr");
    const badSha = applyEvent(
      state,
      ev("pr_opened", { pr_number: 1, head_sha: "abc" })
    );
    assert.equal(badSha.failure_class, "malformed_input");
  });

  it("stale head SHA on checks or merge refuses as stale_sha", () => {
    const { state } = foldHappy(2);
    const staleChecks = applyEvent(
      state,
      ev("checks_observed", {
        head_sha: "c".repeat(40),
        check_rollup: "success",
      })
    );
    assert.equal(staleChecks.failure_class, "stale_sha");
    const approved = foldHappy(5).state;
    const staleMerge = applyEvent(
      approved,
      ev(
        "merge_observed",
        { merge_sha: MERGE, head_sha: "c".repeat(40), observed_via: "gh" },
        { actor: "human" }
      )
    );
    assert.equal(staleMerge.failure_class, "stale_sha");
  });

  it("CI failure routes VISIBLY to Blocked (never silent), and a human unblock restores the prior state", () => {
    const { state } = foldHappy(2);
    const failed = applyEvent(
      state,
      ev(
        "checks_observed",
        { head_sha: HEAD, check_rollup: "failure" },
        { event_key: "checks-red" }
      )
    );
    assert.equal(failed.ok, true);
    assert.equal(failed.state.state, "Blocked");
    assert.equal(failed.record.failure_class, "ci_failure");
    assert.equal(failed.state.blocked_from, "PR Open");
    // Machine cannot unblock (human authority).
    const machineUnblock = applyEvent(
      failed.state,
      ev("unblocked", { resolution_ref: "fixed", observed_via: "gh" })
    );
    assert.equal(machineUnblock.failure_class, "authority_violation");
    // Human unblock returns to the recorded state.
    const humanUnblock = applyEvent(
      failed.state,
      ev(
        "unblocked",
        { resolution_ref: "fixed", observed_via: "PREZ said so in review" },
        { actor: "human" }
      )
    );
    assert.equal(humanUnblock.ok, true);
    assert.equal(humanUnblock.state.state, "PR Open");
  });

  it("review cannot start without observed green checks", () => {
    const { state } = foldHappy(2);
    const withPending = applyEvent(
      state,
      ev("checks_observed", { head_sha: HEAD, check_rollup: "pending" })
    );
    const result = applyEvent(
      withPending.state,
      ev("review_requested", { review_ref: "r" })
    );
    assert.equal(result.failure_class, "ci_failure");
  });

  it("human-authority transitions refuse machine actors — approval is never automated", () => {
    const review = foldHappy(4).state;
    const machineApproval = applyEvent(
      review,
      ev("approval_observed", {
        reviewer: "PREZ",
        review_id: "R-1",
        review_state: "APPROVED",
        observed_via: "gh",
      })
    );
    assert.equal(machineApproval.failure_class, "authority_violation");
    assert.match(machineApproval.detail, /never perform or infer/);
    const notApproved = applyEvent(
      review,
      ev(
        "approval_observed",
        {
          reviewer: "PREZ",
          review_id: "R-1",
          review_state: "CHANGES_REQUESTED",
          observed_via: "gh",
        },
        { actor: "human" }
      )
    );
    assert.equal(notApproved.failure_class, "malformed_input");
  });

  it("post-merge verification requires the recorded deploy consequence first — no time-based inference", () => {
    const merged = foldHappy(6).state;
    const result = applyEvent(
      merged,
      ev("post_merge_verified", { evidence_ref: "e" })
    );
    assert.equal(result.failure_class, "missing_evidence");
    assert.match(result.detail, /consequence/);
  });

  it("authority-layer failures fail closed: permission denial, timeout, expired credentials", () => {
    const { state } = foldHappy(2);
    for (const cls of [
      "permission_denial",
      "api_timeout",
      "expired_credentials",
    ]) {
      const result = applyEvent(
        state,
        ev(
          "authority_failure",
          { failure_class: cls, detail: "simulated" },
          { event_key: `auth-${cls}` }
        )
      );
      assert.equal(result.ok, false);
      assert.equal(result.failure_class, cls);
      assert.match(result.detail, /fails closed; no transition was inferred/);
    }
  });

  it("partial write freezes the lifecycle until re-verified (§37 partial_write)", () => {
    const { state } = foldHappy(2);
    const partial = applyEvent(
      state,
      ev("mutation_result", { plan_ref: "plan-1", applied: "partial" })
    );
    assert.equal(partial.ok, true);
    assert.equal(partial.state.pending_partial_write, true);
    assert.equal(partial.record.failure_class, "partial_write");
    const frozen = applyEvent(
      partial.state,
      ev("checks_observed", { head_sha: HEAD, check_rollup: "success" })
    );
    assert.equal(frozen.failure_class, "partial_write");
    const reverified = applyEvent(
      partial.state,
      ev("write_reverified", { verification_ref: "re-read-1" })
    );
    assert.equal(reverified.state.pending_partial_write, false);
    const resumed = applyEvent(
      reverified.state,
      ev("checks_observed", { head_sha: HEAD, check_rollup: "success" })
    );
    assert.equal(resumed.ok, true);
  });

  it("stale task generation refuses (re-read before acting)", () => {
    const { state } = foldHappy(2);
    const result = applyEvent(
      state,
      ev(
        "checks_observed",
        { head_sha: HEAD, check_rollup: "success" },
        { expected_generation: 0 }
      )
    );
    assert.equal(result.failure_class, "stale_task");
  });

  it("malformed input refuses: no event_key, wrong task, non-object evidence", () => {
    const state = initialState(TASK);
    assert.equal(
      applyEvent(state, { task_id: TASK, type: "work_started" }).failure_class,
      "malformed_input"
    );
    assert.equal(
      applyEvent(state, ev("work_started", {}, {})).failure_class,
      "missing_evidence" // evidence object present but empty → field checks
    );
    const wrongTask = { ...ev("work_started", {}), task_id: "f".repeat(32) };
    assert.equal(applyEvent(state, wrongTask).failure_class, "malformed_input");
  });

  it("foldLifecycle collects refusals without advancing state (no silent continuation)", () => {
    const log = [
      HAPPY[0],
      ev(
        "merge_observed",
        { merge_sha: MERGE, observed_via: "gh" },
        { actor: "human" }
      ), // reorder
      HAPPY[1],
    ];
    const { state, refusals } = foldLifecycle(log, TASK);
    assert.equal(state.state, "PR Open");
    assert.equal(refusals.length, 1);
    assert.equal(refusals[0].failure_class, "event_reorder");
  });

  it("every declared failure class is reachable or explicitly exercised", () => {
    // replay_divergence, duplicate_event etc. covered above; this pins the
    // vocabulary so a class cannot be added without a conscious test decision.
    assert.deepEqual(
      [...FAILURE_CLASSES].sort(),
      [
        "api_timeout",
        "authority_violation",
        "ci_failure",
        "duplicate_event",
        "event_reorder",
        "expired_credentials",
        "malformed_input",
        "missing_evidence",
        "missing_pr",
        "missing_relation",
        "partial_write",
        "permission_denial",
        "replay_divergence",
        "stale_sha",
        "stale_task",
      ].sort()
    );
  });
});

describe("TOS-009 authority + mutation plan — fail closed, plan only", () => {
  it("api mode fails closed while the kill switch is engaged, and returns the owner grant when authorized", () => {
    const manifest = loadControlPlaneManifest();
    // Kill-switch state: flag false MUST refuse regardless of what the repo
    // manifest currently says — this is the rollback/disable path.
    const disarmed = structuredClone(manifest);
    disarmed.safety.notionWriteOperationsAuthorized = false;
    delete disarmed.safety.notionWriteAuthorization;
    assert.throws(
      () => assertLiveNotionAuthority(disarmed),
      (error: any) =>
        error instanceof LifecycleError &&
        error.code === "notion-write-unauthorized"
    );
    // Authorized state: authority is returned as the owner's grant descriptor
    // naming the sanctioned write path — never a bare silent true.
    const armed = structuredClone(manifest);
    armed.safety.notionWriteOperationsAuthorized = true;
    armed.safety.notionWriteAuthorization = manifest.safety
      .notionWriteAuthorization ?? {
      decision: "https://app.notion.com/p/3b99673313e781229b85f35a0b9f2966",
      grantedBy: "PREZ",
      grantedOn: "2026-08-11",
      actor: "AI-10",
      scope: "test",
    };
    const authority = assertLiveNotionAuthority(armed);
    assert.equal(authority.authorized, true);
    assert.equal(
      authority.write_path,
      "scripts/tailered-os/lifecycle-writer.mjs"
    );
    // Fully anchored: an unanchored host pattern would accept
    // https://evil.test/app.notion.com/... (CodeQL js/regex/missing-regexp-anchor,
    // alert #453 — a true positive even in a test, since it is the assertion
    // that is supposed to pin the canonical decision URL).
    assert.match(
      String(authority.grant.decision),
      /^https:\/\/app\.notion\.com\/p\/[0-9a-f]{32}$/
    );
  });

  it("the mutation plan is DATA and never claims execution", () => {
    const manifest = loadControlPlaneManifest();
    const { state } = foldHappy();
    const plan = planMutation(state, manifest, "fixture");
    assert.equal(plan.executed, false);
    assert.equal(plan.set_to, "Verified");
    assert.equal(plan.target.property, "Execution State");
    assert.equal(plan.target.database_id, manifest.notion.databases.tasks.id);
    assert.match(plan.reason, /fixture mode — no live authority/);
  });
});
