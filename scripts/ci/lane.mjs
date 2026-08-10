#!/usr/bin/env node
/**
 * lane.mjs — P04.T03 (serial DB lane) + P04.T10 (deterministic lane sentinel).
 *
 * A lane is a NAMED EXCLUSIVE resource (the frozen instance: one MySQL). The
 * scheduler SERIALIZES legitimate concurrent requests — it never rejects
 * them; a bypass acquisition that finds the lane held is a LANE_VIOLATION,
 * detected structurally, never by timing.
 *
 * Mechanics:
 *   - acquisition is an atomic `mkdir` of `<root>/<lane>.lock` (POSIX gives
 *     exactly one winner), with `owner.json` written inside it;
 *   - every event is appended to `<root>/<lane>.journal.jsonl`, and the
 *     journal is the STRUCTURAL record the sentinel audits: two ACQUIREs
 *     without an intervening RELEASE is a violation regardless of clocks;
 *   - release verifies run_id + acquisition_id, so one run can never release
 *     another run's lock (UNAUTHORIZED_RELEASE);
 *   - a lock whose owner pid is dead is STALE — detected and CLASSIFIED; it
 *     is reclaimed only by an explicit `reclaimStale` call that journals the
 *     reclaim, never silently overridden.
 */
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { pidAlive } from "./teardown.mjs";

export class LaneError extends Error {
  constructor(reason, detail = {}) {
    super(reason);
    this.name = "LaneError";
    this.reason = reason;
    Object.assign(this, detail);
  }
}

let ACQ_SEQ = 0;

export class LaneManager {
  constructor(options) {
    if (!options?.root) throw new LaneError("LANE_ROOT_REQUIRED", {});
    if (!options?.run_id) throw new LaneError("RUN_ID_REQUIRED", {});
    this.root = options.root;
    this.run_id = options.run_id;
    mkdirSync(this.root, { recursive: true });
    // In-process FIFO queues give scheduler-sanctioned serialization; the
    // on-disk lock is the cross-process truth the sentinel audits.
    this.queues = new Map();
    this.held = new Map(); // lane -> acquisition
  }

  lockDir(lane) {
    return path.join(this.root, `${lane}.lock`);
  }

  journalPath(lane) {
    return path.join(this.root, `${lane}.journal.jsonl`);
  }

  journal(lane, event) {
    appendFileSync(
      this.journalPath(lane),
      `${JSON.stringify({ ...event, at: new Date().toISOString() })}\n`
    );
  }

  readOwner(lane) {
    const ownerPath = path.join(this.lockDir(lane), "owner.json");
    if (!existsSync(ownerPath)) return null;
    try {
      return JSON.parse(readFileSync(ownerPath, "utf8"));
    } catch {
      return { malformed: true };
    }
  }

  /** Classify the current on-disk lock state without mutating it. */
  inspect(lane) {
    if (!existsSync(this.lockDir(lane))) return { state: "FREE" };
    const owner = this.readOwner(lane);
    if (!owner) return { state: "ACQUIRING", owner: null };
    if (owner.malformed) return { state: "MALFORMED", owner };
    if (!pidAlive(owner.pid)) return { state: "STALE", owner };
    return { state: "HELD", owner };
  }

