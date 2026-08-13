#!/usr/bin/env node
/**
 * teardown.mjs — P04.T07: the guaranteed teardown registry and the ownership
 * law that governs every destructive operation the executor performs.
 *
 * OWNERSHIP LAW (frozen): P04 may clean ONLY what P04 can PROVE it owns.
 * Proof means one of:
 *   - a live ChildProcess handle this run spawned (we hold the object);
 *   - a pid whose environment carries this run's minted ownership marker,
 *     re-verified against the live process table at kill time;
 *   - a filesystem path whose REAL path resolves inside this run's owned
 *     scratch root (symlinks and `..` cannot escape it);
 *   - a lane lock whose owner record names this run_id.
 *
 * Anything else is refused and RECORDED — similarity of name, prefix, or
 * location is never proof. A refusal is evidence, not an error to hide.
 *
 * This module is the ONLY P04 module allowed to delete files or directories.
 * P04.AUD01 enforces that structurally.
 */
import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
} from "node:fs";
import path from "node:path";

export class TeardownError extends Error {
  constructor(reason, detail = {}) {
    super(reason);
    this.name = "TeardownError";
    this.reason = reason;
    Object.assign(this, detail);
  }
}

/** Resource classes the registry understands. Extend by declaration only. */
export const RESOURCE_TYPES = [
  "process",
  "process_group",
  "temp_dir",
  "worktree",
  "port",
  "lane_lock",
  "container",
  "browser",
  "scratch_artifact",
];

/** The environment variable this run injects into every owned child. */
export const OWNER_MARKER = "CI_VERIFY_OWNER";
export const GATE_MARKER = "CI_VERIFY_GATE";

/**
 * Path-ownership proof. The registered path must resolve — through every
 * existing symlink — to a location inside the owned root. A path that does
 * not exist is checked at its deepest existing ancestor, so a dangling
 * registration cannot be parked outside the root either.
 */
export function assertOwnedPath(candidate, ownedRoot) {
  if (typeof candidate !== "string" || candidate.length === 0) {
    throw new TeardownError("UNOWNED_PATH", {
      candidate,
      detail: "empty path can never be proven owned",
    });
  }
  const root = realpathSync(ownedRoot);
  let probe = path.resolve(candidate);
  // Walk up to the deepest EXISTING ancestor so realpath cannot throw and a
  // dangling path cannot dodge the containment check.
  let suffix = [];
  while (!existsSync(probe)) {
    suffix.unshift(path.basename(probe));
    const parent = path.dirname(probe);
    if (parent === probe) break;
    probe = parent;
  }
  const real = path.join(realpathSync(probe), ...suffix);
  if (real !== root && !real.startsWith(root + path.sep)) {
    throw new TeardownError("UNOWNED_PATH", {
      candidate,
      resolved: real,
      owned_root: root,
    });
  }
  return real;
}

/**
 * Remove an owned directory tree. `rmSync` removes symlinks themselves and
 * never follows them, so a link inside the owned root cannot delete content
 * outside it; the containment proof above stops the registered path itself
 * from escaping.
 */
export function safeRemoveOwned(candidate, ownedRoot) {
  const real = assertOwnedPath(candidate, ownedRoot);
  rmSync(real, { recursive: true, force: true });
  return real;
}

/** Is `pid` alive (still known to the kernel)? Signal 0 probes only. */
export function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM"; // alive but not ours — treat as alive
  }
}

/**
 * Ownership proof for a pid we no longer hold a handle for: the live process
 * table must show this run's marker in the process environment. `ps -wwE`
 * prints the environment of same-user processes on darwin; a pid whose
 * environment cannot be read is AMBIGUOUS and is never killed.
 */
export function verifyPidOwnership(pid, runId) {
  if (!pidAlive(pid)) return { alive: false, owned: false, detail: "dead" };
  // procps-ng has no `-E`; on linux the same-user environment is
  // /proc/<pid>/environ (unreadable stays AMBIGUOUS, never killed) — DEF-074.
  if (process.platform === "linux") {
    const entries = readProcEnviron(pid);
    if (entries === null) {
      return { alive: true, owned: false, detail: "env unreadable: AMBIGUOUS" };
    }
    const owned = entries.includes(`${OWNER_MARKER}=${runId}`);
    return {
      alive: true,
      owned,
      detail: owned ? "marker verified" : "marker absent",
    };
  }
  let commandLine;
  try {
    commandLine = execFileSync(
      "ps",
      ["-wwE", "-o", "command=", "-p", String(pid)],
      { encoding: "utf8" }
    );
  } catch {
    return { alive: true, owned: false, detail: "env unreadable: AMBIGUOUS" };
  }
  const owned = commandLine.includes(`${OWNER_MARKER}=${runId}`);
  return {
    alive: true,
    owned,
    detail: owned ? "marker verified" : "marker absent",
  };
}

function readProcEnviron(pid) {
  try {
    return readFileSync(`/proc/${pid}/environ`, "utf8").split("\0");
  } catch {
    return null;
  }
}

/**
 * Discover live processes carrying this run's marker. DETECTION may scan the
 * process table; DESTRUCTION still re-verifies each candidate individually.
 */
