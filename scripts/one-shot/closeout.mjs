// §45 metrics derivation + §53 closeout gate for one-shot runs. Everything here
// is derived mechanically from the event ledger — no hand-estimated numbers.
// closeout exits 0 only when the run can honestly emit COMPLETE; otherwise it
// prints exactly which conditions block, exits 1, and the campaign ends with
// the Owner-Gate Queue instead of a false COMPLETE.
import { loadManifest, readEvents, verifyRun } from "./ledger.mjs";

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
  if (metrics.critical_findings > 0 || metrics.high_findings > 0) {
    const open = events.length && metrics.findings_open > 0;
    if (open) blockers.push(`${metrics.findings_open} finding(s) not CLOSED`);
  } else if (metrics.findings_open > 0) {
    blockers.push(`${metrics.findings_open} finding(s) not CLOSED`);
  }
  const requiredScopes = manifest.scopes.filter(scope =>
    /^TOS-\d{3}$/.test(scope)
  );
  const completed = new Set(
    events.filter(e => e.event_type === "SCOPE_COMPLETED").map(e => e.scope_id)
  );
  const nonTerminal = requiredScopes.filter(scope => !completed.has(scope));
  if (nonTerminal.length > 0) {
    blockers.push(`required scopes not terminal: ${nonTerminal.join(", ")}`);
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
  return {
    run_id: runId,
    complete: blockers.length === 0 && terminalRunEvent,
    terminal_run_event_recorded: terminalRunEvent,
    blockers,
    metrics,
  };
}

const invokedDirectly =
  process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
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
