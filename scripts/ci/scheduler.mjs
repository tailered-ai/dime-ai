#!/usr/bin/env node
/**
 * scheduler.mjs — P04.T01 (dependency-aware DAG scheduler) + P04.T02
 * (concurrency and resource budget).
 *
 * The graph is validated BEFORE anything executes: unknown prerequisites,
 * self-dependencies, duplicate edges, and cycles are configuration failures
 * raised up front — the scheduler never "picks an order anyway".
 *
 * Determinism: simultaneously-runnable gates are ordered lexicographically
 * by gate_id — never by filesystem enumeration, hash-map iteration, wall
 * clock, or completion races. Admission decisions happen at well-defined
 * points (run start and each settle event) and are journaled with sequence
 * numbers, so two runs over the same graph produce the same decision log.
 *
 * BUDGET TRUTH (frozen): admission control is SCHEDULER_ENFORCED. It is not
 * an operating-system quota and this module never claims it is — each
 * dimension carries its real enforcement level.
 */
import { GATE_STATUSES } from "./result.mjs";

export class SchedulerError extends Error {
  constructor(reason, detail = {}) {
    super(reason);
    this.name = "SchedulerError";
    this.reason = reason;
    Object.assign(this, detail);
  }
}

/**
 * The CENTRAL prerequisite-permission table (frozen semantics). A dependent
 * may enter execution only when EVERY prerequisite settled in a `true`
 * status. Totality over the 12 statuses is asserted at module load, so a
 * future status cannot silently default to "permitted".
 */
export const PREREQUISITE_PERMITS = {
  PASS: true,
  // A declared non-execution is not a failure; CI's own `needs:` treats the
  // corresponding success-with-skip semantics as satisfied for these shapes.
  "N/A": true,
  SKIPPED_DECLARED: true,
  CI_ONLY: true,
  FAIL: false,
  FLAKY: false,
  TIMEOUT: false,
  BLOCKED: false,
  INFRA_FAIL: false,
  CONTRACT_DRIFT: false,
  BROKEN_GATE: false,
  INCONCLUSIVE: false,
};
for (const status of GATE_STATUSES) {
  if (!(status in PREREQUISITE_PERMITS)) {
    throw new SchedulerError("PERMIT_TABLE_INCOMPLETE", { status });
  }
}
for (const status of Object.keys(PREREQUISITE_PERMITS)) {
  if (!GATE_STATUSES.includes(status)) {
    throw new SchedulerError("PERMIT_TABLE_UNKNOWN_STATUS", { status });
  }
}

/** Enforcement levels a budget dimension may truthfully claim. */
export const ENFORCEMENT_LEVELS = [
  "DECLARED",
  "SCHEDULER_ENFORCED",
  "OS_ENFORCED",
  "UNENFORCED",
];

export function makeBudget(options = {}) {
  const budget = {
    max_concurrency: options.max_concurrency ?? 2,
    memory_budget_mb: options.memory_budget_mb ?? null,
    max_processes: options.max_processes ?? null,
    cpu_weight: options.cpu_weight ?? null,
    headroom_note:
      options.headroom_note ??
      "system headroom is reserved by keeping max_concurrency below host cores",
    enforcement: {
      concurrency: "SCHEDULER_ENFORCED",
      memory:
        (options.memory_budget_mb ?? null) === null
          ? "DECLARED"
          : "SCHEDULER_ENFORCED", // admission arithmetic over DECLARED hints
      memory_note:
        "admission-time arithmetic over declared per-gate hints; the OS " +
        "imposes no hard quota on this path and none is claimed",
      processes:
        (options.max_processes ?? null) === null
          ? "DECLARED"
          : "SCHEDULER_ENFORCED",
      cpu: "DECLARED",
      cpu_note: "no cgroup/priority mechanism owned on this host",
    },
  };
  if (!Number.isInteger(budget.max_concurrency) || budget.max_concurrency < 1) {
    throw new SchedulerError("INVALID_BUDGET", {
      field: "max_concurrency",
      value: budget.max_concurrency,
    });
  }
  return budget;
}

/**
 * Build and validate the execution graph from declared specs.
 * spec: { gate_id, requires?: [], lane?: string|null, memory_hint_mb? }
 */
