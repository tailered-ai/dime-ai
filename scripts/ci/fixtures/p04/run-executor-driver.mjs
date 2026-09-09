// Fixture driver for P04.NEG03 / P04.CLN01 / P04.FI01: a REAL executor run
// in an isolated scratch root, interruptible from the outside.
//
// Usage: node run-executor-driver.mjs --root <scratch> [--hold-ms 15000]
//
// Protocol on stdout (line-delimited JSON):
//   {"marker":"READY", run_id, run_dir, lanes_root, pids:[...]}   <- both
//     fixture children are live; owned resources (lane, port, tmpdirs) held
//   {"marker":"DONE", ...}                                        <- only on
//     uninterrupted completion
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync } from "node:fs";
import { ExecutorRun } from "../../executor.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? fallback : args[index + 1];
};
const root = flag("root", null);
if (!root) {
  console.error("--root required");
  process.exit(2);
}
const holdMs = Number(flag("hold-ms", "15000"));
const runsRoot = path.join(root, "runs");
const lanesRoot = path.join(root, "lanes");
const cwd = path.join(root, "cwd");
mkdirSync(cwd, { recursive: true });

const sleeper = holdArg => ({
  command: { argv: [process.execPath, path.join(here, "sleep.mjs"), holdArg] },
  cwd,
  class: "PARITY",
  timeout_ms: holdMs + 30_000,
});

const run = new ExecutorRun({
  specs: [
    {
      gate_id: "fx-db-sleeper",
      ...sleeper(String(holdMs)),
      lane: "db",
      needs_port: true,
    },
    {
      gate_id: "fx-plain-sleeper",
      ...sleeper(String(holdMs)),
    },
  ],
  candidate: {
    head_sha: "f".repeat(40),
    base_sha: "e".repeat(40),
    merge_tree_sha: "d".repeat(40),
    merge_commit_sha: "c".repeat(40),
  },
  budget: { max_concurrency: 2 },
  runsRoot,
  lanesRoot,
  onEvent: event => {
    if (event.type === "ATTEMPT_SPAWNED") {
      pids.push(event.pid);
      if (pids.length === 2) {
        console.log(
          JSON.stringify({
            marker: "READY",
            run_id: run.run_id,
            run_dir: run.runDir,
            lanes_root: lanesRoot,
            pids,
          })
        );
      }
    }
  },
});
const pids = [];

run
  .execute()
  .then(outcome => {
    console.log(
      JSON.stringify({
        marker: "DONE",
        run_id: outcome.run_id,
        statuses: outcome.results.map(r => `${r.gate_id}=${r.status}`),
      })
    );
  })
  .catch(error => {
    console.error(error?.reason ?? error?.message);
    process.exit(3);
  });
