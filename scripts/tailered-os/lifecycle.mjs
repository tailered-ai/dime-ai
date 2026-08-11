// TOS-009 — Task execution lifecycle engine.
//
// A pure, event-driven state machine over the Notion Task "Execution State"
// vocabulary (config/tailered-os-control-plane.v1.json → Tasks database). Events
// are OBSERVED external facts (a PR opened, a check rollup, a human review
// approval, a merge SHA); the engine folds them into a lifecycle state and a
// Notion MUTATION PLAN. It never performs approval, merge, or deploy — those
// are human acts it may only record from evidence — and in fixture mode it
// never claims to have written anything (executed: false, always).
//
// Laws this file enforces (Campaign Four directive §35–§37):
//   - controlled transition table; authority "human" transitions require an
//     observed human fact, never a machine-initiated event;
//   - idempotent + replay-safe: duplicate event_keys are visible no-ops,
//     out-of-order events refuse loudly naming the expected from-state, and
//     foldLifecycle(events) is deterministic (record.at comes from the event,
//     never from the wall clock — NO transition fires because time passed);
//   - every transition demands its evidence fields; absence = refusal, not
//     inference; refusals are visible values, never silent continuation;
//   - failures that invalidate the happy path route to Blocked with the
//     failure class recorded (route_to_blocked), everything else refuses;
//   - mode "api" fails CLOSED: headless sessions hold no live Notion write
//     authority (manifest safety.notionWriteOperationsAuthorized === false).
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadControlPlaneManifest } from "../tailered-os-control-plane.mjs";

export const LIFECYCLE_SCHEMA_VERSION = 1;

// The nine Execution State options of the canonical Tasks database — a
// controlled vocabulary; the engine never invents a tenth.
export const LIFECYCLE_STATES = Object.freeze([
  "Ready",
  "Executing",
  "PR Open",
  "CI",
  "Review",
  "Approval",
  "Merged",
  "Blocked",
  "Verified",
]);

// §37 failure law — every refusal carries exactly one of these classes.
export const FAILURE_CLASSES = Object.freeze([
  "duplicate_event", // idempotent no-op (surfaced as ok:true, duplicate:true)
  "event_reorder",
  "replay_divergence",
  "missing_relation",
  "missing_evidence",
  "stale_task",
  "missing_pr",
  "stale_sha",
  "ci_failure",
  "authority_violation",
  "permission_denial",
  "api_timeout",
  "partial_write",
  "malformed_input",
  "expired_credentials",
]);

const SHA40 = /^[0-9a-f]{40}$/;
const CHECK_ROLLUPS = Object.freeze(["pending", "success", "failure"]);
const AUTHORITY_FAILURES = Object.freeze([
  "permission_denial",
  "api_timeout",
  "expired_credentials",
]);