export function buildGraph(specs) {
  const nodes = new Map();
  for (const spec of specs) {
    if (typeof spec?.gate_id !== "string" || spec.gate_id.length === 0) {
      throw new SchedulerError("GATE_ID_REQUIRED", { spec });
    }
    if (nodes.has(spec.gate_id)) {
      throw new SchedulerError("DUPLICATE_GATE_ID", { gate_id: spec.gate_id });
    }
    nodes.set(spec.gate_id, { spec, requires: [], dependents: [] });
  }
  for (const spec of specs) {
    const seen = new Set();
    for (const requirement of spec.requires ?? []) {
      if (requirement === spec.gate_id) {
        throw new SchedulerError("SELF_DEPENDENCY", { gate_id: spec.gate_id });
      }
      if (!nodes.has(requirement)) {
        throw new SchedulerError("UNKNOWN_PREREQUISITE", {
          gate_id: spec.gate_id,
          requirement,
        });
      }
      if (seen.has(requirement)) {
        // A duplicate edge is where a typo'd second requirement hides.
        throw new SchedulerError("DUPLICATE_DEPENDENCY_EDGE", {
          gate_id: spec.gate_id,
          requirement,
        });
      }
      seen.add(requirement);
      nodes.get(spec.gate_id).requires.push(requirement);
      nodes.get(requirement).dependents.push(spec.gate_id);
    }
  }
  // Cycle detection BEFORE execution — Kahn's algorithm; leftovers form the
  // cycle, reported explicitly. Order is never "chosen anyway".
  const indegree = new Map();
  for (const [id, node] of nodes) indegree.set(id, node.requires.length);
  const ready = [...nodes.keys()].filter(id => indegree.get(id) === 0).sort();
  const order = [];
  const queue = [...ready];
  while (queue.length) {
    queue.sort(); // deterministic lexicographic tie-break
    const id = queue.shift();
    order.push(id);
    for (const dependent of [...nodes.get(id).dependents].sort()) {
      indegree.set(dependent, indegree.get(dependent) - 1);
      if (indegree.get(dependent) === 0) queue.push(dependent);
    }
  }
  if (order.length !== nodes.size) {
    const cycle = [...nodes.keys()].filter(id => indegree.get(id) > 0).sort();
    throw new SchedulerError("DEPENDENCY_CYCLE", { members: cycle });
  }
  return { nodes, order };
}

/**
 * Evaluate one gate's prerequisites against settled results.
 * Returns { permitted, blocking } where blocking lists every prerequisite
 * that settled in a disqualifying status — the CAUSAL RECORD a skipped
 * dependent must retain.
 */
export function prerequisiteDecision(node, settled) {
  const blocking = [];
  const pending = [];
  for (const requirement of node.requires) {
    const result = settled.get(requirement);
    if (!result) {
      pending.push(requirement);
      continue;
    }
    if (!PREREQUISITE_PERMITS[result.status]) {
      blocking.push({ gate_id: requirement, status: result.status });
    }
  }
  return {
    permitted: blocking.length === 0 && pending.length === 0,
    blocking,
    pending,
  };
}

/**
 * The admission decision for one candidate gate under the current budget.
 * Pure and deterministic: same state, same answer.
 */
export function admissionDecision(spec, running, budget) {
  const hint = spec.memory_hint_mb ?? 0;
  if (budget.memory_budget_mb !== null && hint > budget.memory_budget_mb) {
    return {
      decision: "IMPOSSIBLE",
      reason:
        `RESOURCE_ADMISSION_IMPOSSIBLE: declared memory hint ${hint}MB ` +
        `exceeds the total budget ${budget.memory_budget_mb}MB`,
    };
  }
  if (running.length >= budget.max_concurrency) {
    return { decision: "WAIT", reason: "concurrency budget consumed" };
  }
  if (
    budget.max_processes !== null &&
    running.length + 1 > budget.max_processes
  ) {
    return { decision: "WAIT", reason: "process budget consumed" };
  }
  if (budget.memory_budget_mb !== null) {
    const inUse = running.reduce((sum, r) => sum + (r.memory_hint_mb ?? 0), 0);
    if (inUse + hint > budget.memory_budget_mb) {
      return {
        decision: "WAIT",
        reason: `memory budget consumed (${inUse}MB in use, hint ${hint}MB)`,
      };
    }
  }
  return { decision: "ADMIT", reason: null };
}

