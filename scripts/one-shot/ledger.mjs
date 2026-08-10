// One-Shot Execution Event Ledger — append + verify + status kernel.
// Records observable execution facts for evidence-gated campaigns (run manifest,
// hash-chained event envelope, deterministic integrity verification). It is NOT
// a transcript: no chain-of-thought, no secrets, no per-command noise.
//
// Storage authority: Notion holds organizational state, GitHub holds engineering
// truth, this ledger holds execution history. Run artifacts live under
// os/one-shot/runs/<run_id>/ (repo evidence-bundle convention — distinct from
// os/ledger/, which is the token-cost ledger). Follows the
// scripts/tailered-os-control-plane.mjs pattern: hand-written invariants are the
// enforcement; fail loudly rather than record silently-corrupt history.
import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  ".."
);
// ONE_SHOT_RUNS_ROOT override exists for the test suite only — production runs
// always live in the repo's os/one-shot/runs/ evidence location.
export function runsRoot() {
  return (
    process.env.ONE_SHOT_RUNS_ROOT ?? join(REPO_ROOT, "os", "one-shot", "runs")
  );
}

// Controlled event vocabulary (§36 of the campaign contract) plus two documented
// repo extensions: GATE_EVALUATED (gate ledger, §39) and DECISION_RECORDED
// (bootstrap/storage/strategy decisions). Do not add synonyms of existing types.
export const EVENT_TYPES = Object.freeze([
  // campaign
  "RUN_STARTED",
  "RUN_RESUMED",
  "RUN_PAUSED_EXTERNAL",
  "RUN_COMPLETED",
  "RUN_FAILED",
  // context
  "CONTEXT_RESTORED",
  "CONTEXT_VERIFIED",
  "CONTEXT_DRIFT_DETECTED",
  "AUTHORITY_VERIFIED",
  "AUTHORITY_CHANGED",
  // scope
  "SCOPE_DISCOVERED",
  "SCOPE_STARTED",
  "SCOPE_BLOCKED",
  "SCOPE_UNBLOCKED",
  "SCOPE_COMPLETED",
  // planning
  "PLAN_CREATED",
  "PLAN_REVIEWED",
  "PLAN_CHANGED",
  "DEPENDENCY_GRAPH_CHANGED",
  // gstack
  "GSTACK_STARTED",
  "GSTACK_COMPLETED",
  "GSTACK_FINDING",
  "GSTACK_UNAVAILABLE",
  // subagents
  "SUBAGENT_STARTED",
  "SUBAGENT_FINDING",
  "SUBAGENT_COMPLETED",
  "SUBAGENT_DISAGREEMENT",
  // implementation
  "CHANGE_STARTED",
  "CHANGE_APPLIED",
  "CHANGE_REVERTED",
  "SCHEMA_CHANGED",
  "CONFIG_CHANGED",
  // testing
  "TEST_STARTED",
  "TEST_RESULT",
  "NEGATIVE_TEST_RESULT",
  "MUTATION_TEST_RESULT",
  "BENCHMARK_RESULT",
  // findings
  "FINDING_OPENED",
  "FINDING_REMEDIATED",
  "FINDING_REVERIFIED",
  "FINDING_CLOSED",
  // notion
  "NOTION_READ_VERIFIED",
  "NOTION_WRITE_INTENT",
  "NOTION_WRITE_COMMITTED",
  "NOTION_WRITE_VERIFIED",
  "NOTION_DRIFT_DETECTED",
  // github
  "BRANCH_CREATED",
  "COMMIT_CREATED",
  "PR_OPENED",
  "PR_UPDATED",
  "CI_STATE_CHANGED",
  "REVIEW_REQUESTED",
  "REVIEW_COMPLETED",
  "PR_READY",
  "PR_MERGED",
  // human authority
  "OWNER_GATE_CREATED",
  "OWNER_GATE_UPDATED",
  "OWNER_GATE_RESOLVED",
  // deployment
  "DEPLOYMENT_GATE_EVALUATED",
  "STAGING_DEPLOYED",
  "CANARY_STARTED",
  "CANARY_RESULT",
  "PRODUCTION_DEPLOYED",
  "ROLLBACK_STARTED",
  "ROLLBACK_COMPLETED",
  "POST_DEPLOY_VALIDATED",
  // learning
  "LEARNING_CAPTURED",
  "REUSABLE_ASSET_CREATED",
  "SKILLIFY_CANDIDATE",
  "SKILL_CREATED",
  "SKILL_EVALUATED",
  "SKILL_PROMOTED",
  // repo extensions
  "GATE_EVALUATED",
  "DECISION_RECORDED",
]);