// Controlled transition table. from "*" = any non-Blocked state; to null =
// dynamic (unblocked returns to the state recorded when the task was blocked;
// annotation triggers keep the current state). authority "human" transitions
// can only be RECORDED from an observed external fact (actor "human" +
// observed_via evidence) — the engine may never initiate them.
export const TRANSITIONS = Object.freeze(
  [
    {
      from: "Ready",
      to: "Executing",
      trigger_event_type: "work_started",
      required_evidence_fields: ["packet_ref", "work_link"],
      authority: "machine",
    },
    {
      from: "Executing",
      to: "PR Open",
      trigger_event_type: "pr_opened",
      required_evidence_fields: ["pr_number", "head_sha"],
      authority: "machine",
    },
    {
      from: "PR Open",
      to: "CI",
      trigger_event_type: "checks_observed",
      required_evidence_fields: ["head_sha", "check_rollup"],
      authority: "machine",
    },
    {
      // Re-observation while checks settle; a "failure" rollup routes to
      // Blocked (ci_failure) instead — see applyEvent.
      from: "CI",
      to: "CI",
      trigger_event_type: "checks_observed",
      required_evidence_fields: ["head_sha", "check_rollup"],
      authority: "machine",
    },
    {
      from: "CI",
      to: "Review",
      trigger_event_type: "review_requested",
      required_evidence_fields: ["review_ref"],
      authority: "machine",
    },
    {
      from: "Review",
      to: "Approval",
      trigger_event_type: "approval_observed",
      required_evidence_fields: [
        "reviewer",
        "review_id",
        "review_state",
        "observed_via",
      ],
      authority: "human",
    },
    {
      from: "Approval",
      to: "Merged",
      trigger_event_type: "merge_observed",
      required_evidence_fields: ["merge_sha", "observed_via"],
      authority: "human",
    },
    {
      // Deploy/No-Deploy CONSEQUENCE of the human merge, observed post-fact
      // (merging dime-ai main IS a production deploy — deploy law).
      from: "Merged",
      to: "Merged",
      trigger_event_type: "deploy_consequence_recorded",
      required_evidence_fields: ["deploy_decision", "consequence_ref"],
      authority: "machine",
    },
    {
      from: "Merged",
      to: "Verified",
      trigger_event_type: "post_merge_verified",
      required_evidence_fields: ["evidence_ref"],
      authority: "machine",
    },
    {
      from: "Verified",
      to: "Verified",
      trigger_event_type: "learning_captured",
      required_evidence_fields: ["learning_ref"],
      authority: "machine",
    },
    {
      from: "*",
      to: "Blocked",
      trigger_event_type: "failure_observed",
      required_evidence_fields: ["failure_class", "detail_ref"],
      authority: "machine",
    },
    {
      from: "Blocked",
      to: null, // returns to the recorded blocked_from state
      trigger_event_type: "unblocked",
      required_evidence_fields: ["resolution_ref", "observed_via"],
      authority: "human",
    },
    {
      // Result of attempting a previously planned Notion mutation. applied
      // "partial" freezes further transitions until write_reverified (§37).
      from: "*",
      to: null,
      trigger_event_type: "mutation_result",
      required_evidence_fields: ["plan_ref", "applied"],
      authority: "machine",
    },
    {
      from: "*",
      to: null,
      trigger_event_type: "write_reverified",
      required_evidence_fields: ["verification_ref"],
      authority: "machine",
    },
  ].map(Object.freeze)
);

export class LifecycleError extends Error {
  constructor(code, what, why, fix) {
    super(`${code}: ${what}`);
    this.code = code;
    this.what = what;
    this.why = why;
    this.fix = fix;
  }
  render() {
    return `TOS-009 lifecycle failed — ${this.code}\n  What: ${this.what}\n  Why it matters: ${this.why}\n  Fix: ${this.fix}`;
  }
}

export function initialState(taskId) {
  return {
    schema_version: LIFECYCLE_SCHEMA_VERSION,
    task_id: taskId,
    state: "Ready",
    generation: 0,
    applied_event_keys: [],
    packet_ref: null,
    work_link: null,
    pr: null, // { number, head_sha }
    ci: null, // { head_sha, check_rollup, observed_at }
    review_ref: null,
    approval: null, // { reviewer, review_id, observed_via }
    merge_sha: null,
    deploy_decision: null, // "deploy" | "no-deploy"
    consequence_ref: null,
    evidence_ref: null,
    learning_ref: null,
    blocked_from: null,
    blocked_failure_class: null,
    blocked_detail: null,
    pending_partial_write: false,
    records: [], // observable transition log: {task_id, from, to, trigger, evidence, actor, at, generation, event_key}
  };
}

function refuse(failureClass, detail) {
  return { ok: false, failure_class: failureClass, detail };
}

function isNonEmpty(value) {
  return value !== undefined && value !== null && value !== "";
}

// Class per missing evidence field: the directive names missing_relation
// (Work Link) and missing_pr specially; everything else is missing_evidence.
function missingEvidenceClass(trigger, field) {
  if (trigger === "work_started" && field === "work_link")
    return "missing_relation";
  if (trigger === "pr_opened") return "missing_pr";
  return "missing_evidence";
}