/**
 * Drive the graph to completion. `runGate(spec)` executes ONE gate and
 * resolves to a settled result ({ gate_id, status, ... }); the scheduler
 * never invents statuses for executed gates — only for gates it refuses to
 * run (prerequisite-blocked or admission-impossible), and those are always
 * non-green with the causal reason attached.
 *
 * Returns { settled, decisions } where decisions is the journaled decision
 * log (seq, kind, gate_id, detail) — structured scheduler evidence.
 */
export async function runGraph(graph, budget, runGate, hooks = {}) {
  const settled = new Map();
  const running = new Map();
  const decisions = [];
  let seq = 0;
  const journal = (kind, gateId, detail = {}) => {
    const entry = { seq: (seq += 1), kind, gate_id: gateId, ...detail };
    decisions.push(entry);
    if (hooks.onDecision) hooks.onDecision(entry);
    return entry;
  };

  const remaining = new Set(graph.order);

  const settleRefusal = (id, status, reason, extra = {}) => {
    remaining.delete(id);
    settled.set(id, {
      gate_id: id,
      status,
      reason,
      scheduled: false,
      ...extra,
    });
  };

  // One pass per wake-up: settle refusals, admit what fits, in deterministic
  // (topological, lexicographically tie-broken) order.
  const pump = () => {
    let progressed = true;
    while (progressed) {
      progressed = false;
      for (const id of graph.order) {
        if (!remaining.has(id) || running.has(id)) continue;
        const node = graph.nodes.get(id);
        const prereq = prerequisiteDecision(node, settled);
        if (prereq.blocking.length > 0) {
          journal("PREREQUISITE_REFUSED", id, { blocking: prereq.blocking });
          // The frozen semantics: an unexecuted dependent is BLOCKED with the
          // prerequisite IDs retained — never PASS, N/A, or a generic skip.
          settleRefusal(
            id,
            "BLOCKED",
            `PREREQUISITE_NOT_PERMITTED: ${prereq.blocking
              .map(b => `${b.gate_id}=${b.status}`)
              .join(", ")}`,
            { blocked_by: prereq.blocking }
          );
          progressed = true;
          continue;
        }
        if (prereq.pending.length > 0) continue; // wait for settlement
        const admission = admissionDecision(
          node.spec,
          [...running.values()].map(r => r.spec),
          budget
        );
        journal("ADMISSION", id, admission);
        if (admission.decision === "IMPOSSIBLE") {
          settleRefusal(id, "INFRA_FAIL", admission.reason, {
            infra: "RESOURCE_ADMISSION_IMPOSSIBLE",
          });
          progressed = true;
          continue;
        }
        if (admission.decision === "WAIT") continue;
        // ADMIT
        remaining.delete(id);
        const execution = Promise.resolve()
          .then(() => runGate(node.spec))
          .then(result => ({ ok: true, result }))
          .catch(error => ({ ok: false, error }));
        running.set(id, { spec: node.spec, execution });
        journal("START", id, {
          running: [...running.keys()].sort(),
        });
        progressed = true;
      }
    }
  };

  pump();
  while (running.size > 0) {
    // Wait for ANY running gate to settle; process settlements one at a time
    // (the JS event loop already serializes them).
    const [id, outcome] = await Promise.race(
      [...running.entries()].map(async ([gateId, entry]) => [
        gateId,
        await entry.execution,
      ])
    );
    running.delete(id);
    if (outcome.ok) {
      settled.set(id, { ...outcome.result, scheduled: true });
      journal("SETTLED", id, { status: outcome.result.status });
    } else {
      // A scheduler/executor exception is INFRASTRUCTURE — it must never be
      // translated into a product FAIL for the gate.
      settled.set(id, {
        gate_id: id,
        status: "INFRA_FAIL",
        reason: `EXECUTOR_EXCEPTION: ${outcome.error?.reason ?? outcome.error?.message}`,
        scheduled: true,
        executor_exception: true,
      });
      journal("EXECUTOR_EXCEPTION", id, {
        error: outcome.error?.reason ?? outcome.error?.message,
      });
    }
    pump();
  }
  if (remaining.size > 0) {
    // Structurally impossible on a validated DAG; refuse to fabricate.
    throw new SchedulerError("SCHEDULER_STARVATION", {
      remaining: [...remaining].sort(),
    });
  }
  return { settled, decisions };
}
