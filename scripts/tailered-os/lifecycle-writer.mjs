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
//   - AUTHORITY COMES FROM DISK, not from the caller: every authorization loads
//     and validates the control-plane manifest itself, so the kill switch is a
//     real switch (independent verification NEW-OG6-0007).
//   - COPY, THEN VALIDATE, THEN SEND THE COPY: the write map is snapshotted into
//     a plain own-string-key object ONCE; validation and the payload read that
//     same frozen copy, so a getter/Proxy cannot answer differently on a second
//     read (NEW-OG6-0006 validate-then-copy TOCTOU).
//   - CAPABILITIES ARE UNFORGEABLE: authorizeWrite registers each authorized
//     plan in a module-private WeakSet; executeMutation refuses anything that is
//     not in it. Object shape is not authenticity (NEW-OG6-0005).
//   - The writer executes prevalidated plans only. It never invents transitions,
//     never reinterprets evidence, never expands its own scope.
//   - PLAN → AUTHORIZE → WRITE → REREAD → COMPARE → ATTEST. No optimistic
//     success: a write whose reread does not match the plan is applied:"partial"
//     and the caller must freeze the lifecycle until a human-visible
//     write_reverified.
//   - HUMAN AUTHORITY IS DERIVED, NEVER ASSERTED (OG-006 Round 2). Round 1
//     re-checked human authority by reading `actor: "human"` and
//     `evidence.observed_via` off the caller's own plan, which is why three
//     independent verifications failed it (NEW3-OG6-0024). A human-authority
//     transition now requires an authority FACT that ./authority.mjs derived by
//     independently fetching the forge — and the plan's evidence must AGREE
//     with that fact rather than supply it. Same for the SHA cross-checks
//     (`opts.github` was a caller object too) and for terminal proof.
//   - AUTHORITY HAS NO CALLER SEAM. There is no manifest path parameter: the
//     canonical manifest is the only authority source, and unknown option keys
//     are refused rather than ignored, so an attempt to reintroduce a seam is
//     visible instead of silent.
//   - Every refusal is a visible value naming one of the kernel's 15 failure
//     classes. Silence is never success.
import { LIFECYCLE_STATES, TRANSITIONS, LifecycleError } from "./lifecycle.mjs";
import {
  CONTROL_PLANE_MANIFEST_PATH,
  SECRETISH,
  loadControlPlaneManifest,
} from "../tailered-os-control-plane.mjs";
import {
  TRIGGER_AUTHORITY_SOURCE,
  consumeAuthorityFact,
  isAuthorityFact,
  readAuthorityFact,
  resolveOwnerGrantAuthority,
} from "./authority.mjs";

export const WRITER_SCHEMA_VERSION = 1;

// Freshness bound for the pre-write reread. A HARD cap: a caller may ask for a
// tighter bound, never a looser one (NEW-OG6-0012).
export const MAX_SNAPSHOT_AGE_MS = 120_000;

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

// Authenticity, not shape: only plans this module authorized are executable.
// A WeakMap cannot be enumerated or forged from outside the module. The value
// carries mint metadata so a capability can be SINGLE-USE and time-bounded:
// round-2 verification showed one capability executing twice, and an
// already-minted capability still writing after the on-disk kill switch was
// engaged (NEW2-OG6-0017).
const AUTHORIZED_CAPABILITIES = new WeakMap();
export const CAPABILITY_TTL_MS = 120_000;

// The complete option surface. Unknown keys REFUSE rather than being ignored:
// `manifest_path` and `github` were both real authority seams in Round 1, and a
// silently-ignored option is how a seam comes back without anyone noticing.
const ALLOWED_OPTION_KEYS = Object.freeze([
  "connector_failure",
  "attested_event_keys",
  "max_snapshot_age_ms",
  "authority_fact",
  "github_fact",
  "proof_fact",
  "undo_of",
  "pending_partial_write",
]);

