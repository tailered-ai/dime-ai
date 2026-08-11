// TOS-009 live writer — OG-006 activation battery. Same standard as the
// kernel suites: drive the real deriveWrites/authorizeWrite/executeMutation
// path and prove every gate can FAIL. A writer that cannot refuse is the
// bypass the policy layer exists to prevent.
import assert from "node:assert/strict";
import { describe, it } from "vitest";

import {
  MAX_SNAPSHOT_AGE_MS,
  WHY_BLOCKED_PROPERTY,
  WRITE_ALLOWLIST,
  authorizeWrite,
  buildUndoPlan,
  deriveWrites,
  executeMutation,
} from "./lifecycle-writer.mjs";
import { applyEvent, foldLifecycle, initialState } from "./lifecycle.mjs";
import { loadControlPlaneManifest } from "../tailered-os-control-plane.mjs";

const TASK = "3b89673313e7815aafcaeaebc32ea8ff";
const HEAD = "a".repeat(40);
const MERGE = "b".repeat(40);

// Authority is loaded from DISK by the writer, never passed in, so "armed" is
// simply the committed manifest and the other states are in-repo fixtures
// (only a code-reviewed file can ever grant write authority).
const manifest = loadControlPlaneManifest();
const DISARMED = {
  manifest_path: "scripts/tailered-os/fixtures/control-plane-disarmed.v1.json",
};
const SELF_GRANTED = {
  manifest_path: "scripts/tailered-os/fixtures/control-plane-selfgrant.v1.json",
};

const PROJECT_ID = manifest.notion.taileredOsProject.id;
const fresh = () => Date.now() - 1_000;

const ev = (type: string, evidence: any = {}, extra: any = {}) => ({
  event_key: extra.event_key ?? `${type}-k`,
  task_id: TASK,
  type,
  actor: extra.actor ?? "machine",
  at: "2026-08-11T00:00:00Z",
  evidence,
});

// Fold up to a state + take the last applied record — plans always come from
// the kernel, never hand-built (mirrors production use).
function recordFor(events: any[]) {
  const { state, records, refusals } = foldLifecycle(events, TASK);
  assert.equal(refusals.length, 0, JSON.stringify(refusals));
  return { state, record: records[records.length - 1] };
}

const START = [
  ev("work_started", {
    packet_ref: "packet-1",
    work_link: "https://github.com/tailered-ai/dime-ai/tree/feat/x",
  }),
];

function snapshotFor(plan: any, over: any = {}) {
  return {
    page_id: plan.task_id,
    data_source_id: WRITE_ALLOWLIST.data_source_id,
    scope_id: "TOS-TEST",
    project_ids: [PROJECT_ID],
    execution_state: plan.expected_from_state,
    pending_partial_write: false,
    fetched_at: fresh(),
    properties: {
      "Execution State": plan.expected_from_state,
      "Work Link": "",
      "Proof / Result": "",
      [WHY_BLOCKED_PROPERTY]: "",
    },
    ...over,
  };
}

function authorize(plan: any, over: any = {}, opts: any = {}) {
  return authorizeWrite(plan, snapshotFor(plan, over), opts);
}

// A well-behaved fake transport backed by a mutable record.
function fakeTransport(initial: any) {
  const record = { ...initial };
  return {
    record,
    calls: { update: 0, fetch: 0 },
    async updatePage(_pageId: string, props: any) {
      this.calls.update += 1;
      Object.assign(record, props);
    },
    async fetchTask(_pageId: string) {
      this.calls.fetch += 1;
      return { properties: { ...record }, fetched_at: Date.now() };
    },
  };
}

