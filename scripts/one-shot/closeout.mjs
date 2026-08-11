// §45 metrics derivation + §53 closeout gate for one-shot runs. Everything here
// is derived mechanically from the event ledger — no hand-estimated numbers.
// closeout exits 0 only when the run can honestly emit COMPLETE; otherwise it
// prints exactly which conditions block, exits 1, and the campaign ends with
// the Owner-Gate Queue instead of a false COMPLETE.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  HISTORICAL_V1_RUNS,
  loadManifest,
  readEvents,
  resolveProofRef,
  runDir,
  verifyRun,
} from "./ledger.mjs";

export function deriveMetrics(runId) {
  const events = readEvents(runId);
  const byType = {};
  for (const event of events)
    byType[event.event_type] = (byType[event.event_type] ?? 0) + 1;
  const findings = new Map();
  for (const event of events) {
    if (event.event_type === "FINDING_OPENED") {
      findings.set(event.finding, {
        severity: event.severity,
        state: "OPEN",
        cycles: 0,
      });
    }
    if (
      event.event_type === "FINDING_REMEDIATED" &&
      findings.has(event.finding)
    ) {
      const f = findings.get(event.finding);
      f.state = "REMEDIATING";
      f.cycles += 1;
    }
    if (event.event_type === "FINDING_CLOSED" && findings.has(event.finding)) {
      findings.get(event.finding).state = "CLOSED";
    }
  }
  const ownerGates = new Map();
  for (const event of events) {
    if (event.event_type?.startsWith("OWNER_GATE_")) {
      ownerGates.set(event.owner_gate.id, event.owner_gate.state);
    }
  }
  const scopes = new Map();
  for (const event of events) {
    if (event.event_type === "SCOPE_STARTED" && !scopes.has(event.scope_id))
      scopes.set(event.scope_id, "started");
    if (event.event_type === "SCOPE_COMPLETED")
      scopes.set(event.scope_id, "completed");
  }
  const prs = new Map();
  for (const event of events) {
    if (event.pr != null) prs.set(event.pr, event.event_type);
  }
  const severityCount = severity =>
    [...findings.values()].filter(f => f.severity === severity).length;
  return {
    run_id: runId,
    events_total: events.length,
    events_by_type: byType,
    scopes_started: [...scopes.keys()].length,
    scopes_completed: [...scopes.values()].filter(v => v === "completed")
      .length,
    findings_total: findings.size,
    findings_open: [...findings.values()].filter(f => f.state !== "CLOSED")
      .length,
    critical_findings: severityCount("critical"),
    high_findings: severityCount("high"),
    remediation_cycles: [...findings.values()].reduce(
      (sum, f) => sum + f.cycles,
      0
    ),
    negative_tests_recorded: byType.NEGATIVE_TEST_RESULT ?? 0,
    gstack_invocations:
      (byType.GSTACK_STARTED ?? 0) + (byType.GSTACK_COMPLETED ?? 0),
    subagents_dispatched: byType.SUBAGENT_STARTED ?? 0,
    subagents_completed: byType.SUBAGENT_COMPLETED ?? 0,
    subagent_disagreements: byType.SUBAGENT_DISAGREEMENT ?? 0,
    context_drift_events: byType.CONTEXT_DRIFT_DETECTED ?? 0,
    notion_writes_committed: byType.NOTION_WRITE_COMMITTED ?? 0,
    notion_writes_verified: byType.NOTION_WRITE_VERIFIED ?? 0,
    prs_touched: [...prs.keys()].sort((a, b) => a - b),
    owner_gates: Object.fromEntries(ownerGates),
    owner_gates_open: [...ownerGates.values()].filter(s => s === "OPEN").length,
  };
}