// Pure. Applies one observed event to a lifecycle state. Never mutates its
// inputs; never consults the wall clock; refusals are returned, not thrown.
export function applyEvent(state, event) {
  // ---- malformed input (before anything else, fail closed) ----
  if (state === null || typeof state !== "object" || !state.task_id)
    return refuse("malformed_input", "state is not a lifecycle state object.");
  if (event === null || typeof event !== "object")
    return refuse("malformed_input", "event is not an object.");
  if (typeof event.event_key !== "string" || event.event_key === "")
    return refuse(
      "malformed_input",
      "event has no event_key — dedup and replay safety depend on it."
    );
  if (typeof event.type !== "string" || event.type === "")
    return refuse("malformed_input", `event ${event.event_key} has no type.`);
  if (event.task_id !== state.task_id)
    return refuse(
      "malformed_input",
      `event ${event.event_key} references task ${event.task_id ?? "(none)"}, but this state is task ${state.task_id}.`
    );
  const actor = event.actor ?? "machine";
  if (actor !== "machine" && actor !== "human")
    return refuse(
      "malformed_input",
      `event ${event.event_key} actor "${event.actor}" is not "machine" or "human".`
    );
  const evidence = event.evidence ?? {};
  if (typeof evidence !== "object" || Array.isArray(evidence))
    return refuse(
      "malformed_input",
      `event ${event.event_key} evidence is not an object.`
    );

  // ---- idempotent duplicate: same event twice = same state, no second record ----
  if (state.applied_event_keys.includes(event.event_key))
    return {
      ok: true,
      duplicate: true,
      failure_class: "duplicate_event",
      detail: `event ${event.event_key} was already applied — idempotent no-op, no second record.`,
      state,
      record: null,
    };

  // ---- stale_task: event pinned to a different state generation ----
  if (
    event.expected_generation !== undefined &&
    event.expected_generation !== null &&
    event.expected_generation !== state.generation
  )
    return refuse(
      "stale_task",
      `event ${event.event_key} expects task ${state.task_id} at generation ${event.expected_generation}, but it is at generation ${state.generation} — re-read the task before acting.`
    );

  // ---- observed authority-layer failures are fail-closed refusals ----
  if (event.type === "authority_failure") {
    const cls = evidence.failure_class;
    if (!AUTHORITY_FAILURES.includes(cls))
      return refuse(
        "malformed_input",
        `authority_failure event ${event.event_key} names "${cls}"; expected one of ${AUTHORITY_FAILURES.join(", ")}.`
      );
    return refuse(
      cls,
      `observed authority failure (${cls}) for task ${state.task_id}: ${evidence.detail ?? "no detail"} — the engine fails closed; no transition was inferred.`
    );
  }

  // ---- partial-write freeze: a partially applied mutation plan must be
  //      re-verified before any further transition (§37 partial_write) ----
  if (
    state.pending_partial_write &&
    event.type !== "write_reverified" &&
    event.type !== "failure_observed"
  )
    return refuse(
      "partial_write",
      `task ${state.task_id} has a partially applied mutation plan; re-verify it (write_reverified) before any further transition. Refusing ${event.type} (${event.event_key}).`
    );

  // ---- resolve the transition from the controlled table ----
  const candidates = TRANSITIONS.filter(
    t => t.trigger_event_type === event.type
  );
  if (candidates.length === 0)
    return refuse(
      "malformed_input",
      `unknown event type "${event.type}" (${event.event_key}) — the transition table is closed; the engine never invents transitions.`
    );
  const transition = candidates.find(
    t =>
      t.from === state.state ||
      (t.from === "*" && state.state !== "Blocked") ||
      (t.from === "*" &&
        state.state === "Blocked" &&
        (event.type === "mutation_result" || event.type === "write_reverified"))
  );
  if (!transition) {
    const expected = [
      ...new Set(
        candidates.map(t => (t.from === "*" ? "any non-Blocked state" : t.from))
      ),
    ].join('" or "');
    return refuse(
      "event_reorder",
      `event ${event.event_key} (${event.type}) expects task ${state.task_id} in state "${expected}", but it is in "${state.state}" — out-of-order events are refused, never silently reordered.`
    );
  }

  // ---- authority: human transitions are RECORDED observations, never
  //      machine-initiated (approval, merge, unblock) ----
  if (transition.authority === "human" && actor !== "human")
    return refuse(
      "authority_violation",
      `${event.type} is a human-authority transition; event ${event.event_key} has actor "${actor}". The engine may only record an observed human act (actor "human" + observed_via evidence), never perform or infer it.`
    );

  // ---- evidence completeness: absence = refusal, not inference ----
  for (const field of transition.required_evidence_fields) {
    if (!isNonEmpty(evidence[field]))
      return refuse(
        missingEvidenceClass(event.type, field),
        `event ${event.event_key} (${event.type}) is missing required evidence "${field}" — transitions require evidence, never inference.`
      );
  }

  // ---- per-trigger evidence shape + cross-event consistency guards ----
  let nextStateName = transition.to;
  let recordFailureClass = null;
  const next = structuredClone(state);

  switch (event.type) {
    case "work_started": {
      if (!/^https?:\/\//.test(String(evidence.work_link)))
        return refuse(
          "missing_relation",
          `event ${event.event_key} work_link "${evidence.work_link}" is not a URL — the Work Link relation is the GitHub↔Notion join.`
        );
      next.packet_ref = evidence.packet_ref;
      next.work_link = evidence.work_link;
      break;
    }
    case "pr_opened": {
      if (!Number.isInteger(evidence.pr_number) || evidence.pr_number <= 0)
        return refuse(
          "missing_pr",
          `event ${event.event_key} pr_number "${evidence.pr_number}" is not a positive integer.`
        );
      if (!SHA40.test(String(evidence.head_sha)))
        return refuse(
          "malformed_input",
          `event ${event.event_key} head_sha "${evidence.head_sha}" is not a 40-hex commit SHA.`
        );
      next.pr = { number: evidence.pr_number, head_sha: evidence.head_sha };
      break;
    }
    case "checks_observed": {
      if (!next.pr)
        return refuse(
          "missing_pr",
          `event ${event.event_key} observed checks but no PR is recorded for task ${state.task_id}.`
        );
      if (!SHA40.test(String(evidence.head_sha)))
        return refuse(
          "malformed_input",
          `event ${event.event_key} head_sha "${evidence.head_sha}" is not a 40-hex commit SHA.`
        );
      if (evidence.head_sha !== next.pr.head_sha)
        return refuse(
          "stale_sha",
          `event ${event.event_key} reports checks for ${evidence.head_sha}, but PR #${next.pr.number} head is ${next.pr.head_sha} — stale observation refused.`
        );
      if (!CHECK_ROLLUPS.includes(evidence.check_rollup))
        return refuse(
          "malformed_input",
          `event ${event.event_key} check_rollup "${evidence.check_rollup}" is not one of ${CHECK_ROLLUPS.join(", ")}.`
        );
      next.ci = {
        head_sha: evidence.head_sha,
        check_rollup: evidence.check_rollup,
        observed_at: event.at ?? null,
      };
      if (evidence.check_rollup === "failure") {
        // Visible CI-failed routing to Blocked — never silent continuation.
        nextStateName = "Blocked";
        recordFailureClass = "ci_failure";
        next.blocked_from = state.state;
        next.blocked_failure_class = "ci_failure";
        next.blocked_detail = `check rollup "failure" on ${evidence.head_sha} (PR #${next.pr.number})`;
      } else {
        nextStateName = "CI";
      }
      break;
    }
    case "review_requested": {
      if (!next.ci || next.ci.check_rollup !== "success")
        return refuse(
          "ci_failure",
          `event ${event.event_key} requests review but the recorded check rollup is "${next.ci?.check_rollup ?? "(none)"}" — Review requires observed green checks.`
        );
      next.review_ref = evidence.review_ref;
      break;
    }
    case "approval_observed": {
      if (evidence.review_state !== "APPROVED")
        return refuse(
          "malformed_input",
          `event ${event.event_key} review_state "${evidence.review_state}" is not "APPROVED" — only an observed APPROVED review can be recorded as Approval.`
        );
      next.approval = {
        reviewer: evidence.reviewer,
        review_id: evidence.review_id,
        observed_via: evidence.observed_via,
      };
      break;
    }
    case "merge_observed": {
      if (!SHA40.test(String(evidence.merge_sha)))
        return refuse(
          "malformed_input",
          `event ${event.event_key} merge_sha "${evidence.merge_sha}" is not a 40-hex commit SHA — Merged requires merge SHA evidence.`
        );
      if (
        isNonEmpty(evidence.head_sha) &&
        next.pr &&
        evidence.head_sha !== next.pr.head_sha
      )
        return refuse(
          "stale_sha",
          `event ${event.event_key} says head ${evidence.head_sha} merged, but PR #${next.pr.number} head is ${next.pr.head_sha}.`
        );
      next.merge_sha = evidence.merge_sha;
      break;
    }
    case "deploy_consequence_recorded": {
      if (!["deploy", "no-deploy"].includes(evidence.deploy_decision))
        return refuse(
          "malformed_input",
          `event ${event.event_key} deploy_decision "${evidence.deploy_decision}" is not "deploy" or "no-deploy".`
        );
      next.deploy_decision = evidence.deploy_decision;
      next.consequence_ref = evidence.consequence_ref;
      break;
    }
    case "post_merge_verified": {
      if (!next.deploy_decision)
        return refuse(
          "missing_evidence",
          `event ${event.event_key} verifies task ${state.task_id} but no deploy/no-deploy consequence was recorded (deploy_consequence_recorded) — Verified requires the consequence first.`
        );
      next.evidence_ref = evidence.evidence_ref;
      break;
    }
    case "learning_captured": {
      next.learning_ref = evidence.learning_ref;
      break;
    }
    case "failure_observed": {
      if (!FAILURE_CLASSES.includes(evidence.failure_class))
        return refuse(
          "malformed_input",
          `event ${event.event_key} failure_class "${evidence.failure_class}" is not a known failure class.`
        );
      recordFailureClass = evidence.failure_class;
      next.blocked_from = state.state;
      next.blocked_failure_class = evidence.failure_class;
      next.blocked_detail = evidence.detail_ref;
      break;
    }
    case "unblocked": {
      if (!state.blocked_from)
        return refuse(
          "malformed_input",
          `event ${event.event_key} unblocks task ${state.task_id} but no blocked_from state is recorded.`
        );
      nextStateName = state.blocked_from;
      next.blocked_from = null;
      next.blocked_failure_class = null;
      next.blocked_detail = null;
      break;
    }
    case "mutation_result": {
      if (!["full", "partial"].includes(evidence.applied))
        return refuse(
          "malformed_input",
          `event ${event.event_key} applied "${evidence.applied}" is not "full" or "partial".`
        );
      nextStateName = state.state; // annotation, no state change
      if (evidence.applied === "partial") {
        next.pending_partial_write = true;
        recordFailureClass = "partial_write";
      }
      break;
    }
    case "write_reverified": {
      nextStateName = state.state; // annotation, no state change
      next.pending_partial_write = false;
      break;
    }
    default:
      return refuse(
        "malformed_input",
        `event type "${event.type}" has no evidence guard — the table and the guard set drifted; refusing rather than guessing.`
      );
  }

  // ---- apply: one observable, evidence-linked record per applied event ----
  next.state = nextStateName;
  next.generation = state.generation + 1;
  next.applied_event_keys = [...state.applied_event_keys, event.event_key];
  const record = {
    task_id: state.task_id,
    from: state.state,
    to: nextStateName,
    trigger: event.type,
    evidence: { ...evidence },
    actor,
    authority: transition.authority,
    at: event.at ?? null,
    generation: next.generation,
    event_key: event.event_key,
    ...(recordFailureClass ? { failure_class: recordFailureClass } : {}),
  };
  next.records = [...state.records, record];
  return { ok: true, duplicate: false, state: next, record };
}

// Deterministic fold: replaying the same event log always reconstructs the
// same terminal state (records carry event timestamps, never wall-clock).
// Refusals are collected, visible, and never advance the state.
export function foldLifecycle(events, taskId) {
  if (!Array.isArray(events))
    throw new LifecycleError(
      "fixture-malformed",
      "the event log is not an array.",
      "a fold over unknown input would fabricate lifecycle state.",
      "provide { task_id, events: [...] } (see references/tailered-os-lifecycle.md)."
    );
  const resolvedTaskId = taskId ?? events[0]?.task_id;
  if (!resolvedTaskId)
    throw new LifecycleError(
      "task-id-missing",
      "no task id — the event log is empty and none was supplied.",
      "lifecycle state must always be pinned to one canonical Task.",
      "pass --task <32hex id> or ensure events carry task_id."
    );
  let state = initialState(resolvedTaskId);
  const refusals = [];
  for (const event of events) {
    const result = applyEvent(state, event);
    if (result.ok) {
      state = result.state;
    } else {
      refusals.push({
        event_key: event?.event_key ?? null,
        type: event?.type ?? null,
        failure_class: result.failure_class,
        detail: result.detail,
      });
    }
  }
  return { state, records: state.records, refusals };
}

// Replay-divergence check: refold the log and compare with a claimed state.
// Any mismatch is a visible replay_divergence failure, never silently trusted.
export function verifyReplay(events, claimedState, taskId) {
  const { state } = foldLifecycle(events, taskId ?? claimedState?.task_id);
  const replayed = JSON.stringify(state);
  const claimed = JSON.stringify(claimedState);
  if (replayed !== claimed)
    return refuse(
      "replay_divergence",
      `replaying the ${events.length}-event log for task ${state.task_id} does not reconstruct the claimed state (replayed generation ${state.generation}/state "${state.state}" vs claimed generation ${claimedState?.generation}/state "${claimedState?.state}") — the claimed state is not trusted.`
    );
  return { ok: true, state };
}

// What should happen next, and under whose authority. Descriptive only —
// the engine plans; humans and observed facts move the world.
export function nextAction(state) {
  if (state.pending_partial_write)
    return {
      description: `Re-verify the partially applied mutation plan for task ${state.task_id} (write_reverified with verification_ref) before any further transition.`,
      authority: "machine",
    };
  switch (state.state) {
    case "Ready":
      return {
        description:
          "Resolve the TOS-007 context packet (scripts/tailered-os/context.mjs) and record work_started with packet_ref + work_link.",
        authority: "machine",
      };
    case "Executing":
      return {
        description:
          "Open the PR for the Work Link branch and record pr_opened with pr_number + head_sha.",
        authority: "machine",
      };
    case "PR Open":
      return {
        description: `Observe the check rollup for PR #${state.pr?.number} and record checks_observed.`,
        authority: "machine",
      };
    case "CI":
      return state.ci?.check_rollup === "success"
        ? {
            description:
              "Checks are green — request review and record review_requested with review_ref.",
            authority: "machine",
          }
        : {
            description: `Await the check rollup (currently "${state.ci?.check_rollup}") and re-record checks_observed.`,
            authority: "machine",
          };
    case "Review":
      return {
        description:
          "Await human review approval (PREZ). The engine may only record an observed APPROVED review (approval_observed), never perform or infer approval.",
        authority: "human",
      };
    case "Approval":
      return {
        description:
          "Await the human merge. The engine may only record the observed merge SHA (merge_observed), never merge.",
        authority: "human",
      };
    case "Merged":
      return state.deploy_decision
        ? {
            description:
              "Record post-merge verification evidence (post_merge_verified with evidence_ref).",
            authority: "machine",
          }
        : {
            description:
              "Record the observed deploy/no-deploy consequence (deploy_consequence_recorded). The deploy decision itself is human — merging dime-ai main IS a production deploy.",
            authority: "human",
          };
    case "Verified":
      return state.learning_ref
        ? {
            description:
              "Lifecycle complete — learning captured. Generate the next task with the human owner.",
            authority: "human",
          }
        : {
            description:
              "Capture the learning (learning_captured with learning_ref).",
            authority: "machine",
          };
    case "Blocked":
      return {
        description: `Resolve the recorded failure (${state.blocked_failure_class}: ${state.blocked_detail}); a human records unblocked with resolution_ref to resume "${state.blocked_from}".`,
        authority: "human",
      };
    default:
      return {
        description: `Unknown state "${state.state}" — refuse to plan.`,
        authority: "human",
      };
  }
}

// The Notion mutation the fold implies, as DATA. In fixture mode the engine
// NEVER claims it wrote anything: executed is false, always, with the reason.
export function planMutation(state, manifest, mode = "fixture") {
  return {
    task_id: state.task_id,
    target: {
      database_name: manifest.notion.databases.tasks.name,
      database_id: manifest.notion.databases.tasks.id,
      page_id: state.task_id,
      property: "Execution State",
    },
    set_to: state.state,
    generation: state.generation,
    mode,
    executed: false,
    reason:
      mode === "fixture"
        ? "fixture mode — no live authority"
        : "api mode — write authority not granted",
  };
}

// api mode fails CLOSED with the missing authority named — the same law as
// context.mjs apiSource(): credential presence is governed, not discovered.
// OG-006 (2026-08-11): with the owner grant recorded in the manifest, an
// authorized manifest now RETURNS the grant descriptor instead of throwing
// api-write-unimplemented — the sanctioned live path is the policy-separated
// writer (scripts/tailered-os/lifecycle-writer.mjs), never this engine.
export function assertLiveNotionAuthority(manifest) {
  if (manifest.safety.notionWriteOperationsAuthorized !== true)
    throw new LifecycleError(
      "notion-write-unauthorized",
      "live Notion write authority is not granted (manifest safety.notionWriteOperationsAuthorized is false).",
      "the lifecycle engine mutates the organizational control plane; an unauthorized write path would let an agent move its own approval state.",
      "run with --fixture <path> (the engine emits mutation plans, executed: false); flipping the flag is an owner-reviewed PR carrying the decision grant (safety.notionWriteAuthorization)."
    );
  return Object.freeze({
    authorized: true,
    grant: manifest.safety.notionWriteAuthorization,
    write_path: "scripts/tailered-os/lifecycle-writer.mjs",
  });
}

function loadFixture(path) {
  if (!path || !existsSync(path))
    throw new LifecycleError(
      "fixture-missing",
      `fixture file "${path ?? "(none)"}" does not exist.`,
      "the engine only folds observed events; it never invents a log.",
      "pass --fixture <path> pointing at { task_id, events: [...] }."
    );
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new LifecycleError(
      "fixture-malformed",
      `fixture "${path}" is not valid JSON (${error.message}).`,
      "a half-read log would fold into a wrong state.",
      "fix the fixture JSON."
    );
  }
  if (!Array.isArray(parsed?.events))
    throw new LifecycleError(
      "fixture-malformed",
      `fixture "${path}" has no events array.`,
      "the fold contract is { task_id, events: [...] }.",
      "export observed events into that shape."
    );
  return parsed;
}