export const GATES = Object.freeze([
  "G0",
  "G1",
  "G2",
  "G3",
  "G4",
  "G5",
  "G6",
  "G7",
  "G8",
  "G9",
  "G10",
]);
export const GATE_STATUSES = Object.freeze([
  "PASS",
  "FAIL",
  "BLOCKED",
  "NOT_APPLICABLE",
]);
export const SEVERITIES = Object.freeze([
  "critical",
  "high",
  "medium",
  "low",
  "info",
]);
export const OWNER_GATE_STATES = Object.freeze([
  "OPEN",
  "ANSWERED",
  "SUPERSEDED",
  "CANCELLED",
]);
export const ACTOR_TYPES = Object.freeze(["agent", "human", "system"]);

const ISO_TS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const RUN_ID = /^ONE-\d{8}-[A-Z0-9-]{2,32}$/;
const EVENT_ID = /^evt_\d{5}$/;
// Credential-shaped tripwire, same class the control-plane validator enforces:
// live/test key prefixes, PATs, JWTs, PEM blocks, and passworded connection URIs.
const SECRETISH =
  /(sk_live_|sk_test_|rk_live_|sk-ant-|ghp_[A-Za-z0-9]|github_pat_|xox[bpc]-|xapp-|AKIA[0-9A-Z]{16}|eyJ[A-Za-z0-9_-]{10,}|-----BEGIN|[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^@\s/]+@)/;

function invariant(condition, message) {
  if (!condition) throw new Error(`one-shot-ledger: ${message}`);
}