function refuse(failureClass, detail) {
  return { ok: false, failure_class: failureClass, detail };
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// Own-property only: bracket access walks the prototype chain, so
// "__proto__"/"constructor"/"toString" used to resolve truthy and skip every
// value check (FIND-OG6-0002).
function ruleFor(property) {
  return Object.hasOwn(WRITE_ALLOWLIST.properties, property)
    ? WRITE_ALLOWLIST.properties[property]
    : null;
}

function validValueForProperty(property, value, { allowClear = false } = {}) {
  const rule = ruleFor(property);
  if (!rule) return `property "${property}" is not allowlisted`;
  if (typeof value !== "string")
    return `property "${property}" value must be a string`;
  if (SECRETISH.test(value))
    return `property "${property}" value is credential-shaped — refused`;
  if (rule.kind === "select") {
    // "" clears a select — lawful ONLY when restoring a captured prior, so an
    // undo of a write to a previously-empty field is possible (NEW-OG6-0011)
    // without giving ordinary plans a way to erase Execution State.
    if (value === "" && allowClear) return null;
    if (!rule.values.includes(value))
      return `property "${property}" value "${value}" is not in the closed vocabulary`;
  }
  if (rule.kind === "url" && value !== "") {
    if (!HTTPS_URL.test(value) || value.length > MAX_URL_LENGTH)
      return `property "${property}" value must be an https URL (≤${MAX_URL_LENGTH} chars) or "" to clear`;
  }
  if (rule.kind === "text" && value.length > MAX_TEXT_LENGTH)
    return `property "${property}" value exceeds ${MAX_TEXT_LENGTH} chars`;
  return null;
}

// ONE read of the caller's object, into a plain own-string-key map. Everything
// downstream — validation, the frozen capability, the transport payload — uses
// this copy, so a getter or Proxy gets exactly one chance to answer and cannot
// present different keys to the validator and to the transport.
function snapshotWrites(writes) {
  if (!isPlainObject(writes)) return { error: "writes is not an object" };
  // Reflection itself can throw (a Proxy ownKeys trap): every refusal is a
  // VALUE, never an escaping Error (NEW3-OG6-0028).
  let keys;
  try {
    if (Object.getOwnPropertySymbols(writes).length > 0)
      return {
        error:
          "writes carries symbol-keyed properties — the allowlist is string-keyed, and a symbol key is not an allowlisted property",
      };
    keys = Object.keys(writes);
  } catch (error) {
    return { error: `enumerating writes threw (${error.message}) — refusing` };
  }
  const copy = Object.create(null);
  let count = 0;
  for (const key of keys) {
    let value;
    try {
      value = writes[key];
    } catch {
      return { error: `reading property "${key}" threw — refusing the plan` };
    }
    copy[key] = value;
    count += 1;
  }
  if (count === 0) return { error: "plan writes nothing" };
  return { copy: { ...copy } };
}

function validateWriteMap(writes, options) {
  for (const [property, value] of Object.entries(writes)) {
    const problem = validValueForProperty(property, value, options);
    if (problem) return problem;
  }
  return null;
}

// Object.freeze is SHALLOW (FIND-OG6-0001). This walks only objects the writer
// itself constructed, with a seen-guard so a cycle cannot blow the stack
// (NEW-OG6-0009).
function deepFreeze(value, seen = new WeakSet()) {
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return value;
  seen.add(value);
  for (const key of Object.getOwnPropertyNames(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor && "value" in descriptor) deepFreeze(descriptor.value, seen);
  }
  return Object.freeze(value);
}

// Evidence is attestation metadata supplied by the caller, so the capability
// takes a bounded PLAIN COPY of it rather than a reference: freezing a caller's
// object graph as a side effect is not the writer's business, and a cycle or a
// throwing getter in caller memory must not be able to reach deepFreeze
// (NEW-OG6-0009). Non-JSON values are stringified; depth and breadth are capped.
function plainCopy(value, depth = 0) {
  if (value === null) return null;
  const type = typeof value;
  if (type === "string" || type === "number" || type === "boolean")
    return value;
  if (type !== "object") return String(value);
  if (depth >= 3) return "[depth-capped]";
  if (Array.isArray(value))
    return value.slice(0, 32).map(item => plainCopy(item, depth + 1));
  const copy = {};
  let keys;
  try {
    keys = Object.keys(value).slice(0, 64);
  } catch {
    return "[unreadable]";
  }
  for (const key of keys) {
    try {
      copy[key] = plainCopy(value[key], depth + 1);
    } catch {
      copy[key] = "[unreadable]";
    }
  }
  return copy;
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

// AUTHORITY COMES FROM THE CANONICAL MANIFEST — full stop.
//
// Round 1 accepted `opts.manifest_path` so tests could exercise armed and
// disarmed manifests. That was a production seam: a caller could name an
// alternate armed manifest, and hardening it into "realpath, then confine to
// two directories" only narrowed the seam (NEW2-OG6-0016) instead of closing
// it. There is now no path parameter at all. The canonical manifest's location
// is derived from this module's own location, so cwd cannot move it, no
// environment variable is read, and a symlink has nothing to redirect.
//
// Tests reach the armed/disarmed cases by mocking the manifest LOADER module,
// which is dependency injection strictly below the authority boundary and has
// no production equivalent.
function loadCanonicalAuthority() {
  try {
    return {
      manifest: loadControlPlaneManifest(),
      path: CONTROL_PLANE_MANIFEST_PATH,
    };
  } catch (error) {
    return {
      error: `canonical control-plane manifest failed validation: ${error.message}`,
    };
  }
}

// The manifest's grant is JSON the machine can edit, so the grant TEXT is not
// the authority — the reviewed merge behind it is. This authenticates that
// merge against the forge on every authorization (see authority.mjs), which is
// what makes arming a reviewable human act rather than a one-character edit.
function authenticateGrant(manifest) {
  const grant = manifest.safety.notionWriteAuthorization;
  if (!isPlainObject(grant))
    return refuse(
      "permission_denial",
      "write authority carries no owner grant — a bare true is a self-grant, not authority."
    );
  if (grant.grantedBy !== "PREZ" || grant.actor !== "AI-10")
    return refuse(
      "permission_denial",
      "owner grant does not name PREZ as grantor and AI-10 as actor."
    );
  const authenticated = resolveOwnerGrantAuthority(grant);
  if (!authenticated.ok)
    return refuse(
      authenticated.failure_class ?? "permission_denial",
      `owner grant is not authentic: ${authenticated.detail}`
    );
  return { ok: true, fact: authenticated.fact };
}

// Identifies WHICH grant authorized a capability, so execute time can prove the
// authority on disk is still the same authority — not merely still truthy.
function grantFingerprint(manifest) {
  return JSON.stringify([
    manifest.safety.notionWriteOperationsAuthorized,
    manifest.safety.notionWriteAuthorization ?? null,
  ]);
}

// EVERY scalar the gates rely on is read from the caller's plan exactly ONCE,
// into this frozen copy. Round-2 verification showed `plan.task_id` was read
// three times — gate, capability, and target.page_id — so a getter could pass
// the identity/scope/project gates for a legitimate page and then land the write
// on an arbitrary one, with the attestation naming the innocent page
// (NEW2-OG6-0013). Same class for authority/trigger (NEW2-OG6-0019).
function snapshotPlan(plan) {
  if (!isPlainObject(plan)) return { error: "plan is not an object" };
  const read = key => {
    try {
      return plan[key];
    } catch {
      return undefined;
    }
  };
  const scalars = {
    schema_version: read("schema_version"), // read once, like every other field
    plan_id: read("plan_id"),
    event_key: read("event_key"),
    task_id: read("task_id"),
    trigger: read("trigger"),
    authority: read("authority"),
    actor: read("actor"),
    expected_from_state: read("expected_from_state"),
    expected_generation: read("expected_generation") ?? null,
    restores_state: read("restores_state") ?? null,
  };
  for (const key of [
    "plan_id",
    "event_key",
    "task_id",
    "trigger",
    "authority",
    "actor",
  ]) {
    if (typeof scalars[key] !== "string" || scalars[key] === "")
      return { error: `plan.${key} must be a non-empty string` };
  }
  const writes = snapshotWrites(read("writes"));
  if (writes.error) return { error: `plan writes rejected: ${writes.error}` };
  return {
    plan: Object.freeze({
      ...scalars,
      writes: writes.copy,
      evidence: plainCopy(read("evidence") ?? {}),
    }),
  };
}

// ---------------------------------------------------------------------------
// AUTHORIZE — the pre-write gates. Every one refuses visibly; the order is
// fail-fast but every gate is independent law.
// ---------------------------------------------------------------------------
export function authorizeWrite(plan, snapshot, opts = {}) {
  // The option surface is closed. An unknown key is refused, not ignored:
  // silently dropping `manifest_path` would make a reintroduced seam invisible.
  if (!isPlainObject(opts))
    return refuse("malformed_input", "opts must be an object.");
  const unknownOptions = Object.keys(opts).filter(
    key => !ALLOWED_OPTION_KEYS.includes(key)
  );
  if (unknownOptions.length > 0)
    return refuse(
      "malformed_input",
      `unknown writer option(s): ${unknownOptions.join(", ")} — the option surface is closed, and authority in particular is never caller-selectable.`
    );

  // connector health — unresolved credential/permission failure blocks all writes
  if (opts.connector_failure)
    return refuse(
      String(opts.connector_failure.failure_class ?? "permission_denial"),
      `unresolved connector failure: ${opts.connector_failure.detail ?? "(no detail)"} — resolve it before any write.`
    );

  // authority — loaded and validated from the CANONICAL manifest on EVERY
  // write, so the kill switch is a real switch and a caller cannot assert,
  // redirect, or select its own permission.
  const authority = loadCanonicalAuthority();
  if (authority.error) return refuse("permission_denial", authority.error);
  const manifest = authority.manifest;
  if (manifest.safety.notionWriteOperationsAuthorized !== true)
    return refuse(
      "permission_denial",
      "notion-write-unauthorized: manifest safety.notionWriteOperationsAuthorized is not true — the kill switch is engaged; no live write may execute."
    );
  const grantCheck = authenticateGrant(manifest);
  if (!grantCheck.ok) return grantCheck;

  // plan shape — the caller's plan is read EXACTLY ONCE into a frozen copy, and
  // only that copy is used from here on. Reading safe.task_id again later let a
  // getter pass the scope gates for one page and land the write on another
  // (NEW2-OG6-0013); the same class applied to authority/trigger (0019).
  const snapshotted = snapshotPlan(plan);
  if (snapshotted.error)
    return refuse("malformed_input", `plan rejected: ${snapshotted.error}.`);
  const safe = snapshotted.plan;
  if (safe.schema_version !== WRITER_SCHEMA_VERSION)
    return refuse("malformed_input", "plan is not a v1 writer mutation plan.");
  // idempotency — an event key that already produced an attestation never
  // executes twice (visible no-op, mirrors the kernel's duplicate law)
  const attested = opts.attested_event_keys;
  if (attested !== undefined && !(attested instanceof Set))
    return refuse(
      "malformed_input",
      "attested_event_keys must be a Set — a duck-typed lookup could silently answer false."
    );
  if (attested?.has(safe.event_key))
    return {
      ok: true,
      duplicate: true,
      failure_class: "duplicate_event",
      detail: `event ${safe.event_key} already has an attestation — idempotent no-op, no second mutation.`,
    };

  const writes = safe.writes;

  // canonical task exists, identity matches, snapshot is FRESH
  if (!isPlainObject(snapshot))
    return refuse(
      "stale_task",
      "no fresh snapshot of the canonical Task was provided — reread before acting."
    );
  if (snapshot.page_id !== safe.task_id)
    return refuse(
      "malformed_input",
      `snapshot is for page ${snapshot.page_id}, plan targets ${safe.task_id}.`
    );
  // Number.isFinite, not typeof: NaN is a number and made every comparison
  // below false, authorizing a snapshot ten days old (NEW2-OG6-0015).
  if (!Number.isFinite(snapshot.fetched_at))
    return refuse(
      "stale_task",
      "snapshot freshness is unprovable (fetched_at is not a finite number) — refusing rather than assuming."
    );
  const now = Date.now();
  const requested = opts.max_snapshot_age_ms;
  if (requested !== undefined && !Number.isFinite(requested))
    return refuse(
      "malformed_input",
      "max_snapshot_age_ms must be a finite number — a non-finite bound is not a bound."
    );
  const maxAge = Math.min(
    requested === undefined ? MAX_SNAPSHOT_AGE_MS : requested,
    MAX_SNAPSHOT_AGE_MS
  );
  const age = now - snapshot.fetched_at;
  if (age > maxAge || age < 0)
    return refuse(
      "stale_task",
      `snapshot of ${safe.task_id} is ${age}ms old (max ${maxAge}ms) — reread before acting.`
    );

  // permitted Tailered OS scope only
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

  // The snapshot must be SELF-CONSISTENT before any gate trusts it: the state
  // the gates read and the property value the priors are captured from are the
  // same field of the same record, so a disagreement means the snapshot is not
  // a faithful read (NEW3-OG6-0023). An unset select ("" / null / absent) is
  // legitimate on a fresh row and is not a disagreement.
  if (Object.hasOwn(snapshot.properties ?? {}, "Execution State")) {
    const asProperty = snapshot.properties["Execution State"];
    const unset =
      asProperty === "" || asProperty === null || asProperty === undefined;
    if (!unset && asProperty !== snapshot.execution_state)
      return refuse(
        "stale_task",
        `snapshot is internally inconsistent: execution_state "${snapshot.execution_state}" but properties["Execution State"] is "${asProperty}" — a snapshot that disagrees with itself is not a faithful read; re-read the task.`
      );
  }

  // current state equals the plan's expected from-state
  if (snapshot.execution_state !== safe.expected_from_state)
    return refuse(
      "stale_task",
      `live Execution State is "${snapshot.execution_state}", plan expects "${safe.expected_from_state}" — the record moved; refold from fresh facts.`
    );

  // the transition exists in the closed table
  const transition = TRANSITIONS.find(
    t =>
      t.trigger_event_type === safe.trigger &&
      (t.from === safe.expected_from_state ||
        (t.from === "*" && safe.expected_from_state !== null))
  );
  if (!transition)
    return refuse(
      "malformed_input",
      `plan trigger "${safe.trigger}" from "${safe.expected_from_state}" matches no row of the closed transition table.`
    );

  // `write_reverified` is a from:"*" wildcard row, so a plan carrying it could
  // otherwise set ANY allowlisted value from ANY state — sequencing laundering
  // straight to Merged or Approval (NEW-OG6-0008). The ONLY write-bearing
  // write_reverified is an UNDO bound to a real prior authorization: its writes
  // must be exactly that authorization's captured priors, and it must start
  // from the state that authorization wrote.
  const isUndo = safe.trigger === "write_reverified";

  // THE TARGET STATE MUST BE THE ROW'S TARGET STATE. Proving that (trigger,
  // from) exists in the table said nothing about what the plan actually writes,
  // so a plain machine `work_started` plan from Ready authorized and applied
  // "Execution State": "Merged" — laundering a record into the states the
  // runbook calls permanently human, through the sanctioned path, with no
  // Proxy and no forged capability (NEW2-OG6-0014). This is the gate that makes
  // "approval and merge are human" true at the writer, not just at the kernel.
  // Bookkeeping triggers imply no live write. deriveWrites refuses them, but a
  // hand-built plan reached authorizeWrite through the from:"*" row and
  // overwrote Proof / Result on a Verified record (NEW3-OG6-0026).
  if (safe.trigger === "mutation_result")
    return refuse(
      "malformed_input",
      "mutation_result is writer bookkeeping and never carries a live Notion write."
    );

  // Every state-bearing row MUST declare the state it writes; the gate used to
  // be keyed on the key being present, so omitting it skipped the gate
  // entirely (NEW3-OG6-0026).
  if (!isUndo && typeof transition.to === "string" && transition.to !== null) {
    if (!Object.hasOwn(writes, "Execution State"))
      return refuse(
        "malformed_input",
        `trigger "${safe.trigger}" moves the record to "${transition.to}" — the plan must declare that Execution State write, not omit it.`
      );
  }
  if (!isUndo && Object.hasOwn(writes, "Execution State")) {
    const declared = writes["Execution State"];
    if (typeof transition.to === "string") {
      if (declared !== transition.to)
        return refuse(
          "authority_violation",
          `plan writes Execution State "${declared}" but trigger "${safe.trigger}" from "${safe.expected_from_state}" may only produce "${transition.to}" — the transition table decides the target state, never the plan.`
        );
    } else if (safe.trigger === "unblocked") {
      // Dynamic row: returns to the state recorded when the task was blocked.
      // "not Blocked" was the only constraint, which made this a one-step jump
      // to any state including Merged (NEW3-OG6-0025). The caller must now
      // carry blocked_from from the kernel fold and it must match what is
      // written.
      if (declared === "Blocked")
        return refuse(
          "malformed_input",
          "an unblock must leave Blocked — writing Blocked is not an unblock."
        );
      const blockedFrom = snapshot.blocked_from;
      if (typeof blockedFrom !== "string" || blockedFrom === "")
        return refuse(
          "missing_evidence",
          "an unblock must carry the recorded blocked_from state (snapshot.blocked_from) — without it the target state is unconstrained."
        );
      if (declared !== blockedFrom)
        return refuse(
          "authority_violation",
          `an unblock returns the record to "${blockedFrom}", not "${declared}" — the recorded blocked_from decides, never the plan.`
        );
    } else {
      // Annotation rows (mutation_result) never change state.
      if (declared !== snapshot.execution_state)
        return refuse(
          "authority_violation",
          `trigger "${safe.trigger}" is an annotation and may not change Execution State (live "${snapshot.execution_state}", plan "${declared}").`
        );
    }
  }

  if (isUndo) {
    const origin = opts.undo_of;
    if (!String(safe.plan_id).startsWith("undo:") || !isPlainObject(origin))
      return refuse(
        "permission_denial",
        "write_reverified implies a live write only as an undo bound to a prior authorization — pass opts.undo_of (the authorized plan being reverted)."
      );
    if (!AUTHORIZED_CAPABILITIES.has(origin))
      return refuse(
        "permission_denial",
        "opts.undo_of is not a capability this writer authorized — an undo must revert a real authorization, not a hand-built object."
      );
    const captured = Object.keys(origin.prior).sort();
    const restoring = Object.keys(writes).sort();
    const sameKeys =
      restoring.length === captured.length &&
      restoring.every((key, index) => key === captured[index]);
    if (!sameKeys || restoring.some(key => writes[key] !== origin.prior[key]))
      return refuse(
        "permission_denial",
        "an undo must restore EXACTLY the prior values captured by the authorization it reverts — this plan writes something else."
      );
    const wroteState =
      origin.writes?.["Execution State"] ?? origin.expected_from_state;
    if (safe.expected_from_state !== wroteState)
      return refuse(
        "stale_task",
        `undo expects the record at "${safe.expected_from_state}", but the authorization it reverts wrote "${wroteState}".`
      );
    // Reverting a HUMAN-authority write moves the record backward across a
    // human decision, so the undo itself needs an observed human act.
    if (origin.authority === "human") {
      if (safe.actor !== "human" || !safe.evidence?.observed_via)
        return refuse(
          "authority_violation",
          `undoing a human-authority ${origin.trigger} requires an observed human act (actor "human" + observed_via) — a machine may not walk back a human decision.`
        );
    }
  }

  // actor authority — human transitions demand DERIVED evidence of a human act
  if (transition.authority !== safe.authority)
    return refuse(
      "authority_violation",
      `plan claims authority "${safe.authority}" but the table says "${transition.authority}" — plans never reinterpret authority.`
    );

  // Facts are validated here and CONSUMED only once every gate has passed, so a
  // plan that fails a later gate does not burn evidence the operator must then
  // re-resolve.
  const toConsume = [];
  const checkFact = (token, expectedKind, label) => {
    if (!isAuthorityFact(token))
      return refuse(
        "authority_violation",
        `${label} requires authority evidence derived by the authority adapter; what was supplied is not a fact this system minted. A caller-built object with the right shape is not evidence — resolve it against the source system.`
      );
    const meta = readAuthorityFact(token);
    if (meta.kind !== expectedKind)
      return refuse(
        "authority_violation",
        `${label} requires a ${expectedKind} fact; a ${meta.kind} fact was supplied.`
      );
    if (meta.consumed)
      return refuse(
        "authority_violation",
        `the ${meta.kind} fact for ${label} was already consumed — evidence authorizes one transition.`
      );
    if (meta.age_ms > MAX_SNAPSHOT_AGE_MS || meta.age_ms < 0)
      return refuse(
        "stale_task",
        `the ${meta.kind} fact for ${label} is ${meta.age_ms}ms old (max ${MAX_SNAPSHOT_AGE_MS}ms) — re-resolve it.`
      );
    return { ok: true };
  };
  const mustEqual = (actual, expected, label) =>
    String(actual ?? "") === String(expected ?? "")
      ? null
      : refuse(
          "authority_violation",
          `${label}: the plan says "${actual}" but the authenticated evidence says "${expected}" — the source system decides, never the plan.`
        );

  const authoritySource = Object.hasOwn(TRIGGER_AUTHORITY_SOURCE, safe.trigger)
    ? TRIGGER_AUTHORITY_SOURCE[safe.trigger]
    : null;

  if (transition.authority === "human" && !isUndo) {
    if (!authoritySource)
      return refuse(
        "authority_violation",
        `${safe.trigger} is a human-authority transition with no declared authority source — it cannot be authenticated, so it fails closed.`
      );
    // `actor: "human"` is still required as the kernel's vocabulary, but it is
    // no longer what makes the transition lawful — the derived fact is.
    if (safe.actor !== "human")
      return refuse(
        "authority_violation",
        `${safe.trigger} is a human-authority transition; plan actor is "${safe.actor}". The writer records observed human acts; it never performs them.`
      );
    const fact = opts.authority_fact;
    const usable = checkFact(fact, authoritySource.kind, safe.trigger);
    if (usable.ok !== true) return usable;

    // The plan's evidence must AGREE with the fetched evidence. It cannot
    // supply it: every field below is compared against what the forge returned.
    const disagreement =
      mustEqual(
        safe.evidence?.observed_via,
        fact.evidence_url,
        `${safe.trigger} observed_via`
      ) ??
      (safe.trigger === "approval_observed"
        ? (mustEqual(
            safe.evidence?.reviewer,
            fact.human_identity,
            "approval reviewer"
          ) ??
          mustEqual(
            safe.evidence?.review_id,
            fact.review_id,
            "approval review_id"
          ) ??
          mustEqual(
            safe.evidence?.review_state,
            fact.review_state,
            "approval review_state"
          ))
        : safe.trigger === "merge_observed"
          ? mustEqual(safe.evidence?.merge_sha, fact.merge_sha, "merge sha")
          : null);
    if (disagreement) return disagreement;
    toConsume.push({ token: fact, kind: authoritySource.kind });
  }

  // PR/SHA evidence must match CURRENT forge state. Round 1 satisfied this with
  // `opts.github`, an object the caller also filled in — the same defect one
  // layer over. It now takes a derived github_head/github_merge fact.
  if (
    ["pr_opened", "checks_observed", "merge_observed"].includes(safe.trigger)
  ) {
    const isMerge = safe.trigger === "merge_observed";
    // merge_observed already carries an authenticated github_merge fact above;
    // requiring a second fetch of the same object would add no evidence.
    const fact = isMerge ? opts.authority_fact : opts.github_fact;
    if (!isMerge) {
      const usable = checkFact(
        fact,
        "github_head",
        `${safe.trigger} SHA check`
      );
      if (usable.ok !== true) return usable;
      toConsume.push({ token: fact, kind: "github_head" });
    }
    const claimed = isMerge ? safe.evidence.merge_sha : safe.evidence.head_sha;
    const live = isMerge ? fact.merge_sha : fact.head_sha;
    if (String(claimed) !== String(live))
      return refuse(
        "stale_sha",
        `plan ${isMerge ? "merge_sha" : "head_sha"} ${claimed} does not match the authenticated GitHub ${isMerge ? "merge" : "head"} ${live}.`
      );
    if (safe.trigger === "checks_observed" && fact.check_rollup !== null) {
      if (String(safe.evidence.check_rollup) !== String(fact.check_rollup))
        return refuse(
          "stale_sha",
          `plan check_rollup "${safe.evidence.check_rollup}" does not match the authenticated rollup "${fact.check_rollup}".`
        );
    }
  }

  // Terminal verification evidence must be FETCHED, not asserted. Round 1 let a
  // record reach Verified on the strength of an https-shaped string nobody
  // resolved; a proof URL alone is a caller string with a scheme on the front.
  if (safe.trigger === "post_merge_verified") {
    const fact = opts.proof_fact;
    const usable = checkFact(fact, "github_proof", "post_merge_verified");
    if (usable.ok !== true) return usable;
    const mismatch = mustEqual(
      safe.evidence?.evidence_ref,
      fact.evidence_url,
      "post_merge_verified evidence_ref"
    );
    if (mismatch) return mismatch;
    toConsume.push({ token: fact, kind: "github_proof" });
  }

  // target database, properties, and mutation shapes are allowlisted —
  // validated on THE COPY that will be sent, not on the caller's live object.
  const writeProblem = validateWriteMap(writes, { allowClear: isUndo });
  if (writeProblem)
    return refuse("permission_denial", `allowlist violation: ${writeProblem}.`);

  // reversibility — capture prior values so every write has an undo
  const prior = {};
  for (const property of Object.keys(writes)) {
    if (!Object.hasOwn(snapshot.properties ?? {}, property))
      return refuse(
        "stale_task",
        `snapshot does not carry current value of "${property}" — reversibility is unprovable without it.`
      );
    const captured = snapshot.properties[property];
    // Normalise to a string: a null/undefined live value is an EMPTY property,
    // and an un-normalised object here both broke reversibility (0022) and let
    // deepFreeze walk a caller-owned graph (0021).
    prior[property] =
      captured === null || captured === undefined
        ? ""
        : typeof captured === "string"
          ? captured
          : String(captured);
  }

  // no unresolved partial-write freeze
  if (
    opts.pending_partial_write === true ||
    snapshot.pending_partial_write === true
  )
    return refuse(
      "partial_write",
      `task ${safe.task_id} has an unresolved partially applied mutation — write_reverified is required before any further write.`
    );

  // Every gate has passed: burn the evidence now, so one authenticated human
  // act authorizes exactly one transition and cannot be replayed into a second.
  for (const { token, kind } of toConsume) {
    const consumed = consumeAuthorityFact(token, {
      kind,
      max_age_ms: MAX_SNAPSHOT_AGE_MS,
    });
    if (!consumed.ok)
      return refuse(
        consumed.failure_class,
        `authority evidence: ${consumed.detail}`
      );
  }

  // The authorized plan is an UNFORGEABLE CAPABILITY: built from the validated
  // copy, deep-frozen, and registered in a module-private WeakSet that
  // executeMutation checks. Shape is not authenticity.
  const capability = deepFreeze({
    schema_version: safe.schema_version,
    plan_id: safe.plan_id,
    event_key: safe.event_key,
    task_id: safe.task_id,
    trigger: safe.trigger,
    authority: safe.authority,
    actor: safe.actor,
    evidence: plainCopy(safe.evidence ?? {}),
    expected_from_state: safe.expected_from_state,
    expected_generation: safe.expected_generation ?? null,
    writes,
    prior,
    authorized_at: now,
    authority_source: authority.path,
    grant_fingerprint: grantFingerprint(manifest),
    target: {
      data_source_id: WRITE_ALLOWLIST.data_source_id,
      page_id: safe.task_id,
    },
  });
  AUTHORIZED_CAPABILITIES.set(capability, {
    minted_at: now,
    grant_fingerprint: grantFingerprint(manifest),
    consumed: false,
  });
  return { ok: true, duplicate: false, authorized_plan: capability };
}

// ---------------------------------------------------------------------------
// WRITE → REREAD → COMPARE → ATTEST. The transport is injected: tests use
// fakes; the live session supplies the governed Notion connector. Transport
// errors are classified fail-closed — an error AFTER the write may mean bytes
// landed, so the writer rereads before deciding, and an unreadable outcome is
// a partial write (freeze), never an assumed success or an assumed no-op.
// ---------------------------------------------------------------------------
export async function executeMutation(authorizedPlan, transport) {
  // Authenticity: membership in the module-private registry, not object shape.
  // A hand-built object with a `prior` key used to satisfy this (NEW-OG6-0005).
  if (
    !isPlainObject(authorizedPlan) ||
    !AUTHORIZED_CAPABILITIES.has(authorizedPlan)
  )
    throw new LifecycleError(
      "writer-unauthorized-plan",
      "executeMutation was handed something this writer never authorized.",
      "executing unvalidated plans is exactly the bypass the policy layer exists to prevent; a forged capability would write past every gate and past the kill switch.",
      "call authorizeWrite and pass the exact object it returned as authorized_plan."
    );
  const mint = AUTHORIZED_CAPABILITIES.get(authorizedPlan);

  // SINGLE USE. A capability is permission for ONE write; replaying it wrote a
  // stale value over a record that had moved on (NEW2-OG6-0017).
  if (mint.consumed)
    throw new LifecycleError(
      "writer-capability-spent",
      `the capability for ${authorizedPlan.plan_id} was already executed.`,
      "a capability is permission for exactly one write; replaying it would overwrite a record that may have moved since.",
      "re-read the task, re-derive the plan, and authorize again."
    );

  // TIME-BOUNDED, and authority is RE-READ from disk here. Otherwise the kill
  // switch only stopped new authorizations while outstanding capabilities kept
  // writing (NEW2-OG6-0017).
  const age = Date.now() - mint.minted_at;
  if (age > CAPABILITY_TTL_MS || age < 0)
    throw new LifecycleError(
      "writer-capability-expired",
      `the capability for ${authorizedPlan.plan_id} is ${age}ms old (max ${CAPABILITY_TTL_MS}ms).`,
      "an old capability was authorized against a snapshot of the world that no longer holds.",
      "re-read the task and authorize again."
    );
  const recheck = loadCanonicalAuthority();
  if (
    recheck.error ||
    recheck.manifest.safety.notionWriteOperationsAuthorized !== true
  )
    throw new LifecycleError(
      "notion-write-unauthorized",
      `write authority is no longer granted at execute time (${recheck.error ?? "kill switch engaged"}).`,
      "the kill switch must stop writes that are already in flight, not merely new authorizations.",
      "re-arm the manifest through an owner-reviewed PR if the write is still intended."
    );
  // Still true is not enough: it must be the SAME grant. A grant swapped
  // between authorize and execute would otherwise ride an in-flight capability.
  if (grantFingerprint(recheck.manifest) !== mint.grant_fingerprint)
    throw new LifecycleError(
      "notion-write-unauthorized",
      "the owner grant on disk changed between authorization and execution.",
      "a capability is permission under one specific reviewed grant; a different grant is a different decision.",
      "re-read the task and authorize again under the current grant."
    );
  AUTHORIZED_CAPABILITIES.set(authorizedPlan, { ...mint, consumed: true });
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

  // The capability is frozen and was validated at authorization, so the payload
  // is a plain copy of already-lawful data — no second read of caller memory.
  const payload = { ...authorizedPlan.writes };
  const tamper = validateWriteMap(payload, {
    allowClear: authorizedPlan.trigger === "write_reverified",
  });
  if (tamper)
    throw new LifecycleError(
      "writer-plan-tampered",
      `the capability's write map violates the allowlist at the transport boundary: ${tamper}.`,
      "a capability that changed after authorization is exactly the TOCTOU bypass the policy layer exists to prevent.",
      "re-derive and re-authorize the plan; never mutate an authorized plan."
    );

  const classifyTransportError = error => {
    const code = String(error?.code ?? error?.message ?? "");
    if (/permission|forbidden|unauthorized|403/i.test(code))
      return "permission_denial";
    if (/timeout|timed?[ _-]?out|ETIMEDOUT|ECONN/i.test(code))
      return "api_timeout";
    if (/expired|credential|401/i.test(code)) return "expired_credentials";
    return "api_timeout"; // unknown transport failure: reachability, fail-closed
  };

  let writeError = null;
  try {
    await transport.updatePage(authorizedPlan.target.page_id, payload);
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

  const observedProperties = isPlainObject(observed?.properties)
    ? observed.properties
    : null;
  const readObserved = property =>
    observedProperties && Object.hasOwn(observedProperties, property)
      ? observedProperties[property]
      : undefined;

  const mismatches = [];
  for (const [property, planned] of Object.entries(payload)) {
    if (readObserved(property) !== planned)
      mismatches.push({
        property,
        planned,
        actual: readObserved(property) ?? null,
      });
  }

  if (mismatches.length === 0) {
    if (writeError)
      return {
        applied: "full",
        attestation: buildAttestation(authorizedPlan, observed, "full", {
          write_error: classifyTransportError(writeError),
          detail:
            "transport errored after the bytes landed; reread matches the plan.",
        }),
      };
    return {
      applied: "full",
      attestation: buildAttestation(authorizedPlan, observed, "full", {}),
    };
  }

  if (writeError && mismatches.length === Object.keys(payload).length)
    return {
      applied: "none",
      failure_class: classifyTransportError(writeError),
      attestation: buildAttestation(authorizedPlan, observed, "none", {
        write_error: classifyTransportError(writeError),
        detail:
          "transport refused before any byte landed; record verified unchanged.",
      }),
    };

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
  const observedProperties = isPlainObject(observed?.properties)
    ? observed.properties
    : null;
  return {
    schema_version: WRITER_SCHEMA_VERSION,
    attestation_for: plan.plan_id,
    event_key: plan.event_key,
    task_id: plan.task_id,
    trigger: plan.trigger,
    applied,
    planned_writes: { ...plan.writes },
    prior_values: { ...plan.prior },
    observed_after: observedProperties
      ? Object.fromEntries(
          Object.keys(plan.writes).map(property => [
            property,
            Object.hasOwn(observedProperties, property)
              ? observedProperties[property]
              : null,
          ])
        )
      : null,
    observed_generation_source: observed?.fetched_at ?? null,
    authority_source: plan.authority_source ?? null,
    ...extra,
  };
}

// Reversibility made concrete: the undo plan writes the captured prior values
// back through the same authorize/execute contract (same allowlist, same gates,
// same attestation).
//
// It is modelled as a `write_reverified` repair, not as a replay of the original
// trigger: the original trigger's transition row does not exist from the state
// the write just produced, so an undo carrying it could never authorize
// (FIND-OG6-0004). `authorizeWrite` binds the undo to the capability it reverts,
// so this trigger is not a general-purpose write primitive (NEW-OG6-0008).
export function buildUndoPlan(authorizedPlan) {
  if (
    !isPlainObject(authorizedPlan) ||
    !AUTHORIZED_CAPABILITIES.has(authorizedPlan)
  )
    return refuse(
      "malformed_input",
      "only a capability this writer authorized can be undone."
    );
  return {
    ok: true,
    plan: {
      schema_version: WRITER_SCHEMA_VERSION,
      plan_id: `undo:${authorizedPlan.plan_id}`,
      event_key: `undo:${authorizedPlan.event_key}`,
      task_id: authorizedPlan.task_id,
      trigger: "write_reverified",
      authority: "machine",
      actor: "machine",
      evidence: {
        verification_ref: `undo-of:${authorizedPlan.plan_id}`,
        reverting_trigger: authorizedPlan.trigger,
      },
      expected_from_state:
        authorizedPlan.writes["Execution State"] ??
        authorizedPlan.expected_from_state,
      restores_state:
        authorizedPlan.prior["Execution State"] ??
        authorizedPlan.expected_from_state,
      expected_generation: null,
      writes: { ...authorizedPlan.prior },
    },
  };
}
