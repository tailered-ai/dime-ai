/**
 * P04 validation suite — executor core.
 *
 *   P04.TEST01  scheduler respects declared requires ordering
 *   P04.TEST02  serial lane exclusivity holds (structural intervals)
 *   P04.TEST03  hermetic env observed inside a real child process
 *   P04.NEG01   orphaned owned process reaped and reported INFRA-FAIL
 *   P04.NEG02   hanging gate yields TIMEOUT, not FAIL (and the latch holds)
 *   P04.NEG03   SIGINT yields clean teardown and a non-zero exit
 *   P04.NEG04   network:deny on host yields INCONCLUSIVE, never PASS
 *   P04.NEG05   top-level exit-code suppression detected / preserved
 *   P04.NEG06   scheduler-bypass concurrent lane acquisition trips
 *               LANE_VIOLATION deterministically
 *   P04.NEG07   ownership boundary: unowned resources can NEVER be destroyed
 *   P04.NEG08   executor false-green adversarial suite
 *   P04.FI01    kill -9 the executor mid-gate; recovery reaps verified
 *               orphans and reclaims the stale lane with classification
 *   P04.FI02    exhaust the admission budget deterministically
 *   P04.CLN01   SIGINT teardown leaves zero residue — 10 of 10 runs
 *   P04.AUD01-03 audits green on the shipped modules
 */
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
// @ts-expect-error — plain .mjs module without type declarations
import { GATE_STATUSES, makeResult } from "./result.mjs";
// @ts-expect-error — plain .mjs module without type declarations
import { JsonlReporter, summarize } from "./reporter.mjs";
// @ts-expect-error — plain .mjs module without type declarations
import {
  PREREQUISITE_PERMITS,
  SchedulerError,
  admissionDecision,
  buildGraph,
  makeBudget,
  prerequisiteDecision,
  runGraph,
} from "./scheduler.mjs";
// @ts-expect-error — plain .mjs module without type declarations
import { LaneManager, auditLaneJournal } from "./lane.mjs";
// @ts-expect-error — plain .mjs module without type declarations
import {
  SECRET_NAME_PATTERN,
  allocateOwnedPort,
  buildEnvironment,
  detectNetworkEnforcement,
  heldPorts,
  networkVerdict,
} from "./environment.mjs";
// @ts-expect-error — plain .mjs module without type declarations
import {
  GHA_DEFAULT_SHELL,
  attemptStatus,
  resolveCommand,
  runCommand,
} from "./proc.mjs";
// @ts-expect-error — plain .mjs module without type declarations
import {
  TeardownRegistry,
  assertOwnedPath,
  findMarkedProcesses,
  killVerifiedOwned,
  pidAlive,
  safeRemoveOwned,
  verifyPidOwnership,
} from "./teardown.mjs";
// @ts-expect-error — plain .mjs module without type declarations
import { ExecutorRun, NEVER_RETRY, readExecutorEvidence } from "./executor.mjs";
// @ts-expect-error — plain .mjs module without type declarations
import { loadVerifiedContract } from "./registry.mjs";
// @ts-expect-error — plain .mjs module without type declarations
import {
  SUPPRESSION_PATTERNS,
  auditP03Integration,
  auditSpawnPaths,
  auditSuppressionRuntime,
  auditSuppressionStatic,
  auditTeardownOwnership,
} from "./p04-audit.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, "fixtures", "p04");
const NODE = process.execPath;

const SCRATCH = mkdtempSync(path.join(tmpdir(), "p04-suite-"));
afterAll(() => {
  rmSync(SCRATCH, { recursive: true, force: true });
});

const CANDIDATE = {
  head_sha: "f".repeat(40),
  base_sha: "e".repeat(40),
  merge_tree_sha: "d".repeat(40),
  merge_commit_sha: "c".repeat(40),
};

let scratchSeq = 0;
function freshRoot(): { root: string; cwd: string } {
  const root = path.join(SCRATCH, `run-${(scratchSeq += 1)}`);
  const cwd = path.join(root, "cwd");
  mkdirSync(cwd, { recursive: true });
  return { root, cwd };
}

function fixtureGate(
  id: string,
  args: string[],
  cwd: string,
  extra: Record<string, unknown> = {}
) {
  return {
    gate_id: id,
    class: "PARITY",
    cwd,
    command: { argv: [NODE, ...args] },
    ...extra,
  };
}

function makeRun(
  specs: unknown[],
  root: string,
  extra: Record<string, unknown> = {}
) {
  return new ExecutorRun({
    specs,
    candidate: CANDIDATE,
    runsRoot: path.join(root, "runs"),
    lanesRoot: path.join(root, "lanes"),
    ...extra,
  });
}

/** Drive the real driver fixture to READY, then deliver `signal`. */
function driveAndSignal(
  root: string,
  signal: NodeJS.Signals | "SIGKILL",
  holdMs = 8000
): Promise<{
  ready: {
    run_id: string;
    run_dir: string;
    lanes_root: string;
    pids: number[];
  };
  exit_code: number | null;
  exit_signal: string | null;
  stdout: string;
}> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      NODE,
      [
        path.join(FIXTURES, "run-executor-driver.mjs"),
        "--root",
        root,
        "--hold-ms",
        String(holdMs),
      ],
      { stdio: ["ignore", "pipe", "pipe"] }
    );
    let buffer = "";
    let ready: {
      run_id: string;
      run_dir: string;
      lanes_root: string;
      pids: number[];
    } | null = null;
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`driver never reached READY: ${buffer}`));
    }, 20_000);
    child.stdout.on("data", chunk => {
      buffer += chunk.toString();
      if (!ready) {
        for (const line of buffer.split("\n")) {
          if (line.includes('"READY"')) {
            ready = JSON.parse(line);
            // Interrupt while owned resources are demonstrably live.
            child.kill(signal);
          }
        }
      }
    });
    child.on("exit", (code, exitSignal) => {
      clearTimeout(timer);
      if (!ready) {
        reject(new Error(`driver exited before READY: ${buffer}`));
        return;
      }
      resolve({
        ready,
        exit_code: code,
        exit_signal: exitSignal,
        stdout: buffer,
      });
    });
  });
}

function residueOf(runId: string, lanesRoot: string, runDir: string) {
  return {
    marked_processes: findMarkedProcesses(runId),
    lane_locks: existsSync(lanesRoot)
      ? readdirSync(lanesRoot).filter(entry => entry.endsWith(".lock"))
      : [],
    tmp_dir_exists: existsSync(path.join(runDir, "tmp")),
    manifest_exists: existsSync(path.join(runDir, "evidence", "manifest.json")),
  };
}