// Deterministic canonical form: sorted keys at every depth, event_hash excluded.
export function canonicalize(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (value && typeof value === "object") {
    const keys = Object.keys(value)
      .filter(key => key !== "event_hash")
      .sort();
    return `{${keys.map(key => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function hashEvent(event, previousEventHash) {
  return createHash("sha256")
    .update(canonicalize(event) + (previousEventHash ?? ""))
    .digest("hex");
}

export function runDir(runId) {
  return join(runsRoot(), runId);
}
export function manifestPath(runId) {
  return join(runDir(runId), "run-manifest.json");
}
export function eventsPath(runId) {
  return join(runDir(runId), "events.jsonl");
}

export function validateManifest(manifest) {
  invariant(
    manifest && typeof manifest === "object",
    "manifest must be an object"
  );
  invariant(manifest.schema_version === 1, "manifest.schema_version must be 1");
  invariant(
    RUN_ID.test(manifest.run_id ?? ""),
    "manifest.run_id must match ONE-YYYYMMDD-NAME"
  );
  for (const key of [
    "program",
    "scope_id",
    "canonical_task",
    "repository",
    "base_sha",
    "started_at",
    "human_owner",
    "risk_class",
    "authorization_profile",
    "deployment_policy",
    "heartbeat_cadence",
  ]) {
    invariant(
      typeof manifest[key] === "string" && manifest[key].length > 0,
      `manifest.${key} must be a non-empty string`
    );
  }
  invariant(
    ISO_TS.test(manifest.started_at),
    "manifest.started_at must be an ISO-8601 UTC timestamp"
  );
  invariant(
    /^[0-9a-f]{40}$/.test(manifest.base_sha),
    "manifest.base_sha must be a 40-hex sha"
  );
  for (const key of [
    "required_gates",
    "required_gstack",
    "definition_of_done",
    "non_goals",
    "scopes",
  ]) {
    invariant(
      Array.isArray(manifest[key]) &&
        manifest[key].every(v => typeof v === "string" && v.length > 0),
      `manifest.${key} must be an array of non-empty strings`
    );
  }
  invariant(
    manifest.scopes.length > 0,
    "manifest.scopes must declare the allowed scope_id set"
  );
  invariant(
    manifest.required_gates.every(gate => GATES.includes(gate)),
    "manifest.required_gates contains an unknown gate"
  );
  invariant(
    !SECRETISH.test(JSON.stringify(manifest)),
    "manifest contains a credential-shaped value"
  );
  return manifest;
}

export function validateEvent(event, manifest) {
  invariant(event && typeof event === "object", "event must be an object");
  invariant(event.schema_version === 1, "event.schema_version must be 1");
  invariant(
    EVENT_ID.test(event.event_id ?? ""),
    `event_id must match evt_NNNNN (got ${event.event_id})`
  );
  invariant(
    event.run_id === manifest.run_id,
    `event.run_id must be ${manifest.run_id}`
  );
  invariant(
    Number.isInteger(event.sequence) && event.sequence >= 1,
    "event.sequence must be a positive integer"
  );
  invariant(
    ISO_TS.test(event.timestamp ?? ""),
    "event.timestamp must be an ISO-8601 UTC timestamp"
  );
  invariant(
    manifest.scopes.includes(event.scope_id),
    `event.scope_id "${event.scope_id}" is not in the manifest's declared scope set`
  );
  invariant(
    EVENT_TYPES.includes(event.event_type),
    `unknown event_type "${event.event_type}" — the vocabulary is controlled`
  );
  invariant(
    event.actor &&
      ACTOR_TYPES.includes(event.actor.type) &&
      typeof event.actor.name === "string" &&
      event.actor.name.length > 0 &&
      typeof event.actor.role === "string" &&
      event.actor.role.length > 0,
    "event.actor must carry type (agent|human|system), name, role"
  );
  invariant(
    typeof event.summary === "string" &&
      event.summary.length > 0 &&
      event.summary.length <= 2000,
    "event.summary must be a non-empty string of at most 2000 chars"
  );
  if (event.gate !== undefined && event.gate !== null) {
    invariant(
      GATES.includes(event.gate),
      `event.gate must be one of ${GATES.join(",")}`
    );
  }
  if (event.event_type === "GATE_EVALUATED") {
    invariant(GATES.includes(event.gate), "GATE_EVALUATED requires a gate");
    invariant(
      GATE_STATUSES.includes(event.gate_status),
      "GATE_EVALUATED requires gate_status PASS|FAIL|BLOCKED|NOT_APPLICABLE"
    );
  }
  if (event.severity !== undefined && event.severity !== null) {
    invariant(
      SEVERITIES.includes(event.severity),
      `event.severity must be one of ${SEVERITIES.join(",")}`
    );
  }
  if (event.event_type.startsWith("FINDING_")) {
    invariant(
      typeof event.finding === "string" &&
        /^FIND-[A-Z0-9-]+-\d{4}$/.test(event.finding),
      "FINDING_* events require finding id FIND-<SCOPE>-NNNN"
    );
    if (event.event_type === "FINDING_OPENED") {
      invariant(event.severity != null, "FINDING_OPENED requires a severity");
    }
  }
  if (event.event_type.startsWith("OWNER_GATE_")) {
    invariant(
      event.owner_gate &&
        typeof event.owner_gate === "object" &&
        /^OG-\d{3}$/.test(event.owner_gate.id ?? "") &&
        typeof event.owner_gate.decision === "string" &&
        event.owner_gate.decision.length > 0 &&
        typeof event.owner_gate.owner === "string" &&
        event.owner_gate.owner.length > 0 &&
        OWNER_GATE_STATES.includes(event.owner_gate.state),
      "OWNER_GATE_* events require owner_gate {id: OG-NNN, decision, owner, state}"
    );
  }
  if (event.evidence !== undefined && event.evidence !== null) {
    invariant(Array.isArray(event.evidence), "event.evidence must be an array");
    for (const item of event.evidence) {
      invariant(
        item &&
          typeof item.type === "string" &&
          item.type.length > 0 &&
          typeof item.ref === "string" &&
          item.ref.length > 0,
        "each evidence item requires {type, ref}"
      );
    }
  }
  for (const key of ["blocked_by", "unblocked"]) {
    if (event[key] !== undefined && event[key] !== null) {
      invariant(
        Array.isArray(event[key]) &&
          event[key].every(v => typeof v === "string"),
        `event.${key} must be an array of strings`
      );
    }
  }
  invariant(
    !SECRETISH.test(JSON.stringify(event)),
    "event contains a credential-shaped value — secrets never enter the ledger"
  );
  return event;
}

export function loadManifest(runId) {
  return validateManifest(
    JSON.parse(readFileSync(manifestPath(runId), "utf8"))
  );
}

export function readEvents(runId) {
  if (!existsSync(eventsPath(runId))) return [];
  return readFileSync(eventsPath(runId), "utf8")
    .split("\n")
    .filter(line => line.trim().length > 0)
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch {
        throw new Error(
          `one-shot-ledger: events.jsonl line ${index + 1} is not valid JSON`
        );
      }
    });
}

