#!/usr/bin/env node
/**
 * executor.mjs — P04.T08 (attempts + flake recording) and P04.T09 (canonical
 * executor evidence), orchestrating scheduler, lanes, environment, process
 * runner, and teardown into ONE execution engine.
 *
 * Truthfulness architecture:
 *   - every gate result is built by P03 `makeResult` and validated before it
 *     exists anywhere — there is NO second taxonomy (P04.AUD03);
 *   - `executor.jsonl` is an append-only event stream; the FINAL results are
 *     written to `results.jsonl` via P03's JsonlReporter in DETERMINISTIC
 *     graph order after the run settles, so parallel completion order can
 *     never reorder the record;
 *   - `manifest.json` is written LAST (write-then-rename) with hashes of
 *     both streams. `readExecutorEvidence` refuses a run without a complete
 *     manifest or with a hash mismatch — an interrupted or tampered run is
 *     structurally unable to summarize green;
 *   - a retry that eventually passes is FLAKY (P03 `classifyAttempts`);
 *     prior attempt records are never overwritten;
 *   - condition overrides never DOWNGRADE severity, only upgrade it, and the
 *     functional outcome they overrode is preserved in the result reason and
 *     event stream.
 */
import { randomBytes, createHash } from "node:crypto";
import {
  appendFileSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import path from "node:path";
import { classifyAttempts, makeResult } from "./result.mjs";
import { JsonlReporter, readResults, summarize } from "./reporter.mjs";
import { buildGraph, makeBudget, runGraph } from "./scheduler.mjs";
import { LaneManager } from "./lane.mjs";
import {
  allocateOwnedPort,
  buildEnvironment,
  detectNetworkEnforcement,
  makeGateTmpdir,
  networkVerdict,
} from "./environment.mjs";
import { attemptStatus, runCommand } from "./proc.mjs";
import {
  TeardownRegistry,
  findMarkedProcesses,
  killVerifiedOwned,
  safeRemoveOwned,
} from "./teardown.mjs";

export const EXECUTOR_SCHEMA_VERSION = "1.0.0";

export class ExecutorError extends Error {
  constructor(reason, detail = {}) {
    super(reason);
    this.name = "ExecutorError";
    this.reason = reason;
    Object.assign(this, detail);
  }
}

/** Statuses that must NEVER be retried in pursuit of green. */
export const NEVER_RETRY = new Set([
  "BLOCKED",
  "INFRA_FAIL",
  "CONTRACT_DRIFT",
  "BROKEN_GATE",
  "INCONCLUSIVE",
  "TIMEOUT",
]);
export const RETRYABLE = new Set(["FAIL"]);

const sha256 = buf => createHash("sha256").update(buf).digest("hex");

/**
 * Refuse a stale candidate: the provenance link must name the revision that
 * is actually checked out. A mismatch is CONTRACT_DRIFT-class and blocks the
 * whole run before any gate starts.
 */
export function verifyCandidateBinding(candidate) {
  for (const field of ["head_sha", "base_sha", "merge_tree_sha"]) {
    if (!candidate?.[field]) {
      throw new ExecutorError("CANDIDATE_INCOMPLETE", { missing: field });
    }
  }
  return true;
}

/** Deterministic-ish unique run id: timestamp + pid + strong nonce. */
export function mintRunId(now = new Date()) {
  return `${now.toISOString().replace(/[:.]/g, "-")}-${process.pid}-${randomBytes(6).toString("hex")}`;
}

function hashWalk(dir) {
  const files = [];
  const walk = current => {
    const entries = readdirSync(current, { withFileTypes: true }).sort(
      (a, b) => (a.name < b.name ? -1 : 1)
    );
    for (const entry of entries) {
      const abs = path.join(current, entry.name);
      if (entry.isDirectory()) walk(abs);
      else {
        let bytes;
        try {
          bytes = readFileSync(abs);
        } catch {
          continue; // vanished between listing and read
        }
        files.push(`${path.relative(dir, abs)} ${sha256(bytes)}`);
      }
    }
  };
  walk(dir);
  return sha256(files.join("\n"));
}

export class ExecutorRun {
  constructor(options) {
    const {
      specs,
      candidate,
      budget = {},
      runsRoot,
      lanesRoot,
      bindHeadSha = null,
      networkDefault = "allow",
      enforcementProbe = detectNetworkEnforcement,
      declared = null,
      onEvent = null,
    } = options;
    if (!Array.isArray(specs) || specs.length === 0) {
      throw new ExecutorError("NO_GATES", {});
    }
    if (!candidate) throw new ExecutorError("CANDIDATE_REQUIRED", {});
    verifyCandidateBinding(candidate);
    if (bindHeadSha && candidate.head_sha !== bindHeadSha) {
      // Stale provenance is refused up front, not "accepted with a note".
      throw new ExecutorError("CANDIDATE_STALE", {
        candidate_head: candidate.head_sha,
        actual_head: bindHeadSha,
      });
    }
    if (!runsRoot) throw new ExecutorError("RUNS_ROOT_REQUIRED", {});
    if (!lanesRoot) throw new ExecutorError("LANES_ROOT_REQUIRED", {});

    this.run_id = mintRunId();
    this.candidate = candidate;
    this.specs = specs;
    this.graph = buildGraph(specs); // validates BEFORE any resource exists
    this.budget = makeBudget(budget);
    this.networkDefault = networkDefault;
    this.enforcement = enforcementProbe();
    this.declared = declared;
    this.onEvent = onEvent;

    this.runDir = path.join(runsRoot, this.run_id);
    this.evidenceDir = path.join(this.runDir, "evidence");
    this.gatesDir = path.join(this.evidenceDir, "gates");
    mkdirSync(this.gatesDir, { recursive: true });
    this.executorLog = path.join(this.evidenceDir, "executor.jsonl");
    this.resultsLog = path.join(this.evidenceDir, "results.jsonl");
    this.manifestPath = path.join(this.evidenceDir, "manifest.json");
    writeFileSync(this.executorLog, "");

    this.registry = new TeardownRegistry({
      run_id: this.run_id,
      owned_root: this.runDir,
    });
    this.lanes = new LaneManager({ root: lanesRoot, run_id: this.run_id });
    this.seq = 0;
    this.interrupted = false;

    this.registry.register({
      type: "scratch_artifact",
      id: path.join(this.runDir, "tmp"),
      path: path.join(this.runDir, "tmp"),
      evidence: "run-scoped temp root",
      cleanup: async () => {
        if (existsSync(path.join(this.runDir, "tmp"))) {
          safeRemoveOwned(path.join(this.runDir, "tmp"), this.runDir);
        }
      },
    });
  }

  event(type, payload = {}) {
    const record = {
      executor_schema_version: EXECUTOR_SCHEMA_VERSION,
      run_id: this.run_id,
      seq: (this.seq += 1),
      at: new Date().toISOString(),
      type,
      ...payload,
    };
    appendFileSync(this.executorLog, `${JSON.stringify(record)}\n`);
    if (this.onEvent) this.onEvent(record);
    return record;
  }

  /** Upgrade-only status override chain. Never downgrades severity. */
  static overrideStatus(current, override) {
    const rank = {
      PASS: 0,
      FLAKY: 1,
      FAIL: 2,
      INCONCLUSIVE: 3,
      TIMEOUT: 3,
      BLOCKED: 3,
      INFRA_FAIL: 4,
      CONTRACT_DRIFT: 5,
      BROKEN_GATE: 6,
    };
    return (rank[override.status] ?? 0) > (rank[current.status] ?? 0)
      ? override
      : current;
  }

  async runGate(spec) {
    const gateId = spec.gate_id;
    const gateDir = path.join(
      this.gatesDir,
      gateId.replace(/[^A-Za-z0-9._-]/g, "_")
    );
    mkdirSync(gateDir, { recursive: true });
    const startedAt = new Date().toISOString();
    this.event("GATE_START", { gate_id: gateId });

    // --- environment ------------------------------------------------------
    const tmpdir = makeGateTmpdir(this.runDir, gateId);
    const tmpToken = this.registry.register({
      type: "temp_dir",
      id: tmpdir,
      path: tmpdir,
      gate_id: gateId,
      evidence: "gate-isolated TMPDIR",
      cleanup: async () => {
        if (existsSync(tmpdir)) safeRemoveOwned(tmpdir, this.runDir);
      },
    });
    let portHandle = null;
    let portToken = null;
    if (spec.needs_port) {
      portHandle = await allocateOwnedPort();
      portToken = this.registry.register({
        type: "port",
        id: `port-${portHandle.port}`,
        gate_id: gateId,
        evidence: `127.0.0.1:${portHandle.port} reservation held`,
        cleanup: async () => portHandle.release(),
      });
    }
    const { env, profile } = buildEnvironment({
      run_id: this.run_id,
      gate_id: gateId,
      tmpdir,
      seed: spec.seed,
      node_options: spec.node_options ?? null,
      gate_env: {
        ...(spec.env ?? {}),
        ...(portHandle ? { CI_VERIFY_PORT: String(portHandle.port) } : {}),
      },
      env_remove: spec.env_remove ?? [],
      secret_ci_only: spec.secret_ci_only ?? [],
    });
    this.event("ENV_PROFILE", {
      gate_id: gateId,
      profile_id: profile.profile_id,
      tmpdir,
      port: portHandle?.port ?? null,
      dropped_host_variables: profile.dropped_host_variables,
    });

    // --- network policy ---------------------------------------------------
    const policy =
      (spec.network ?? "inherit") === "inherit"
        ? this.networkDefault
        : spec.network;
    const verdict = networkVerdict(policy, this.enforcement);
    this.event("NETWORK", {
      gate_id: gateId,
      policy,
      hermetic: verdict.hermetic,
      downgrade: verdict.downgrade?.status ?? null,
    });

    // --- optional cwd integrity baseline ----------------------------------
    const cwd = spec.cwd;
    if (!cwd) throw new ExecutorError("GATE_CWD_REQUIRED", { gate_id: gateId });
    const integrityBefore = spec.integrity_check_cwd ? hashWalk(cwd) : null;

    // --- lane -------------------------------------------------------------
    let acquisition = null;
    let laneToken = null;
    if (spec.lane) {
      acquisition = await this.lanes.acquire(spec.lane, gateId);
      laneToken = this.registry.register({
        type: "lane_lock",
        id: `${spec.lane}:${acquisition.acquisition_id}`,
        gate_id: gateId,
        evidence: `lane ${spec.lane} acquired ${acquisition.entered_at}`,
        cleanup: async () => {
          if (acquisition.release_state === "HELD") {
            this.lanes.release(acquisition);
          }
        },
      });
      this.event("LANE", {
        gate_id: gateId,
        lane: spec.lane,
        acquisition_id: acquisition.acquisition_id,
        entered_at: acquisition.entered_at,
      });
    }

    // --- attempts ---------------------------------------------------------
    const attempts = [];
    const maxAttempts = spec.max_attempts ?? 1;
    let functional = null;
    try {
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        const record = await runCommand(spec.command, {
          env,
          cwd,
          timeout_ms: spec.timeout_ms ?? 60_000,
          grace_ms: spec.grace_ms ?? 1_500,
          stdout_path: path.join(gateDir, `attempt-${attempt}.stdout`),
          stderr_path: path.join(gateDir, `attempt-${attempt}.stderr`),
          registry: this.registry,
          gate_id: gateId,
          onSpawn: pid =>
            this.event("ATTEMPT_SPAWNED", { gate_id: gateId, attempt, pid }),
        });
        const classified = attemptStatus(record);
        const attemptEntry = {
          attempt,
          status: classified.status,
          reason: classified.reason,
          duration_ms: record.duration_ms,
          exit_code: record.exit_code,
          signal: record.signal,
          timed_out: record.timed_out,
          pid: record.pid,
          shell_mode: record.shell_mode,
          signal_sequence: record.signal_sequence,
          stdout_path: record.stdout_path,
          stderr_path: record.stderr_path,
          started_at: record.started_at,
          ended_at: record.ended_at,
        };
        attempts.push(attemptEntry);
        this.event("ATTEMPT", { gate_id: gateId, ...attemptEntry });
        if (classified.status === "PASS") break;
        if (NEVER_RETRY.has(classified.status)) break;
        if (!RETRYABLE.has(classified.status)) break;
      }
      functional = classifyAttempts(attempts);
      if (!functional.reason && functional.status !== "PASS") {
        // classifyAttempts only synthesizes a reason for FLAKY; a non-green
        // single-attempt outcome keeps its own attempt reason (EXIT_n,
        // MISSING_EXECUTABLE, deadline text, ...). P03 refuses a reasonless
        // non-green result — rightly — so the causal reason travels here.
        functional = {
          ...functional,
          reason: attempts.at(-1)?.reason ?? `status ${functional.status}`,
        };
      }
    } finally {
      // --- lane release (normal path) ------------------------------------
      if (acquisition && acquisition.release_state === "HELD") {
        this.lanes.release(acquisition);
        this.registry.markCleaned(laneToken);
        this.event("LANE", {
          gate_id: gateId,
          lane: spec.lane,
          acquisition_id: acquisition.acquisition_id,
          exited_at: acquisition.exited_at,
          release_state: acquisition.release_state,
        });
      }
    }

    let verdictChain = {
      status: functional.status,
      reason: functional.reason,
    };
    const overrides = [];

    // --- network downgrade -----------------------------------------------
    if (verdict.downgrade) {
      const next = ExecutorRun.overrideStatus(verdictChain, {
        status: verdict.downgrade.status,
        reason: verdict.downgrade.reason,
      });
      if (next !== verdictChain) {
        overrides.push({
          kind: "NETWORK_DENY_UNENFORCED",
          from: verdictChain.status,
          to: next.status,
        });
        verdictChain = next;
      }
    }

    // --- owned-orphan detection ------------------------------------------
    const leaked = findMarkedProcesses(this.run_id).filter(
      item => item.gate_id === gateId
    );
    if (leaked.length > 0) {
      const reaped = [];
      for (const orphan of leaked) {
        reaped.push(await killVerifiedOwned(orphan.pid, this.run_id));
      }
      this.event("LEAK", { gate_id: gateId, leaked, reaped });
      const next = ExecutorRun.overrideStatus(verdictChain, {
        status: "INFRA_FAIL",
        reason:
          `OWNED_RESOURCE_LEAK: ${leaked.length} owned process(es) survived ` +
          `the gate (pids ${leaked.map(l => l.pid).join(",")}); reaped by ` +
          `the executor; functional outcome was ${functional.status}`,
      });
      if (next !== verdictChain) {
        overrides.push({
          kind: "OWNED_RESOURCE_LEAK",
          from: verdictChain.status,
          to: next.status,
        });
        verdictChain = next;
      }
    }

    // --- candidate-mutation detection ------------------------------------
    if (spec.integrity_check_cwd) {
      const integrityAfter = hashWalk(cwd);
      if (integrityAfter !== integrityBefore) {
        this.event("INTEGRITY", {
          gate_id: gateId,
          before: integrityBefore,
          after: integrityAfter,
        });
        const next = ExecutorRun.overrideStatus(verdictChain, {
          status: "INFRA_FAIL",
          reason:
            `CANDIDATE_MUTATION: execution cwd changed during the gate ` +
            `(functional outcome was ${functional.status})`,
        });
        if (next !== verdictChain) {
          overrides.push({
            kind: "CANDIDATE_MUTATION",
            from: verdictChain.status,
            to: next.status,
          });
          verdictChain = next;
        }
      }
    }

    // --- owned cleanup for this gate --------------------------------------
    let cleanupFailed = null;
    try {
      if (existsSync(tmpdir)) safeRemoveOwned(tmpdir, this.runDir);
      this.registry.markCleaned(tmpToken);
      if (portHandle) {
        await portHandle.release();
        this.registry.markCleaned(portToken);
      }
    } catch (error) {
      cleanupFailed = error.reason ?? error.message;
      this.event("CLEANUP_FAILED", { gate_id: gateId, error: cleanupFailed });
      const next = ExecutorRun.overrideStatus(verdictChain, {
        status: "INFRA_FAIL",
        reason: `CLEANUP_FAILED: ${cleanupFailed} (functional outcome was ${functional.status})`,
      });
      if (next !== verdictChain) {
        overrides.push({
          kind: "CLEANUP_FAILED",
          from: verdictChain.status,
          to: next.status,
        });
        verdictChain = next;
      }
    }

    const last = attempts.at(-1) ?? {};
    const result = makeResult({
      gate_id: gateId,
      class: spec.class,
      status: verdictChain.status,
      mandatory: spec.mandatory !== false,
      attempts,
      duration_ms: attempts.reduce((sum, a) => sum + (a.duration_ms ?? 0), 0),
      exit_code:
        verdictChain.status === "PASS" ? (last.exit_code ?? null) : null,
      evidence_path: gateDir,
      reason: verdictChain.reason,
      started_at: startedAt,
      completed_at: new Date().toISOString(),
      contract_check_id: spec.contract_check_id ?? null,
      runnability: spec.runnability ?? null,
    });
    this.event("GATE_RESULT", {
      gate_id: gateId,
      status: result.status,
      reason: result.reason,
      overrides,
      functional_status: functional.status,
      functional_exit_code: last.exit_code ?? null,
      cleanup_failed: cleanupFailed,
      env_profile_id: profile.profile_id,
      hermetic: verdict.hermetic,
      network_policy: policy,
      lane: spec.lane ?? null,
      lane_interval: acquisition
        ? {
            acquisition_id: acquisition.acquisition_id,
            entered_at: acquisition.entered_at,
            exited_at: acquisition.exited_at,
            release_state: acquisition.release_state,
          }
        : null,
    });
    return result;
  }

  async execute() {
    this.registry.wireSignals(
      (signal, report) => {
        this.event("INTERRUPTED", {
          signal,
          teardown_clean: report.clean,
          failures: report.failures,
        });
      },
      signal => {
        // DEF-021: latch SYNCHRONOUSLY at signal entry. Every completion
        // write below checks this flag, so the still-draining main flow can
        // never publish a completed-looking record for an interrupted run.
        this.interrupted = true;
        this.event("INTERRUPT_SIGNAL", { signal });
      }
    );
    this.event("RUN_START", {
      candidate: this.candidate,
      budget: this.budget,
      enforcement: this.enforcement,
      gates: this.graph.order,
      network_default: this.networkDefault,
    });
    try {
      const { settled, decisions } = await runGraph(
        this.graph,
        this.budget,
        spec => this.runGate(spec),
        {
          onDecision: entry => this.event("SCHED_DECISION", entry),
        }
      );

      // Refusals (BLOCKED / INFRA_FAIL settled by the scheduler without
      // execution) become canonical results too — a skipped dependent is a
      // RECORDED non-green result, never a hole in the stream.
      const results = [];
      for (const gateId of this.graph.order) {
        const entry = settled.get(gateId);
        if (entry.schema_version) {
          results.push(entry);
          continue;
        }
        const spec = this.graph.nodes.get(gateId).spec;
        results.push(
          makeResult({
            gate_id: gateId,
            class: spec.class,
            status: entry.status,
            mandatory: spec.mandatory !== false,
            attempts: [],
            duration_ms: null,
            exit_code: null,
            evidence_path: this.executorLog,
            reason: entry.reason,
            started_at: null,
            completed_at: new Date().toISOString(),
            contract_check_id: spec.contract_check_id ?? null,
            runnability: spec.runnability ?? null,
          })
        );
      }

      // DEF-021 guard: an interrupted run may drain to this point while the
      // signal handler's teardown is still awaiting. It must never publish —
      // and it must not throw into caller code either, because the caller
      // exiting would PREEMPT the teardown. The signal handler owns process
      // termination now; the main flow parks here until it happens.
      if (this.interrupted) {
        await new Promise(() => {});
      }

      // Deterministic final ordering: graph order, regardless of completion
      // order. The reporter refuses duplicates by construction.
      const reporter = new JsonlReporter(this.resultsLog);
      for (const result of results) reporter.write(result);

      const summary = summarize(results, {
        declared: this.declared ?? undefined,
      });
      const sweep = await this.registry.runAll("run-complete");
      this.event("CLEANUP", {
        clean: sweep.clean,
        failures: sweep.failures,
        outcomes_count: sweep.outcomes.length,
      });
      this.event("RUN_COMPLETE", {
        results: results.length,
        blocking_classes: summary.blocking_classes,
        teardown_clean: sweep.clean,
      });

      const manifest = {
        executor_schema_version: EXECUTOR_SCHEMA_VERSION,
        run_id: this.run_id,
        candidate: this.candidate,
        complete: true,
        interrupted: false,
        teardown_clean: sweep.clean,
        teardown_failures: sweep.failures,
        scheduler_decisions: decisions.length,
        executor_jsonl_sha256: sha256(readFileSync(this.executorLog)),
        results_jsonl_sha256: sha256(readFileSync(this.resultsLog)),
        finished_at: new Date().toISOString(),
      };
      if (this.interrupted) {
        // Second DEF-021 checkpoint: interruption between the results write
        // and the completion marker still refuses the marker and parks.
        await new Promise(() => {});
      }
      const tmpManifest = `${this.manifestPath}.tmp`;
      writeFileSync(tmpManifest, JSON.stringify(manifest, null, 2));
      renameSync(tmpManifest, this.manifestPath); // atomic completion marker
      return { run_id: this.run_id, results, summary, manifest, decisions };
    } finally {
      this.registry.unwireSignals();
    }
  }
}

/**
 * Read a run's evidence, fail-closed. No manifest => the run never completed
 * => there is NOTHING to summarize (INCOMPLETE_RUN). A hash mismatch means
 * the streams were altered after completion (EVIDENCE_TAMPERED).
 */
export function readExecutorEvidence(runDir) {
  const manifestPath = path.join(runDir, "evidence", "manifest.json");
  if (!existsSync(manifestPath)) {
    throw new ExecutorError("INCOMPLETE_RUN", { runDir });
  }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (manifest.complete !== true) {
    throw new ExecutorError("INCOMPLETE_RUN", { runDir, manifest });
  }
  const executorLog = path.join(runDir, "evidence", "executor.jsonl");
  const resultsLog = path.join(runDir, "evidence", "results.jsonl");
  for (const [file, expected] of [
    [executorLog, manifest.executor_jsonl_sha256],
    [resultsLog, manifest.results_jsonl_sha256],
  ]) {
    const actual = sha256(readFileSync(file));
    if (actual !== expected) {
      throw new ExecutorError("EVIDENCE_TAMPERED", {
        file,
        expected,
        actual,
      });
    }
  }
  const { results } = readResults(resultsLog);
  return { manifest, results, summary: summarize(results) };
}