// ---------------------------------------------------------------------------
// P04.T01 / P04.TEST01 — DAG scheduler
// ---------------------------------------------------------------------------
describe("P04.TEST01 scheduler respects declared requires ordering", () => {
  const instantGate =
    (log: string[]) =>
    async (spec: { gate_id: string }): Promise<Record<string, unknown>> => {
      log.push(spec.gate_id);
      return { gate_id: spec.gate_id, status: "PASS", reason: null };
    };

  it("executes a linear chain in dependency order", async () => {
    const log: string[] = [];
    const graph = buildGraph([
      { gate_id: "c", requires: ["b"] },
      { gate_id: "b", requires: ["a"] },
      { gate_id: "a" },
    ]);
    await runGraph(graph, makeBudget({ max_concurrency: 4 }), instantGate(log));
    expect(log).toEqual(["a", "b", "c"]);
  });

  it("a dependent never starts before ALL prerequisites settle", async () => {
    const started: string[] = [];
    const graph = buildGraph([
      { gate_id: "join", requires: ["left", "right"] },
      { gate_id: "left" },
      { gate_id: "right" },
    ]);
    await runGraph(
      graph,
      makeBudget({ max_concurrency: 4 }),
      async (spec: { gate_id: string }) => {
        started.push(spec.gate_id);
        if (spec.gate_id === "left") {
          await new Promise(resolve => setTimeout(resolve, 120));
        }
        return { gate_id: spec.gate_id, status: "PASS", reason: null };
      }
    );
    expect(started.indexOf("join")).toBe(2);
  });

  it("independent gates may run concurrently under the budget", async () => {
    let live = 0;
    let peak = 0;
    const graph = buildGraph([
      { gate_id: "p1" },
      { gate_id: "p2" },
      { gate_id: "p3" },
    ]);
    await runGraph(
      graph,
      makeBudget({ max_concurrency: 3 }),
      async (spec: { gate_id: string }) => {
        live += 1;
        peak = Math.max(peak, live);
        await new Promise(resolve => setTimeout(resolve, 60));
        live -= 1;
        return { gate_id: spec.gate_id, status: "PASS", reason: null };
      }
    );
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(3);
  });

  it("a failed prerequisite blocks the dependent WITH the causal record", async () => {
    const graph = buildGraph([
      { gate_id: "up" },
      { gate_id: "down", requires: ["up"] },
      { gate_id: "grand", requires: ["down"] },
    ]);
    const { settled } = await runGraph(
      graph,
      makeBudget({ max_concurrency: 2 }),
      async (spec: { gate_id: string }) => ({
        gate_id: spec.gate_id,
        status: spec.gate_id === "up" ? "FAIL" : "PASS",
        reason: spec.gate_id === "up" ? "EXIT_1" : null,
      })
    );
    const down = settled.get("down");
    expect(down.status).toBe("BLOCKED");
    expect(down.scheduled).toBe(false);
    expect(down.reason).toContain("up=FAIL");
    expect(down.blocked_by).toEqual([{ gate_id: "up", status: "FAIL" }]);
    // The refusal CASCADES with its own causal record — never PASS/N/A.
    const grand = settled.get("grand");
    expect(grand.status).toBe("BLOCKED");
    expect(grand.reason).toContain("down=BLOCKED");
  });

  it("unknown prerequisite / self-dependency / duplicate edge / cycle all refuse up front", () => {
    expect(() => buildGraph([{ gate_id: "a", requires: ["ghost"] }])).toThrow(
      /UNKNOWN_PREREQUISITE/
    );
    expect(() => buildGraph([{ gate_id: "a", requires: ["a"] }])).toThrow(
      /SELF_DEPENDENCY/
    );
    expect(() =>
      buildGraph([{ gate_id: "a" }, { gate_id: "b", requires: ["a", "a"] }])
    ).toThrow(/DUPLICATE_DEPENDENCY_EDGE/);
    expect(() =>
      buildGraph([
        { gate_id: "a", requires: ["b"] },
        { gate_id: "b", requires: ["a"] },
      ])
    ).toThrow(/DEPENDENCY_CYCLE/);
    try {
      buildGraph([
        { gate_id: "x", requires: ["y"] },
        { gate_id: "y", requires: ["x"] },
        { gate_id: "z" },
      ]);
      expect.unreachable("cycle must throw");
    } catch (error) {
      expect((error as { members: string[] }).members).toEqual(["x", "y"]);
    }
    expect(() => buildGraph([{ gate_id: "a" }, { gate_id: "a" }])).toThrow(
      /DUPLICATE_GATE_ID/
    );
  });

  it("simultaneously-runnable order is lexicographic — never insertion/random", () => {
    const graph = buildGraph([
      { gate_id: "zeta" },
      { gate_id: "alpha" },
      { gate_id: "mid" },
    ]);
    expect(graph.order).toEqual(["alpha", "mid", "zeta"]);
  });

  it("scheduler decisions are journaled with sequence numbers", async () => {
    const graph = buildGraph([{ gate_id: "solo" }]);
    const { decisions } = await runGraph(
      graph,
      makeBudget({ max_concurrency: 1 }),
      instantGate([])
    );
    expect(decisions.length).toBeGreaterThan(0);
    expect(decisions.map((d: { seq: number }) => d.seq)).toEqual(
      decisions.map((_: unknown, i: number) => i + 1)
    );
    expect(
      decisions.some((d: { kind: string }) => d.kind === "ADMISSION")
    ).toBe(true);
  });

  it("the prerequisite-permission table is total over the 12 statuses and central", () => {
    expect(Object.keys(PREREQUISITE_PERMITS).sort()).toEqual(
      [...GATE_STATUSES].sort()
    );
    for (const status of [
      "FAIL",
      "FLAKY",
      "TIMEOUT",
      "BLOCKED",
      "INFRA_FAIL",
      "CONTRACT_DRIFT",
      "BROKEN_GATE",
      "INCONCLUSIVE",
    ]) {
      expect(PREREQUISITE_PERMITS[status]).toBe(false);
    }
    const node = { requires: ["x"] };
    const settled = new Map([["x", { status: "FLAKY" }]]);
    const decision = prerequisiteDecision(node, settled);
    expect(decision.permitted).toBe(false);
    expect(decision.blocking).toEqual([{ gate_id: "x", status: "FLAKY" }]);
  });
});