export function initRun(manifest) {
  validateManifest(manifest);
  invariant(
    !existsSync(manifestPath(manifest.run_id)),
    `run ${manifest.run_id} already exists — the run manifest is immutable`
  );
  mkdirSync(runDir(manifest.run_id), { recursive: true });
  writeFileSync(
    manifestPath(manifest.run_id),
    `${JSON.stringify(manifest, null, 2)}\n`
  );
  return manifest;
}

export function appendEvent(runId, partial) {
  const manifest = loadManifest(runId);
  const events = readEvents(runId);
  const previous = events[events.length - 1] ?? null;
  const sequence = (previous?.sequence ?? 0) + 1;
  const event = {
    schema_version: 1,
    event_id: `evt_${String(sequence).padStart(5, "0")}`,
    run_id: runId,
    sequence,
    timestamp: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
    ...partial,
  };
  validateEvent(event, manifest);
  invariant(
    previous === null || event.timestamp >= previous.timestamp,
    "event.timestamp must be monotonically non-decreasing"
  );
  event.previous_event_hash = previous?.event_hash ?? null;
  event.event_hash = hashEvent(event, event.previous_event_hash);
  appendFileSync(eventsPath(runId), `${JSON.stringify(event)}\n`);
  return event;
}

// §43 deterministic integrity verification. Returns {ok, errors[], stats}.
export function verifyRun(runId) {
  const errors = [];
  let manifest;
  try {
    manifest = loadManifest(runId);
  } catch (error) {
    return { ok: false, errors: [String(error.message ?? error)], stats: null };
  }
  const events = readEvents(runId);
  const seenIds = new Set();
  const seenIdempotency = new Set();
  const openOwnerGates = new Map();
  const openFindings = new Map();
  let previousHash = null;
  let previousTimestamp = null;
  events.forEach((event, index) => {
    const at = `event ${index + 1} (${event.event_id ?? "?"})`;
    try {
      validateEvent(event, manifest);
    } catch (error) {
      errors.push(`${at}: ${error.message}`);
      return;
    }
    if (event.sequence !== index + 1)
      errors.push(
        `${at}: sequence ${event.sequence} breaks monotonic order (expected ${index + 1})`
      );
    if (seenIds.has(event.event_id)) errors.push(`${at}: duplicate event_id`);
    seenIds.add(event.event_id);
    if (previousTimestamp !== null && event.timestamp < previousTimestamp) {
      errors.push(
        `${at}: timestamp ${event.timestamp} is earlier than its predecessor`
      );
    }
    previousTimestamp = event.timestamp;
    if (event.idempotency_key != null) {
      if (seenIdempotency.has(event.idempotency_key))
        errors.push(
          `${at}: duplicate idempotency_key ${event.idempotency_key}`
        );
      seenIdempotency.add(event.idempotency_key);
    }
    if ((event.previous_event_hash ?? null) !== previousHash) {
      errors.push(
        `${at}: previous_event_hash does not chain to the prior event`
      );
    }
    const expected = hashEvent(event, event.previous_event_hash);
    if (event.event_hash !== expected)
      errors.push(
        `${at}: event_hash mismatch — event content was altered after append`
      );
    previousHash = event.event_hash;
    if (event.event_type === "OWNER_GATE_CREATED") {
      if (openOwnerGates.has(event.owner_gate.id))
        errors.push(`${at}: owner gate ${event.owner_gate.id} created twice`);
      openOwnerGates.set(event.owner_gate.id, event.owner_gate.state);
    }
    if (
      event.event_type === "OWNER_GATE_UPDATED" ||
      event.event_type === "OWNER_GATE_RESOLVED"
    ) {
      if (!openOwnerGates.has(event.owner_gate.id)) {
        errors.push(
          `${at}: ${event.event_type} references owner gate ${event.owner_gate.id} that was never created`
        );
      } else {
        openOwnerGates.set(event.owner_gate.id, event.owner_gate.state);
      }
    }
    if (event.event_type === "FINDING_OPENED")
      openFindings.set(event.finding, event.severity);
    if (
      ["FINDING_REMEDIATED", "FINDING_REVERIFIED", "FINDING_CLOSED"].includes(
        event.event_type
      )
    ) {
      if (!openFindings.has(event.finding))
        errors.push(
          `${at}: ${event.event_type} references finding ${event.finding} that was never opened`
        );
      if (event.event_type === "FINDING_CLOSED")
        openFindings.delete(event.finding);
    }
  });
  const stats = {
    run_id: runId,
    events: events.length,
    open_owner_gates: [...openOwnerGates.entries()]
      .filter(([, state]) => state === "OPEN")
      .map(([id]) => id),
    open_findings: [...openFindings.entries()].map(([id, severity]) => ({
      id,
      severity,
    })),
  };
  return { ok: errors.length === 0, errors, stats };
}

