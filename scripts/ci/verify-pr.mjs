#!/usr/bin/env node
/**
 * ci:verify:pr — the one command a developer (or agent) runs before opening
 * a PR. No tribal knowledge, no hidden setup: it refuses loudly when a
 * prerequisite is missing, runs every local stage SERIALLY (the DEF-047
 * contention law), measures itself, and ends by issuing the
 * LOCAL_READY_FOR_PR certificate — or telling you exactly why not.
 *
 * Stages: preflight → P06 roster → P06 ASSURANCE → P07 (tests/coverage/db)
 *         → P08 cleanroom → P09 hardening → negative suites → certificate.
 *
 * Usage: pnpm ci:verify:pr        (or: node scripts/ci/verify-pr.mjs)
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveBase, resolveHead } from "./snapshot.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..");
const OUT = path.join(REPO_ROOT, ".ci-verify", "verify-pr");

// When invoked AS a pnpm script, children inherit pnpm-run's corepack
// strictness — and a packageManager-pin/machine-pnpm mismatch then fails
// every child `pnpm` call ("pnpm missing") even though direct invocation
// works. Found by this rehearsal's own first run. Strip the run-context so
// children resolve the shell toolchain exactly as a direct `node` launch
// does; nothing else about the environment changes.
const CLEAN_ENV = Object.fromEntries(
  Object.entries(process.env).filter(
    ([k]) => !/^(npm_|COREPACK_|PNPM_)/i.test(k)
  )
);

const STAGES = [
  { id: "p06-roster", cmd: ["node", "scripts/ci/p06/run-gates.mjs"] },
  { id: "p06-assurance", cmd: ["node", "scripts/ci/p06/assurance.mjs"] },
  { id: "p07", cmd: ["node", "scripts/ci/p07/run-p07.mjs", "all"] },
  { id: "p08", cmd: ["node", "scripts/ci/p08/run-p08.mjs", "all"] },
  { id: "p09", cmd: ["node", "scripts/ci/p09/run-p09.mjs", "all"] },
  {
    id: "negatives",
    cmd: [
      "npx",
      "vitest",
      "run",
      "scripts/ci/p06/p06.test.ts",
      "scripts/ci/p07/p07.test.ts",
      "scripts/ci/selftest/timeout-consistency.test.ts",
      "scripts/ci/selftest/certificate-binding.test.ts",
      "scripts/ci/ledger-lease.test.ts",
      "scripts/ci/deploy/deploy.test.ts",
    ],
    env: { VITEST_MAX_FORKS: "4", VITEST_MAX_THREADS: "4" },
  },
  {
    id: "certificate",
    cmd: ["node", "scripts/ci/p10/certificate.mjs", "issue"],
  },
];

// DEF-067 — the report must prove BY ITSELF which commit it describes;
// identity comes from P01 (snapshot.mjs), never from raw git here.
export function identityBindings() {
  return {
    head_sha: resolveHead(REPO_ROOT),
    base_sha: resolveBase(REPO_ROOT, { fetch: false }).base_sha,
  };
}

function preflight() {
  const problems = [];
  const probe = (cmd, args) => {
    try {
      execFileSync(cmd, args, {
        encoding: "utf8",
        timeout: 15_000,
        env: CLEAN_ENV,
      });
      return true;
    } catch {
      return false;
    }
  };
  if (!probe("docker", ["version", "--format", "{{.Server.Version}}"]))
    problems.push(
      "docker daemon unreachable (P07 MySQL fixture + P08 cleanroom need it)"
    );
  if (!probe("pnpm", ["--version"])) problems.push("pnpm missing");
  if (!process.version.startsWith("v22."))
    problems.push(`node ${process.version} — CI pins 22.x`);
  return problems;
}

function main() {
  mkdirSync(OUT, { recursive: true });
  const t0 = Date.now();
  const report = {
    started_at: new Date().toISOString(),
    host: {
      cores: os.cpus().length,
      platform: `${os.platform()}/${os.arch()}`,
    },
    stages: [],
  };

  const missing = preflight();
  if (missing.length) {
    // stdout, one line each, grep-safe: a refusal nobody can see is a trap
    for (const m of missing)
      console.log(`[ci:verify:pr] PRECONDITION MISSING: ${m}`);
    process.exitCode = 4;
    return;
  }

  Object.assign(report, identityBindings());

  for (const stage of STAGES) {
    const started = Date.now();
    const loadBefore = os.loadavg()[0];
    console.log(`[ci:verify:pr] ▶ ${stage.id}`);
    // /usr/bin/time -l gives child-tree peak RSS on darwin
    const res = spawnSync("/usr/bin/time", ["-l", ...stage.cmd], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      timeout: 3_600_000,
      maxBuffer: 128 * 1024 * 1024,
      env: { ...CLEAN_ENV, ...(stage.env ?? {}) },
    });
    const wall = Date.now() - started;
    const rssMatch = (res.stderr ?? "").match(
      /(\d+)\s+maximum resident set size/
    );
    const record = {
      id: stage.id,
      ok: res.status === 0,
      wall_s: Math.round(wall / 100) / 10,
      peak_rss_mb: rssMatch ? Math.round(Number(rssMatch[1]) / 1e6) : null,
      load_before: loadBefore,
      tail: `${res.stdout ?? ""}`.split("\n").filter(Boolean).slice(-4),
    };
    report.stages.push(record);
    console.log(
      `[ci:verify:pr] ${record.ok ? "✓" : "✗"} ${stage.id} ${record.wall_s}s` +
        (record.peak_rss_mb ? ` peakRSS=${record.peak_rss_mb}MB` : "")
    );
    if (!record.ok) {
      console.error(record.tail.join("\n"));
      report.verdict = `FAILED_AT: ${stage.id}`;
      break;
    }
  }

  report.total_wall_s = Math.round((Date.now() - t0) / 100) / 10;
  report.slowest = [...report.stages]
    .sort((a, b) => b.wall_s - a.wall_s)
    .slice(0, 3)
    .map(s => `${s.id}:${s.wall_s}s`);
  report.verdict ??= "LOCAL_READY_FOR_PR";
  report.finished_at = new Date().toISOString();
  writeFileSync(
    path.join(OUT, "report.json"),
    JSON.stringify(report, null, 2) + "\n"
  );
  console.log(
    `[ci:verify:pr] ${report.verdict} — total ${report.total_wall_s}s; slowest: ${report.slowest.join(", ")}`
  );
  process.exitCode = report.verdict === "LOCAL_READY_FOR_PR" ? 0 : 1;
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
) {
  main();
}
