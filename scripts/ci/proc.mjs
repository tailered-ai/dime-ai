#!/usr/bin/env node
/**
 * proc.mjs — P04.T06 (timeout lifecycle) + the strict process-execution
 * rules (§12): the ONLY module that spawns gate child processes.
 *
 * Correctness rules enforced here:
 *   - direct argv spawn by default (`shell: false`); shell semantics are
 *     OPT-IN per contract command and run under GitHub Actions' exact
 *     default shell (`bash --noprofile --norc -eo pipefail`), so a failing
 *     producer in a pipeline keeps its non-zero status — the DEF-007 class
 *     (false PASS from a piped `$?`) is structurally impossible;
 *   - the exit code comes from the child's own `exit` event, never from
 *     textual output, never through a wrapper pipeline;
 *   - stdout and stderr are captured to SEPARATE files;
 *   - timeout is measured on the MONOTONIC clock and latches: once the
 *     deadline fires the attempt is TIMEOUT even if the process then exits 0
 *     during termination;
 *   - SIGTERM -> bounded grace -> SIGKILL, against the child's own process
 *     GROUP (detached spawn), and the sequence is recorded;
 *   - spawn failure is infrastructure, not product failure: ENOENT maps to
 *     MISSING_EXECUTABLE (frozen: BLOCKED), anything else to SPAWN_FAILURE
 *     (frozen: INFRA_FAIL).
 */
import { spawn } from "node:child_process";
import { createWriteStream, mkdirSync } from "node:fs";
import path from "node:path";
import { pidAlive } from "./teardown.mjs";

export class ProcError extends Error {
  constructor(reason, detail = {}) {
    super(reason);
    this.name = "ProcError";
    this.reason = reason;
    Object.assign(this, detail);
  }
}

/** GitHub Actions' default shell for `run:` steps — exact flags. */
export const GHA_DEFAULT_SHELL = [
  "/bin/bash",
  "--noprofile",
  "--norc",
  "-e",
  "-o",
  "pipefail",
  "-c",
];

/**
 * Resolve a command spec to an argv. Two legal shapes, both explicit:
 *   { argv: ["node", "x.mjs"] }       direct spawn, no shell anywhere
 *   { shell: "false | tee out.txt" }  contract shell text, GHA semantics
 */
export function resolveCommand(command) {
  if (command?.argv && command?.shell) {
    throw new ProcError("AMBIGUOUS_COMMAND", { command });
  }
  if (Array.isArray(command?.argv) && command.argv.length > 0) {
    return {
      argv: command.argv,
      shell_mode: "none",
      display: command.argv.join(" "),
    };
  }
  if (typeof command?.shell === "string" && command.shell.length > 0) {
    return {
      argv: [...GHA_DEFAULT_SHELL, command.shell],
      shell_mode: "gha-default",
      display: command.shell,
    };
  }
  throw new ProcError("EMPTY_COMMAND", { command });
}

function monotonicMs() {
  return Number(process.hrtime.bigint() / 1_000_000n);
}