// §38 status heartbeat, derived mechanically from the event stream — never hand-estimated.
export function deriveStatus(runId) {
  const manifest = loadManifest(runId);
  const events = readEvents(runId);
  const scopeState = new Map();
  const blockedCause = new Map();
  const prs = new Map();
  const gates = new Map();
  const { stats } = verifyRun(runId);
  for (const event of events) {
    if (event.event_type === "SCOPE_STARTED")
      scopeState.set(event.scope_id, "EXECUTING");
    if (event.event_type === "SCOPE_BLOCKED") {
      scopeState.set(event.scope_id, "BLOCKED");
      blockedCause.set(event.scope_id, event.summary);
    }
    if (event.event_type === "SCOPE_UNBLOCKED")
      scopeState.set(event.scope_id, "EXECUTING");
    if (event.event_type === "SCOPE_COMPLETED")
      scopeState.set(event.scope_id, "COMPLETED");
    if (
      ["PR_OPENED", "PR_UPDATED", "PR_READY", "PR_MERGED"].includes(
        event.event_type
      ) &&
      event.pr != null
    ) {
      prs.set(event.pr, {
        state: event.event_type,
        head: event.head_sha ?? null,
      });
    }
    if (event.event_type === "GATE_EVALUATED") {
      gates.set(`${event.scope_id}:${event.gate}`, event.gate_status);
    }
  }
  const last = events[events.length - 1] ?? null;
  const terminalScopes = [...scopeState.entries()]
    .filter(([, s]) => s === "COMPLETED")
    .map(([s]) => s);
  return {
    run: manifest.run_id,
    generated_at: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
    last_event: last
      ? { id: last.event_id, type: last.event_type, summary: last.summary }
      : null,
    executing_scopes: [...scopeState.entries()]
      .filter(([, s]) => s === "EXECUTING")
      .map(([s]) => s),
    blocked_lanes: [...blockedCause.entries()]
      .filter(([scope]) => scopeState.get(scope) === "BLOCKED")
      .map(([scope, cause]) => ({ scope, cause })),
    open_criticals: (stats?.open_findings ?? []).filter(
      f => f.severity === "critical"
    ),
    open_highs: (stats?.open_findings ?? []).filter(f => f.severity === "high"),
    open_owner_gates: stats?.open_owner_gates ?? [],
    active_prs: [...prs.entries()].map(([pr, info]) => ({ pr, ...info })),
    gates: Object.fromEntries(gates),
    program_completion: `${terminalScopes.filter(s => /^TOS-\d{3}$/.test(s)).length} of ${manifest.scopes.filter(s => /^TOS-\d{3}$/.test(s)).length} declared TOS scopes terminal`,
    next_action: last?.next_action ?? null,
  };
}

// CLI: node scripts/one-shot/ledger.mjs <init|append|verify|status> <run_id> [json]
const invokedDirectly =
  process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) {
  const [, , command, runId, payload] = process.argv;
  try {
    if (command === "init") {
      const manifest = initRun(JSON.parse(payload ?? readFileSync(0, "utf8")));
      console.log(`initialized run ${manifest.run_id}`);
    } else if (command === "append") {
      const event = appendEvent(
        runId,
        JSON.parse(payload ?? readFileSync(0, "utf8"))
      );
      console.log(`${event.event_id} ${event.event_type} recorded`);
    } else if (command === "verify") {
      const result = verifyRun(runId);
      console.log(JSON.stringify(result, null, 2));
      if (!result.ok) process.exit(1);
    } else if (command === "status") {
      console.log(JSON.stringify(deriveStatus(runId), null, 2));
    } else {
      console.error(
        "usage: ledger.mjs <init|append|verify|status> <run_id> [json]"
      );
      process.exit(2);
    }
  } catch (error) {
    console.error(String(error.message ?? error));
    process.exit(1);
  }
}
