// TOS-009 — live Notion lifecycle writer (OG-006 activation, run ONE-20260811-OG6).
//
// This is the POLICY layer between the pure lifecycle kernel and the Notion
// connector. The kernel (lifecycle.mjs) folds observed facts and implies a
// mutation; this module decides whether that mutation may execute, executes it
// through an INJECTED transport, rereads the canonical record, and attests to
// what actually happened. It is the only sanctioned live write path for actor
// AI-10 (AI Systems Registry), approved by PREZ 2026-08-11 conditional on
// qualification — decision: https://app.notion.com/p/3b99673313e781229b85f35a0b9f2966
//
// Laws:
//   - ALLOWLIST, not capability: the connector credential is broader than this
//     policy; anything not explicitly allowlisted here refuses. Four properties
//     on TOS-* Tasks in the canonical Tasks data source. Nothing else, ever.
//   - The writer executes prevalidated plans only. It never invents transitions,
//     never reinterprets evidence, never expands its own scope (the allowlist is
//     frozen; manifest safety changes are owner-reviewed PR territory).
//   - PLAN → AUTHORIZE → WRITE → REREAD → COMPARE → ATTEST. No optimistic
//     success: a write whose reread does not match the plan is applied:"partial"
//     and the caller must freeze the lifecycle (kernel mutation_result) until a
//     human-visible write_reverified.
//   - Human authority is re-checked here (defense in depth with the kernel):
//     a plan derived from a human-authority transition must carry actor "human"
//     and observed_via evidence or it hard-fails authority_violation.
//   - Every refusal is a visible value naming one of the kernel's 15 failure
//     classes. Silence is never success.
import { LIFECYCLE_STATES, TRANSITIONS, LifecycleError } from "./lifecycle.mjs";
import { SECRETISH } from "../tailered-os-control-plane.mjs";

export const WRITER_SCHEMA_VERSION = 1;

// Freshness bound for the pre-write reread (gate 4): a snapshot older than
// this is stale by definition — reread before acting.
export const MAX_SNAPSHOT_AGE_MS = 120_000;

// Bounds on written values — lifecycle bookkeeping is short strings, never
// documents; anything larger is not a lifecycle write.
const MAX_URL_LENGTH = 2_000;
const MAX_TEXT_LENGTH = 2_000;
const HTTPS_URL = /^https:\/\/[^\s]+$/;

// The canonical Tasks property is spelled with U+2019 (right single quote).
export const WHY_BLOCKED_PROPERTY = "Why It’s Blocked";

// The entire live write surface of actor AI-10. Frozen — the writer cannot
// expand it at runtime; changing it is an owner-reviewed PR to this file.
export const WRITE_ALLOWLIST = Object.freeze({
  data_source_id: "06a44772-1ae8-4d9d-be70-30741b334b85",
  scope_id_pattern: /^TOS-/,
  properties: Object.freeze({
    "Execution State": Object.freeze({
      kind: "select",
      values: LIFECYCLE_STATES,
    }),
    "Work Link": Object.freeze({ kind: "url" }),
    "Proof / Result": Object.freeze({ kind: "url" }),
    [WHY_BLOCKED_PROPERTY]: Object.freeze({ kind: "text" }),
  }),
});