// ---------------------------------------------------------------------------
// P04.T02 — budget and admission
// ---------------------------------------------------------------------------
describe("P04.T02 concurrency and resource budget", () => {
  it("labels enforcement truthfully per dimension", () => {
    const declared = makeBudget({});
    expect(declared.enforcement.concurrency).toBe("SCHEDULER_ENFORCED");
    expect(declared.enforcement.memory).toBe("DECLARED");
    expect(declared.enforcement.cpu).toBe("DECLARED");
    const bounded = makeBudget({ memory_budget_mb: 2048, max_processes: 4 });
    expect(bounded.enforcement.memory).toBe("SCHEDULER_ENFORCED");
    expect(bounded.enforcement.memory_note).toContain("admission-time");
    expect(bounded.enforcement.processes).toBe("SCHEDULER_ENFORCED");
    expect(() => makeBudget({ max_concurrency: 0 })).toThrow(/INVALID_BUDGET/);
  });

  it("admission is pure and deterministic: ADMIT / WAIT / IMPOSSIBLE", () => {
    const budget = makeBudget({ max_concurrency: 2, memory_budget_mb: 1000 });
    expect(
      admissionDecision({ memory_hint_mb: 400 }, [], budget).decision
    ).toBe("ADMIT");
    expect(
      admissionDecision(
        { memory_hint_mb: 400 },
        [{ memory_hint_mb: 700 }],
        budget
      ).decision
    ).toBe("WAIT");
    expect(
      admissionDecision({ memory_hint_mb: 1200 }, [], budget)
    ).toMatchObject({
      decision: "IMPOSSIBLE",
      reason: expect.stringContaining("RESOURCE_ADMISSION_IMPOSSIBLE"),
    });
  });

  it("the concurrency budget is never exceeded during a real run", async () => {
    let live = 0;
    let peak = 0;
    const graph = buildGraph(
      ["a", "b", "c", "d", "e"].map(id => ({ gate_id: id }))
    );
    await runGraph(
      graph,
      makeBudget({ max_concurrency: 2 }),
      async (spec: { gate_id: string }) => {
        live += 1;
        peak = Math.max(peak, live);
        await new Promise(resolve => setTimeout(resolve, 40));
        live -= 1;
        return { gate_id: spec.gate_id, status: "PASS", reason: null };
      }
    );
    expect(peak).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// P04.TEST02 — serial lane exclusivity (structural)
// ---------------------------------------------------------------------------
describe("P04.TEST02 serial lane exclusivity holds", () => {
  it("two DB gates serialize: disjoint intervals, one holder, zero violations, empty final state", async () => {
    const { root, cwd } = freshRoot();
    const run = makeRun(
      [
        fixtureGate("db-one", [path.join(FIXTURES, "sleep.mjs"), "150"], cwd, {
          lane: "db",
        }),
        fixtureGate("db-two", [path.join(FIXTURES, "sleep.mjs"), "150"], cwd, {
          lane: "db",
        }),
      ],
      root,
      { budget: { max_concurrency: 2 } }
    );
    const outcome = await run.execute();
    // 1-2: both executed (serialized, NOT rejected) and passed.
    for (const result of outcome.results) {
      expect(result.status).toBe("PASS");
    }
    // 3-7: structural interval audit over the journal.
    const audit = auditLaneJournal(
      path.join(root, "lanes", "db.journal.jsonl")
    );
    expect(audit.ok).toBe(true);
    expect(audit.violations).toEqual([]);
    expect(audit.intervals).toHaveLength(2);
    for (const interval of audit.intervals) {
      expect(interval.release_state).toBe("RELEASED");
      expect(interval.exited_line).toBeGreaterThan(interval.entered_line);
    }
    // Structural disjointness: first holder's RELEASE line precedes the
    // second holder's ACQUIRE line in the append-ordered journal.
    const [first, second] = audit.intervals;
    expect(first.exited_line).toBeLessThan(second.entered_line);
    expect(audit.still_held).toBeNull();
    expect(
      readdirSync(path.join(root, "lanes")).filter(f => f.endsWith(".lock"))
    ).toEqual([]);
  }, 20_000);
});

// ---------------------------------------------------------------------------
// P04.TEST03 — hermetic environment observed in a real child
// ---------------------------------------------------------------------------
describe("P04.TEST03 hermetic env is observed inside a child process", () => {
  it("the child sees exactly the controlled environment", async () => {
    const { root, cwd } = freshRoot();
    process.env.P04_HOST_CANARY = "must-not-leak";
    process.env.P04_FAKE_TEST_TOKEN = "secret-shaped-must-not-leak";
    try {
      const run = makeRun(
        [
          fixtureGate(
            "env-probe",
            [path.join(FIXTURES, "env-report.mjs")],
            cwd,
            {
              needs_port: true,
              seed: "424242",
              node_options: "--max-old-space-size=256",
              env: { P04_DECLARED: "declared-value" },
              env_remove: ["P04_REMOVED_CANARY"],
            }
          ),
        ],
        root
      );
      const outcome = await run.execute();
      expect(outcome.results[0].status).toBe("PASS");
      const stdout = readFileSync(
        path.join(run.gatesDir, "env-probe", "attempt-1.stdout"),
        "utf8"
      );
      const observed = JSON.parse(stdout);
      expect(observed.TZ).toBe("UTC");
      expect(observed.LC_ALL).toBe("C.UTF-8");
      expect(observed.CI_VERIFY_SEED).toBe("424242");
      expect(observed.TMPDIR.startsWith(run.runDir)).toBe(true);
      expect(observed.NODE_OPTIONS).toBe("--max-old-space-size=256");
      expect(Number(observed.CI_VERIFY_PORT)).toBeGreaterThan(0);
      expect(observed.CI_VERIFY_OWNER).toBe(run.run_id);
      expect(observed.CI_VERIFY_GATE).toBe("env-probe");
      expect(observed.PATH_PRESENT).toBe(true);
      // Host noise and removed names DID NOT leak.
      expect(observed.P04_HOST_CANARY).toBeNull();
      expect(observed.P04_REMOVED_CANARY).toBeNull();
    } finally {
      delete process.env.P04_HOST_CANARY;
      delete process.env.P04_FAKE_TEST_TOKEN;
    }
  }, 20_000);

  it("secret-shaped host names are recorded BY NAME ONLY, never by value", () => {
    const { env, profile } = buildEnvironment({
      run_id: "r-x",
      gate_id: "g-x",
      tmpdir: SCRATCH,
      host_env: {
        PATH: "/usr/bin",
        STRIPE_SECRET_KEY: "sk_live_would_be_a_secret",
        RANDOM_HOST_VAR: "noise",
      },
    });
    expect(env.STRIPE_SECRET_KEY).toBeUndefined();
    expect(env.RANDOM_HOST_VAR).toBeUndefined();
    const names = profile.classification.map((c: { name: string }) => c.name);
    expect(names).toContain("STRIPE_SECRET_KEY");
    expect(
      profile.classification.find(
        (c: { name: string }) => c.name === "STRIPE_SECRET_KEY"
      ).class
    ).toBe("forbidden");
    expect(JSON.stringify(profile)).not.toContain("sk_live");
    expect(profile.dropped_host_variables).toBe(1);
  });

  it("gate env may not override ownership markers or carry secret-shaped values", () => {
    expect(() =>
      buildEnvironment({
        run_id: "r",
        gate_id: "g",
        tmpdir: SCRATCH,
        gate_env: { CI_VERIFY_OWNER: "spoofed" },
      })
    ).toThrow(/MARKER_OVERRIDE_FORBIDDEN/);
    expect(() =>
      buildEnvironment({
        run_id: "r",
        gate_id: "g",
        tmpdir: SCRATCH,
        gate_env: { MY_API_TOKEN: "value" },
      })
    ).toThrow(/SECRET_VALUE_IN_GATE_ENV/);
    expect(SECRET_NAME_PATTERN.test("DATABASE_URL")).toBe(true);
  });

  it("owned ports are collision-checked and released", async () => {
    const a = await allocateOwnedPort();
    const b = await allocateOwnedPort();
    expect(a.port).not.toBe(b.port);
    expect(heldPorts()).toContain(a.port);
    await a.release();
    await b.release();
    expect(heldPorts()).not.toContain(a.port);
  });
});

// ---------------------------------------------------------------------------
// P04.NEG01 — orphaned owned process
// ---------------------------------------------------------------------------
describe("P04.NEG01 orphaned process is reaped and reported INFRA-FAIL", () => {
  it("a gate that leaks an owned child is INFRA_FAIL with the functional outcome preserved — and the orphan is dead", async () => {
    const { root, cwd } = freshRoot();
    const run = makeRun(
      [fixtureGate("leaker", [path.join(FIXTURES, "orphan-spawner.mjs")], cwd)],
      root
    );
    const outcome = await run.execute();
    const result = outcome.results[0];
    expect(result.status).toBe("INFRA_FAIL");
    expect(result.reason).toContain("OWNED_RESOURCE_LEAK");
    // The functional outcome (exit 0) is preserved, not erased.
    expect(result.reason).toContain("functional outcome was PASS");
    expect(result.attempts[0].exit_code).toBe(0);
    // The leak event names the reaped pid and it is genuinely dead.
    const events = readFileSync(run.executorLog, "utf8")
      .split("\n")
      .filter(Boolean)
      .map(line => JSON.parse(line));
    const leak = events.find(e => e.type === "LEAK");
    expect(leak).toBeDefined();
    expect(leak.leaked.length).toBe(1);
    expect(pidAlive(leak.leaked[0].pid)).toBe(false);
    // Zero owned residue after final teardown.
    expect(findMarkedProcesses(run.run_id)).toEqual([]);
    expect(outcome.manifest.teardown_clean).toBe(true);
  }, 20_000);
});

// ---------------------------------------------------------------------------
// P04.NEG02 — TIMEOUT, not FAIL
// ---------------------------------------------------------------------------
describe("P04.NEG02 hanging gate yields TIMEOUT, not FAIL", () => {
  it("graceful responder: monotonic deadline, SIGTERM, TIMEOUT — and the latch defeats a late exit 0", async () => {
    const { root, cwd } = freshRoot();
    const run = makeRun(
      [
        fixtureGate("latcher", [path.join(FIXTURES, "trap-exit0.mjs")], cwd, {
          timeout_ms: 400,
          grace_ms: 800,
        }),
      ],
      root
    );
    const outcome = await run.execute();
    const result = outcome.results[0];
    expect(result.status).toBe("TIMEOUT");
    expect(result.status).not.toBe("FAIL");
    expect(result.attempts[0].timed_out).toBe(true);
    // trap-exit0 exits 0 on SIGTERM — the latch holds anyway.
    expect(result.attempts[0].exit_code).toBe(0);
    expect(result.attempts[0].signal_sequence).toContain("SIGTERM");
    expect(result.attempts[0].signal_sequence).not.toContain("SIGKILL");
    expect(result.reason).toContain("deadline 400ms");
    expect(result.attempts[0].duration_ms).toBeGreaterThanOrEqual(390);
    expect(findMarkedProcesses(run.run_id)).toEqual([]);
  }, 20_000);

  it("SIGTERM-ignorer: escalation to SIGKILL, child reaped, TIMEOUT", async () => {
    const { root, cwd } = freshRoot();
    const run = makeRun(
      [
        fixtureGate(
          "stubborn",
          [path.join(FIXTURES, "ignore-sigterm.mjs")],
          cwd,
          { timeout_ms: 400, grace_ms: 300 }
        ),
      ],
      root
    );
    const outcome = await run.execute();
    const result = outcome.results[0];
    expect(result.status).toBe("TIMEOUT");
    expect(result.attempts[0].signal_sequence).toEqual(["SIGTERM", "SIGKILL"]);
    expect(result.attempts[0].signal).toBe("SIGKILL");
    expect(findMarkedProcesses(run.run_id)).toEqual([]);
  }, 20_000);

  it("TIMEOUT is in NEVER_RETRY — the executor cannot retry its way green", () => {
    expect(NEVER_RETRY.has("TIMEOUT")).toBe(true);
    expect(NEVER_RETRY.has("CONTRACT_DRIFT")).toBe(true);
    expect(NEVER_RETRY.has("BROKEN_GATE")).toBe(true);
    expect(NEVER_RETRY.has("BLOCKED")).toBe(true);
    expect(NEVER_RETRY.has("INFRA_FAIL")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// P04.NEG03 — SIGINT: clean teardown, non-zero exit
// ---------------------------------------------------------------------------
describe("P04.NEG03 SIGINT yields clean teardown and a non-zero exit", () => {
  it("interrupting a live run kills owned children, releases the lane, removes tmp, and never leaves a completed-looking record", async () => {
    const { root } = freshRoot();
    const { ready, exit_code } = await driveAndSignal(root, "SIGINT");
    expect(exit_code).toBe(130); // non-zero, signal-coded
    // Owned children are dead.
    for (const pid of ready.pids) {
      expect(pidAlive(pid)).toBe(false);
    }
    const residue = residueOf(ready.run_id, ready.lanes_root, ready.run_dir);
    expect(residue.marked_processes).toEqual([]);
    expect(residue.lane_locks).toEqual([]);
    expect(residue.tmp_dir_exists).toBe(false);
    // No manifest, no results stream: the interrupted run cannot be read
    // as complete, let alone green.
    expect(residue.manifest_exists).toBe(false);
    expect(() => readExecutorEvidence(ready.run_dir)).toThrow(/INCOMPLETE_RUN/);
    // The event stream records the interruption itself.
    const events = readFileSync(
      path.join(ready.run_dir, "evidence", "executor.jsonl"),
      "utf8"
    );
    expect(events).toContain('"INTERRUPTED"');
  }, 30_000);
});

// ---------------------------------------------------------------------------
// P04.NEG04 — network:deny on host => INCONCLUSIVE, never PASS
// ---------------------------------------------------------------------------
describe("P04.NEG04 network:deny on host yields INCONCLUSIVE, never PASS", () => {
  it("deny-gate is INCONCLUSIVE with HERMETIC:UNENFORCED; allow-gate control is unaffected", async () => {
    const { root, cwd } = freshRoot();
    const run = makeRun(
      [
        fixtureGate("denied", [path.join(FIXTURES, "sleep.mjs"), "20"], cwd, {
          network: "deny",
        }),
        fixtureGate("allowed", [path.join(FIXTURES, "sleep.mjs"), "20"], cwd, {
          network: "allow",
        }),
      ],
      root
    );
    const outcome = await run.execute();
    const denied = outcome.results.find(r => r.gate_id === "denied");
    const allowed = outcome.results.find(r => r.gate_id === "allowed");
    expect(denied.status).toBe("INCONCLUSIVE");
    expect(denied.status).not.toBe("PASS");
    expect(denied.reason).toContain("NETWORK_DENY_UNENFORCED");
    expect(allowed.status).toBe("PASS");
    const events = readFileSync(run.executorLog, "utf8");
    expect(events).toContain('"hermetic":"HERMETIC:UNENFORCED"');
  }, 20_000);

  it("enforcement detection is truthful in both directions", () => {
    const host = detectNetworkEnforcement();
    expect(host.mode).toBe("HERMETIC:UNENFORCED");
    expect(host.mechanism).toBeNull();
    // The abstraction CAN report enforcement — only for an owned, VERIFIED
    // mechanism (the P08 cleanroom path), never simulated.
    const enforced = detectNetworkEnforcement({
      available_mechanisms: [
        {
          name: "container:network=none",
          owned: true,
          verified: true,
          evidence: "inspect shows NetworkMode=none",
        },
      ],
    });
    expect(enforced.mode).toBe("HERMETIC:ENFORCED");
    const unverified = detectNetworkEnforcement({
      available_mechanisms: [
        { name: "container:network=none", owned: true, verified: false },
      ],
    });
    expect(unverified.mode).toBe("HERMETIC:UNENFORCED");
    // Verdict table: deny+unenforced downgrades; allow never does.
    expect(networkVerdict("deny", host).downgrade?.status).toBe("INCONCLUSIVE");
    expect(networkVerdict("allow", host).downgrade).toBeNull();
    expect(networkVerdict("deny", enforced).downgrade).toBeNull();
    expect(() => networkVerdict("sometimes", host)).toThrow(
      /UNKNOWN_NETWORK_POLICY/
    );
  });
});

// ---------------------------------------------------------------------------
// P04.NEG05 — exit-code suppression
// ---------------------------------------------------------------------------
describe("P04.NEG05 top-level exit-code suppression is detected by audit", () => {
  it("the shipped executor modules contain zero suppression shapes", () => {
    const audit = auditSuppressionStatic();
    expect(audit.findings).toEqual([]);
    expect(audit.ok).toBe(true);
  });

  it("the detector itself can detect (positive corpus)", () => {
    const corpus: Array<[string, boolean]> = [
      ["run-tests | tee out.log 2>&1", false],
      ["npm test 2>&1 | tee build.log", true],
      ["cmd || true", true],
      ["cmd ; true", true],
      ["status=$?", true],
      ["echo $?", true],
      ["plain-command --flag", false],
    ];
    for (const [line, shouldMatch] of corpus) {
      const matched = SUPPRESSION_PATTERNS.some((rule: { pattern: RegExp }) =>
        rule.pattern.test(line)
      );
      expect(matched, line).toBe(shouldMatch);
    }
  });

  it("runtime: producer failure SURVIVES the classic suppression shapes under the GHA shell", async () => {
    const dir = path.join(SCRATCH, "neg05");
    mkdirSync(dir, { recursive: true });
    const audit = await auditSuppressionRuntime(dir);
    expect(audit.ok).toBe(true);
    const byId = Object.fromEntries(
      audit.probes.map((p: { id: string }) => [p.id, p])
    );
    expect(byId["piped-producer-failure"].exit_code).toBe(1);
    expect(byId["mid-pipeline-exit-code"].exit_code).toBe(7);
    expect(byId["deliberate-contract-suppression"].exit_code).toBe(0);
  }, 30_000);

  it("the shell contract is exactly GitHub Actions' default", () => {
    expect(GHA_DEFAULT_SHELL).toEqual([
      "/bin/bash",
      "--noprofile",
      "--norc",
      "-e",
      "-o",
      "pipefail",
      "-c",
    ]);
    expect(() => resolveCommand({ argv: ["x"], shell: "y" })).toThrow(
      /AMBIGUOUS_COMMAND/
    );
    expect(() => resolveCommand({})).toThrow(/EMPTY_COMMAND/);
  });
});

// ---------------------------------------------------------------------------
// P04.NEG06 — scheduler-bypass lane acquisition
// ---------------------------------------------------------------------------
describe("P04.NEG06 direct concurrent lane invocation trips LANE_VIOLATION", () => {
  it("the bypass intruder is refused deterministically; the holder survives untouched", () => {
    const root = path.join(SCRATCH, "neg06-lanes");
    mkdirSync(root, { recursive: true });
    const holder = new LaneManager({ root, run_id: "run-holder" });
    const intruder = new LaneManager({ root, run_id: "run-intruder" });
    const acquisition = holder.tryAcquire("db", "legit-gate");
    expect(acquisition).not.toBeNull();
    // Structural violation — no timing race decides this.
    expect(() =>
      intruder.tryAcquire("db", "bypass-gate", { bypass: true })
    ).toThrow(/LANE_VIOLATION/);
    // Holder ownership intact; the intruder cannot release it either.
    expect(holder.inspect("db").state).toBe("HELD");
    expect(holder.inspect("db").owner.run_id).toBe("run-holder");
    expect(() =>
      intruder.release({
        lane: "db",
        acquisition_id: "forged",
        run_id: "run-intruder",
      })
    ).toThrow(/UNAUTHORIZED_RELEASE/);
    // The journal carries the violation FOREVER — later success cannot hide it.
    holder.release(acquisition);
    const after = holder.tryAcquire("db", "second-legit");
    expect(after).not.toBeNull();
    holder.release(after);
    const audit = auditLaneJournal(path.join(root, "db.journal.jsonl"));
    expect(audit.ok).toBe(false);
    expect(
      audit.violations.some(
        (v: { kind: string }) => v.kind === "LANE_VIOLATION"
      )
    ).toBe(true);
    // Final lane state is clean.
    expect(holder.inspect("db").state).toBe("FREE");
  });

  it("a scheduler-path (non-bypass) second request queues instead of tripping", async () => {
    const root = path.join(SCRATCH, "neg06-queue");
    mkdirSync(root, { recursive: true });
    const manager = new LaneManager({ root, run_id: "run-q" });
    const first = await manager.acquire("db", "g1");
    const secondPromise = manager.acquire("db", "g2");
    let settled = false;
    void secondPromise.then(() => {
      settled = true;
    });
    await new Promise(resolve => setTimeout(resolve, 80));
    expect(settled).toBe(false); // queued, not violated, not rejected
    manager.release(first);
    const second = await secondPromise;
    expect(second.gate_id).toBe("g2");
    manager.release(second);
    const audit = auditLaneJournal(path.join(root, "db.journal.jsonl"));
    expect(audit.ok).toBe(true);
  });

  it("a stale lock is detected and classified, never silently overridden", () => {
    const root = path.join(SCRATCH, "neg06-stale");
    mkdirSync(root, { recursive: true });
    const deadOwner = new LaneManager({ root, run_id: "run-dead" });
    const acquisition = deadOwner.tryAcquire("db", "gate-x");
    // Forge death: rewrite owner.json with a pid that cannot be alive.
    const ownerPath = path.join(root, "db.lock", "owner.json");
    const owner = JSON.parse(readFileSync(ownerPath, "utf8"));
    owner.pid = 999999999;
    writeFileSync(ownerPath, JSON.stringify(owner));
    const next = new LaneManager({ root, run_id: "run-next" });
    expect(next.inspect("db").state).toBe("STALE");
    expect(() => next.tryAcquire("db", "gate-y")).toThrow(/STALE_LOCK/);
    // Explicit, journaled reclaim is the ONLY path forward.
    const reclaim = next.reclaimStale("db");
    expect(reclaim.reclaimed).toBe(true);
    const audit = auditLaneJournal(path.join(root, "db.journal.jsonl"));
    expect(
      audit.intervals.some(
        (i: { release_state: string }) => i.release_state === "STALE_RECLAIMED"
      )
    ).toBe(true);
    const fresh = next.tryAcquire("db", "gate-z");
    expect(fresh).not.toBeNull();
    next.release(fresh);
    void acquisition;
  });
});

// ---------------------------------------------------------------------------
// P04.NEG07 — ownership boundary adversarial suite
// ---------------------------------------------------------------------------
describe("P04.NEG07 teardown can never destroy what it cannot prove it owns", () => {
  it("an unowned process with a similar command line is NOT killed", async () => {
    // Spawn a plain sleeper WITHOUT any ownership marker.
    const bystander = spawn(NODE, [path.join(FIXTURES, "sleep.mjs"), "8000"], {
      stdio: "ignore",
    });
    try {
      expect(pidAlive(bystander.pid!)).toBe(true);
      // Detection refuses it; destruction refuses it.
      expect(
        findMarkedProcesses("some-run-id").some(
          (p: { pid: number }) => p.pid === bystander.pid
        )
      ).toBe(false);
      const proof = verifyPidOwnership(bystander.pid!, "some-run-id");
      expect(proof.owned).toBe(false);
      const outcome = await killVerifiedOwned(bystander.pid!, "some-run-id");
      expect(outcome.action).toBe("REFUSED_UNOWNED");
      expect(pidAlive(bystander.pid!)).toBe(true); // still alive
    } finally {
      bystander.kill("SIGKILL"); // the TEST owns it (live handle)
    }
  }, 20_000);

  it("an unowned directory with a similar prefix is refused, with traversal and symlink escapes", () => {
    const ownedRoot = path.join(SCRATCH, "neg07-owned");
    const lookalike = path.join(SCRATCH, "neg07-owned-lookalike");
    mkdirSync(ownedRoot, { recursive: true });
    mkdirSync(lookalike, { recursive: true });
    writeFileSync(path.join(lookalike, "innocent.txt"), "bystander");
    // Similar prefix: refused.
    expect(() => assertOwnedPath(lookalike, ownedRoot)).toThrow(/UNOWNED_PATH/);
    expect(() => safeRemoveOwned(lookalike, ownedRoot)).toThrow(/UNOWNED_PATH/);
    expect(existsSync(path.join(lookalike, "innocent.txt"))).toBe(true);
    // Path traversal: refused.
    expect(() =>
      safeRemoveOwned(
        path.join(ownedRoot, "..", "neg07-owned-lookalike"),
        ownedRoot
      )
    ).toThrow(/UNOWNED_PATH/);
    // A registered path that RESOLVES outside via symlink: refused.
    const escape = path.join(ownedRoot, "escape-link");
    symlinkSync(lookalike, escape);
    expect(() => safeRemoveOwned(escape, ownedRoot)).toThrow(/UNOWNED_PATH/);
    expect(existsSync(path.join(lookalike, "innocent.txt"))).toBe(true);
    // A dangling path parked outside the root: refused too.
    expect(() =>
      assertOwnedPath(path.join(lookalike, "not-yet-created"), ownedRoot)
    ).toThrow(/UNOWNED_PATH/);
  });

  it("removing an owned tree does not FOLLOW symlinks out of it", () => {
    const ownedRoot = path.join(SCRATCH, "neg07-symlink-root");
    const outside = path.join(SCRATCH, "neg07-outside");
    mkdirSync(path.join(ownedRoot, "sub"), { recursive: true });
    mkdirSync(outside, { recursive: true });
    writeFileSync(path.join(outside, "precious.txt"), "must survive");
    symlinkSync(outside, path.join(ownedRoot, "sub", "link-out"));
    safeRemoveOwned(path.join(ownedRoot, "sub"), ownedRoot);
    expect(existsSync(path.join(ownedRoot, "sub"))).toBe(false);
    expect(existsSync(path.join(outside, "precious.txt"))).toBe(true);
  });

  it("another run's lane lock cannot be released; malformed records cannot authorize cleanup", () => {
    const root = path.join(SCRATCH, "neg07-lanes");
    mkdirSync(root, { recursive: true });
    const owner = new LaneManager({ root, run_id: "run-a" });
    const other = new LaneManager({ root, run_id: "run-b" });
    const acquisition = owner.tryAcquire("db", "gate-a");
    expect(() => other.release(acquisition)).toThrow(/UNAUTHORIZED_RELEASE/);
    expect(owner.inspect("db").state).toBe("HELD");
    owner.release(acquisition);
    // Malformed registration is refused before anything exists to destroy.
    const registry = new TeardownRegistry({
      run_id: "run-a",
      owned_root: root,
    });
    expect(() =>
      registry.register({ type: "not-a-type", id: "x", cleanup: () => {} })
    ).toThrow(/UNKNOWN_RESOURCE_TYPE/);
    expect(() =>
      registry.register({ type: "temp_dir", id: "", cleanup: () => {} })
    ).toThrow(/RESOURCE_ID_REQUIRED/);
    expect(() => registry.register({ type: "process", id: "p1" })).toThrow(
      /CLEANUP_CALLBACK_REQUIRED/
    );
    // A temp_dir registration OUTSIDE the owned root is refused up front.
    expect(() =>
      registry.register({
        type: "temp_dir",
        id: SCRATCH,
        path: SCRATCH,
        cleanup: () => {},
      })
    ).toThrow(/UNOWNED_PATH/);
  });

  it("duplicated cleanup is an idempotent no-op; cleanup failure is visible and preserved", async () => {
    const root = path.join(SCRATCH, "neg07-registry");
    mkdirSync(root, { recursive: true });
    const registry = new TeardownRegistry({
      run_id: "run-c",
      owned_root: root,
    });
    let cleanups = 0;
    const token = registry.register({
      type: "process",
      id: "counted",
      cleanup: () => {
        cleanups += 1;
      },
    });
    registry.register({
      type: "process",
      id: "exploder",
      cleanup: () => {
        throw new Error("cleanup exploded");
      },
    });
    const first = await registry.runAll("test");
    expect(cleanups).toBe(1);
    expect(first.clean).toBe(false); // failure is VISIBLE
    expect(first.failures).toHaveLength(1);
    expect(first.failures[0].id).toBe("exploder");
    // Second sweep: idempotent, no double-clean of the counted resource.
    const second = await registry.runAll("test-again");
    expect(cleanups).toBe(1);
    expect(
      second.outcomes.every(
        (o: { note?: string }) => o.note?.includes("idempotent") ?? false
      )
    ).toBe(true);
    // markCleaned twice is safe.
    registry.markCleaned(token);
    registry.markCleaned(token);
    expect(() => registry.markCleaned("td-bogus")).toThrow(/UNKNOWN_TOKEN/);
  });
});

// ---------------------------------------------------------------------------
// P04.NEG08 — executor false-green adversarial suite
// ---------------------------------------------------------------------------
describe("P04.NEG08 no loss, drift, interruption, or infra failure converts to PASS", () => {
  it("a missing mandatory result cannot summarize green (declared vs observed)", () => {
    const results = [
      makeResult({
        gate_id: "present",
        class: "PARITY",
        status: "PASS",
        exit_code: 0,
        evidence_path: "x",
      }),
    ];
    const summary = summarize(results, {
      declared: { PARITY: ["present", "absent-mandatory"] },
    });
    expect(summary.classes.PARITY.blocking).toBe(true);
    expect(summary.classes.PARITY.missing_gate_ids).toEqual([
      "absent-mandatory",
    ]);
  });

  it("a runGate exception becomes INFRA_FAIL (executor fault), never product FAIL", async () => {
    const graph = buildGraph([{ gate_id: "explode" }]);
    const { settled } = await runGraph(
      graph,
      makeBudget({ max_concurrency: 1 }),
      async () => {
        throw new Error("scheduler-visible executor crash");
      }
    );
    const result = settled.get("explode");
    expect(result.status).toBe("INFRA_FAIL");
    expect(result.status).not.toBe("FAIL");
    expect(result.executor_exception).toBe(true);
    expect(result.reason).toContain("EXECUTOR_EXCEPTION");
  });

  it("spawn failure and missing executables are BLOCKED/INFRA — never PASS", async () => {
    const record = await runCommand(
      { argv: ["p04-definitely-not-installed-anywhere"] },
      {
        env: { PATH: process.env.PATH ?? "" },
        cwd: SCRATCH,
        timeout_ms: 5_000,
        stdout_path: path.join(SCRATCH, "missing.out"),
        stderr_path: path.join(SCRATCH, "missing.err"),
      }
    );
    expect(record.spawn_error).toBe("MISSING_EXECUTABLE");
    const status = attemptStatus(record);
    expect(status.status).toBe("BLOCKED");
    expect(status.status).not.toBe("PASS");
    expect(status.reason).toContain("MISSING_EXECUTABLE");
  }, 15_000);

  it("a malformed result cannot enter the reporter", () => {
    const reporter = new JsonlReporter(
      path.join(SCRATCH, "neg08-results.jsonl")
    );
    expect(() =>
      reporter.write({ gate_id: "bad", status: "GREENISH", class: "PARITY" })
    ).toThrow();
  });

  it("truncated or tampered executor evidence refuses to summarize; a missing manifest is INCOMPLETE_RUN", async () => {
    const { root, cwd } = freshRoot();
    const run = makeRun(
      [fixtureGate("ok", [path.join(FIXTURES, "sleep.mjs"), "20"], cwd)],
      root
    );
    await run.execute();
    // Control: intact evidence reads clean.
    const evidence = readExecutorEvidence(run.runDir);
    expect(evidence.results).toHaveLength(1);
    // Tamper with the results stream => hash mismatch.
    const resultsPath = path.join(run.runDir, "evidence", "results.jsonl");
    const original = readFileSync(resultsPath, "utf8");
    writeFileSync(resultsPath, original.replace('"PASS"', '"FAIL"'));
    expect(() => readExecutorEvidence(run.runDir)).toThrow(/EVIDENCE_TAMPERED/);
    writeFileSync(resultsPath, original); // restore => green control again
    expect(readExecutorEvidence(run.runDir).results).toHaveLength(1);
    // Truncate the executor event stream => hash mismatch too.
    const logPath = path.join(run.runDir, "evidence", "executor.jsonl");
    const events = readFileSync(logPath, "utf8");
    writeFileSync(logPath, events.slice(0, events.length - 10));
    expect(() => readExecutorEvidence(run.runDir)).toThrow(/EVIDENCE_TAMPERED/);
    writeFileSync(logPath, events);
    // Manifest marked incomplete => INCOMPLETE_RUN.
    const manifestPath = path.join(run.runDir, "evidence", "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    writeFileSync(
      manifestPath,
      JSON.stringify({ ...manifest, complete: false })
    );
    expect(() => readExecutorEvidence(run.runDir)).toThrow(/INCOMPLETE_RUN/);
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  }, 20_000);

  it("a stale candidate binding is refused before any gate runs", () => {
    const { root, cwd } = freshRoot();
    expect(() =>
      makeRun(
        [fixtureGate("g", [path.join(FIXTURES, "sleep.mjs"), "10"], cwd)],
        root,
        { bindHeadSha: "a".repeat(40) } // real HEAD differs from CANDIDATE
      )
    ).toThrow(/CANDIDATE_STALE/);
    expect(
      () =>
        new ExecutorRun({
          specs: [
            fixtureGate("g", [path.join(FIXTURES, "sleep.mjs"), "10"], cwd),
          ],
          candidate: { head_sha: "x".repeat(40) }, // incomplete
          runsRoot: path.join(root, "runs"),
          lanesRoot: path.join(root, "lanes"),
        })
    ).toThrow(/CANDIDATE_INCOMPLETE/);
  });

  it("a contract whose bytes drifted from the pin blocks registry-bound execution", () => {
    const dir = path.join(SCRATCH, "neg08-contract");
    mkdirSync(dir, { recursive: true });
    const contractPath = path.join(dir, "contract.frozen.json");
    const shaPath = path.join(dir, "contract.sha256");
    writeFileSync(contractPath, JSON.stringify({ checks: [] }));
    writeFileSync(shaPath, `${"0".repeat(64)}  contract.frozen.json\n`);
    expect(() => loadVerifiedContract({ contractPath, shaPath })).toThrow(
      /CONTRACT_DRIFT/
    );
  });

  it("candidate-worktree mutation during a gate is detected and is INFRA_FAIL, not PASS", async () => {
    const { root, cwd } = freshRoot();
    writeFileSync(path.join(cwd, "pristine.txt"), "baseline");
    const run = makeRun(
      [
        fixtureGate("mutator", [path.join(FIXTURES, "mutate-cwd.mjs")], cwd, {
          integrity_check_cwd: true,
        }),
      ],
      root
    );
    const outcome = await run.execute();
    const result = outcome.results[0];
    expect(result.status).toBe("INFRA_FAIL");
    expect(result.reason).toContain("CANDIDATE_MUTATION");
    expect(result.reason).toContain("functional outcome was PASS");
  }, 20_000);

  it("a lane violation in the journal is never hidden by later successful runs", () => {
    // Proven in NEG06's final audit assertion; re-asserted here as the
    // false-green framing: the journal is append-only history.
    const root = path.join(SCRATCH, "neg06-lanes");
    const audit = auditLaneJournal(path.join(root, "db.journal.jsonl"));
    expect(audit.ok).toBe(false);
  });

  it("PASS with a failed attempt in history is structurally invalid (P03 boundary holds)", () => {
    try {
      makeResult({
        gate_id: "flaky-hidden",
        class: "PARITY",
        status: "PASS",
        exit_code: 0,
        evidence_path: "x",
        attempts: [
          { attempt: 1, status: "FAIL", reason: "EXIT_1" },
          { attempt: 2, status: "PASS" },
        ],
      });
      expect.unreachable("hidden flake must be refused");
    } catch (error) {
      expect((error as { reason: string }).reason).toBe("INVALID_RESULT");
      expect((error as { problems: string[] }).problems.join(" ")).toContain(
        "FLAKY"
      );
    }
  });
});

// ---------------------------------------------------------------------------
// P04.FI01 — kill the executor mid-gate (uncatchable boundary + recovery)
// ---------------------------------------------------------------------------
describe("P04.FI01 kill -9 the executor mid-gate", () => {
  it("SIGKILL prevents in-process teardown BY DEFINITION; next-invocation discovery reaps verified orphans and reclaims the stale lane with classification", async () => {
    const { root } = freshRoot();
    const { ready, exit_signal } = await driveAndSignal(root, "SIGKILL");
    expect(exit_signal).toBe("SIGKILL");
    // The uncatchable boundary, stated honestly: owned children SURVIVE
    // (they are their own process groups), the lane lock is now stale.
    const survivors = ready.pids.filter(pid => pidAlive(pid));
    expect(survivors.length).toBeGreaterThan(0);
    // No manifest — the killed run can never read as complete.
    expect(() => readExecutorEvidence(ready.run_dir)).toThrow(/INCOMPLETE_RUN/);
    // RECOVERY (what a next invocation does): marker-verified discovery.
    const marked = findMarkedProcesses(ready.run_id);
    expect(marked.length).toBeGreaterThan(0);
    for (const orphan of marked) {
      const outcome = await killVerifiedOwned(orphan.pid, ready.run_id);
      expect(["killed", "already-dead"]).toContain(outcome.action);
    }
    expect(findMarkedProcesses(ready.run_id)).toEqual([]);
    // Stale lane: detected, CLASSIFIED, reclaimed via the journaled path.
    const recovery = new LaneManager({
      root: ready.lanes_root,
      run_id: "recovery-run",
    });
    const state = recovery.inspect("db");
    expect(state.state).toBe("STALE");
    expect(() => recovery.tryAcquire("db", "recovery-gate")).toThrow(
      /STALE_LOCK/
    );
    const reclaim = recovery.reclaimStale("db");
    expect(reclaim.previous.state).toBe("STALE");
    expect(recovery.inspect("db").state).toBe("FREE");
    const audit = auditLaneJournal(
      path.join(ready.lanes_root, "db.journal.jsonl")
    );
    expect(
      audit.intervals.some(
        (i: { release_state: string }) => i.release_state === "STALE_RECLAIMED"
      )
    ).toBe(true);
  }, 30_000);

  it("the three termination boundaries are distinct and honestly claimed", async () => {
    // SIGINT (catchable): NEG03 proved in-process teardown runs => exit 130.
    // SIGKILL (uncatchable): this suite proved survivors + stale lock =>
    // recovery is NEXT-invocation discovery, not an in-process guarantee.
    // Catchable exception: TeardownRegistry.wireSignals routes
    // uncaughtException through runAll — proven at registry level here.
    const root = path.join(SCRATCH, "fi01-exception");
    mkdirSync(root, { recursive: true });
    const registry = new TeardownRegistry({
      run_id: "run-ex",
      owned_root: root,
    });
    let cleaned = false;
    registry.register({
      type: "process",
      id: "x",
      cleanup: () => {
        cleaned = true;
      },
    });
    const report = await registry.runAll("uncaughtException");
    expect(cleaned).toBe(true);
    expect(report.clean).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// P04.FI02 — deterministic budget exhaustion
// ---------------------------------------------------------------------------
describe("P04.FI02 exhaust the memory budget", () => {
  it("admission serializes hinted gates, refuses the impossible one as INFRA (not product FAIL), and never fans out", async () => {
    const { root, cwd } = freshRoot();
    const run = makeRun(
      [
        fixtureGate("mem-a", [path.join(FIXTURES, "sleep.mjs"), "120"], cwd, {
          memory_hint_mb: 600,
        }),
        fixtureGate("mem-b", [path.join(FIXTURES, "sleep.mjs"), "120"], cwd, {
          memory_hint_mb: 600,
        }),
        fixtureGate("mem-huge", [path.join(FIXTURES, "sleep.mjs"), "10"], cwd, {
          memory_hint_mb: 4096,
        }),
      ],
      root,
      {
        budget: {
          max_concurrency: 4,
          memory_budget_mb: 1000,
        },
      }
    );
    const outcome = await run.execute();
    const byId = Object.fromEntries(outcome.results.map(r => [r.gate_id, r]));
    // The two hinted gates both ran (serialized) and passed.
    expect(byId["mem-a"].status).toBe("PASS");
    expect(byId["mem-b"].status).toBe("PASS");
    // The impossible gate is refused as infrastructure/resource state.
    expect(byId["mem-huge"].status).toBe("INFRA_FAIL");
    expect(byId["mem-huge"].status).not.toBe("FAIL");
    expect(byId["mem-huge"].reason).toContain("RESOURCE_ADMISSION_IMPOSSIBLE");
    expect(byId["mem-huge"].attempts).toEqual([]); // never started
    // Decision log: at least one WAIT (serialization), and the impossible
    // admission is journaled.
    const events = readFileSync(run.executorLog, "utf8")
      .split("\n")
      .filter(Boolean)
      .map(line => JSON.parse(line));
    const admissions = events.filter(
      e => e.type === "SCHED_DECISION" && e.kind === "ADMISSION"
    );
    expect(admissions.some(a => a.decision === "WAIT")).toBe(true);
    expect(admissions.some(a => a.decision === "IMPOSSIBLE")).toBe(true);
    // No fan-out: the two 600MB gates never ran concurrently.
    const spawned = events.filter(e => e.type === "ATTEMPT_SPAWNED");
    expect(spawned).toHaveLength(2);
    // Structural: mem-b spawns only after mem-a's ATTEMPT (completion) event.
    const aDone = events.findIndex(
      e => e.type === "ATTEMPT" && e.gate_id === "mem-a"
    );
    const bSpawn = events.findIndex(
      e => e.type === "ATTEMPT_SPAWNED" && e.gate_id === "mem-b"
    );
    expect(aDone).toBeGreaterThan(-1);
    expect(bSpawn).toBeGreaterThan(aDone);
    expect(outcome.manifest.teardown_clean).toBe(true);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// P04.CLN01 — SIGINT teardown: 10 of 10 runs leave zero residue
// ---------------------------------------------------------------------------
describe("P04.CLN01 SIGINT teardown leaves zero residue, 10 of 10", () => {
  it("ten consecutive interrupted runs each tear down completely", async () => {
    const iterations: Array<Record<string, unknown>> = [];
    for (let i = 1; i <= 10; i += 1) {
      const { root } = freshRoot();
      const { ready, exit_code } = await driveAndSignal(root, "SIGINT");
      const residue = residueOf(ready.run_id, ready.lanes_root, ready.run_dir);
      const childrenDead = ready.pids.every(pid => !pidAlive(pid));
      const record = {
        iteration: i,
        run_id: ready.run_id,
        exit_code,
        nonzero_exit: exit_code !== 0,
        children_dead: childrenDead,
        marked_processes: residue.marked_processes.length,
        lane_locks: residue.lane_locks.length,
        tmp_dir_exists: residue.tmp_dir_exists,
        manifest_exists: residue.manifest_exists,
      };
      iterations.push(record);
      // EVERY iteration must independently pass — 9/10 is a FAIL.
      expect(record.nonzero_exit, `iteration ${i} exit`).toBe(true);
      expect(record.children_dead, `iteration ${i} children`).toBe(true);
      expect(record.marked_processes, `iteration ${i} processes`).toBe(0);
      expect(record.lane_locks, `iteration ${i} locks`).toBe(0);
      expect(record.tmp_dir_exists, `iteration ${i} tmp`).toBe(false);
      expect(record.manifest_exists, `iteration ${i} manifest`).toBe(false);
    }
    expect(iterations).toHaveLength(10);
    // Persist the per-iteration record for the evidence bundle. Default:
    // the suite scratch (removed on exit); an evidence-collection pass
    // points CI_VERIFY_P04_EVIDENCE_DIR at the durable evidence directory.
    const evidenceDir = process.env.CI_VERIFY_P04_EVIDENCE_DIR ?? SCRATCH;
    writeFileSync(
      path.join(evidenceDir, "cln01-iterations.json"),
      JSON.stringify(iterations, null, 2)
    );
  }, 120_000);
});

// ---------------------------------------------------------------------------
// P04.AUD01-03 as tests
// ---------------------------------------------------------------------------
describe("P04 audits are green on the shipped modules", () => {
  it("AUD01 teardown ownership: zero broad destructive mechanisms", () => {
    const audit = auditTeardownOwnership();
    expect(audit.findings).toEqual([]);
    expect(audit.ok).toBe(true);
    expect(audit.classified.length).toBeGreaterThan(0);
  });
  it("AUD02 spawn-path fidelity: one spawn site, direct exit capture", () => {
    const audit = auditSpawnPaths();
    expect(audit.findings).toEqual([]);
    expect(audit.ok).toBe(true);
    expect(
      audit.paths.filter((p: { kind: string }) => p.kind === "gate child")
    ).toHaveLength(1);
  });
  it("AUD03 P03 integration: one taxonomy, one reporter, one registry, one ledger", () => {
    const audit = auditP03Integration();
    expect(audit.findings).toEqual([]);
    expect(audit.ok).toBe(true);
    expect(audit.evidence.length).toBeGreaterThanOrEqual(4);
  });
});
