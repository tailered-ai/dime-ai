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
  MEMORY_MUTATING_TYPES,
  deriveArtifacts,
  deriveInteractionGraph,
  deriveProgress,
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
      // A url proof is shape-checked, not liveness-checked (refutation attack 2):
      // a well-formed but dead URL must not manufacture COMPLETE. delivered:true
      // therefore requires an EXISTENCE-checked proof (repo/run-artifact/event);
      // a url may accompany but never suffices on its own.
      if (completion.proof?.type === "url") {
        blockers.push(
          `scope ${scope} claims delivered:true on a url-only proof — url proofs are shape-checked, not liveness-checked; terminal delivery needs an existence-checked repo/run-artifact/event proof`
        );
        continue;
      }
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
  // Law 3 / 2R v2.1: a subagent dispatched and never terminated is a dangling
  // execution — closeout blocks until it reaches a terminal event.
  if ((integrity.stats?.dangling_subagents ?? []).length > 0) {
    blockers.push(
      `dangling subagent dispatch(es) with no terminal event: ${integrity.stats.dangling_subagents.join(", ")} — each must reach SUBAGENT_COMPLETED/FAILED/CANCELLED/ABORTED/SUPERSEDED`
    );
  }
  // Law 14: an open REFUTED claim blocks until a later correlated event that is
  // ITSELF a strong claim (PROVEN/SUPPORTED) corrects it — an INFERRED/UNKNOWN
  // "correction" does not lift a refutation (refutation caveat B).
  const refutedOpen = [];
  const strongCorrections = new Set(
    events
      .filter(
        e =>
          e.correlation_id && (e.label === "PROVEN" || e.label === "SUPPORTED")
      )
      .map(e => e.correlation_id)
  );
  for (const event of events) {
    if (event.label === "REFUTED" && !strongCorrections.has(event.event_id)) {
      refutedOpen.push(event.event_id);
    }
  }
  if (refutedOpen.length > 0) {
    blockers.push(
      `open REFUTED claim(s) with no PROVEN/SUPPORTED correcting event: ${refutedOpen.join(", ")} (Law 14)`
    );
  }
  // Law 18: DERIVE conflicts, not only accept self-reports (refutation attack 5).
  // Two subagent dispatches declaring the SAME write scope is a conflict the
  // kernel flags even if no agent volunteered a CONFLICT event.
  const scopeToAgents = {};
  for (const event of events) {
    if (event.event_type === "SUBAGENT_STARTED" && event.scope_declaration) {
      (scopeToAgents[event.scope_declaration] ??= []).push(event.actor?.name);
    }
  }
  const derivedConflicts = Object.entries(scopeToAgents).filter(
    ([, agents]) => new Set(agents).size > 1
  );
  if (derivedConflicts.length > 0) {
    blockers.push(
      `derived write conflict(s): ${derivedConflicts.map(([scope, agents]) => `"${scope}" declared by ${[...new Set(agents)].join(" & ")}`).join("; ")} — one implementation owner per artifact (Law 18)`
    );
  }
  if (metrics.notion_writes_committed > metrics.notion_writes_verified) {
    blockers.push(
      `${metrics.notion_writes_committed - metrics.notion_writes_verified} Notion write(s) committed without a recorded re-read verification`
    );
  }
  // §13: no stale-dependent anything may integrate or deploy — a run cannot
  // COMPLETE while any registered artifact sits in STALE-DEPENDENCY without an
  // explicit revalidation citing the new upstream identity.
  const artifactManifest = deriveArtifacts(runId);
  if (artifactManifest.stale.length > 0) {
    blockers.push(
      `stale-dependency artifact(s) never revalidated: ${artifactManifest.stale.map(a => `${a.id} (upstream ${a.cause?.upstream} via ${a.cause?.via})`).join("; ")} (§13)`
    );
  }
  if (artifactManifest.ephemeral_unretired.length > 0) {
    blockers.push(
      `ephemeral artifact(s) not RETIRED before closeout: ${artifactManifest.ephemeral_unretired.join(", ")} (§6 removal condition)`
    );
  }
  // Refutation R7: the manifest must not repeat fabrications — offline-
  // checkable bytes are checked, and mismatches block.
  if (artifactManifest.fidelity_defects.length > 0) {
    blockers.push(
      `artifact-manifest fidelity defect(s): ${artifactManifest.fidelity_defects.join("; ")}`
    );
  }
  // Refutation R8: work consumed while stale is poisoned until the SAME scope
  // re-consumes the artifact after revalidation — recorded-but-toothless is
  // not a control.
  const unclearedStaleConsumptions = artifactManifest.stale_consumptions.filter(
    poisoned => {
      const artifact = artifactManifest.artifacts.find(
        a => a.id === poisoned.artifact
      );
      return !(artifact?.consumers ?? []).some(
        c =>
          c.scope === poisoned.scope &&
          !c.while_stale &&
          c.event > poisoned.event
      );
    }
  );
  if (unclearedStaleConsumptions.length > 0) {
    blockers.push(
      `stale consumption(s) never repeated on fresh bytes: ${unclearedStaleConsumptions.map(c => `${c.artifact} by ${c.scope} at ${c.event}`).join("; ")} (§13: no stale-dependent work integrates)`
    );
  }
  // §16: every integration boundary evaluated must END at NO_GAP — a gap
  // clears only through a later re-evaluation of the SAME integration_id.
  const compositionState = new Map();
  for (const event of events) {
    if (event.event_type === "COMPOSITION_EVALUATED")
      compositionState.set(event.integration_id, event.composition_verdict);
  }
  const openGaps = [...compositionState.entries()].filter(
    ([, verdict]) => verdict !== "NO_GAP"
  );
  if (openGaps.length > 0) {
    blockers.push(
      `composition gap(s) not closed: ${openGaps.map(([id, verdict]) => `${id}=${verdict}`).join(", ")} — individually green components do not certify the composed system (§16)`
    );
  }
  // Refutation R5: an unevaluated boundary is invisible to the latest-verdict
  // rule, so the manifest may DECLARE the boundaries that objectively exist —
  // each then requires a terminal NO_GAP, mirroring required_gates.
  const unevaluatedCompositions = (manifest.required_compositions ?? []).filter(
    id => compositionState.get(id) !== "NO_GAP"
  );
  if (unevaluatedCompositions.length > 0) {
    blockers.push(
      `required composition boundaries without a terminal NO_GAP: ${unevaluatedCompositions.join(", ")} (§16)`
    );
  }
  // §47: if this run mutated execution memory, the LAST mutation must be
  // followed by a MEMORY_RECONCILED clean:true — reconcile-then-mutate-again
  // does not count.
  const lastMutationIndex = events.reduce(
    (latest, event, index) =>
      MEMORY_MUTATING_TYPES.includes(event.event_type) ? index : latest,
    -1
  );
  if (lastMutationIndex >= 0) {
    const reconciledAfter = events
      .slice(lastMutationIndex + 1)
      .some(e => e.event_type === "MEMORY_RECONCILED" && e.clean === true);
    if (!reconciledAfter) {
      blockers.push(
        `execution memory mutated after the last clean MEMORY_RECONCILED (last mutation: ${events[lastMutationIndex].event_id}) — run memory reconciliation before closeout (§47)`
      );
    }
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
  // Law 14: epistemic-label census across the whole run.
  const labelCounts = {};
  for (const event of events) {
    if (event.label)
      labelCounts[event.label] = (labelCounts[event.label] ?? 0) + 1;
  }
  // Law 18: the agent-interaction graph — each dispatch, its declared scope,
  // its terminal, and any CONFLICT flags raised.
  const subagentTerminals = new Set([
    "SUBAGENT_COMPLETED",
    "SUBAGENT_FAILED",
    "SUBAGENT_CANCELLED",
    "SUBAGENT_ABORTED",
    "SUBAGENT_SUPERSEDED",
  ]);
  const interactionGraph = {};
  for (const event of events) {
    const name = event.actor?.name;
    if (event.event_type === "SUBAGENT_STARTED") {
      interactionGraph[name] = {
        scope: event.scope_declaration ?? null,
        terminal: null,
      };
    }
    if (subagentTerminals.has(event.event_type) && interactionGraph[name]) {
      interactionGraph[name].terminal = event.event_type;
    }
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
        label: completion.label ?? null,
      };
    }),
    owner_gates: metrics.owner_gates,
    legacy_terminalizations: legacyTerminalizations,
    epistemic_labels: labelCounts,
    interaction_graph: interactionGraph,
    conflicts: events
      .filter(e => e.event_type === "CONFLICT")
      .map(e => e.conflict_scope),
    interventions: events
      .filter(e => e.event_type === "INTERVENTION")
      .map(e => ({ choice: e.intervention, summary: e.summary })),
    // §5-§7: the derived Artifact Manifest summary — never hand-counted.
    artifacts: {
      total: artifactManifest.artifacts_total,
      by_state: artifactManifest.by_state,
      stale: artifactManifest.stale,
      stale_consumptions: artifactManifest.stale_consumptions,
    },
    // §16: final composition verdicts per integration boundary.
    composition: Object.fromEntries(compositionState),
    // §14: derived multi-resource conflicts beyond the write-scope equality.
    resource_conflicts: deriveInteractionGraph(runId).potential_conflicts,
    // §10-§11: derived progress verdict (stream-derived; honest boundary in
    // the README — reported facts, not raw behavior).
    progress: (() => {
      const p = deriveProgress(runId);
      return {
        loop_candidates: p.loop_candidates.length,
        stall_breached: p.stall_breached,
        stall_suspected_recorded: p.stall_suspected_recorded,
        interventions_recorded: p.interventions_recorded,
      };
    })(),
  };
  // §24: owner-gate census by state AND classification with exact ids — no
  // future reader reconstructs counts from prose. Latest event per gate wins.
  const gateCensus = new Map();
  for (const event of events) {
    if (event.event_type?.startsWith("OWNER_GATE_")) {
      const prior = gateCensus.get(event.owner_gate.id);
      gateCensus.set(event.owner_gate.id, {
        state: event.owner_gate.state,
        classification:
          event.owner_gate.classification ?? prior?.classification ?? null,
      });
    }
  }
  const gateIdsWhere = predicate =>
    [...gateCensus.entries()]
      .filter(([, gate]) => predicate(gate))
      .map(([id]) => id)
      .sort();
  const ownerGateCensus = {
    RUN_BLOCKING: gateIdsWhere(
      g => g.state === "OPEN" && g.classification === "RUN_BLOCKING"
    ),
    PROGRAM_OPEN: gateIdsWhere(
      g => g.state === "OPEN" && g.classification === "PROGRAM_OPEN"
    ),
    SEQUENCED: gateIdsWhere(
      g => g.state === "OPEN" && g.classification === "SEQUENCED"
    ),
    STANDING: gateIdsWhere(
      g => g.state === "OPEN" && g.classification === "STANDING"
    ),
    OPEN_UNCLASSIFIED: gateIdsWhere(
      g => g.state === "OPEN" && g.classification === null
    ),
    RESOLVED: gateIdsWhere(g => g.state === "ANSWERED"),
    SUPERSEDED: gateIdsWhere(g => g.state === "SUPERSEDED"),
    CANCELLED: gateIdsWhere(g => g.state === "CANCELLED"),
    TOTAL_MINTED: [...gateCensus.keys()].sort(),
  };
  // Law 12: denominators emitted, never prosed.
  const requiredTos = requiredScopes.length;
  const denominators = {
    scopes_terminal_of_required: `${terminalScopes.length} of ${requiredTos}`,
    gates_pass_of_required: `${manifest.required_gates.filter(g => gateState.get(g) === "PASS" || gateState.get(g) === "NOT_APPLICABLE").length} of ${manifest.required_gates.length}`,
    gstack_accounted_of_required: `${manifest.required_gstack.length - unaccountedGstack.length} of ${manifest.required_gstack.length}`,
    owner_gates_open: metrics.owner_gates_open,
    findings_open_of_total: `${metrics.findings_open} of ${metrics.findings_total}`,
    artifacts_stale_of_total: `${artifactManifest.stale.length} of ${artifactManifest.artifacts_total}`,
    composition_no_gap_of_evaluated: `${[...compositionState.values()].filter(v => v === "NO_GAP").length} of ${compositionState.size}`,
    owner_gate_census: ownerGateCensus,
  };
  return {
    run_id: runId,
    complete: blockers.length === 0 && terminalRunEvent,
    terminal_run_event_recorded: terminalRunEvent,
    blockers,
    denominators,
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
