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
  realpathSync,
  rmdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import {
  dirname,
  isAbsolute,
  join,
  relative,
  resolve as resolvePath,
} from "node:path";
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
  // subagent terminal vocabulary (Campaign Three, Law 3 / 2R v2.1): a dispatch
  // that did not COMPLETE ends in exactly one of these, never silently dangles.
  "SUBAGENT_FAILED",
  "SUBAGENT_CANCELLED",
  "SUBAGENT_ABORTED",
  "SUBAGENT_SUPERSEDED",
  // assurance layer (Campaign Three, Laws 16-18)
  "STALL_SUSPECTED",
  "INTERVENTION",
  "DRIFT",
  "CONFLICT",
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
  // universal execution memory (Campaign Four, directive §6-§7): artifact
  // lifecycle + dependency invalidation + composition + memory reconciliation.
  // These are the ONLY sanctioned spellings — no synonyms.
  "ARTIFACT_REGISTERED",
  "ARTIFACT_UPDATED",
  "ARTIFACT_CONSUMED",
  "ARTIFACT_VALIDATED",
  "ARTIFACT_SUPERSEDED",
  "ARTIFACT_RETIRED",
  "DEPENDENCY_INVALIDATED",
  "DEPENDENCY_REVALIDATED",
  "COMPOSITION_EVALUATED",
  "MEMORY_RECONCILED",
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
// §24 (Campaign Four): an OPEN gate optionally declares WHAT it blocks, so the
// closeout can emit denominators by class instead of prose. RESOLVED in the
// §24 sense maps to state ANSWERED.
export const OWNER_GATE_CLASSIFICATIONS = Object.freeze([
  "RUN_BLOCKING", // blocks this run's COMPLETE
  "PROGRAM_OPEN", // open program decision, does not block this run
  "SEQUENCED", // deliberately queued behind another gate/scope
  "STANDING", // permanent policy invariant, never "resolves"
]);
export const ACTOR_TYPES = Object.freeze(["agent", "human", "system"]);

// Envelope contract v2 (Campaign Two, audit findings C1/H1/H4/M1/M2): appends
// stamp version 2 and carry the delivery contract; version-1 events in
// committed historical runs stay valid under their original rules — backward
// verification of v1 runs is a hard requirement. v4 (Campaign Four) adds the
// universal-execution-memory contract: artifact lifecycle identity, the
// dependency-invalidation cascade, composition verdicts, and the
// memory-reconciliation gate. Older versions keep their original rules.
export const EVENT_SCHEMA_VERSION = 4;
// Epistemic labels (Campaign Three, Law 14): every v3 event carries exactly one.
// A PROVEN label must attach a resolvable proof; a REFUTED label blocks its scope.
export const EPISTEMIC_LABELS = Object.freeze([
  "PROVEN",
  "SUPPORTED",
  "INFERRED",
  "UNKNOWN",
  "BLOCKED",
  "REFUTED",
]);
// Subagent dispatches must reach exactly one terminal (Law 3).
export const SUBAGENT_TERMINALS = Object.freeze([
  "SUBAGENT_COMPLETED",
  "SUBAGENT_FAILED",
  "SUBAGENT_CANCELLED",
  "SUBAGENT_ABORTED",
  "SUBAGENT_SUPERSEDED",
]);
// "Delivered is a field, not a vibe": true means delivered-with-proof; every
// other value is an explicit non-delivery that needs an owner decision_ref to
// count as terminal.
export const DELIVERED_VALUES = Object.freeze([
  true,
  "gated",
  "not_applicable",
  "superseded",
]);
// Six facts never collapse — every capability claim names its plane.
export const AUTHORITY_PLANES = Object.freeze([
  "candidate",
  "main",
  "staging",
  "production",
  "live-canonical",
  "design",
]);
export const PROOF_TYPES = Object.freeze([
  "repo",
  "url",
  "event",
  "run-artifact",
]);
// ---- Universal execution memory (Campaign Four, directive §6/§8/§13/§16) ----
// Stable artifact identity: lower-kebab under an ART- prefix, assigned once at
// registration and never reused for different content lineage.
export const ARTIFACT_ID = /^ART-[a-z0-9][a-z0-9-]{1,63}$/;
// §6 committed/external/ephemeral/generated/canonical status — where the bytes
// authoritatively live, per the §8 storage hierarchy.
export const ARTIFACT_STORAGE_CLASSES = Object.freeze([
  "committed", // in-repo, reviewed, durable (schemas, kernels, anchors)
  "external", // out-of-git execution artifacts (run dirs, snapshots, traces)
  "canonical", // lives in a canonical external system (Notion page, GitHub PR)
  "generated", // mechanically derived; regenerable from its inputs
  "ephemeral", // scratch; must be RETIRED or promoted before closeout
]);
// External (non-artifact) upstream identities in depends_on / DEPENDENCY_*
// events use an ext: prefix so a typo'd artifact id cannot masquerade as an
// external dependency: ext:github:pr:496@6c00a6df…, ext:notion:page:<id>, …
export const EXTERNAL_DEP = /^ext:[a-z0-9:/@._-]+$/i;
// §16 composition-gap vocabulary. "Did individually validated components
// remain correct after composition?" — NO_GAP is the only terminal-good verdict.
export const COMPOSITION_VERDICTS = Object.freeze([
  "NO_GAP",
  "FUNCTIONAL_GAP",
  "STATE_GAP",
  "AUTHORITY_GAP",
  "SCHEMA_GAP",
  "SECURITY_GAP",
  "PERFORMANCE_GAP",
  "OBSERVABILITY_GAP",
  "UNKNOWN_GAP",
]);
const ARTIFACT_EVENT_TYPES = Object.freeze([
  "ARTIFACT_REGISTERED",
  "ARTIFACT_UPDATED",
  "ARTIFACT_CONSUMED",
  "ARTIFACT_VALIDATED",
  "ARTIFACT_SUPERSEDED",
  "ARTIFACT_RETIRED",
]);
// Memory-mutating types: after the LAST of these, a clean MEMORY_RECONCILED
// must follow before closeout can return COMPLETE (§47).
export const MEMORY_MUTATING_TYPES = Object.freeze([
  ...ARTIFACT_EVENT_TYPES,
  "DEPENDENCY_INVALIDATED",
  "DEPENDENCY_REVALIDATED",
]);
const GIT_SHA = /^[0-9a-f]{40}$/;
// Runs that legitimately predate the v2 envelope contract. A run whose events
// are schema_version 1 is only trusted to terminalize scopes if it is one of
// these — otherwise a new run could hand-forge v1 events (the marker is
// author-assertable) to dodge the delivery contract. Each entry pins the run's
// tail anchor so a listed id cannot be reused for a different, forged chain.
// (FIND-TOS011-0001: closeout BLOCKS unlisted legacy terminalizations.)
export const HISTORICAL_V1_RUNS = Object.freeze({
  "ONE-20260810-TOS": {
    events_total: 102,
    final_event_hash:
      "7efad216ae715b522ca5400578d790a39f61c2b533f57a7e26863a8c5a624831",
  },
});
const PR_IDENTITY_EVENTS = Object.freeze([
  "PR_OPENED",
  "PR_UPDATED",
  "PR_READY",
  "CI_STATE_CHANGED",
]);