export function closeout(runId) {
  const blockers = [];
  const manifest = loadManifest(runId);
  const integrity = verifyRun(runId);
  if (!integrity.ok)
    blockers.push(`ledger integrity: ${integrity.errors.length} violation(s)`);
  const metrics = deriveMetrics(runId);
  const events = readEvents(runId);
  if (metrics.findings_open > 0) {
    blockers.push(`${metrics.findings_open} finding(s) not CLOSED`);
  }
  const requiredScopes = manifest.scopes.filter(scope =>
    /^TOS-\d{3}$/.test(scope)
  );
  // Delivery contract (audit C1): terminality is decided by the delivered
  // field, never by the mere existence of a SCOPE_COMPLETED event. v1 events
  // (historical runs) are grandfathered but surfaced, never silently blended.
  const lastCompletion = new Map();
  for (const event of events) {
    if (event.event_type === "SCOPE_COMPLETED")
      lastCompletion.set(event.scope_id, event);
  }
  const legacyTerminalizations = [];
  const terminalScopes = [];
  for (const scope of requiredScopes) {
    const completion = lastCompletion.get(scope);
    if (!completion) continue;
    if ((completion.schema_version ?? 1) < 2) {
      legacyTerminalizations.push(scope);
      // A v1 terminalization only counts if this run is a KNOWN historical run
      // whose tail anchor matches the committed pin — otherwise the v1 marker
      // is author-forgeable and would dodge the whole delivery contract
      // (FIND-TOS011-0001). Unlisted legacy terminalizations block.
      const historical = HISTORICAL_V1_RUNS[runId];
      const lastEvent = events[events.length - 1];
      const anchorMatches =
        historical &&
        historical.events_total === events.length &&
        historical.final_event_hash === lastEvent?.event_hash;
      if (anchorMatches) {
        terminalScopes.push(scope);
      } else {
        blockers.push(
          `scope ${scope} terminalized by a schema_version:1 event, but run ${runId} is not a pinned historical v1 run (or its tail anchor does not match) — legacy terminalizations from a new run are forgeable and do not count`
        );
      }
      continue;
    }
    if (completion.delivered === true) {
      if (!resolveProofRef(completion.proof, runId, events)) {
        blockers.push(
          `scope ${scope} claims delivered:true but its proof (${completion.proof?.type}:${completion.proof?.ref}) does not resolve — dead proof links block completion`
        );
        continue;
      }
      terminalScopes.push(scope);
    } else {
      // gated / not_applicable / superseded: an owner Decision record must be
      // referenced — a campaign never reclassifies a definition of done itself.
      if (
        typeof completion.decision_ref === "string" &&
        completion.decision_ref.length > 0
      ) {
        terminalScopes.push(scope);
      } else {
        blockers.push(
          `scope ${scope} terminalized as "${completion.delivered}" without a decision_ref — non-delivery counts as terminal only when a canonical owner Decision record ratifies it`
        );
      }
    }
  }
  const nonTerminal = requiredScopes.filter(
    scope => !terminalScopes.includes(scope)
  );
  const nonTerminalUnblocked = nonTerminal.filter(
    scope => !blockers.some(blocker => blocker.startsWith(`scope ${scope} `))
  );
  if (nonTerminalUnblocked.length > 0) {
    blockers.push(
      `required scopes not terminal: ${nonTerminalUnblocked.join(", ")}`
    );
  }
  // DoD divergence (audit C1): when the governing directive is pinned into the
  // run, every definition_of_done line must appear in it verbatim — a manifest
  // may never legislate its own weaker done-condition.
  const directivePath = join(runDir(runId), "directive.md");
  if (existsSync(directivePath)) {
    const directiveText = readFileSync(directivePath, "utf8");
    const divergentDod = manifest.definition_of_done.filter(
      line => !directiveText.includes(line)
    );
    if (divergentDod.length > 0) {
      blockers.push(
        `manifest definition_of_done diverges from the pinned directive (no owner decision_ref): ${divergentDod.map(line => JSON.stringify(line.slice(0, 60))).join("; ")}`
      );
    }
  }
  // Required gates (gstack-review HIGH): every manifest-required gate needs a
  // terminal evaluation, and its LAST recorded state must be PASS or
  // NOT_APPLICABLE — a FAIL only clears through re-evaluation, never silently.
  const gateState = new Map();
  for (const event of events) {
    if (event.event_type === "GATE_EVALUATED")
      gateState.set(event.gate, event.gate_status);
  }
  const unevaluatedGates = manifest.required_gates.filter(
    gate => !gateState.has(gate)
  );
  if (unevaluatedGates.length > 0) {
    blockers.push(
      `required gates never evaluated: ${unevaluatedGates.join(", ")}`
    );
  }
  const failedGates = manifest.required_gates.filter(gate =>
    ["FAIL", "BLOCKED"].includes(gateState.get(gate))
  );
  if (failedGates.length > 0) {
    blockers.push(
      `required gates not terminal-PASS: ${failedGates.map(gate => `${gate}=${gateState.get(gate)}`).join(", ")}`
    );
  }
  // Required gstack workflows (audit M1): exact-match on the structured
  // workflow field of v2 events. v1 events (which cannot carry the field) fall
  // back to summary substring — a path that exists only for historical events,
  // since every new append is v2.
  const accountedWorkflows = new Set(
    events
      .filter(
        event =>
          ["GSTACK_COMPLETED", "GSTACK_UNAVAILABLE"].includes(
            event.event_type
          ) && (event.schema_version ?? 1) >= 2
      )
      .map(event => event.workflow)
  );
  const legacyGstackText = events
    .filter(
      event =>
        ["GSTACK_COMPLETED", "GSTACK_UNAVAILABLE"].includes(event.event_type) &&
        (event.schema_version ?? 1) < 2
    )
    .map(event => event.summary.toLowerCase())
    .join("\n");
  const unaccountedGstack = manifest.required_gstack.filter(
    name =>
      !accountedWorkflows.has(name) &&
      !legacyGstackText.includes(name.toLowerCase())
  );
  if (unaccountedGstack.length > 0) {
    blockers.push(
      `required gstack workflows unaccounted: ${unaccountedGstack.join(", ")}`
    );
  }
  if (metrics.owner_gates_open > 0) {
    blockers.push(
      `${metrics.owner_gates_open} owner gate(s) OPEN: ${Object.entries(
        metrics.owner_gates
      )
        .filter(([, state]) => state === "OPEN")
        .map(([id]) => id)
        .join(
          ", "
        )} — external-blocking is a valid terminal condition ONLY when everything else is done`
    );
  }
  if (metrics.notion_writes_committed > metrics.notion_writes_verified) {
    blockers.push(
      `${metrics.notion_writes_committed - metrics.notion_writes_verified} Notion write(s) committed without a recorded re-read verification`
    );
  }
  const terminalRunEvent = events.some(e =>
    ["RUN_COMPLETED", "RUN_FAILED", "RUN_PAUSED_EXTERNAL"].includes(
      e.event_type
    )
  );
  const last = events[events.length - 1] ?? null;
  // Claims index (§53: handoff claim tracing): the machine-readable set of
  // claims the final handoff must reference — PR identities with exact SHAs,
  // terminal scopes with their delivery class and proof, owner-gate states.
  const prClaims = {};
  for (const event of events) {
    if (event.pr == null) continue;
    const claim = (prClaims[event.pr] ??= {
      head_shas: [],
      merge_sha: null,
      last_event: null,
    });
    if (event.head_sha && !claim.head_shas.includes(event.head_sha))
      claim.head_shas.push(event.head_sha);
    if (event.merge_sha) claim.merge_sha = event.merge_sha;
    claim.last_event = event.event_type;
  }
  const claims = {
    prs: prClaims,
    terminal_scopes: terminalScopes.map(scope => {
      const completion = lastCompletion.get(scope);
      return {
        scope,
        delivered:
          (completion.schema_version ?? 1) < 2
            ? "legacy-v1"
            : completion.delivered,
        authority_plane: completion.authority_plane ?? null,
        proof: completion.proof ?? null,
        decision_ref: completion.decision_ref ?? null,
      };
    }),
    owner_gates: metrics.owner_gates,
    legacy_terminalizations: legacyTerminalizations,
  };
  return {
    run_id: runId,
    complete: blockers.length === 0 && terminalRunEvent,
    terminal_run_event_recorded: terminalRunEvent,
    blockers,
    claims,
    // External tail anchor (FIND-LANE0-0002): verify proves chain linearity but
    // cannot detect deletion of the FINAL lines. Quote these two values in the
    // PR body / final handoff; any later tail truncation then contradicts an
    // out-of-band record.
    tail_anchor: last
      ? { events_total: events.length, final_event_hash: last.event_hash }
      : null,
    metrics,
  };
}

const invokedDirectly =
  process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) {
  const [, , command, runId] = process.argv;
  if (command === "metrics") {
    console.log(JSON.stringify(deriveMetrics(runId), null, 2));
  } else if (command === "closeout") {
    const result = closeout(runId);
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.complete ? 0 : 1);
  } else {
    console.error("usage: closeout.mjs <metrics|closeout> <run_id>");
    process.exit(2);
  }
}