describe("writer PLAN — derivation is a closed table", () => {
  it("derives Execution State + Work Link for work_started", () => {
    const { state, record } = recordFor(START);
    const derived: any = deriveWrites(record, state);
    assert.equal(derived.ok, true);
    assert.equal(derived.plan.writes["Execution State"], "Executing");
    assert.match(derived.plan.writes["Work Link"], /^https:\/\/github\.com\//);
    assert.equal(derived.plan.expected_from_state, "Ready");
    assert.equal(derived.plan.event_key, record.event_key);
  });

  it("post_merge_verified requires a resolvable https proof for the live write", () => {
    const { state, record } = recordFor(START);
    const fake = {
      ...record,
      trigger: "post_merge_verified",
      evidence: { evidence_ref: "not-a-url" },
    };
    const derived: any = deriveWrites(fake, state);
    assert.equal(derived.ok, false);
    assert.equal(derived.failure_class, "malformed_input");
  });

  it("blocked routing writes the failure class into Why It's Blocked; unblock clears it", () => {
    const blockedEvents = [
      ...START,
      ev("failure_observed", {
        failure_class: "ci_failure",
        detail_ref: "run-123",
      }),
    ];
    const { state, record } = recordFor(blockedEvents);
    const derived: any = deriveWrites(record, state);
    assert.equal(derived.ok, true);
    assert.equal(derived.plan.writes["Execution State"], "Blocked");
    assert.match(
      derived.plan.writes[WHY_BLOCKED_PROPERTY],
      /^ci_failure: run-123/
    );

    const unblocked = [
      ...blockedEvents,
      ev(
        "unblocked",
        { resolution_ref: "fixed", observed_via: "owner note" },
        { actor: "human" }
      ),
    ];
    const after = recordFor(unblocked);
    const cleared: any = deriveWrites(after.record, after.state);
    assert.equal(cleared.ok, true);
    assert.equal(cleared.plan.writes[WHY_BLOCKED_PROPERTY], "");
  });

  it("writer-bookkeeping events never imply a live write", () => {
    const { state, record } = recordFor(START);
    const derived: any = deriveWrites(
      { ...record, trigger: "mutation_result" },
      state
    );
    assert.equal(derived.ok, false);
  });
});

describe("writer AUTHORIZE — the sixteen pre-write gates fail closed", () => {
  const planFor = (events = START) => {
    const { state, record } = recordFor(events);
    const derived: any = deriveWrites(record, state);
    assert.equal(derived.ok, true);
    return derived.plan;
  };

  it("authorizes the valid Ready → Executing mutation (happy path)", () => {
    const result: any = authorize(planFor());
    assert.equal(result.ok, true);
    assert.equal(result.duplicate, false);
    assert.equal(result.authorized_plan.prior["Execution State"], "Ready");
    assert.equal(
      result.authorized_plan.target.data_source_id,
      WRITE_ALLOWLIST.data_source_id
    );
  });

  it("kill switch: manifest flag false refuses every write (rollback path)", () => {
    const result: any = authorize(planFor(), {}, DISARMED);
    assert.equal(result.ok, false);
    assert.equal(result.failure_class, "permission_denial");
    assert.match(result.detail, /notion-write-unauthorized/);
  });

  it("duplicate event_key is a visible idempotent no-op — never a second mutation", () => {
    const plan = planFor();
    const result: any = authorize(
      plan,
      {},
      {
        attested_event_keys: new Set([plan.event_key]),
      }
    );
    assert.equal(result.ok, true);
    assert.equal(result.duplicate, true);
    assert.equal(result.failure_class, "duplicate_event");
    assert.equal(result.authorized_plan, undefined);
  });

  it("stale snapshot age refuses (reread before acting)", () => {
    const result: any = authorize(planFor(), {
      fetched_at: Date.now() - MAX_SNAPSHOT_AGE_MS - 5_000,
    });
    assert.equal(result.ok, false);
    assert.equal(result.failure_class, "stale_task");
  });

  it("unprovable freshness refuses — missing fetched_at is stale, not fresh", () => {
    const result: any = authorize(planFor(), { fetched_at: undefined });
    assert.equal(result.ok, false);
    assert.equal(result.failure_class, "stale_task");
  });

  it("live state drift refuses: snapshot state ≠ expected from-state", () => {
    const result: any = authorize(planFor(), { execution_state: "PR Open" });
    assert.equal(result.ok, false);
    assert.equal(result.failure_class, "stale_task");
    assert.match(result.detail, /the record moved/);
  });

  it("cross-database write refuses (wrong data source)", () => {
    const result: any = authorize(planFor(), { data_source_id: "deadbeef" });
    assert.equal(result.ok, false);
    assert.equal(result.failure_class, "permission_denial");
  });

  it("cross-task write refuses (non-TOS scope id)", () => {
    const result: any = authorize(planFor(), { scope_id: "DIME-42" });
    assert.equal(result.ok, false);
    assert.equal(result.failure_class, "permission_denial");
  });

  it("cross-project write refuses (task outside the canonical project)", () => {
    const result: any = authorize(planFor(), { project_ids: ["f".repeat(32)] });
    assert.equal(result.ok, false);
    assert.equal(result.failure_class, "permission_denial");
  });

  it("human-authority transitions demand an observed human act — machine actor hard-fails", () => {
    const events = [
      ...START,
      ev("pr_opened", { pr_number: 507, head_sha: HEAD }),
      ev("checks_observed", { head_sha: HEAD, check_rollup: "success" }),
      ev("review_requested", { review_ref: "rr-1" }),
      ev(
        "approval_observed",
        {
          reviewer: "PREZ",
          review_id: "R-1",
          review_state: "APPROVED",
          observed_via: "gh api pulls/507/reviews",
        },
        { actor: "human" }
      ),
    ];
    const plan = planFor(events);
    // Tamper: claim the approval was machine-actored (spoofed observation).
    const spoofed = { ...plan, actor: "machine" };
    const result: any = authorize(spoofed);
    assert.equal(result.ok, false);
    assert.equal(result.failure_class, "authority_violation");

    // Tamper: strip the observed_via evidence.
    const unobserved = {
      ...plan,
      evidence: { ...plan.evidence, observed_via: "" },
    };
    const result2: any = authorize(unobserved);
    assert.equal(result2.ok, false);
    assert.equal(result2.failure_class, "authority_violation");
  });

  it("plans cannot reinterpret authority — a human row claimed as machine refuses", () => {
    const events = [
      ...START,
      ev("pr_opened", { pr_number: 507, head_sha: HEAD }),
      ev("checks_observed", { head_sha: HEAD, check_rollup: "success" }),
      ev("review_requested", { review_ref: "rr-1" }),
      ev(
        "approval_observed",
        {
          reviewer: "PREZ",
          review_id: "R-1",
          review_state: "APPROVED",
          observed_via: "gh api pulls/507/reviews",
        },
        { actor: "human" }
      ),
    ];
    const plan = planFor(events);
    const tampered = { ...plan, authority: "machine" };
    const result: any = authorize(tampered);
    assert.equal(result.ok, false);
    assert.equal(result.failure_class, "authority_violation");
  });

  it("pr/merge-evidence writes demand a LIVE GitHub cross-check; stale SHA refuses", () => {
    const events = [
      ...START,
      ev("pr_opened", { pr_number: 507, head_sha: HEAD }),
    ];
    const plan = planFor(events);
    // No live cross-check provided at all → refuse.
    const missing: any = authorize(plan);
    assert.equal(missing.ok, false);
    assert.equal(missing.failure_class, "missing_evidence");
    // Live head moved → stale_sha.
    const stale: any = authorize(
      plan,
      {},
      { github: { head_sha: "c".repeat(40) } }
    );
    assert.equal(stale.ok, false);
    assert.equal(stale.failure_class, "stale_sha");
    // Matching live head → authorized.
    const fresh: any = authorize(plan, {}, { github: { head_sha: HEAD } });
    assert.equal(fresh.ok, true);
  });

  it("superseded merge evidence refuses against live GitHub", () => {
    const events = [
      ...START,
      ev("pr_opened", { pr_number: 507, head_sha: HEAD }),
      ev("checks_observed", { head_sha: HEAD, check_rollup: "success" }),
      ev("review_requested", { review_ref: "rr-1" }),
      ev(
        "approval_observed",
        {
          reviewer: "PREZ",
          review_id: "R-1",
          review_state: "APPROVED",
          observed_via: "gh api pulls/507/reviews",
        },
        { actor: "human" }
      ),
      ev(
        "merge_observed",
        { merge_sha: MERGE, observed_via: "gh pr view 507" },
        { actor: "human" }
      ),
    ];
    const plan = planFor(events);
    const stale: any = authorize(
      plan,
      {},
      { github: { merge_sha: "d".repeat(40) } }
    );
    assert.equal(stale.ok, false);
    assert.equal(stale.failure_class, "stale_sha");
  });

  it("non-allowlisted property refuses — the writer cannot be steered off-allowlist", () => {
    const plan = planFor();
    const tampered = {
      ...plan,
      writes: { ...plan.writes, Owner: "attacker" },
    };
    const result: any = authorize(tampered);
    assert.equal(result.ok, false);
    assert.equal(result.failure_class, "permission_denial");
    assert.match(result.detail, /not allowlisted/);
  });

  it("off-vocabulary Execution State and credential-shaped values refuse", () => {
    const plan = planFor();
    const badState: any = authorize({
      ...plan,
      writes: { "Execution State": "Approved-by-bot" },
    });
    assert.equal(badState.ok, false);

    const secretish: any = authorize({
      ...plan,
      writes: { ...plan.writes, "Work Link": "https://x.test/sk_live_abcdef" },
    });
    assert.equal(secretish.ok, false);
  });

  it("unresolved partial-write freeze blocks all writes until reverified", () => {
    const result: any = authorize(
      planFor(),
      {},
      { pending_partial_write: true }
    );
    assert.equal(result.ok, false);
    assert.equal(result.failure_class, "partial_write");
  });

  it("unresolved connector failure (expired credentials) blocks all writes", () => {
    const result: any = authorize(
      planFor(),
      {},
      {
        connector_failure: {
          failure_class: "expired_credentials",
          detail: "OAuth token expired at 12:00Z",
        },
      }
    );
    assert.equal(result.ok, false);
    assert.equal(result.failure_class, "expired_credentials");
  });
});

describe("writer EXECUTE — write / reread / compare / attest", () => {
  const authorizedPlan = (events = START, opts: any = {}) => {
    const { state, record } = recordFor(events);
    const derived: any = deriveWrites(record, state);
    const result: any = authorize(derived.plan, opts.snapshot ?? {}, opts);
    assert.equal(result.ok, true, JSON.stringify(result));
    return result.authorized_plan;
  };

  it("refuses to execute a plan that never passed authorizeWrite", async () => {
    const { state, record } = recordFor(START);
    const derived: any = deriveWrites(record, state);
    await assert.rejects(
      () => executeMutation(derived.plan, fakeTransport({})),
      /writer-unauthorized-plan/
    );
  });

  it("full write: transport lands every property, reread matches, attestation says full", async () => {
    const plan = authorizedPlan();
    const transport = fakeTransport({
      "Execution State": "Ready",
      "Work Link": "",
      "Proof / Result": "",
      [WHY_BLOCKED_PROPERTY]: "",
    });
    const result = await executeMutation(plan, transport);
    assert.equal(result.applied, "full");
    assert.equal(transport.calls.update, 1);
    assert.equal(transport.calls.fetch, 1);
    assert.equal(
      result.attestation.observed_after["Execution State"],
      "Executing"
    );
    assert.equal(result.attestation.prior_values["Execution State"], "Ready");
    assert.equal(result.attestation.event_key, plan.event_key);
  });

  it("partial write: reread mismatch freezes — applied partial, mismatches named", async () => {
    const plan = authorizedPlan();
    const transport = fakeTransport({ "Execution State": "Ready" });
    // Sabotage: the transport silently drops the Work Link write.
    const realUpdate = transport.updatePage.bind(transport);
    transport.updatePage = async (pageId: string, props: any) => {
      const { "Work Link": _dropped, ...rest } = props;
      await realUpdate(pageId, rest);
    };
    const result = await executeMutation(plan, transport);
    assert.equal(result.applied, "partial");
    assert.equal(result.failure_class, "partial_write");
    assert.equal(result.attestation.mismatches.length, 1);
    assert.equal(result.attestation.mismatches[0].property, "Work Link");
  });

  it("permission denial before any byte lands: applied none, record verified unchanged", async () => {
    const plan = authorizedPlan();
    const transport = fakeTransport({
      "Execution State": "Ready",
      "Work Link": "",
    });
    transport.updatePage = async () => {
      const err: any = new Error("permission denied by connector");
      err.code = "permission_denied_403";
      throw err;
    };
    const result = await executeMutation(plan, transport);
    assert.equal(result.applied, "none");
    assert.equal(result.failure_class, "permission_denial");
    assert.equal(transport.record["Execution State"], "Ready");
  });

  it("timeout with unreadable outcome fails closed as partial (freeze), never assumed success", async () => {
    const plan = authorizedPlan();
    const transport = fakeTransport({});
    transport.updatePage = async () => {
      const err: any = new Error("ETIMEDOUT");
      err.code = "ETIMEDOUT";
      throw err;
    };
    transport.fetchTask = async () => {
      const err: any = new Error("ETIMEDOUT");
      err.code = "ETIMEDOUT";
      throw err;
    };
    const result = await executeMutation(plan, transport);
    assert.equal(result.applied, "partial");
    assert.equal(result.failure_class, "partial_write");
    assert.equal(result.attestation.reread_error, "api_timeout");
  });

  it("expired credentials are classified and visible", async () => {
    const plan = authorizedPlan();
    const transport = fakeTransport({
      "Execution State": "Ready",
      "Work Link": "",
    });
    transport.updatePage = async () => {
      const err: any = new Error("credential expired (401)");
      err.code = "401_expired_credentials";
      throw err;
    };
    const result = await executeMutation(plan, transport);
    assert.equal(result.applied, "none");
    assert.equal(result.failure_class, "expired_credentials");
  });

  it("undo plan writes the captured priors back (reversibility is concrete)", async () => {
    const plan = authorizedPlan();
    const undo: any = buildUndoPlan(plan);
    assert.equal(undo.ok, true);
    assert.equal(undo.plan.writes["Execution State"], "Ready");
    assert.equal(undo.plan.writes["Work Link"], "");
    assert.equal(undo.plan.expected_from_state, "Executing");
  });
});

// Adversarial-review regressions (independent refutation, 2026-08-11). Each of
// these FAILED against the pre-remediation writer; they are the proof the
// findings are closed, not the claim.
describe("writer v1.1 — adversarial regressions", () => {
  const planFor = (events = START) => {
    const { state, record } = recordFor(events);
    const derived: any = deriveWrites(record, state);
    assert.equal(derived.ok, true);
    return derived.plan;
  };

  it("FIND-OG6-0001: the authorized plan is DEEP-frozen and un-aliased — post-authorization tampering cannot reach the transport", async () => {
    const plan = planFor();
    const result: any = authorize(plan);
    const ap = result.authorized_plan;
    assert.equal(Object.isFrozen(ap), true);
    assert.equal(Object.isFrozen(ap.writes), true, "writes must be frozen");
    assert.equal(Object.isFrozen(ap.evidence), true, "evidence must be frozen");
    assert.equal(Object.isFrozen(ap.prior), true);
    // Un-aliased: mutating the ORIGINAL plan's writes must not touch the
    // authorized capability.
    plan.writes["Owner"] = "attacker";
    assert.equal(ap.writes.Owner, undefined);
    // And the frozen copy silently ignores (non-strict) or throws (strict) —
    // either way the value never appears.
    try {
      (ap.writes as any)["Owner"] = "attacker";
    } catch {
      /* strict-mode TypeError is the stronger outcome */
    }
    assert.equal(ap.writes.Owner, undefined);
    // End-to-end: the transport only ever sees allowlisted properties.
    const transport = fakeTransport({
      "Execution State": "Ready",
      "Work Link": "",
    });
    const sent: any[] = [];
    const inner = transport.updatePage.bind(transport);
    transport.updatePage = async (pageId: string, props: any) => {
      sent.push(props);
      await inner(pageId, props);
    };
    await executeMutation(ap, transport);
    assert.deepEqual(Object.keys(sent[0]).sort(), [
      "Execution State",
      "Work Link",
    ]);
  });

  it("FIND-OG6-0001b: a tampered plan reaching executeMutation throws writer-plan-tampered (trust-boundary re-validation)", async () => {
    const plan = planFor();
    const result: any = authorize(plan);
    // Simulate a serialize/queue/handoff that reconstitutes a mutable plan —
    // exactly the phased PLAN → AUTHORIZE → WRITE pattern the design implies.
    const rehydrated = {
      ...JSON.parse(JSON.stringify(result.authorized_plan)),
      prior: { ...result.authorized_plan.prior },
    };
    rehydrated.writes["Owner"] = "attacker";
    const transport = fakeTransport({ "Execution State": "Ready" });
    // Since v1.2 this is caught even earlier: a rehydrated plan is not the
    // registered capability, so authenticity fails before the tamper check
    // (which remains as belt-and-braces for a mutated capability).
    await assert.rejects(
      () => executeMutation(rehydrated, transport),
      /writer-unauthorized-plan|writer-plan-tampered/
    );
    assert.equal(transport.calls.update, 0, "nothing may be sent");
  });

  it("FIND-OG6-0002: prototype-chain property names are NOT allowlisted (own-property check)", () => {
    const plan = planFor();
    for (const name of [
      "__proto__",
      "constructor",
      "toString",
      "hasOwnProperty",
    ]) {
      const tampered = {
        ...plan,
        writes: JSON.parse(
          JSON.stringify({ ...plan.writes, [name]: "attacker" })
        ),
      };
      const result: any = authorize(tampered);
      assert.equal(result.ok, false, `${name} must refuse`);
      assert.equal(result.failure_class, "permission_denial");
    }
  });

  it("FIND-OG6-0003 / NEW-OG6-0007: authority comes from DISK — a caller cannot assert its own permission", () => {
    const plan = planFor();
    // There is no manifest parameter at all: the writer loads and validates the
    // control-plane manifest itself on every write. A self-granted file (bare
    // true, no owner grant) is refused because the loader rejects it.
    const selfGrant: any = authorize(plan, {}, SELF_GRANTED);
    assert.equal(selfGrant.ok, false);
    assert.equal(selfGrant.failure_class, "permission_denial");
    assert.match(selfGrant.detail, /failed validation/);

    // Authority may only come from an in-repo, code-reviewed file: a path that
    // escapes the repository is refused before anything is read.
    const escaped: any = authorize(
      plan,
      {},
      {
        manifest_path: "../../../tmp/forged-manifest.json",
      }
    );
    assert.equal(escaped.ok, false);
    assert.equal(escaped.failure_class, "permission_denial");
    assert.match(escaped.detail, /outside the repository/);
  });

  it("FIND-OG6-0004: the undo plan AUTHORIZES and executes through the same contract (reversibility is real)", async () => {
    // Do the forward write.
    const plan = planFor();
    const forward: any = authorize(plan);
    const transport = fakeTransport({
      "Execution State": "Ready",
      "Work Link": "",
      "Proof / Result": "",
      [WHY_BLOCKED_PROPERTY]: "",
    });
    const applied = await executeMutation(forward.authorized_plan, transport);
    assert.equal(applied.applied, "full");
    assert.equal(transport.record["Execution State"], "Executing");

    // Now undo it — same authorize gauntlet, no special path.
    const undo: any = buildUndoPlan(forward.authorized_plan);
    assert.equal(undo.ok, true);
    const undoAuth: any = authorizeWrite(
      undo.plan,
      {
        page_id: TASK,
        data_source_id: WRITE_ALLOWLIST.data_source_id,
        scope_id: "TOS-TEST",
        project_ids: [PROJECT_ID],
        execution_state: "Executing", // the state the forward write produced
        pending_partial_write: false,
        fetched_at: fresh(),
        properties: { ...transport.record },
      },
      { undo_of: forward.authorized_plan }
    );
    assert.equal(undoAuth.ok, true, JSON.stringify(undoAuth));
    const undone = await executeMutation(undoAuth.authorized_plan, transport);
    assert.equal(undone.applied, "full");
    assert.equal(transport.record["Execution State"], "Ready");
    assert.equal(transport.record["Work Link"], "");
  });

  it("undo must be BOUND to a real prior authorization — write_reverified cannot launder arbitrary state", () => {
    const plan = planFor();
    const forward: any = authorize(plan);
    const liveSnapshot = {
      page_id: TASK,
      data_source_id: WRITE_ALLOWLIST.data_source_id,
      scope_id: "TOS-TEST",
      project_ids: [PROJECT_ID],
      execution_state: "Executing",
      pending_partial_write: false,
      fetched_at: fresh(),
      properties: {
        "Execution State": "Executing",
        "Work Link": "https://github.com/tailered-ai/dime-ai/tree/feat/x",
      },
    };

    // (a) An unbound undo — no opts.undo_of — refuses.
    const undo: any = buildUndoPlan(forward.authorized_plan);
    const unbound: any = authorizeWrite(undo.plan, liveSnapshot, {});
    assert.equal(unbound.ok, false);
    assert.equal(unbound.failure_class, "permission_denial");

    // (b) A FORGED write_reverified that jumps the record straight to
    //     "Verified" — the sequencing-laundering attack — refuses even when it
    //     names a real prior authorization.
    const forged = {
      ...undo.plan,
      writes: { "Execution State": "Verified" },
    };
    const laundering: any = authorizeWrite(forged, liveSnapshot, {
      undo_of: forward.authorized_plan,
    });
    assert.equal(laundering.ok, false);
    assert.equal(laundering.failure_class, "permission_denial");
    assert.match(laundering.detail, /restore EXACTLY the prior values/);

    // (c) A write_reverified that is not an undo at all refuses.
    const notAnUndo: any = authorizeWrite(
      { ...undo.plan, plan_id: "plan:sneaky" },
      liveSnapshot,
      { undo_of: forward.authorized_plan }
    );
    assert.equal(notAnUndo.ok, false);

    // (d) The genuine bound undo still authorizes.
    const bound: any = authorizeWrite(undo.plan, liveSnapshot, {
      undo_of: forward.authorized_plan,
    });
    assert.equal(bound.ok, true, JSON.stringify(bound));
  });
});

// Second independent-verification round (verdict FAIL) found the CLASS behind
// the HIGH was still open. These regressions cover its findings; each fails
// against the module the verifier attacked.
describe("writer v1.2 — independent-verification regressions", () => {
  const planFor = (events = START) => {
    const { state, record } = recordFor(events);
    const derived: any = deriveWrites(record, state);
    assert.equal(derived.ok, true);
    return derived.plan;
  };

  it("NEW-OG6-0005: a FORGED capability cannot execute — authenticity is registry membership, not object shape", async () => {
    const transport = fakeTransport({ "Execution State": "Ready" });
    // The exact shape the old check accepted: any object with a `prior` key.
    const forged = {
      schema_version: 1,
      plan_id: "plan:forged",
      event_key: "forged",
      task_id: TASK,
      trigger: "post_merge_verified",
      authority: "machine",
      actor: "machine",
      evidence: {},
      expected_from_state: "Merged",
      writes: {
        "Execution State": "Verified",
        "Proof / Result": "https://attacker.example/fake-proof",
      },
      prior: {},
      target: {
        data_source_id: WRITE_ALLOWLIST.data_source_id,
        page_id: "SOME-OTHER-PAGE",
      },
    };
    await assert.rejects(
      () => executeMutation(forged as any, transport),
      /writer-unauthorized-plan/
    );
    assert.equal(transport.calls.update, 0, "no byte may be sent");
    // A structural clone of a REAL capability is also not the capability.
    const real: any = authorize(planFor());
    const cloned = JSON.parse(JSON.stringify(real.authorized_plan));
    await assert.rejects(
      () => executeMutation(cloned, transport),
      /writer-unauthorized-plan/
    );
    assert.equal(transport.calls.update, 0);
  });

  it("NEW-OG6-0006: a getter/Proxy write map is read ONCE — it cannot show the validator one thing and the transport another", async () => {
    const plan = planFor();
    let reads = 0;
    const twoFaced: any = {};
    Object.defineProperty(twoFaced, "Execution State", {
      enumerable: true,
      get() {
        reads += 1;
        return reads === 1 ? "Executing" : "Verified";
      },
    });
    const result: any = authorize({ ...plan, writes: twoFaced });
    // Whatever the verdict, the capability must hold the value that was
    // validated — never a second, unvalidated read.
    if (result.ok) {
      assert.equal(
        result.authorized_plan.writes["Execution State"],
        "Executing"
      );
      const transport = fakeTransport({ "Execution State": "Ready" });
      const sent: any[] = [];
      const inner = transport.updatePage.bind(transport);
      transport.updatePage = async (pageId: string, props: any) => {
        sent.push({ ...props });
        await inner(pageId, props);
      };
      await executeMutation(result.authorized_plan, transport);
      assert.equal(sent[0]["Execution State"], "Executing");
    } else {
      assert.equal(result.failure_class, "permission_denial");
    }

    // A Proxy that adds a key only on the second ownKeys() cannot smuggle it.
    const sneaky = new Proxy(
      { "Execution State": "Executing" },
      {
        ownKeys(target) {
          reads += 1;
          return reads > 2
            ? [...Reflect.ownKeys(target), "Owner"]
            : Reflect.ownKeys(target);
        },
        getOwnPropertyDescriptor(target, key) {
          return key === "Owner"
            ? { value: "attacker", enumerable: true, configurable: true }
            : Reflect.getOwnPropertyDescriptor(target, key);
        },
        get(target, key) {
          return key === "Owner" ? "attacker" : (target as any)[key];
        },
      }
    );
    const proxied: any = authorize({ ...plan, writes: sneaky });
    if (proxied.ok) {
      assert.equal(
        Object.hasOwn(proxied.authorized_plan.writes, "Owner"),
        false,
        "a late-appearing key must never reach the capability"
      );
      const transport2 = fakeTransport({ "Execution State": "Ready" });
      const sent2: any[] = [];
      const inner2 = transport2.updatePage.bind(transport2);
      transport2.updatePage = async (pageId: string, props: any) => {
        sent2.push({ ...props });
        await inner2(pageId, props);
      };
      await executeMutation(proxied.authorized_plan, transport2);
      assert.equal(Object.hasOwn(sent2[0], "Owner"), false);
    }
  });

  it("NEW-OG6-0008: write_reverified is not a general write primitive — it cannot launder a record to Merged or Verified", () => {
    const plan = planFor();
    const forward: any = authorize(plan);
    for (const target of ["Verified", "Merged", "Approval"]) {
      const laundering = {
        ...plan,
        plan_id: "undo:plan:laundering",
        trigger: "write_reverified",
        authority: "machine",
        actor: "machine",
        evidence: { verification_ref: "x" },
        expected_from_state: "Ready",
        writes: { "Execution State": target },
      };
      const result: any = authorize(
        laundering,
        {},
        {
          undo_of: forward.authorized_plan,
        }
      );
      assert.equal(result.ok, false, `${target} must refuse`);
    }
  });

  it("NEW-OG6-0009: deepFreeze survives cycles and never freezes caller-owned graphs", () => {
    const plan = planFor();
    const shared: any = { keepMutable: true };
    shared.self = shared; // cycle
    const result: any = authorize({
      ...plan,
      evidence: { ...plan.evidence, shared },
    });
    assert.equal(result.ok, true);
    // No stack overflow, and the caller's object stays mutable.
    shared.keepMutable = false;
    assert.equal(shared.keepMutable, false);
    assert.equal(Object.isFrozen(shared), false);
  });

  it("NEW-OG6-0010: symbol-keyed writes are refused outright", () => {
    const plan = planFor();
    const withSymbol: any = { ...plan.writes };
    withSymbol[Symbol("Owner")] = "attacker";
    const result: any = authorize({ ...plan, writes: withSymbol });
    assert.equal(result.ok, false);
    assert.equal(result.failure_class, "malformed_input");
    assert.match(result.detail, /symbol-keyed/);
  });

  it("NEW-OG6-0011: an undo can restore a previously EMPTY select value", async () => {
    const plan = planFor();
    // Live record whose Execution State is empty (a fresh row).
    const emptySnapshot = {
      page_id: TASK,
      data_source_id: WRITE_ALLOWLIST.data_source_id,
      scope_id: "TOS-TEST",
      project_ids: [PROJECT_ID],
      execution_state: "Ready",
      pending_partial_write: false,
      fetched_at: fresh(),
      properties: { "Execution State": "", "Work Link": "" },
    };
    const forward: any = authorizeWrite(plan, emptySnapshot, {});
    assert.equal(forward.ok, true, JSON.stringify(forward));
    assert.equal(forward.authorized_plan.prior["Execution State"], "");
    const undo: any = buildUndoPlan(forward.authorized_plan);
    const undoAuth: any = authorizeWrite(
      undo.plan,
      {
        ...emptySnapshot,
        execution_state: "Executing",
        fetched_at: fresh(),
        properties: {
          "Execution State": "Executing",
          "Work Link": plan.writes["Work Link"],
        },
      },
      { undo_of: forward.authorized_plan }
    );
    assert.equal(undoAuth.ok, true, JSON.stringify(undoAuth));
    assert.equal(undoAuth.authorized_plan.writes["Execution State"], "");
  });

  it("NEW-OG6-0012: the freshness bound cannot be widened by the caller, and attested keys must be a real Set", () => {
    const plan = planFor();
    const ancient: any = authorize(
      plan,
      { fetched_at: 0 },
      { max_snapshot_age_ms: Number.MAX_SAFE_INTEGER }
    );
    assert.equal(ancient.ok, false);
    assert.equal(ancient.failure_class, "stale_task");

    const duckTyped: any = authorize(
      plan,
      {},
      {
        attested_event_keys: { has: () => false },
      }
    );
    assert.equal(duckTyped.ok, false);
    assert.equal(duckTyped.failure_class, "malformed_input");
  });
});

describe("writer + kernel — replay and freeze compose", () => {
  it("full event replay reconstructs the same final state, and duplicates never double-mutate", () => {
    const events = [
      ...START,
      ev("pr_opened", { pr_number: 507, head_sha: HEAD }),
      ev("checks_observed", { head_sha: HEAD, check_rollup: "success" }),
    ];
    const a = foldLifecycle(events, TASK);
    const b = foldLifecycle(events, TASK);
    assert.deepEqual(a.state, b.state);
    // Duplicate transport delivery of the same event: kernel says duplicate,
    // writer's attested-keys gate says duplicate — no second mutation either way.
    const dup = applyEvent(a.state, events[2]);
    assert.equal(dup.ok, true);
    assert.equal((dup as any).duplicate, true);
  });

  it("after a partial write the kernel freezes; write_reverified reopens; the writer honors both", () => {
    let state = initialState(TASK);
    for (const event of START) {
      const r: any = applyEvent(state, event);
      state = r.state;
    }
    const partial: any = applyEvent(
      state,
      ev("mutation_result", {
        plan_ref: "plan:work_started-k",
        applied: "partial",
      })
    );
    assert.equal(partial.ok, true);
    state = partial.state;
    assert.equal(state.pending_partial_write, true);
    // Kernel refuses further transitions.
    const advance: any = applyEvent(
      state,
      ev("pr_opened", { pr_number: 1, head_sha: HEAD })
    );
    assert.equal(advance.ok, false);
    assert.equal(advance.failure_class, "partial_write");
    // Writer refuses too (gate 15) — defense in depth.
    const { record } = recordFor(START);
    const derived: any = deriveWrites(record, {
      ...state,
      state: "Ready",
      task_id: TASK,
    });
    // (derivation is from the pre-partial record; authorization must still refuse)
    const auth: any = authorizeWrite(
      derived.ok ? derived.plan : record,
      {
        page_id: TASK,
        data_source_id: WRITE_ALLOWLIST.data_source_id,
        scope_id: "TOS-TEST",
        project_ids: [PROJECT_ID],
        execution_state: "Ready",
        pending_partial_write: true,
        fetched_at: fresh(),
        properties: { "Execution State": "Ready", "Work Link": "" },
      },
      {}
    );
    assert.equal(auth.ok, false);
    assert.equal(auth.failure_class, "partial_write");
    // Human-visible recovery: write_reverified reopens the kernel.
    const reopened: any = applyEvent(
      state,
      ev("write_reverified", {
        verification_ref: "reread-attestation-1",
      })
    );
    assert.equal(reopened.ok, true);
    assert.equal(reopened.state.pending_partial_write, false);
  });
});