// Fixed-width, no fractional seconds: lexicographic order == temporal order.
// (gstack-review: optional fractions made string comparison unsound.)
const ISO_TS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const RUN_ID = /^ONE-\d{8}-[A-Z0-9-]{2,32}$/;
const EVENT_ID = /^evt_\d{5}$/;
// Credential-shaped tripwire, same class the control-plane validator enforces:
// live/test key prefixes, PATs, JWTs, PEM blocks, and passworded connection URIs.
const SECRETISH =
  /(sk_live_|sk_test_|rk_live_|sk-ant-|ghp_[A-Za-z0-9]|github_pat_|xox[bpc]-|xapp-|AKIA[0-9A-Z]{16}|eyJ[A-Za-z0-9_-]{10,}|-----BEGIN|[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^@\s/]+@)/;

function invariant(condition, message) {
  if (!condition) throw new Error(`one-shot-ledger: ${message}`);
}

// Deterministic canonical form: sorted keys at every depth. event_hash is
// excluded at the TOP LEVEL ONLY — a nested key that happens to be named
// event_hash (e.g. inside an evidence item referencing another event) stays
// inside integrity coverage (FIND-LANE0-0001).
export function canonicalize(value, isRoot = true) {
  if (Array.isArray(value))
    return `[${value.map(item => canonicalize(item, false)).join(",")}]`;
  if (value && typeof value === "object") {
    const keys = Object.keys(value)
      .filter(key => !(isRoot && key === "event_hash"))
      .sort();
    return `{${keys.map(key => `${JSON.stringify(key)}:${canonicalize(value[key], false)}`).join(",")}}`;
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
  if (manifest.required_compositions !== undefined) {
    invariant(
      Array.isArray(manifest.required_compositions) &&
        manifest.required_compositions.every(
          id => typeof id === "string" && id.length > 0
        ),
      "manifest.required_compositions must be an array of integration ids (§16)"
    );
  }
  invariant(
    !SECRETISH.test(JSON.stringify(manifest)),
    "manifest contains a credential-shaped value"
  );
  return manifest;
}

export function validateEvent(event, manifest) {
  invariant(event && typeof event === "object", "event must be an object");
  invariant(
    [1, 2, 3, 4].includes(event.schema_version),
    "event.schema_version must be 1 (historical), 2, 3, or 4"
  );
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
    if (event.owner_gate.classification !== undefined) {
      invariant(
        OWNER_GATE_CLASSIFICATIONS.includes(event.owner_gate.classification),
        `owner_gate.classification must be one of ${OWNER_GATE_CLASSIFICATIONS.join("|")} (§24)`
      );
    }
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
  // ---- v2 contract (audit C1/H1/H4/M1): applies to events appended by the
  // upgraded kernel; version-1 events in historical runs keep their rules. ----
  if (event.schema_version >= 2) {
    if (event.event_type === "SCOPE_COMPLETED") {
      invariant(
        DELIVERED_VALUES.includes(event.delivered),
        'SCOPE_COMPLETED requires delivered: true | "gated" | "not_applicable" | "superseded" — delivered is a field, not a vibe'
      );
      invariant(
        AUTHORITY_PLANES.includes(event.authority_plane),
        `SCOPE_COMPLETED requires authority_plane in ${AUTHORITY_PLANES.join("|")}`
      );
      invariant(
        typeof event.dod_ref === "string" && event.dod_ref.length > 0,
        "SCOPE_COMPLETED requires dod_ref naming the definition-of-done it satisfies"
      );
      if (event.delivered === true) {
        invariant(
          event.proof &&
            PROOF_TYPES.includes(event.proof.type) &&
            typeof event.proof.ref === "string" &&
            event.proof.ref.length > 0,
          "SCOPE_COMPLETED with delivered:true requires a resolvable proof {type, ref}"
        );
      }
    }
    if (PR_IDENTITY_EVENTS.includes(event.event_type)) {
      invariant(
        Number.isInteger(event.pr) && event.pr > 0,
        `${event.event_type} requires an integer pr number`
      );
      invariant(
        GIT_SHA.test(event.head_sha ?? ""),
        `${event.event_type} requires head_sha as an exact 40-hex commit sha`
      );
    }
    if (event.event_type === "PR_MERGED") {
      invariant(
        Number.isInteger(event.pr) && event.pr > 0,
        "PR_MERGED requires an integer pr number"
      );
      invariant(
        GIT_SHA.test(event.head_sha ?? ""),
        "PR_MERGED requires head_sha as an exact 40-hex commit sha"
      );
      invariant(
        GIT_SHA.test(event.merge_sha ?? ""),
        "PR_MERGED requires merge_sha as an exact 40-hex commit sha"
      );
    }
    if (event.event_type.startsWith("GSTACK_")) {
      invariant(
        typeof event.workflow === "string" && event.workflow.length > 0,
        "GSTACK_* events require a structured workflow field (accounting is exact-match, never substring)"
      );
      if (event.event_type === "GSTACK_UNAVAILABLE") {
        invariant(
          typeof event.reason === "string" && event.reason.length > 0,
          "GSTACK_UNAVAILABLE requires a reason proving the workflow was genuinely uninvocable — a skill not invoked by choice is OMITTED, never UNAVAILABLE"
        );
      }
    }
  }
  // ---- v3 assurance contract (Campaign Three, Laws 14-18) ----
  if (event.schema_version >= 3) {
    invariant(
      EPISTEMIC_LABELS.includes(event.label),
      `v3 events require exactly one epistemic label in ${EPISTEMIC_LABELS.join("|")} (Law 14)`
    );
    if (event.label === "PROVEN") {
      invariant(
        Array.isArray(event.evidence) && event.evidence.length > 0,
        "a PROVEN claim must attach at least one evidence reference (Law 14)"
      );
    }
    // Law 18: every dispatch declares its worktree/file scope so the kernel can
    // derive the interaction graph and flag write conflicts.
    if (event.event_type === "SUBAGENT_STARTED") {
      invariant(
        typeof event.scope_declaration === "string" &&
          event.scope_declaration.length > 0,
        "SUBAGENT_STARTED must declare a worktree/file scope_declaration (Law 18)"
      );
    }
    // Law 16: a stall/loop signal names which threshold it breached.
    if (event.event_type === "STALL_SUSPECTED") {
      invariant(
        typeof event.threshold === "string" && event.threshold.length > 0,
        "STALL_SUSPECTED must name the breached threshold (Law 16)"
      );
    }
    if (event.event_type === "INTERVENTION") {
      invariant(
        [
          "continue",
          "stop",
          "retry",
          "transfer-context",
          "reassign",
          "yield-ownership",
        ].includes(event.intervention),
        "INTERVENTION must record one of the declared choices (Law 16)"
      );
    }
    // Law 17: a DRIFT names the pinned digest that mismatched.
    if (event.event_type === "DRIFT") {
      invariant(
        typeof event.instruction_digest === "string" &&
          event.instruction_digest.length > 0,
        "DRIFT must carry the mismatched instruction_digest (Law 17)"
      );
    }
    // Law 18: a CONFLICT names the overlapping scope.
    if (event.event_type === "CONFLICT") {
      invariant(
        typeof event.conflict_scope === "string" &&
          event.conflict_scope.length > 0,
        "CONFLICT must name the overlapping conflict_scope (Law 18)"
      );
    }
  }
  // ---- v4 universal-execution-memory contract (Campaign Four, §6/§7/§13/§16/§47) ----
  // The memory vocabulary did not exist before v4, so a memory-typed event
  // stamped with an older schema_version is definitionally forged — it would
  // dodge every artifact-shape rule and be invisible to the registry while
  // crashing the graph/closeout consumers (review F7).
  invariant(
    !(
      (MEMORY_MUTATING_TYPES.includes(event.event_type) ||
        ["COMPOSITION_EVALUATED", "MEMORY_RECONCILED"].includes(
          event.event_type
        )) &&
      event.schema_version < 4
    ),
    `${event.event_type} requires schema_version >= 4 — the memory vocabulary does not exist in earlier envelope versions`
  );
  if (event.schema_version >= 4) {
    if (ARTIFACT_EVENT_TYPES.includes(event.event_type)) {
      invariant(
        event.artifact && ARTIFACT_ID.test(event.artifact.id ?? ""),
        `${event.event_type} requires artifact.id matching ART-<slug> (§6: stable identity)`
      );
      if (event.event_type === "ARTIFACT_REGISTERED") {
        invariant(
          typeof event.artifact.uri === "string" &&
            event.artifact.uri.length > 0,
          "ARTIFACT_REGISTERED requires artifact.uri (canonical location)"
        );
        invariant(
          typeof event.artifact.artifact_type === "string" &&
            event.artifact.artifact_type.length > 0,
          "ARTIFACT_REGISTERED requires artifact.artifact_type"
        );
        invariant(
          ARTIFACT_STORAGE_CLASSES.includes(event.artifact.storage_class),
          `ARTIFACT_REGISTERED requires artifact.storage_class in ${ARTIFACT_STORAGE_CLASSES.join("|")} (§8 storage hierarchy)`
        );
        if (event.artifact.depends_on != null) {
          invariant(
            Array.isArray(event.artifact.depends_on) &&
              event.artifact.depends_on.every(
                dep =>
                  typeof dep === "string" &&
                  (ARTIFACT_ID.test(dep) || EXTERNAL_DEP.test(dep))
              ),
            "artifact.depends_on entries must be ART-<slug> artifact ids or ext:-prefixed external identities (§13: consumed upstream state is recorded by identity)"
          );
        }
      }
      if (event.event_type === "ARTIFACT_SUPERSEDED") {
        invariant(
          ARTIFACT_ID.test(event.artifact.superseded_by ?? ""),
          "ARTIFACT_SUPERSEDED requires artifact.superseded_by naming the successor artifact id"
        );
      }
      if (event.event_type === "ARTIFACT_VALIDATED") {
        invariant(
          Array.isArray(event.evidence) && event.evidence.length > 0,
          "ARTIFACT_VALIDATED must attach the evidence that validated the artifact"
        );
      }
    }
    if (event.event_type === "DEPENDENCY_INVALIDATED") {
      invariant(
        typeof event.upstream === "string" &&
          (ARTIFACT_ID.test(event.upstream) ||
            EXTERNAL_DEP.test(event.upstream)),
        "DEPENDENCY_INVALIDATED requires upstream as an artifact id or ext: identity (§13)"
      );
    }
    if (event.event_type === "DEPENDENCY_REVALIDATED") {
      invariant(
        event.artifact && ARTIFACT_ID.test(event.artifact.id ?? ""),
        "DEPENDENCY_REVALIDATED requires artifact.id (the downstream consumer being cleared)"
      );
      invariant(
        typeof event.upstream_identity === "string" &&
          event.upstream_identity.length > 0,
        "DEPENDENCY_REVALIDATED must explicitly cite the NEW upstream identity (§13: revalidation is never implicit)"
      );
    }
    if (event.event_type === "COMPOSITION_EVALUATED") {
      invariant(
        typeof event.integration_id === "string" &&
          event.integration_id.length > 0,
        "COMPOSITION_EVALUATED requires an integration_id (§16)"
      );
      invariant(
        Array.isArray(event.components) &&
          event.components.length > 0 &&
          event.components.every(c => typeof c === "string" && c.length > 0),
        "COMPOSITION_EVALUATED requires the participating components (§16)"
      );
      invariant(
        COMPOSITION_VERDICTS.includes(event.composition_verdict),
        `COMPOSITION_EVALUATED requires composition_verdict in ${COMPOSITION_VERDICTS.join("|")} (§16)`
      );
      // Refutation R4: a composition verdict is a claim about observed
      // behavior — with no evidence it is an unbacked assertion, and a bare
      // NO_GAP could launder any prior gap.
      invariant(
        Array.isArray(event.evidence) && event.evidence.length > 0,
        "COMPOSITION_EVALUATED must attach the evidence behind its verdict (§16; a bare NO_GAP is an assertion, not an evaluation)"
      );
    }
    if (event.event_type === "MEMORY_RECONCILED") {
      invariant(
        typeof event.clean === "boolean",
        "MEMORY_RECONCILED requires clean: true|false — reconciliation is a verdict, not a ceremony (§47)"
      );
    }
  }
  invariant(
    !SECRETISH.test(JSON.stringify(event)),
    "event contains a credential-shaped value — secrets never enter the ledger"
  );
  return event;
}

// Resolve a proof reference (§53: terminal-task proof). Offline-deterministic:
// repo paths and run artifacts must exist, event refs must exist in the run,
// URLs must be well-formed against the systems of record.
// Is `child` contained within `parent` after normalization? Closes the
// repo-proof `../` traversal hole (FIND-TOS011-0002): "repo proof" must mean a
// file INSIDE the repo, not any path the process can stat.
function isContained(parent, child) {
  const rel = relative(parent, child);
  if (rel.length === 0 || rel.startsWith("..") || isAbsolute(rel)) return false;
  // Lexical containment can be defeated by a symlink planted inside the tree
  // (CSO MEDIUM-1): when the target exists, re-check against physical paths so
  // a contained-looking link cannot read or attest bytes outside the root.
  if (existsSync(child)) {
    try {
      const realChild = realpathSync(child);
      const realParent = existsSync(parent) ? realpathSync(parent) : parent;
      const realRel = relative(realParent, realChild);
      if (
        realRel.length === 0 ||
        realRel.startsWith("..") ||
        isAbsolute(realRel)
      )
        return false;
    } catch {
      return false; // unresolvable link chain: fail closed
    }
  }
  return true;
}

// CSO MEDIUM-2: fidelity hashing slurps the file — cap it so a huge target
// cannot OOM the evidence CLI. Evidence artifacts are documents, not datasets.
export const FIDELITY_HASH_MAX_BYTES = 32 * 1024 * 1024;

export function resolveProofRef(proof, runId, events) {
  if (!proof || !PROOF_TYPES.includes(proof.type)) return false;
  if (proof.type === "repo") {
    const resolved = resolvePath(REPO_ROOT, proof.ref);
    return isContained(REPO_ROOT, resolved) && existsSync(resolved);
  }
  if (proof.type === "run-artifact") {
    const root = runDir(runId);
    const resolved = resolvePath(root, proof.ref);
    return isContained(root, resolved) && existsSync(resolved);
  }
  if (proof.type === "event")
    return events.some(event => event.event_id === proof.ref);
  if (proof.type === "url")
    return /^https:\/\/(github\.com|app\.notion\.com|www\.notion\.so)\/\S+$/.test(
      proof.ref
    );
  return false;
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
  // wx: atomic create-or-fail closes the check-then-write race (gstack-review).
  writeFileSync(
    manifestPath(manifest.run_id),
    `${JSON.stringify(manifest, null, 2)}\n`,
    { flag: "wx" }
  );
  return manifest;
}

// Identity fields are tool-assigned; a caller must never forge them into the
// permanent chain (gstack-review: `...partial` previously spread over them).
const RESERVED_EVENT_KEYS = Object.freeze([
  "schema_version",
  "event_id",
  "run_id",
  "sequence",
  "timestamp",
  "previous_event_hash",
  "event_hash",
]);

export function appendEvent(runId, partial) {
  const clash = Object.keys(partial).filter(key =>
    RESERVED_EVENT_KEYS.includes(key)
  );
  invariant(
    clash.length === 0,
    `appendEvent must not receive reserved key(s): ${clash.join(", ")} — identity fields are tool-assigned`
  );
  const manifest = loadManifest(runId);
  // mkdir is the atomic lock primitive: a concurrent append fails loudly here
  // instead of silently chaining two events to the same predecessor.
  const lockPath = join(runDir(runId), ".append.lock");
  try {
    mkdirSync(lockPath);
  } catch {
    throw new Error(
      `one-shot-ledger: another append holds ${lockPath} — the ledger is single-writer; retry after it completes (or remove a stale lock left by a killed process)`
    );
  }
  try {
    const events = readEvents(runId);
    // Append-time idempotency (audit M2): a duplicated external effect must be
    // refused BEFORE it is recorded, not flagged after.
    if (partial.idempotency_key != null) {
      invariant(
        !events.some(
          existing => existing.idempotency_key === partial.idempotency_key
        ),
        `idempotency_key "${partial.idempotency_key}" already recorded — the operation this event describes has already happened`
      );
    }
    const previous = events[events.length - 1] ?? null;
    const sequence = (previous?.sequence ?? 0) + 1;
    // JSON round-trip so the hash covers exactly what the file stores —
    // undefined-valued keys would otherwise diverge hash from serialization
    // and permanently poison verify (gstack-review).
    const event = JSON.parse(
      JSON.stringify({
        schema_version: EVENT_SCHEMA_VERSION,
        event_id: `evt_${String(sequence).padStart(5, "0")}`,
        run_id: runId,
        sequence,
        timestamp: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
        ...partial,
      })
    );
    validateEvent(event, manifest);
    invariant(
      previous === null || event.timestamp >= previous.timestamp,
      "event.timestamp must be monotonically non-decreasing"
    );
    // Refuse-before-record for the memory contract (review F4/F5, refutation
    // R1/R2): a memory-rule violation must never enter the permanent chain —
    // an appended violation would brick an append-only ledger forever. verify
    // re-derives the same rules purely as tamper evidence on hand-edited files.
    if (
      MEMORY_MUTATING_TYPES.includes(event.event_type) ||
      event.event_type === "MEMORY_RECONCILED"
    ) {
      const before = foldArtifacts(events);
      const after = foldArtifacts([...events, event]);
      const newProblems = after.problems.slice(before.problems.length);
      invariant(
        newProblems.length === 0,
        `memory contract violation refused at append: ${newProblems.join("; ")}`
      );
      if (event.event_type === "MEMORY_RECONCILED" && event.clean === true) {
        const staleNow = [...after.registry.values()].filter(a => a.stale);
        invariant(
          staleNow.length === 0,
          `MEMORY_RECONCILED clean:true refused: ${staleNow.length} stale artifact(s) outstanding (${staleNow.map(a => a.id).join(", ")}) — reconcile them or record clean:false`
        );
        invariant(
          after.problems.length === 0,
          `MEMORY_RECONCILED clean:true refused: registry defect(s) outstanding: ${after.problems.join("; ")}`
        );
      }
    }
    event.previous_event_hash = previous?.event_hash ?? null;
    event.event_hash = hashEvent(event, event.previous_event_hash);
    appendFileSync(eventsPath(runId), `${JSON.stringify(event)}\n`);
    return event;
  } finally {
    rmdirSync(lockPath);
  }
}

// ---- Universal execution memory: the Artifact Manifest is DERIVED, never
// hand-maintained (§7 "No hand-maintained artifact count"). Folds the artifact
// lifecycle + dependency events into the registry, computing the §13
// stale-dependency cascade as it goes. Pass a prefix of the run's events to
// get the registry state at that point in history (MEMORY_RECONCILED checks).
export function foldArtifacts(events) {
  const registry = new Map();
  const problems = [];
  // §13 invalidations remember their identity (refutation R2): a registration
  // that arrives AFTER its upstream was invalidated starts stale — the cascade
  // is a property of history, not of iteration order.
  const invalidatedIdentities = new Map(); // identity -> {via, old_identity}
  // Structured stale cause (refutation R1): revalidation must cite an identity
  // rooted in THIS upstream and different from the dead one — the kernel knows
  // both, so "any non-empty string" is no longer a clearing token.
  const cascade = (upstream, oldIdentity, via) => {
    for (const entry of registry.values()) {
      if (entry.stale && entry.stale_cause?.upstream === upstream) continue;
      if ((entry.depends_on ?? []).includes(upstream)) {
        entry.stale = true;
        entry.stale_cause = { upstream, old_identity: oldIdentity, via };
        cascade(entry.id, null, via); // downstream of the downstream
      }
    }
  };
  for (const event of events) {
    if ((event.schema_version ?? 1) < 4) continue;
    const type = event.event_type;
    const id = event.artifact?.id;
    if (type === "ARTIFACT_REGISTERED") {
      if (registry.has(id)) {
        problems.push(`artifact ${id} registered twice (${event.event_id})`);
        continue;
      }
      const dependsOn = event.artifact.depends_on ?? [];
      const entry = {
        id,
        uri: event.artifact.uri,
        artifact_type: event.artifact.artifact_type,
        storage_class: event.artifact.storage_class,
        depends_on: dependsOn,
        content_hash: event.artifact.content_hash ?? null,
        lifecycle_state: "REGISTERED",
        producing_scope: event.scope_id,
        producing_event: event.event_id,
        latest_event: event.event_id,
        consumers: [],
        validated_by: [],
        superseded_by: null,
        stale: false,
        stale_cause: null,
        revalidated_against: [],
      };
      // R2: depending on an identity that is ALREADY invalidated (or on an
      // artifact currently stale/superseded/retired) starts life stale.
      for (const dep of dependsOn) {
        const dead = invalidatedIdentities.get(dep);
        const depEntry = registry.get(dep);
        if (dead) {
          entry.stale = true;
          entry.stale_cause = {
            upstream: dep,
            old_identity: dead.old_identity,
            via: dead.via,
          };
        } else if (
          depEntry &&
          (depEntry.stale ||
            depEntry.lifecycle_state === "SUPERSEDED" ||
            depEntry.lifecycle_state === "RETIRED")
        ) {
          entry.stale = true;
          entry.stale_cause = {
            upstream: dep,
            old_identity: null,
            via: depEntry.latest_event,
          };
        }
      }
      registry.set(id, entry);
      continue;
    }
    if (
      !ARTIFACT_EVENT_TYPES.includes(type) &&
      type !== "DEPENDENCY_REVALIDATED"
    ) {
      if (type === "DEPENDENCY_INVALIDATED") {
        // Upstream identity went bad (refuted / sha changed / superseded /
        // deleted / stale / authority changed): cascade to every consumer,
        // and REMEMBER the identity for late registrations (R2).
        invalidatedIdentities.set(event.upstream, {
          via: event.event_id,
          old_identity: event.upstream,
        });
        cascade(event.upstream, event.upstream, event.event_id);
      }
      continue;
    }
    const entry = registry.get(id);
    if (!entry) {
      problems.push(
        `${type} references artifact ${id} that was never registered (${event.event_id})`
      );
      continue;
    }
    entry.latest_event = event.event_id;
    if (type === "ARTIFACT_UPDATED") {
      if (
        entry.lifecycle_state === "RETIRED" ||
        entry.lifecycle_state === "SUPERSEDED"
      ) {
        // F9: a terminal lifecycle state is never silently resurrected.
        problems.push(
          `artifact ${id} updated after ${entry.lifecycle_state.toLowerCase()} (${event.event_id})`
        );
        continue;
      }
      const newHash = event.artifact.content_hash ?? null;
      // §13 "changes SHA/hash", fail-CLOSED (refutation R3): an update
      // invalidates consumers UNLESS both hashes are present and equal —
      // omitting hashes is no longer a silent opt-out of the cascade.
      const provablyUnchanged =
        newHash !== null &&
        entry.content_hash !== null &&
        newHash === entry.content_hash;
      const oldIdentity =
        entry.content_hash !== null
          ? `${entry.id}@${entry.content_hash}`
          : null;
      if (!provablyUnchanged) {
        cascade(entry.id, oldIdentity, event.event_id);
      }
      if (newHash !== null) entry.content_hash = newHash;
      if (event.artifact.uri) entry.uri = event.artifact.uri;
      entry.lifecycle_state = "UPDATED";
    }
    if (type === "ARTIFACT_CONSUMED") {
      if (entry.lifecycle_state === "RETIRED") {
        problems.push(
          `artifact ${id} consumed after retirement (${event.event_id})`
        );
      }
      entry.consumers.push({
        scope: event.scope_id,
        actor: event.actor?.name ?? null,
        event: event.event_id,
        while_stale: entry.stale,
      });
    }
    if (type === "ARTIFACT_VALIDATED") {
      entry.validated_by.push(event.event_id);
      if (
        entry.lifecycle_state === "REGISTERED" ||
        entry.lifecycle_state === "UPDATED"
      )
        entry.lifecycle_state = "VALIDATED";
    }
    if (type === "ARTIFACT_SUPERSEDED") {
      entry.lifecycle_state = "SUPERSEDED";
      entry.superseded_by = event.artifact.superseded_by;
      if (!registry.has(event.artifact.superseded_by)) {
        problems.push(
          `artifact ${id} superseded by unregistered ${event.artifact.superseded_by} (${event.event_id}) — register the successor BEFORE the supersession`
        );
      }
      // A superseded input is a §13 invalidation for everything built on it.
      invalidatedIdentities.set(entry.id, {
        via: event.event_id,
        old_identity: entry.id,
      });
      cascade(entry.id, entry.id, event.event_id);
    }
    if (type === "ARTIFACT_RETIRED") {
      entry.lifecycle_state = "RETIRED";
      invalidatedIdentities.set(entry.id, {
        via: event.event_id,
        old_identity: entry.id,
      });
      cascade(entry.id, entry.id, event.event_id);
    }
    if (type === "DEPENDENCY_REVALIDATED") {
      // Clears THIS consumer only (no transitive forgiveness), and ONLY by a
      // citation the kernel can authenticate against the recorded cause
      // (refutation R1): the cited identity must be rooted in the upstream
      // that went stale AND must not be the dead identity itself.
      if (!entry.stale) {
        problems.push(
          `DEPENDENCY_REVALIDATED for ${id} which is not stale (${event.event_id})`
        );
      } else {
        // v4.2 (independent-verifier hardening): identity-EXACT where the
        // kernel knows the current truth; otherwise versioned-root citation
        // that is never rooted in the dead identity (closes the bare-id,
        // @aaa2-prefix, and dead+suffix escapes).
        const cause = entry.stale_cause;
        const cited = event.upstream_identity;
        const upstreamEntry = registry.get(cause.upstream);
        let refusal = null;
        if (upstreamEntry?.lifecycle_state === "RETIRED") {
          // A retired upstream has no new identity to cite — the consumer must
          // be rebuilt (re-registered) on a living input, not revalidated.
          refusal = `upstream ${cause.upstream} is RETIRED — there is no new identity to revalidate against; rebuild the consumer on a living input`;
        } else if (upstreamEntry?.lifecycle_state === "SUPERSEDED") {
          // The new identity of a superseded upstream IS its successor.
          const successor = upstreamEntry.superseded_by;
          if (cited !== successor && !cited.startsWith(`${successor}@`)) {
            refusal = `upstream ${cause.upstream} was superseded by ${successor} — the citation must reference the successor`;
          }
        } else if ((upstreamEntry?.content_hash ?? null) !== null) {
          const knownHash = upstreamEntry.content_hash;
          const required = `${cause.upstream}@${knownHash}`;
          if (cited !== required) {
            refusal = `the upstream's current identity is known — the citation must be exactly "${required}"`;
          }
        } else {
          // Versioned root: for a dead identity ext:x@aaaa the root is ext:x;
          // for a hashless artifact the root is its id. The citation must be
          // <root>@<something-new> and never sit inside the dead identity.
          const dead = cause.old_identity;
          const root =
            dead !== null && dead.includes("@")
              ? dead.slice(0, dead.lastIndexOf("@"))
              : cause.upstream;
          const versionedUnderRoot = cited.startsWith(`${root}@`);
          const rootedInDead = dead !== null && cited.startsWith(dead);
          if (!versionedUnderRoot || rootedInDead) {
            refusal = `the citation must be a NEW versioned identity under "${root}@…"${dead ? ` and not rooted in the dead identity "${dead}"` : ""}`;
          }
        }
        if (refusal !== null) {
          problems.push(
            `DEPENDENCY_REVALIDATED for ${id} cites "${cited}" which does not authenticate against its stale cause (upstream ${cause.upstream}): ${refusal} (${event.event_id})`
          );
        } else {
          entry.stale = false;
          entry.stale_cause = null;
          entry.revalidated_against.push({
            upstream_identity: cited,
            event: event.event_id,
          });
        }
      }
    }
  }
  return { registry, problems };
}

export function deriveArtifacts(runId) {
  const { registry, problems } = foldArtifacts(readEvents(runId));
  const artifacts = [...registry.values()];
  // Refutation R7 — manifest fidelity: derived ≠ true, so where the bytes are
  // offline-checkable the kernel checks them. committed-class URIs must exist
  // inside the repo (and their content_hash, when declared, must match the
  // actual sha256); external URIs that resolve inside the run directory must
  // exist there (same hash rule). URIs outside both roots stay a documented
  // trust boundary. Live (non-retired/superseded) artifacts must not share a
  // URI — a fresh id on the same bytes is how a stale artifact gets relaunched.
  const fidelityDefects = [];
  const live = artifacts.filter(
    a => !["RETIRED", "SUPERSEDED"].includes(a.lifecycle_state)
  );
  const checkFile = (artifact, root, resolved) => {
    if (!existsSync(resolved)) {
      fidelityDefects.push(
        `${artifact.id}: uri "${artifact.uri}" does not exist under its ${artifact.storage_class} root`
      );
      return;
    }
    // Only sha256-shaped declarations are checkable against bytes; other hash
    // formats (short ids, non-sha digests) remain a trust boundary.
    if (artifact.content_hash && /^[0-9a-f]{64}$/.test(artifact.content_hash)) {
      const size = statSync(resolved).size;
      if (size > FIDELITY_HASH_MAX_BYTES) {
        fidelityDefects.push(
          `${artifact.id}: uri "${artifact.uri}" is ${size} bytes — exceeds the ${FIDELITY_HASH_MAX_BYTES}-byte fidelity-hash cap (CSO MEDIUM-2); evidence artifacts are documents, not datasets`
        );
        return;
      }
      const actual = createHash("sha256")
        .update(readFileSync(resolved))
        .digest("hex");
      if (actual !== artifact.content_hash) {
        fidelityDefects.push(
          `${artifact.id}: declared content_hash ${artifact.content_hash.slice(0, 12)}… does not match actual ${actual.slice(0, 12)}… for "${artifact.uri}"`
        );
      }
    }
  };
  for (const artifact of live) {
    if (artifact.storage_class === "committed") {
      const resolved = resolvePath(REPO_ROOT, artifact.uri);
      if (!isContained(REPO_ROOT, resolved)) {
        fidelityDefects.push(
          `${artifact.id}: committed uri "${artifact.uri}" resolves outside the repo`
        );
      } else {
        checkFile(artifact, REPO_ROOT, resolved);
      }
    } else if (artifact.storage_class === "external") {
      const root = runDir(runId);
      const resolved = resolvePath(root, artifact.uri);
      const lexicalRel = relative(root, resolved);
      const lexicallyInside =
        lexicalRel.length > 0 &&
        !lexicalRel.startsWith("..") &&
        !isAbsolute(lexicalRel);
      if (lexicallyInside && !isContained(root, resolved)) {
        // Looks inside the run dir but physically escapes through a symlink —
        // flagged, never silently skipped (CSO MEDIUM-1).
        fidelityDefects.push(
          `${artifact.id}: uri "${artifact.uri}" escapes the run directory through a symlink`
        );
      } else if (lexicallyInside) {
        checkFile(artifact, root, resolved);
      }
    }
  }
  const uriOwners = new Map();
  for (const artifact of live) {
    const owners = uriOwners.get(artifact.uri) ?? [];
    owners.push(artifact.id);
    uriOwners.set(artifact.uri, owners);
  }
  for (const [uri, owners] of uriOwners) {
    if (owners.length > 1) {
      fidelityDefects.push(
        `uri "${uri}" is claimed by ${owners.length} live artifacts (${owners.join(", ")}) — one canonical location, one identity`
      );
    }
  }
  return {
    run_id: runId,
    artifacts_total: artifacts.length,
    by_state: artifacts.reduce((acc, a) => {
      acc[a.lifecycle_state] = (acc[a.lifecycle_state] ?? 0) + 1;
      return acc;
    }, {}),
    stale: artifacts
      .filter(a => a.stale)
      .map(a => ({ id: a.id, cause: a.stale_cause })),
    stale_consumptions: artifacts.flatMap(a =>
      a.consumers
        .filter(c => c.while_stale)
        .map(c => ({ artifact: a.id, ...c }))
    ),
    // Ephemeral artifacts must not survive closeout un-retired (§6 removal
    // condition) — surfaced here, enforced by closeout.
    ephemeral_unretired: artifacts
      .filter(
        a => a.storage_class === "ephemeral" && a.lifecycle_state !== "RETIRED"
      )
      .map(a => a.id),
    fidelity_defects: fidelityDefects,
    problems,
    artifacts,
  };
}

// §14: the multi-resource interaction graph, derived — nodes for scopes,
// agents, PRs, artifacts, owner gates and declared write-resources; typed
// edges from the controlled §14 edge vocabulary. Exact identity where the
// event stream carries it (SHAs, artifact ids, OG ids).
export function deriveInteractionGraph(runId) {
  const events = readEvents(runId);
  const nodes = new Map(); // id -> kind
  const edges = []; // {from, to, kind, via}
  const addNode = (id, kind) => {
    if (id && !nodes.has(id)) nodes.set(id, kind);
  };
  const addEdge = (from, to, kind, via) => {
    if (from && to) edges.push({ from, to, kind, via });
  };
  const { registry } = foldArtifacts(events);
  for (const event of events) {
    const scope = event.scope_id;
    addNode(scope, "scope");
    if (event.event_type === "SUBAGENT_STARTED") {
      addNode(event.actor.name, "agent");
      addEdge(event.actor.name, scope, "owns", event.event_id);
      if (event.scope_declaration) {
        addNode(event.scope_declaration, "resource");
        addEdge(
          event.actor.name,
          event.scope_declaration,
          "writes",
          event.event_id
        );
      }
    }
    if (event.pr != null) {
      const prNode = `pr:${event.pr}`;
      addNode(prNode, "pr");
      addEdge(scope, prNode, "produces", event.event_id);
      if (event.merge_sha) {
        addNode(`commit:${event.merge_sha}`, "commit");
        addEdge(
          prNode,
          `commit:${event.merge_sha}`,
          "deployed_as",
          event.event_id
        );
      }
    }
    if (event.event_type?.startsWith("OWNER_GATE_")) {
      const gateNode = event.owner_gate.id;
      addNode(gateNode, "owner_gate");
      addEdge(gateNode, scope, "blocks", event.event_id);
    }
    if (event.event_type === "ARTIFACT_REGISTERED") {
      addNode(event.artifact.id, "artifact");
      addEdge(scope, event.artifact.id, "produces", event.event_id);
      for (const dep of event.artifact.depends_on ?? []) {
        addNode(dep, ARTIFACT_ID.test(dep) ? "artifact" : "external");
        addEdge(event.artifact.id, dep, "depends_on", event.event_id);
      }
    }
    if (event.event_type === "ARTIFACT_CONSUMED") {
      addNode(event.artifact.id, "artifact");
      addEdge(scope, event.artifact.id, "consumes", event.event_id);
    }
    if (event.event_type === "ARTIFACT_VALIDATED") {
      addEdge(event.artifact.id, event.event_id, "verified_by", event.event_id);
    }
    if (event.event_type === "ARTIFACT_SUPERSEDED") {
      addNode(event.artifact.superseded_by, "artifact");
      addEdge(
        event.artifact.superseded_by,
        event.artifact.id,
        "supersedes",
        event.event_id
      );
    }
    if (event.event_type === "DEPENDENCY_INVALIDATED") {
      addNode(
        event.upstream,
        ARTIFACT_ID.test(event.upstream) ? "artifact" : "external"
      );
      addEdge(event.upstream, scope, "invalidates", event.event_id);
    }
  }
  // potential_conflict: two agents declaring the same write resource (string
  // identity; aliased paths still need a self-reported CONFLICT — documented
  // honest boundary).
  const writers = new Map();
  for (const edge of edges) {
    if (edge.kind !== "writes") continue;
    (writers.get(edge.to) ?? writers.set(edge.to, []).get(edge.to)).push(
      edge.from
    );
  }
  for (const [resource, agents] of writers) {
    const distinct = [...new Set(agents)];
    if (distinct.length > 1) {
      for (let i = 0; i < distinct.length; i += 1) {
        for (let j = i + 1; j < distinct.length; j += 1) {
          addEdge(distinct[i], distinct[j], "potential_conflict", resource);
        }
      }
    }
  }
  // stale consumption edges from the registry fold
  for (const entry of registry.values()) {
    for (const consumer of entry.consumers) {
      if (consumer.while_stale)
        addEdge(entry.id, consumer.scope, "invalidates", consumer.event);
    }
  }
  return {
    run_id: runId,
    nodes: [...nodes.entries()].map(([id, kind]) => ({ id, kind })),
    edges,
    potential_conflicts: edges
      .filter(e => e.kind === "potential_conflict")
      .map(e => ({ agents: [e.from, e.to], resource: e.via })),
  };
}

// §10-§11: derived progress + loop detection over the REPORTED event stream.
// Honest boundary (README): this observes what the orchestrator reports, not
// raw agent behavior — it upgrades stall detection from purely self-reported
// to stream-derived, and no further. Signature = the action's stable identity.
// Refutation R6 (progress-wash): context/plan/read-class events resolve
// unknowns, so their FIRST occurrence per (type, scope) is progress — but
// repeating them cheaply must not keep resetting the stall clock or shielding
// a loop. WEAK progress counts once per (type, scope); STRONG always counts.
const WEAK_PROGRESS_TYPES = new Set([
  "RUN_STARTED",
  "RUN_RESUMED",
  "CONTEXT_RESTORED",
  "CONTEXT_VERIFIED",
  "AUTHORITY_VERIFIED",
  "PLAN_CREATED",
  "PLAN_REVIEWED",
  "SCOPE_DISCOVERED",
  "NOTION_READ_VERIFIED",
  // v4.2 (verifier N4): narrative claims are cheap to fabricate — a stalled
  // agent emitting varied "learnings"/"findings" must not reset the stall
  // clock indefinitely. State-changing and externally-verifiable types stay
  // strong; narration counts once per (type, scope).
  "LEARNING_CAPTURED",
  "SUBAGENT_FINDING",
  "GSTACK_FINDING",
  "SKILLIFY_CANDIDATE",
]);
const PROGRESS_TYPES = new Set([
  // resolving an unknown IS progress (§10 "previously unknown fact resolved");
  // dispatching work is not — only its result is.
  "RUN_STARTED",
  "RUN_RESUMED",
  "CONTEXT_RESTORED",
  "CONTEXT_VERIFIED",
  "CONTEXT_DRIFT_DETECTED",
  "AUTHORITY_VERIFIED",
  "AUTHORITY_CHANGED",
  "PLAN_CREATED",
  "PLAN_REVIEWED",
  "PLAN_CHANGED",
  "DEPENDENCY_GRAPH_CHANGED",
  "SCOPE_DISCOVERED",
  "SUBAGENT_FINDING",
  "SUBAGENT_COMPLETED",
  "SUBAGENT_FAILED",
  "SUBAGENT_CANCELLED",
  "SUBAGENT_ABORTED",
  "SUBAGENT_SUPERSEDED",
  "SUBAGENT_DISAGREEMENT",
  "GSTACK_COMPLETED",
  "GSTACK_FINDING",
  "NOTION_READ_VERIFIED",
  "DEPLOYMENT_GATE_EVALUATED",
  "SKILLIFY_CANDIDATE",
  "SCOPE_STARTED",
  "SCOPE_BLOCKED",
  "SCOPE_UNBLOCKED",
  "SCOPE_COMPLETED",
  "FINDING_OPENED",
  "FINDING_REMEDIATED",
  "FINDING_REVERIFIED",
  "FINDING_CLOSED",
  "TEST_RESULT",
  "NEGATIVE_TEST_RESULT",
  "MUTATION_TEST_RESULT",
  "BENCHMARK_RESULT",
  "CHANGE_APPLIED",
  "CHANGE_REVERTED",
  "SCHEMA_CHANGED",
  "CONFIG_CHANGED",
  "COMMIT_CREATED",
  "BRANCH_CREATED",
  "PR_OPENED",
  "PR_UPDATED",
  "PR_READY",
  "PR_MERGED",
  "CI_STATE_CHANGED",
  "REVIEW_COMPLETED",
  "NOTION_WRITE_COMMITTED",
  "NOTION_WRITE_VERIFIED",
  "OWNER_GATE_CREATED",
  "OWNER_GATE_UPDATED",
  "OWNER_GATE_RESOLVED",
  "GATE_EVALUATED",
  "DECISION_RECORDED",
  "STAGING_DEPLOYED",
  "CANARY_STARTED",
  "CANARY_RESULT",
  "PRODUCTION_DEPLOYED",
  "ROLLBACK_STARTED",
  "ROLLBACK_COMPLETED",
  "POST_DEPLOY_VALIDATED",
  "LEARNING_CAPTURED",
  "REUSABLE_ASSET_CREATED",
  "SKILL_CREATED",
  "SKILL_EVALUATED",
  "SKILL_PROMOTED",
  "ARTIFACT_REGISTERED",
  "ARTIFACT_UPDATED",
  "ARTIFACT_VALIDATED",
  "ARTIFACT_SUPERSEDED",
  "ARTIFACT_RETIRED",
  "DEPENDENCY_INVALIDATED",
  "DEPENDENCY_REVALIDATED",
  "COMPOSITION_EVALUATED",
  "MEMORY_RECONCILED",
]);

export function deriveProgress(runId) {
  const manifest = loadManifest(runId);
  const events = readEvents(runId);
  const loopThreshold = manifest.loop_threshold_repeated_action_signature ?? 3;
  const stallThreshold =
    manifest.stall_threshold_actions_without_new_evidence ?? 4;
  const signatureOf = event =>
    [
      event.event_type,
      event.scope_id,
      event.workflow ?? "",
      event.pr ?? "",
      event.artifact?.id ?? "",
      (event.evidence ?? [])
        .map(e => `${e.type}:${e.ref}`)
        .sort()
        .join("|"),
    ].join("~");
  // Per-event progress classification (R6): WEAK types count only on their
  // first occurrence per (type, scope); STRONG types always count. Everything
  // else is a dispatch/signal, never progress.
  const seenWeak = new Set();
  const isProgress = events.map(event => {
    if (!PROGRESS_TYPES.has(event.event_type)) return false;
    if (!WEAK_PROGRESS_TYPES.has(event.event_type)) return true;
    const key = `${event.event_type}~${event.scope_id}`;
    if (seenWeak.has(key)) return false;
    seenWeak.add(key);
    return true;
  });
  // Loop candidates: the same signature recurring >= threshold times with NO
  // progress-class event between its first and last occurrence.
  const occurrences = new Map();
  events.forEach((event, index) => {
    const sig = signatureOf(event);
    (occurrences.get(sig) ?? occurrences.set(sig, []).get(sig)).push(index);
  });
  const loopCandidates = [];
  for (const [signature, indexes] of occurrences) {
    if (indexes.length < loopThreshold) continue;
    const first = indexes[0];
    const last = indexes[indexes.length - 1];
    const progressBetween = events
      .slice(first + 1, last)
      .some(
        (e, offset) =>
          isProgress[first + 1 + offset] && signatureOf(e) !== signature
      );
    if (!progressBetween) {
      loopCandidates.push({
        signature,
        repetitions: indexes.length,
        first_event: events[first].event_id,
        last_event: events[last].event_id,
        threshold: `loop_threshold_repeated_action_signature=${loopThreshold}`,
      });
    }
  }
  // Stall streak: longest run of consecutive events none of which counts as
  // progress under the weak/strong rule.
  let streak = 0;
  let longest = { length: 0, from: null, to: null };
  let streakStart = null;
  events.forEach((event, index) => {
    if (isProgress[index]) {
      streak = 0;
      streakStart = null;
      return;
    }
    streak += 1;
    streakStart ??= event.event_id;
    if (streak > longest.length)
      longest = { length: streak, from: streakStart, to: event.event_id };
  });
  return {
    run_id: runId,
    loop_candidates: loopCandidates,
    longest_no_progress_streak: longest,
    stall_threshold: stallThreshold,
    stall_breached: longest.length >= stallThreshold,
    stall_suspected_recorded: events.filter(
      e => e.event_type === "STALL_SUSPECTED"
    ).length,
    interventions_recorded: events.filter(e => e.event_type === "INTERVENTION")
      .length,
  };
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
  // Gate lifecycle is order-INDEPENDENT within a run: an UPDATE/RESOLVE is valid
  // as long as the id is CREATED somewhere in the run (a prior-run gate carried
  // forward must be re-created, state and all, not silently updated). Pre-scan
  // the created ids so a CREATE appended after its UPDATE still validates.
  const createdOwnerGateIds = new Set(
    events
      .filter(event => event.event_type === "OWNER_GATE_CREATED")
      .map(event => event.owner_gate?.id)
  );
  // Same order-independence for gstack workflows: a COMPLETED is legitimate if
  // its workflow was STARTED anywhere in the run (atomic workflows like learn /
  // benchmark may record STARTED and COMPLETED adjacently or out of order).
  const allStartedGstackWorkflows = new Set(
    events
      .filter(
        event =>
          event.event_type === "GSTACK_STARTED" &&
          (event.schema_version ?? 1) >= 2
      )
      .map(event => event.workflow)
  );
  const openOwnerGates = new Map();
  const seenCreatedGateIds = new Set();
  const openFindings = new Map();
  const startedScopes = new Set();
  const startedGstack = new Set();
  const startedSubagents = new Set();
  const terminatedSubagents = new Set();
  let legacyGstackStarted = false;
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
      // Double-create is tracked by actual CREATE events only — an UPDATE/RESOLVE
      // processed earlier (order-independent lifecycle) must not look like a
      // prior creation.
      if (seenCreatedGateIds.has(event.owner_gate.id))
        errors.push(`${at}: owner gate ${event.owner_gate.id} created twice`);
      seenCreatedGateIds.add(event.owner_gate.id);
      openOwnerGates.set(event.owner_gate.id, event.owner_gate.state);
    }
    if (
      event.event_type === "OWNER_GATE_UPDATED" ||
      event.event_type === "OWNER_GATE_RESOLVED"
    ) {
      if (!createdOwnerGateIds.has(event.owner_gate.id)) {
        errors.push(
          `${at}: ${event.event_type} references owner gate ${event.owner_gate.id} that is never created in this run`
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
    // Lifecycle completeness (audit H4), v2 events only — v1 historical runs
    // predate the rule and stay valid.
    if (event.schema_version >= 2) {
      if (
        event.event_type === "SCOPE_COMPLETED" &&
        !startedScopes.has(event.scope_id)
      ) {
        errors.push(
          `${at}: SCOPE_COMPLETED for ${event.scope_id} without a prior SCOPE_STARTED`
        );
      }
      // Order-INDEPENDENT within the run (matching the owner-gate lifecycle):
      // a COMPLETED is valid if a STARTED for that workflow exists ANYWHERE in
      // the run. Still catches a COMPLETED with no STARTED at all.
      if (
        event.event_type === "GSTACK_COMPLETED" &&
        !allStartedGstackWorkflows.has(event.workflow) &&
        !legacyGstackStarted
      ) {
        errors.push(
          `${at}: GSTACK_COMPLETED for workflow "${event.workflow}" with no GSTACK_STARTED naming it anywhere in the run`
        );
      }
      if (
        event.event_type === "SUBAGENT_COMPLETED" &&
        !startedSubagents.has(event.actor?.name)
      ) {
        errors.push(
          `${at}: SUBAGENT_COMPLETED for "${event.actor?.name}" without a prior SUBAGENT_STARTED`
        );
      }
    }
    if (event.event_type === "SCOPE_STARTED") startedScopes.add(event.scope_id);
    if (event.event_type === "GSTACK_STARTED") {
      if (event.schema_version >= 2) startedGstack.add(event.workflow);
      else legacyGstackStarted = true;
    }
    if (event.event_type === "SUBAGENT_STARTED")
      startedSubagents.add(event.actor?.name);
    if (SUBAGENT_TERMINALS.includes(event.event_type))
      terminatedSubagents.add(event.actor?.name);
    // Law 14: a PROVEN claim whose proof-typed evidence does not resolve is
    // refused — the label is only as strong as its attached reference.
    if (event.schema_version >= 3 && event.label === "PROVEN") {
      for (const item of event.evidence ?? []) {
        if (
          PROOF_TYPES.includes(item.type) &&
          !resolveProofRef(item, runId, events)
        ) {
          errors.push(
            `${at}: PROVEN claim attaches an unresolvable ${item.type} reference "${item.ref}"`
          );
        }
      }
    }
    // §47: a MEMORY_RECONCILED that claims clean:true is re-derived against
    // the registry state at that point in the stream — a claim of cleanliness
    // with stale artifacts outstanding is a verify violation, not an opinion.
    if (
      event.schema_version >= 4 &&
      event.event_type === "MEMORY_RECONCILED" &&
      event.clean === true
    ) {
      const upToHere = events.slice(0, index + 1);
      const { registry, problems } = foldArtifacts(upToHere);
      const staleNow = [...registry.values()].filter(a => a.stale);
      if (staleNow.length > 0) {
        errors.push(
          `${at}: MEMORY_RECONCILED claims clean:true with ${staleNow.length} stale artifact(s) outstanding: ${staleNow.map(a => a.id).join(", ")}`
        );
      }
      if (problems.length > 0) {
        errors.push(
          `${at}: MEMORY_RECONCILED claims clean:true with registry defect(s): ${problems.join("; ")}`
        );
      }
    }
  });
  // §6/§7 artifact lifecycle integrity for the whole run: unregistered
  // references, double registration, consumption after retirement, dangling
  // supersession — all derived from the same fold the manifest uses.
  {
    const { problems } = foldArtifacts(events);
    for (const problem of problems)
      errors.push(`artifact registry: ${problem}`);
  }
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
    dangling_subagents: [...startedSubagents].filter(
      name => !terminatedSubagents.has(name)
    ),
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

// CLI: node scripts/one-shot/ledger.mjs <init|append|verify|status|artifacts|graph|progress> <run_id> [json]
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
    } else if (command === "artifacts") {
      console.log(JSON.stringify(deriveArtifacts(runId), null, 2));
    } else if (command === "graph") {
      console.log(JSON.stringify(deriveInteractionGraph(runId), null, 2));
    } else if (command === "progress") {
      console.log(JSON.stringify(deriveProgress(runId), null, 2));
    } else {
      console.error(
        "usage: ledger.mjs <init|append|verify|status|artifacts|graph|progress> <run_id> [json]"
      );
      process.exit(2);
    }
  } catch (error) {
    console.error(String(error.message ?? error));
    process.exit(1);
  }
}