// fileURLToPath (not string concatenation): a URL-encoding path or symlinked
// invocation would otherwise make this comparison fail and the CLI silently
// import-and-exit-0 — a silent no-op in an engine whose law is that refusals
// are visible (health-review catch).
const invokedDirectly =
  process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) {
  const args = process.argv.slice(2);
  const command = args[0];
  const argOf = flag => {
    const index = args.indexOf(flag);
    return index === -1 ? null : args[index + 1];
  };
  const usage =
    "usage: lifecycle.mjs {plan|fold|apply} --fixture <path> [--task <id>]";
  try {
    if (!["plan", "fold", "apply"].includes(command)) {
      console.error(usage);
      process.exit(2);
    }
    const fixturePath = argOf("--fixture");
    const manifest = loadControlPlaneManifest();
    if (!fixturePath) {
      assertLiveNotionAuthority(manifest); // throws while the kill switch is engaged
      // Authority alone does not make the CLI a write surface: live mutation
      // runs through the writer contract (plan → authorize → write → reread →
      // attest) with an injected transport the CLI does not hold.
      throw new LifecycleError(
        "cli-live-unsupported",
        "the CLI folds fixtures only; it holds no live transport.",
        "a CLI write path would bypass the writer's pre-write gates and attestation contract.",
        "use --fixture <path> here; live mutations go through scripts/tailered-os/lifecycle-writer.mjs (see references/tailered-os-lifecycle.md)."
      );
    }
    const fixture = loadFixture(fixturePath);
    const taskArg = argOf("--task");
    if (taskArg && fixture.task_id && taskArg !== fixture.task_id)
      throw new LifecycleError(
        "task-id-mismatch",
        `--task ${taskArg} does not match fixture task_id ${fixture.task_id}.`,
        "folding one task's events into another task's state corrupts both.",
        "drop --task or point at the right fixture."
      );
    const { state, records, refusals } = foldLifecycle(
      fixture.events,
      taskArg ?? fixture.task_id
    );
    if (command === "fold") {
      console.log(JSON.stringify({ state, refusals }, null, 2));
    } else if (command === "plan") {
      console.log(
        JSON.stringify(
          {
            task_id: state.task_id,
            current_state: state.state,
            generation: state.generation,
            next_action: nextAction(state),
            notion_mutation_plan: planMutation(state, manifest, "fixture"),
            refusals,
          },
          null,
          2
        )
      );
    } else {
      for (const record of records)
        console.error(
          `applied ${record.trigger}: ${record.from} -> ${record.to} (gen ${record.generation}, ${record.event_key})`
        );
      for (const refusal of refusals)
        console.error(
          `REFUSED ${refusal.type ?? "(unknown)"} (${refusal.event_key ?? "no key"}): ${refusal.failure_class} — ${refusal.detail}`
        );
      console.log(
        JSON.stringify(
          {
            state,
            refusals,
            notion_mutation_plan: planMutation(state, manifest, "fixture"),
          },
          null,
          2
        )
      );
      if (refusals.length > 0) process.exit(1);
    }
  } catch (error) {
    console.error(
      error instanceof LifecycleError
        ? error.render()
        : String(error?.stack ?? error)
    );
    process.exit(1);
  }
}