function refuse(failureClass, detail) {
  return { ok: false, failure_class: failureClass, detail };
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validValueForProperty(property, value) {
  const rule = WRITE_ALLOWLIST.properties[property];
  if (!rule) return `property "${property}" is not allowlisted`;
  if (typeof value !== "string")
    return `property "${property}" value must be a string`;
  if (SECRETISH.test(value))
    return `property "${property}" value is credential-shaped — refused`;
  if (rule.kind === "select" && !rule.values.includes(value))
    return `property "${property}" value "${value}" is not in the closed vocabulary`;
  if (rule.kind === "url") {
    if (!HTTPS_URL.test(value) || value.length > MAX_URL_LENGTH)
      return `property "${property}" value must be an https URL (≤${MAX_URL_LENGTH} chars)`;
  }
  if (rule.kind === "text" && value.length > MAX_TEXT_LENGTH)
    return `property "${property}" value exceeds ${MAX_TEXT_LENGTH} chars`;
  return null;
}

// ---------------------------------------------------------------------------
// PLAN — map one APPLIED kernel record (+ the folded state after it) to the
// exact allowlisted property writes it implies. Derivation is a closed table,
// like the kernel's: unknown triggers refuse, they are never guessed.
// ---------------------------------------------------------------------------
export function deriveWrites(record, state) {
  if (!isPlainObject(record) || !isPlainObject(state))
    return refuse(
      "malformed_input",
      "deriveWrites needs a record and a state."
    );
  if (record.task_id !== state.task_id)
    return refuse(
      "malformed_input",
      `record task ${record.task_id} does not match state task ${state.task_id}.`
    );
  const writes = { "Execution State": record.to };
  switch (record.trigger) {
    case "work_started":
      writes["Work Link"] = record.evidence.work_link;
      break;
    case "post_merge_verified": {
      const proof = record.evidence.evidence_ref;
      if (!HTTPS_URL.test(String(proof)))
        return refuse(
          "malformed_input",
          `post_merge_verified evidence_ref "${proof}" is not an https URL — the live Proof / Result write requires resolvable proof.`
        );
      writes["Proof / Result"] = proof;
      break;
    }
    case "failure_observed":
      writes[WHY_BLOCKED_PROPERTY] =
        `${record.evidence.failure_class}: ${record.evidence.detail_ref}`;
      break;
    case "checks_observed":
      if (record.to === "Blocked")
        writes[WHY_BLOCKED_PROPERTY] =
          `ci_failure: check rollup "failure" on ${record.evidence.head_sha}`;
      break;
    case "unblocked":
      writes[WHY_BLOCKED_PROPERTY] = "";
      break;
    case "pr_opened":
    case "review_requested":
    case "approval_observed":
    case "merge_observed":
    case "deploy_consequence_recorded":
    case "learning_captured":
      break; // Execution State only
    case "mutation_result":
    case "write_reverified":
      return refuse(
        "malformed_input",
        `${record.trigger} is a writer-bookkeeping event; it never implies a live Notion write.`
      );
    default:
      return refuse(
        "malformed_input",
        `trigger "${record.trigger}" has no write derivation — the table is closed.`
      );
  }
  return {
    ok: true,
    plan: {
      schema_version: WRITER_SCHEMA_VERSION,
      plan_id: `plan:${record.event_key}`,
      event_key: record.event_key,
      task_id: state.task_id,
      trigger: record.trigger,
      authority: record.authority,
      actor: record.actor,
      evidence: { ...record.evidence },
      expected_from_state: record.from,
      expected_generation: record.generation - 1,
      writes,
    },
  };
}

// ---------------------------------------------------------------------------
// AUTHORIZE — the sixteen pre-write gates. Every one refuses visibly; the
// order is fail-fast but every gate is independent law.
// ---------------------------------------------------------------------------
export function authorizeWrite(plan, snapshot, manifest, opts = {}) {
  // 16. connector health — unresolved credential/permission failure blocks all writes
  if (opts.connector_failure)
    return refuse(
      String(opts.connector_failure.failure_class ?? "permission_denial"),
      `unresolved connector failure: ${opts.connector_failure.detail ?? "(no detail)"} — resolve it before any write.`
    );

  // authority flag — read from the freshly loaded manifest, every write
  if (!isPlainObject(manifest) || !isPlainObject(manifest.safety))
    return refuse(
      "malformed_input",
      "manifest is not a control-plane manifest."
    );
  if (manifest.safety.notionWriteOperationsAuthorized !== true)
    return refuse(
      "permission_denial",
      "notion-write-unauthorized: manifest safety.notionWriteOperationsAuthorized is not true — the kill switch is engaged; no live write may execute."
    );

  // plan shape
  if (
    !isPlainObject(plan) ||
    plan.schema_version !== WRITER_SCHEMA_VERSION ||
    typeof plan.plan_id !== "string" ||
    !isPlainObject(plan.writes)
  )
    return refuse("malformed_input", "plan is not a v1 writer mutation plan.");

  // 6. durable unique event key
  if (typeof plan.event_key !== "string" || plan.event_key === "")
    return refuse(
      "malformed_input",
      "plan has no durable event_key — idempotency depends on it."
    );
  // idempotency — an event key that already produced an attestation never
  // executes twice (visible no-op, mirrors the kernel's duplicate law)
  if (opts.attested_event_keys?.has?.(plan.event_key))
    return {
      ok: true,
      duplicate: true,
      failure_class: "duplicate_event",
      detail: `event ${plan.event_key} already has an attestation — idempotent no-op, no second mutation.`,
    };

  // 1./3./4. canonical task exists, identity matches, snapshot is FRESH
  if (!isPlainObject(snapshot))
    return refuse(
      "stale_task",
      "no fresh snapshot of the canonical Task was provided — reread before acting."
    );
  if (snapshot.page_id !== plan.task_id)
    return refuse(
      "malformed_input",
      `snapshot is for page ${snapshot.page_id}, plan targets ${plan.task_id}.`
    );
  const now = opts.now;
  if (typeof now !== "number" || typeof snapshot.fetched_at !== "number")
    return refuse(
      "stale_task",
      "snapshot freshness is unprovable (fetched_at/now missing) — refusing rather than assuming."
    );
  const maxAge = opts.max_snapshot_age_ms ?? MAX_SNAPSHOT_AGE_MS;
  if (now - snapshot.fetched_at > maxAge || now < snapshot.fetched_at)
    return refuse(
      "stale_task",
      `snapshot of ${plan.task_id} is ${now - snapshot.fetched_at}ms old (max ${maxAge}ms) — reread before acting.`
    );

  // 2. permitted Tailered OS scope only
  if (snapshot.data_source_id !== WRITE_ALLOWLIST.data_source_id)
    return refuse(
      "permission_denial",
      `task lives in data source ${snapshot.data_source_id}, not the allowlisted Tasks data source — cross-database writes are forbidden.`
    );
  if (!WRITE_ALLOWLIST.scope_id_pattern.test(String(snapshot.scope_id ?? "")))
    return refuse(
      "permission_denial",
      `task Scope ID "${snapshot.scope_id ?? "(none)"}" is not a TOS-* scope — cross-task writes are forbidden.`
    );
  const projectId = String(manifest.notion?.taileredOsProject?.id ?? "");
  if (
    projectId === "" ||
    !Array.isArray(snapshot.project_ids) ||
    !snapshot.project_ids.some(id => String(id).replace(/-/g, "") === projectId)
  )
    return refuse(
      "permission_denial",
      `task is not related to the canonical Tailered OS project (${projectId}) — cross-project writes are forbidden.`
    );

  // 5. current state equals the plan's expected from-state
  if (snapshot.execution_state !== plan.expected_from_state)
    return refuse(
      "stale_task",
      `live Execution State is "${snapshot.execution_state}", plan expects "${plan.expected_from_state}" — the record moved; refold from fresh facts.`
    );

  // 7. the transition exists in the closed table
  const transition = TRANSITIONS.find(
    t =>
      t.trigger_event_type === plan.trigger &&
      (t.from === plan.expected_from_state ||
        (t.from === "*" && plan.expected_from_state !== null))
  );
  if (!transition)
    return refuse(
      "malformed_input",
      `plan trigger "${plan.trigger}" from "${plan.expected_from_state}" matches no row of the closed transition table.`
    );

  // 8./9. actor authority — human transitions demand an observed human act
  if (transition.authority !== plan.authority)
    return refuse(
      "authority_violation",
      `plan claims authority "${plan.authority}" but the table says "${transition.authority}" — plans never reinterpret authority.`
    );
  if (transition.authority === "human") {
    if (plan.actor !== "human")
      return refuse(
        "authority_violation",
        `${plan.trigger} is a human-authority transition; plan actor is "${plan.actor}". The writer records observed human acts; it never performs them.`
      );
    if (!plan.evidence?.observed_via)
      return refuse(
        "authority_violation",
        `${plan.trigger} carries no observed_via evidence — an unobserved human act is an inferred one, and inference is forbidden.`
      );
  }

  // 10. PR/SHA evidence must match CURRENT GitHub state where applicable
  if (
    ["pr_opened", "checks_observed", "merge_observed"].includes(plan.trigger)
  ) {
    const live = opts.github;
    if (!isPlainObject(live))
      return refuse(
        "missing_evidence",
        `${plan.trigger} writes require a live GitHub cross-check (opts.github) — none was provided.`
      );
    if (
      plan.trigger === "merge_observed" &&
      live.merge_sha !== plan.evidence.merge_sha
    )
      return refuse(
        "stale_sha",
        `plan merge_sha ${plan.evidence.merge_sha} does not match live GitHub merge ${live.merge_sha}.`
      );
    if (
      plan.trigger !== "merge_observed" &&
      live.head_sha !== plan.evidence.head_sha
    )
      return refuse(
        "stale_sha",
        `plan head_sha ${plan.evidence.head_sha} does not match live GitHub head ${live.head_sha}.`
      );
  }

  // 11./12./13. target database, properties, and mutation shapes are allowlisted
  const entries = Object.entries(plan.writes);
  if (entries.length === 0)
    return refuse(
      "malformed_input",
      "plan writes nothing — refusing a no-op mutation."
    );
  for (const [property, value] of entries) {
    const problem = validValueForProperty(property, value);
    if (problem)
      return refuse("permission_denial", `allowlist violation: ${problem}.`);
  }

  // 14. reversibility — capture prior values so every write has an undo
  const prior = {};
  for (const property of Object.keys(plan.writes)) {
    if (!(property in (snapshot.properties ?? {})))
      return refuse(
        "stale_task",
        `snapshot does not carry current value of "${property}" — reversibility is unprovable without it.`
      );
    prior[property] = snapshot.properties[property];
  }

  // 15. no unresolved partial-write freeze
  if (
    opts.pending_partial_write === true ||
    snapshot.pending_partial_write === true
  )
    return refuse(
      "partial_write",
      `task ${plan.task_id} has an unresolved partially applied mutation — write_reverified is required before any further write.`
    );

  return {
    ok: true,
    duplicate: false,
    authorized_plan: Object.freeze({
      ...plan,
      prior: Object.freeze(prior),
      authorized_at: now,
      target: Object.freeze({
        data_source_id: WRITE_ALLOWLIST.data_source_id,
        page_id: plan.task_id,
      }),
    }),
  };
}

// ---------------------------------------------------------------------------
// WRITE → REREAD → COMPARE → ATTEST. The transport is injected: tests use
// fakes; the live session supplies the governed Notion connector. Transport
// errors are classified fail-closed — an error AFTER the write may mean bytes
// landed, so the writer rereads before deciding, and an unreadable outcome is
// a partial write (freeze), never an assumed success or an assumed no-op.
// ---------------------------------------------------------------------------
export async function executeMutation(authorizedPlan, transport, opts = {}) {
  if (!isPlainObject(authorizedPlan) || !isPlainObject(authorizedPlan.prior))
    throw new LifecycleError(
      "writer-unauthorized-plan",
      "executeMutation was handed a plan that did not pass authorizeWrite.",
      "executing unvalidated plans is exactly the bypass the policy layer exists to prevent.",
      "call authorizeWrite first and pass its authorized_plan."
    );
  if (
    !isPlainObject(transport) ||
    typeof transport.updatePage !== "function" ||
    typeof transport.fetchTask !== "function"
  )
    throw new LifecycleError(
      "writer-transport-missing",
      "no transport with updatePage + fetchTask was injected.",
      "the writer never talks to Notion directly; the governed connector is injected by the session.",
      "pass { updatePage, fetchTask }."
    );

  const classifyTransportError = error => {
    const code = String(error?.code ?? error?.message ?? "");
    if (/permission|forbidden|unauthorized|403/i.test(code))
      return "permission_denial";
    if (/timeout|timed?[ _-]?out|ETIMEDOUT|ECONN/i.test(code))
      return "api_timeout";
    if (/expired|credential|401/i.test(code)) return "expired_credentials";
    return "api_timeout"; // unknown transport failure: treated as reachability, fail-closed
  };

  let writeError = null;
  try {
    await transport.updatePage(authorizedPlan.target.page_id, {
      ...authorizedPlan.writes,
    });
  } catch (error) {
    writeError = error;
  }

  // REREAD — always, even after an error: the only way to know what landed.
  let observed;
  try {
    observed = await transport.fetchTask(authorizedPlan.target.page_id);
  } catch (rereadError) {
    return {
      applied: "partial",
      failure_class: "partial_write",
      attestation: buildAttestation(authorizedPlan, null, "partial", {
        write_error: writeError ? classifyTransportError(writeError) : null,
        reread_error: classifyTransportError(rereadError),
        detail:
          "write outcome is unreadable (reread failed) — fail closed as partial; the lifecycle must freeze until write_reverified.",
      }),
    };
  }

  const mismatches = [];
  for (const [property, planned] of Object.entries(authorizedPlan.writes)) {
    const actual = observed?.properties?.[property];
    if (actual !== planned) mismatches.push({ property, planned, actual });
  }

  if (mismatches.length === 0) {
    if (writeError) {
      // The transport errored but every planned value is live — the write
      // landed. Record the anomaly visibly; the outcome is still full.
      return {
        applied: "full",
        attestation: buildAttestation(authorizedPlan, observed, "full", {
          write_error: classifyTransportError(writeError),
          detail:
            "transport errored after the bytes landed; reread matches the plan.",
        }),
      };
    }
    return {
      applied: "full",
      attestation: buildAttestation(authorizedPlan, observed, "full", {}),
    };
  }

  if (
    writeError &&
    mismatches.length === Object.keys(authorizedPlan.writes).length
  ) {
    // Nothing landed and the transport told us why: a clean visible refusal,
    // not a partial state — the record is untouched.
    return {
      applied: "none",
      failure_class: classifyTransportError(writeError),
      attestation: buildAttestation(authorizedPlan, observed, "none", {
        write_error: classifyTransportError(writeError),
        detail:
          "transport refused before any byte landed; record verified unchanged.",
      }),
    };
  }

  return {
    applied: "partial",
    failure_class: "partial_write",
    attestation: buildAttestation(authorizedPlan, observed, "partial", {
      mismatches,
      write_error: writeError ? classifyTransportError(writeError) : null,
      detail: `reread does not match the plan on ${mismatches.length} propert${mismatches.length === 1 ? "y" : "ies"} — the lifecycle must freeze until write_reverified.`,
    }),
  };
}

function buildAttestation(plan, observed, applied, extra) {
  return {
    schema_version: WRITER_SCHEMA_VERSION,
    attestation_for: plan.plan_id,
    event_key: plan.event_key,
    task_id: plan.task_id,
    trigger: plan.trigger,
    applied,
    planned_writes: { ...plan.writes },
    prior_values: { ...plan.prior },
    observed_after: observed?.properties
      ? Object.fromEntries(
          Object.keys(plan.writes).map(p => [p, observed.properties[p]])
        )
      : null,
    observed_generation_source: observed?.fetched_at ?? null,
    ...extra,
  };
}

// Reversibility made concrete: the undo plan writes the captured prior values
// back through the same authorize/execute contract (same allowlist, same
// attestation). Undo of an undo is the original plan.
export function buildUndoPlan(authorizedPlan) {
  if (!isPlainObject(authorizedPlan) || !isPlainObject(authorizedPlan.prior))
    return refuse(
      "malformed_input",
      "only an authorized plan (with captured priors) can be undone."
    );
  return {
    ok: true,
    plan: {
      schema_version: WRITER_SCHEMA_VERSION,
      plan_id: `undo:${authorizedPlan.plan_id}`,
      event_key: `undo:${authorizedPlan.event_key}`,
      task_id: authorizedPlan.task_id,
      trigger: authorizedPlan.trigger,
      authority: authorizedPlan.authority,
      actor: authorizedPlan.actor,
      evidence: { ...authorizedPlan.evidence },
      expected_from_state:
        authorizedPlan.writes["Execution State"] ??
        authorizedPlan.expected_from_state,
      expected_generation: null,
      writes: { ...authorizedPlan.prior },
    },
  };
}