  /**
   * Atomic acquisition attempt. Returns the acquisition on success; on a held
   * lane it either records a LANE_VIOLATION (bypass semantics) or reports the
   * holder so a queued caller can wait. Never spins on timing.
   */
  tryAcquire(lane, gateId, options = {}) {
    const dir = this.lockDir(lane);
    try {
      mkdirSync(dir); // atomic: exactly one winner
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const status = this.inspect(lane);
      if (status.state === "STALE" || status.state === "MALFORMED") {
        // Detected and CLASSIFIED — never silently overridden.
        throw new LaneError("STALE_LOCK", { lane, holder: status.owner });
      }
      if (options.bypass) {
        // A second holder attempted entry outside the scheduler: this IS the
        // sentinel trip. Structural, deterministic, journaled.
        this.journal(lane, {
          event: "VIOLATION",
          kind: "LANE_VIOLATION",
          attempted_by: { run_id: this.run_id, gate_id: gateId },
          holder: status.owner,
        });
        throw new LaneError("LANE_VIOLATION", {
          lane,
          holder: status.owner,
          attempted_by: { run_id: this.run_id, gate_id: gateId },
        });
      }
      return null; // scheduler path: caller queues
    }
    const acquisition = {
      lane,
      acquisition_id: `${this.run_id}-acq-${(ACQ_SEQ += 1)}`,
      run_id: this.run_id,
      gate_id: gateId,
      pid: process.pid,
      entered_at: new Date().toISOString(),
      entered_seq: null,
      exited_at: null,
      release_state: "HELD",
    };
    writeFileSync(
      path.join(dir, "owner.json"),
      JSON.stringify(acquisition, null, 2)
    );
    this.journal(lane, {
      event: "ACQUIRE",
      acquisition_id: acquisition.acquisition_id,
      run_id: this.run_id,
      gate_id: gateId,
      pid: process.pid,
    });
    this.held.set(lane, acquisition);
    return acquisition;
  }

  /**
   * Scheduler-sanctioned acquisition: QUEUES until the lane frees. FIFO per
   * lane inside this run; cross-process it polls the atomic lock (bounded
   * interval — correctness never depends on the poll winning a race, only
   * the atomic mkdir decides).
   */
  async acquire(lane, gateId, options = {}) {
    const pollMs = options.poll_ms ?? 25;
    const previous = this.queues.get(lane) ?? Promise.resolve();
    let resolveTurn;
    const turn = new Promise(resolve => {
      resolveTurn = resolve;
    });
    this.queues.set(
      lane,
      previous.then(() => turn)
    );
    await previous; // FIFO: wait for every earlier in-process request
    try {
      for (;;) {
        const acquisition = this.tryAcquire(lane, gateId, options);
        if (acquisition) {
          acquisition.release_turn = resolveTurn;
          return acquisition;
        }
        await new Promise(resolve => setTimeout(resolve, pollMs));
      }
    } catch (error) {
      resolveTurn(); // never wedge the queue behind a failed acquisition
      throw error;
    }
  }

  /**
   * Release with ownership verification: run_id AND acquisition_id must match
   * the on-disk owner record. Anything else refuses and leaves the lock.
   */
  release(acquisition) {
    const dir = this.lockDir(acquisition.lane);
    const owner = this.readOwner(acquisition.lane);
    if (
      !owner ||
      owner.run_id !== this.run_id ||
      owner.acquisition_id !== acquisition.acquisition_id
    ) {
      throw new LaneError("UNAUTHORIZED_RELEASE", {
        lane: acquisition.lane,
        holder: owner,
        attempted_by: {
          run_id: this.run_id,
          acquisition_id: acquisition.acquisition_id,
        },
      });
    }
    acquisition.exited_at = new Date().toISOString();
    acquisition.release_state = "RELEASED";
    this.journal(acquisition.lane, {
      event: "RELEASE",
      acquisition_id: acquisition.acquisition_id,
      run_id: this.run_id,
      gate_id: acquisition.gate_id,
    });
    unlinkSync(path.join(dir, "owner.json"));
    rmdirSync(dir);
    this.held.delete(acquisition.lane);
    if (acquisition.release_turn) acquisition.release_turn();
    return acquisition;
  }

  /**
   * Explicit stale reclaim. Journals the classification and the evidence
   * (dead pid) BEFORE clearing. The caller decides; the manager never
   * auto-reclaims.
   */
  reclaimStale(lane) {
    const status = this.inspect(lane);
    if (status.state !== "STALE" && status.state !== "MALFORMED") {
      throw new LaneError("NOT_STALE", { lane, state: status.state });
    }
    this.journal(lane, {
      event: "STALE_RECLAIM",
      classified_as: status.state,
      holder: status.owner,
      reclaimed_by: this.run_id,
    });
    const ownerPath = path.join(this.lockDir(lane), "owner.json");
    if (existsSync(ownerPath)) unlinkSync(ownerPath);
    rmdirSync(this.lockDir(lane));
    return { lane, reclaimed: true, previous: status };
  }