function killGroup(pid, signal) {
  try {
    process.kill(-pid, signal); // negative pid: the whole process group
    return true;
  } catch {
    try {
      process.kill(pid, signal); // group already gone; try the leader
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * Run one attempt. Returns a structured attempt record — it NEVER throws for
 * a failing child; only for caller-contract violations (bad spec).
 *
 * options: { env, cwd, timeout_ms, grace_ms, stdout_path, stderr_path,
 *            registry?, gate_id?, onSpawn? }
 */
export function runCommand(command, options) {
  const resolved = resolveCommand(command);
  const {
    env,
    cwd,
    timeout_ms = 60_000,
    grace_ms = 1_500,
    stdout_path,
    stderr_path,
    registry = null,
    gate_id = null,
    onSpawn = null,
  } = options;
  if (!env) throw new ProcError("ENV_REQUIRED", { gate_id });
  if (!cwd) {
    // Never default to the mutable developer working directory.
    throw new ProcError("CWD_REQUIRED", { gate_id });
  }
  if (!stdout_path || !stderr_path) {
    throw new ProcError("CAPTURE_PATHS_REQUIRED", { gate_id });
  }
  mkdirSync(path.dirname(stdout_path), { recursive: true });

  return new Promise(resolve => {
    const startedAt = new Date().toISOString();
    const startMono = monotonicMs();
    const record = {
      gate_id,
      command: resolved.display,
      shell_mode: resolved.shell_mode,
      argv: resolved.argv,
      cwd,
      started_at: startedAt,
      ended_at: null,
      duration_ms: null,
      pid: null,
      exit_code: null,
      signal: null,
      timed_out: false,
      timeout_ms,
      grace_ms,
      signal_sequence: [],
      spawn_error: null,
      stdout_path,
      stderr_path,
    };

    let child;
    try {
      child = spawn(resolved.argv[0], resolved.argv.slice(1), {
        cwd,
        env,
        detached: true, // own process group => group-wide termination
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      record.spawn_error =
        error.code === "ENOENT" ? "MISSING_EXECUTABLE" : "SPAWN_FAILURE";
      record.ended_at = new Date().toISOString();
      record.duration_ms = monotonicMs() - startMono;
      resolve(record);
      return;
    }
    record.pid = child.pid ?? null;
    if (onSpawn && child.pid) onSpawn(child.pid);

    const out = createWriteStream(stdout_path);
    const err = createWriteStream(stderr_path);
    child.stdout.pipe(out);
    child.stderr.pipe(err);

    let token = null;
    if (registry && child.pid) {
      token = registry.register({
        type: "process_group",
        id: `pgid-${child.pid}`,
        gate_id,
        evidence: `${resolved.display} (pid ${child.pid})`,
        cleanup: async () => {
          if (!pidAlive(child.pid)) return;
          killGroup(child.pid, "SIGTERM");
          const deadline = monotonicMs() + grace_ms;
          while (pidAlive(child.pid) && monotonicMs() < deadline) {
            await new Promise(r => setTimeout(r, 25));
          }
          if (pidAlive(child.pid)) killGroup(child.pid, "SIGKILL");
        },
      });
    }

    let settled = false;
    let killTimer = null;
    const timer = setTimeout(() => {
      // The deadline LATCHES the outcome. Whatever the process does after
      // this instant — including exiting 0 — the attempt is TIMEOUT.
      record.timed_out = true;
      record.deadline_elapsed_ms = monotonicMs() - startMono;
      killGroup(child.pid, "SIGTERM");
      record.signal_sequence.push("SIGTERM");
      killTimer = setTimeout(() => {
        if (!settled && pidAlive(child.pid)) {
          killGroup(child.pid, "SIGKILL");
          record.signal_sequence.push("SIGKILL");
        }
      }, grace_ms);
    }, timeout_ms);

    child.on("error", error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      record.spawn_error =
        error.code === "ENOENT" ? "MISSING_EXECUTABLE" : "SPAWN_FAILURE";
      record.spawn_error_detail = error.message;
      record.ended_at = new Date().toISOString();
      record.duration_ms = monotonicMs() - startMono;
      if (token && registry) registry.markCleaned(token);
      resolve(record);
    });

    child.on("exit", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      record.exit_code = code; // the producer's ACTUAL exit status — direct
      record.signal = signal;
      record.ended_at = new Date().toISOString();
      record.duration_ms = monotonicMs() - startMono;
      // The child itself is reaped by this event; group stragglers (orphaned
      // grandchildren) stay the teardown registry's responsibility.
      if (token && registry && signal !== null) {
        // killed => group cleanup already ran or will run via registry sweep
      } else if (token && registry) {
        registry.markCleaned(token);
      }
      out.end();
      err.end();
      resolve(record);
    });
  });
}

/**
 * Map one attempt record to the frozen gate-result status contribution.
 * TIMEOUT is TIMEOUT — never flattened to FAIL. Spawn failures are
 * infrastructure, never product FAIL.
 */
export function attemptStatus(record) {
  if (record.spawn_error === "MISSING_EXECUTABLE") {
    return {
      status: "BLOCKED",
      reason: `MISSING_EXECUTABLE: ${record.argv?.[0] ?? "(unknown)"}`,
    };
  }
  if (record.spawn_error) {
    return {
      status: "INFRA_FAIL",
      reason: `SPAWN_FAILURE: ${record.spawn_error_detail ?? "spawn failed"}`,
    };
  }
  if (record.timed_out) {
    return {
      status: "TIMEOUT",
      reason:
        `deadline ${record.timeout_ms}ms elapsed (monotonic); ` +
        `signals: ${record.signal_sequence.join("->") || "none"}`,
    };
  }
  if (record.signal) {
    return {
      status: "INFRA_FAIL",
      reason: `TERMINATED_BY_SIGNAL: ${record.signal}`,
    };
  }
  if (record.exit_code === 0) return { status: "PASS", reason: null };
  return {
    status: "FAIL",
    reason: `EXIT_${record.exit_code}`,
  };
}