export function findMarkedProcesses(runId) {
  if (process.platform === "linux") {
    const marker = `${OWNER_MARKER}=${runId}`;
    const found = [];
    let pids = [];
    try {
      pids = readdirSync("/proc").filter(name => /^\d+$/.test(name));
    } catch {
      return [];
    }
    for (const name of pids) {
      const pid = Number(name);
      if (pid === process.pid) continue;
      const entries = readProcEnviron(pid);
      if (entries === null || !entries.includes(marker)) continue;
      const gate = entries.find(e => e.startsWith(`${GATE_MARKER}=`));
      found.push({ pid, gate_id: gate ? gate.split("=")[1] : null });
    }
    return found;
  }
  let table;
  try {
    table = execFileSync("ps", ["-axwwE", "-o", "pid=,command="], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch {
    return [];
  }
  const marker = `${OWNER_MARKER}=${runId}`;
  const found = [];
  for (const line of table.split("\n")) {
    if (!line.includes(marker)) continue;
    const match = line.match(/^\s*(\d+)\s+(.*)$/);
    if (!match) continue;
    const pid = Number(match[1]);
    if (pid === process.pid) continue;
    const gate = match[2].match(new RegExp(`${GATE_MARKER}=(\\S+)`));
    found.push({ pid, gate_id: gate ? gate[1] : null });
  }
  return found;
}

/**
 * Kill a pid ONLY after fresh ownership verification. SIGTERM, bounded grace,
 * then SIGKILL. Returns the structured outcome; never throws on a dead pid.
 */
export async function killVerifiedOwned(pid, runId, options = {}) {
  const graceMs = options.grace_ms ?? 500;
  const proof = verifyPidOwnership(pid, runId);
  if (!proof.alive) return { pid, action: "already-dead", proof };
  if (!proof.owned) {
    return { pid, action: "REFUSED_UNOWNED", proof };
  }
  const sequence = [];
  try {
    process.kill(pid, "SIGTERM");
    sequence.push("SIGTERM");
  } catch {
    return { pid, action: "already-dead", proof, signal_sequence: sequence };
  }
  const deadline = process.hrtime.bigint() + BigInt(graceMs) * 1_000_000n;
  while (pidAlive(pid) && process.hrtime.bigint() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  if (pidAlive(pid)) {
    try {
      process.kill(pid, "SIGKILL");
      sequence.push("SIGKILL");
    } catch {
      /* died between the probe and the kill — that is the goal state */
    }
    while (pidAlive(pid)) {
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  }
  return { pid, action: "killed", proof, signal_sequence: sequence };
}

let TOKEN_SEQ = 0;

/**
 * The registry. Owned resources are registered at creation time; teardown
 * executes newest-first, is idempotent per resource, and records an outcome
 * for every entry. A cleanup failure is VISIBLE — it can fail a green gate,
 * never the other way round.
 */
export class TeardownRegistry {
  constructor(options) {
    if (!options?.run_id) throw new TeardownError("RUN_ID_REQUIRED", {});
    if (!options?.owned_root)
      throw new TeardownError("OWNED_ROOT_REQUIRED", {});
    this.run_id = options.run_id;
    this.owned_root = options.owned_root;
    this.resources = [];
    this.completed = false;
    this.signal_handlers = null;
  }

  /**
   * Register an owned resource. `cleanup` is an async callback; it may only
   * destroy what the accompanying proof covers. A malformed record is refused
   * here — registration is the last moment a bad record is cheap.
   */
  register(record) {
    if (!RESOURCE_TYPES.includes(record?.type)) {
      throw new TeardownError("UNKNOWN_RESOURCE_TYPE", { type: record?.type });
    }
    if (typeof record?.id !== "string" || record.id.length === 0) {
      throw new TeardownError("RESOURCE_ID_REQUIRED", { type: record.type });
    }
    if (typeof record?.cleanup !== "function") {
      throw new TeardownError("CLEANUP_CALLBACK_REQUIRED", {
        type: record.type,
        id: record.id,
      });
    }
    // Path-bearing resources must prove containment AT REGISTRATION, so a
    // traversal or symlink escape is refused before anything exists to clean.
    if (record.type === "temp_dir" || record.type === "scratch_artifact") {
      assertOwnedPath(record.path ?? record.id, this.owned_root);
    }
    const entry = {
      token: `td-${this.run_id}-${(TOKEN_SEQ += 1)}`,
      type: record.type,
      id: record.id,
      owner_run_id: this.run_id,
      owner_gate_id: record.gate_id ?? null,
      created_at: new Date().toISOString(),
      evidence: record.evidence ?? null,
      cleanup: record.cleanup,
      status: "REGISTERED",
      cleanup_error: null,
      cleaned_at: null,
    };
    this.resources.push(entry);
    return entry.token;
  }

  /** Mark a resource cleaned by its normal-path owner (e.g. lane release). */
  markCleaned(token) {
    const entry = this.resources.find(item => item.token === token);
    if (!entry) throw new TeardownError("UNKNOWN_TOKEN", { token });
    if (entry.status === "REGISTERED") {
      entry.status = "CLEANED";
      entry.cleaned_at = new Date().toISOString();
    }
  }

  /**
   * Run every outstanding cleanup, newest-first. Idempotent: a resource is
   * cleaned at most once; a second sweep is a recorded no-op. Failures are
   * captured per-resource and NEVER abort the sweep — every remaining owned
   * resource still gets its cleanup attempt.
   */
  async runAll(reason) {
    const report = {
      reason,
      run_id: this.run_id,
      started_at: new Date().toISOString(),
      outcomes: [],
      failures: [],
    };
    for (const entry of [...this.resources].reverse()) {
      if (entry.status !== "REGISTERED") {
        report.outcomes.push({
          token: entry.token,
          type: entry.type,
          id: entry.id,
          status: entry.status,
          note: "already settled; idempotent no-op",
        });
        continue;
      }
      try {
        await entry.cleanup();
        entry.status = "CLEANED";
        entry.cleaned_at = new Date().toISOString();
      } catch (error) {
        entry.status = "FAILED";
        entry.cleanup_error = error.reason ?? error.message;
        report.failures.push({
          token: entry.token,
          type: entry.type,
          id: entry.id,
          error: entry.cleanup_error,
        });
      }
      report.outcomes.push({
        token: entry.token,
        type: entry.type,
        id: entry.id,
        status: entry.status,
      });
    }
    report.completed_at = new Date().toISOString();
    report.clean = report.failures.length === 0;
    this.completed = true;
    return report;
  }

  /** Outstanding (still REGISTERED) resources — residue if the run is over. */
  residue() {
    return this.resources
      .filter(entry => entry.status === "REGISTERED")
      .map(entry => ({ token: entry.token, type: entry.type, id: entry.id }));
  }

  /**
   * Wire SIGINT/SIGTERM/uncaughtException to teardown-then-exit-nonzero.
   * SIGKILL is uncatchable BY DEFINITION — in-process teardown cannot run and
   * this module never claims otherwise; the next invocation's stale-resource
   * discovery (lane.mjs `discoverStale`, `findMarkedProcesses`) is the
   * recovery boundary for that case.
   */
  wireSignals(onReport, onSignalStart) {
    if (this.signal_handlers) return;
    const handler = signal => {
      // The latch runs SYNCHRONOUSLY, before any await: the owner must know
      // it is interrupted BEFORE teardown yields the event loop, or the main
      // flow can race ahead and publish a completed-looking record (DEF-021).
      if (onSignalStart) onSignalStart(signal);
      this.runAll(`signal:${signal}`)
        .then(report => {
          if (onReport) onReport(signal, report);
          process.exit(signal === "SIGINT" ? 130 : 143);
        })
        .catch(() => process.exit(70));
    };
    const onException = error => {
      if (onSignalStart) onSignalStart("uncaughtException");
      this.runAll("uncaughtException")
        .then(report => {
          if (onReport) onReport("uncaughtException", report);
          console.error(error?.stack ?? String(error));
          process.exit(70);
        })
        .catch(() => process.exit(70));
    };
    process.on("SIGINT", handler);
    process.on("SIGTERM", handler);
    process.on("uncaughtException", onException);
    this.signal_handlers = { handler, onException };
  }

  unwireSignals() {
    if (!this.signal_handlers) return;
    process.removeListener("SIGINT", this.signal_handlers.handler);
    process.removeListener("SIGTERM", this.signal_handlers.handler);
    process.removeListener(
      "uncaughtException",
      this.signal_handlers.onException
    );
    this.signal_handlers = null;
  }
}

/**
 * Structured ownership map for P04.AUD01: every destructive mechanism this
 * module exposes, what proves ownership, and how failure behaves. The audit
 * compares this DECLARED surface against the implemented one.
 */
export const OWNERSHIP_SURFACE = [
  {
    operation: "safeRemoveOwned",
    resource_types: ["temp_dir", "scratch_artifact", "worktree"],
    ownership_proof: "realpath containment inside the run's owned_root",
    failure_behavior: "throws UNOWNED_PATH; nothing is deleted",
  },
  {
    operation: "ChildProcess handle kill (proc.mjs)",
    resource_types: ["process", "process_group"],
    ownership_proof: "live handle from our own spawn() call",
    failure_behavior: "ESRCH tolerated; group kill only on detached children",
  },
  {
    operation: "killVerifiedOwned",
    resource_types: ["process"],
    ownership_proof: `fresh ${OWNER_MARKER}=<run_id> marker in live process env`,
    failure_behavior: "REFUSED_UNOWNED recorded; unverifiable pid never killed",
  },
  {
    operation: "lane release (lane.mjs)",
    resource_types: ["lane_lock"],
    ownership_proof: "owner.json run_id + acquisition_id match",
    failure_behavior: "UNAUTHORIZED_RELEASE thrown; lock left intact",
  },
  {
    operation: "port release (environment.mjs)",
    resource_types: ["port"],
    ownership_proof: "live net.Server handle from our own listen()",
    failure_behavior: "close() on our handle only; no pid/port scanning",
  },
];