  /** Release everything this run still holds (teardown path). */
  releaseAllHeld() {
    const released = [];
    for (const acquisition of [...this.held.values()]) {
      try {
        this.release(acquisition);
        released.push({ lane: acquisition.lane, ok: true });
      } catch (error) {
        released.push({
          lane: acquisition.lane,
          ok: false,
          error: error.reason ?? error.message,
        });
      }
    }
    return released;
  }
}

/**
 * P04.T10 — the sentinel. STRUCTURAL exclusivity audit over a lane journal:
 * a second ACQUIRE before the previous holder's RELEASE is a violation, as
 * is any journaled VIOLATION event. No wall-clock comparison is involved —
 * append order in the journal is the order the atomic lock arbitrated.
 */
export function auditLaneJournal(journalPath) {
  if (!existsSync(journalPath)) {
    return { ok: true, events: 0, violations: [], intervals: [] };
  }
  const lines = readFileSync(journalPath, "utf8")
    .split("\n")
    .filter(line => line.length > 0);
  const violations = [];
  const intervals = [];
  let holder = null;
  for (const [index, line] of lines.entries()) {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      violations.push({ line: index + 1, kind: "MALFORMED_JOURNAL" });
      continue;
    }
    if (event.event === "ACQUIRE") {
      if (holder) {
        violations.push({
          line: index + 1,
          kind: "LANE_VIOLATION",
          detail: "ACQUIRE while held",
          holder: holder.acquisition_id,
          intruder: event.acquisition_id,
        });
      }
      holder = event;
      intervals.push({
        acquisition_id: event.acquisition_id,
        gate_id: event.gate_id ?? null,
        entered_line: index + 1,
        entered_at: event.at,
        exited_line: null,
        exited_at: null,
        release_state: "HELD",
      });
    } else if (event.event === "RELEASE") {
      const interval = intervals.find(
        item => item.acquisition_id === event.acquisition_id
      );
      if (!holder || holder.acquisition_id !== event.acquisition_id) {
        violations.push({
          line: index + 1,
          kind: "RELEASE_WITHOUT_HOLD",
          acquisition_id: event.acquisition_id,
        });
      } else {
        holder = null;
      }
      if (interval) {
        interval.exited_line = index + 1;
        interval.exited_at = event.at;
        interval.release_state = "RELEASED";
      }
    } else if (event.event === "STALE_RECLAIM") {
      holder = null;
      const open = intervals.find(item => item.release_state === "HELD");
      if (open) {
        open.release_state = "STALE_RECLAIMED";
        open.exited_line = index + 1;
        open.exited_at = event.at;
      }
    } else if (event.event === "VIOLATION") {
      violations.push({
        line: index + 1,
        kind: event.kind ?? "LANE_VIOLATION",
        holder: event.holder?.acquisition_id ?? null,
        intruder: event.attempted_by ?? null,
      });
    }
  }
  return {
    ok: violations.length === 0,
    events: lines.length,
    violations,
    intervals,
    still_held: holder ? holder.acquisition_id : null,
  };
}

/**
 * Startup discovery: classify every lock under a lane root. Nothing is
 * mutated — the caller (executor start, FI01 recovery) decides per policy
 * and every reclaim goes through `reclaimStale`, which journals it.
 */
export function discoverStale(root, runId) {
  const found = [];
  if (!existsSync(root)) return found;
  const manager = new LaneManager({ root, run_id: runId });
  for (const entry of readdirSync(root)) {
    if (!entry.endsWith(".lock")) continue;
    const lane = entry.slice(0, -".lock".length);
    found.push({ lane, ...manager.inspect(lane) });
  }
  return found;
}
