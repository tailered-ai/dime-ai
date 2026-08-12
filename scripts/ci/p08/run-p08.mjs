#!/usr/bin/env node
/**
 * p08/run-p08.mjs — CLEANROOM: can the accepted candidate be built, scanned,
 * started, degraded, operated, and shut down from a controlled container
 * environment — repeatedly, with zero residue?
 *
 * Blueprint units: T01 images.pinned.json · T02 base-digest RECORD (DEC-001 =
 * RECORD_ONLY: FROM is never edited) · T03 build per the repo's own contract ·
 * T04 trivy CRITICAL fixable-only · T05 SBOM · T06 profile A (dead DB) ·
 * T07 profile B (healthy DB) · T08 build-variance (ADVISORY) ·
 * NEG01/NEG02/NEG03 · TEST01-03 · GATE01 (3 consecutive A+B) · CLN01.
 *
 * Boundary law carried over from P06: infrastructure conditions (docker
 * daemon, image pulls, a database WE killed) are never candidate verdicts.
 * Profile assertions come from the repository's own runtime contract — the
 * 09-artifact workflow's boot recipe and scripts/smoke-deploy.mjs — so this
 * phase proves the same thing CI proves, plus operation and teardown.
 *
 * Usage: node scripts/ci/p08/run-p08.mjs [all|build|profiles|negatives|gate]
 */
import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { runSnapshot, disposeSnapshot } from "../snapshot.mjs";
import { provisionCandidate } from "../p06/capability.mjs";
import { bootstrapTools } from "../p06/tools.mjs";
import { startOwnedMysql, daemonInfo, inventory } from "../p07/mysql.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..", "..");
const OUT = path.join(REPO_ROOT, ".ci-verify", "p08");
const EVIDENCE = path.join(REPO_ROOT, "docs/verification/evidence/p08");
const PORT_A = 3911;
const PORT_B = 3912;
const HEALTH_POLLS = 40;
const HEALTH_INTERVAL_MS = 3000;
const STABILITY_WINDOW_MS = 12_000;
const STOP_GRACE_S = 25;

function sh(cmd, args, opts = {}) {
  return execFileSync(cmd, args, {
    encoding: "utf8",
    cwd: opts.cwd ?? REPO_ROOT,
    timeout: opts.timeout_ms ?? 600_000,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...opts.env },
    maxBuffer: 64 * 1024 * 1024,
  });
}
function docker(args, opts = {}) {
  return sh("docker", args, opts).trim();
}
function tryDocker(args, opts = {}) {
  try {
    return { ok: true, out: docker(args, opts) };
  } catch (error) {
    return {
      ok: false,
      out: `${error.stdout ?? ""}${error.stderr ?? ""}`.slice(-800),
    };
  }
}

/** INFRA vs candidate: docker daemon must answer before any verdict. */
function requireDaemon() {
  const info = daemonInfo();
  if (!info.reachable) {
    const err = new Error("DOCKER_DAEMON_UNREACHABLE — INFRA, not a verdict");
    err.code = "INFRA";
    throw err;
  }
  return info;
}

// ---------------------------------------------------------------------------
// T01/T02 — image identity, RECORD_ONLY (DEC-001). FROM is never edited.
// ---------------------------------------------------------------------------
export function recordImageIdentities() {
  requireDaemon();
  const dockerfile = readFileSync(path.join(REPO_ROOT, "Dockerfile"), "utf8");
  const froms = [...dockerfile.matchAll(/^FROM\s+(\S+)/gm)].map(m => m[1]);
  const bases = [...new Set(froms)].map(ref => {
    // resolve the digest the daemon actually has (pull if absent)
    let digest = tryDocker([
      "image",
      "inspect",
      ref,
      "--format",
      "{{index .RepoDigests 0}}",
    ]);
    if (!digest.ok || !digest.out) {
      docker(["pull", ref], { timeout_ms: 300_000 });
      digest = tryDocker([
        "image",
        "inspect",
        ref,
        "--format",
        "{{index .RepoDigests 0}}",
      ]);
    }
    return { ref, resolved_digest: digest.out || null };
  });
  const mysql = JSON.parse(
    readFileSync(path.join(EVIDENCE, "P08-ENTRY.json"), "utf8")
  ).db_evidence;
  const pinned = {
    schema: "ci-verify/images.pinned.v1",
    decision: "DEC-001=RECORD_ONLY — digests recorded, FROM never edited",
    dockerfile_bases: bases,
    mysql_fixture: mysql,
    recorded_at: new Date().toISOString(),
  };
  mkdirSync(OUT, { recursive: true });
  writeFileSync(
    path.join(OUT, "images.pinned.json"),
    JSON.stringify(pinned, null, 2) + "\n"
  );
  return pinned;
}

// ---------------------------------------------------------------------------
// T03 — the repository's own build contract: `docker build -t <tag> .`
// ---------------------------------------------------------------------------
export function buildCandidate(worktree, tag) {
  requireDaemon();
  const started = Date.now();
  // --progress=plain so a slow stage is diagnosable from the log; 45min
  // budget because a COLD buildkit cache legitimately takes ~30min on this
  // image (measured 2026-08-12; warm rebuilds are minutes).
  const res = spawnSync(
    "docker",
    ["build", "--progress=plain", "-t", tag, "."],
    {
      cwd: worktree,
      encoding: "utf8",
      timeout: 2_700_000,
      maxBuffer: 64 * 1024 * 1024,
    }
  );
  mkdirSync(OUT, { recursive: true });
  writeFileSync(
    path.join(OUT, "build.log"),
    `${res.stdout ?? ""}\n${res.stderr ?? ""}`.slice(-200_000)
  );
  // A verifier-imposed timeout (or any signal kill) is an INFRA condition,
  // never a candidate verdict — the DEF-031 boundary law. Only a clean
  // nonzero exit from docker build itself is a candidate build failure.
  if (res.signal || res.error) {
    const err = new Error(
      `BUILD_INTERRUPTED_BY_VERIFIER: signal=${res.signal ?? ""} ` +
        `error=${res.error?.code ?? ""} after ${Date.now() - started}ms — ` +
        `INFRA, not a candidate verdict`
    );
    err.code = "INFRA";
    throw err;
  }
  const ok = res.status === 0;
  const imageId = ok
    ? docker(["image", "inspect", tag, "--format", "{{.Id}}"])
    : null;
  return {
    ok,
    tag,
    image_id: imageId,
    duration_ms: Date.now() - started,
    tail: `${res.stdout ?? ""}${res.stderr ?? ""}`.slice(-1500),
  };
}

// ---------------------------------------------------------------------------
// T04 — trivy: CRITICAL, fixable-only, blocking. (The nightly full sweep is
// DEF-046's separate, stricter, base-red gate — deliberately not this one.)
// ---------------------------------------------------------------------------
export function trivyGate(tools, tag) {
  const trivy = tools.resolved.trivy.path;
  const res = spawnSync(
    trivy,
    [
      "image",
      "--severity",
      "CRITICAL",
      "--ignore-unfixed",
      "--exit-code",
      "1",
      "--format",
      "table",
      "--scanners",
      "vuln",
      tag,
    ],
    { encoding: "utf8", timeout: 900_000, maxBuffer: 64 * 1024 * 1024 }
  );
  writeFileSync(path.join(OUT, "trivy.table"), res.stdout ?? "");
  return {
    ok: res.status === 0,
    exit: res.status,
    tail: (res.stdout ?? "").slice(-600),
  };
}

// ---------------------------------------------------------------------------
// T05 — SBOM via governed syft. TEST03: non-empty.
// ---------------------------------------------------------------------------
export function sbomGate(tools, tag) {
  const syft = tools.resolved.syft.path;
  const res = spawnSync(syft, [tag, "-o", "spdx-json"], {
    encoding: "utf8",
    timeout: 900_000,
    maxBuffer: 256 * 1024 * 1024,
  });
  if (res.status !== 0) {
    return { ok: false, tail: (res.stderr ?? "").slice(-400) };
  }
  writeFileSync(path.join(OUT, "sbom.spdx.json"), res.stdout);
  let packages = 0;
  try {
    packages = JSON.parse(res.stdout).packages?.length ?? 0;
  } catch {
    return { ok: false, tail: "SBOM_UNPARSEABLE" };
  }
  // "non-empty" made concrete: a node app image legitimately carries
  // hundreds of packages; single digits means syft saw nothing real.
  return { ok: packages >= 50, packages };
}

// ---------------------------------------------------------------------------
// Runtime profiles. Assertions ARE the repo's own contract (09-artifact +
// smoke-deploy.mjs), executed against a container we own by label.
// ---------------------------------------------------------------------------
function startApp({ tag, name, port, dbUrl, commitSha, marker, secret }) {
  return docker([
    "run",
    "-d",
    "--name",
    name,
    "--label",
    `ci-verify-owner=${marker}`,
    "--add-host",
    "host.docker.internal:host-gateway",
    "-p",
    `127.0.0.1:${port}:3000`,
    "-e",
    "NODE_ENV=production",
    "-e",
    "PORT=3000",
    "-e",
    `APP_SESSION_SECRET=${secret}`,
    "-e",
    `DATABASE_URL=${dbUrl}`,
    "-e",
    "PUBLIC_ORIGIN=https://ai-sports-betting-dime-ai-production.up.railway.app",
    "-e",
    `RAILWAY_GIT_COMMIT_SHA=${commitSha}`,
    tag,
  ]);
}

async function pollHealth(port) {
  for (let i = 1; i <= HEALTH_POLLS; i += 1) {
    const res = spawnSync(
      "curl",
      ["-sf", "-m", "5", `http://127.0.0.1:${port}/health`],
      { encoding: "utf8" }
    );
    if (res.status === 0) return { up: true, polls: i, body: res.stdout };
    await new Promise(r => setTimeout(r, HEALTH_INTERVAL_MS));
  }
  return { up: false, polls: HEALTH_POLLS };
}

function containerState(id) {
  const out = docker([
    "inspect",
    "--format",
    "{{.State.Running}} {{.RestartCount}} {{.State.ExitCode}}",
    id,
  ]).split(" ");
  return {
    running: out[0] === "true",
    restarts: Number(out[1]),
    exit_code: Number(out[2]),
  };
}

function destroyOwned(id, marker) {
  const owner = tryDocker([
    "inspect",
    "--format",
    '{{ index .Config.Labels "ci-verify-owner" }}',
    id,
  ]);
  if (owner.ok && owner.out !== marker) {
    throw new Error(`OWNERSHIP_MISMATCH: refusing to remove ${id}`);
  }
  return tryDocker(["rm", "-fv", id]);
}

/**
 * Profile A — the crash-guard holds with a DEAD database.
 * Contract: /health serves; commit identity reported; chat gate returns a
 * structured 401 (not 500, not HTML); "Server listening" appears in logs;
 * no restart loop across the stability window; no secret value in logs;
 * stop-and-remove leaves nothing.
 */
export async function profileA({ tag, commitSha, marker, worktree }) {
  const checks = {};
  const secret = randomBytes(36).toString("base64");
  const name = `cv-p08a-${marker}`;
  const id = startApp({
    tag,
    name,
    port: PORT_A,
    // 09-artifact's own dead-DB recipe: loopback inside the container.
    dbUrl: "mysql://u:p@127.0.0.1:3306/db",
    commitSha,
    marker,
    secret,
  });
  try {
    const health = await pollHealth(PORT_A);
    checks.health_up = health.up;
    checks.health_polls = health.polls;
    if (!health.up) return { ok: false, checks };

    // the repo's own smoke suite, with build identity bound to the candidate
    const smoke = spawnSync(
      "node",
      [
        path.join(worktree, "scripts/smoke-deploy.mjs"),
        `http://127.0.0.1:${PORT_A}`,
      ],
      {
        encoding: "utf8",
        timeout: 300_000,
        env: { ...process.env, EXPECTED_COMMIT: commitSha },
      }
    );
    checks.smoke_ok = smoke.status === 0;
    checks.smoke_tail = `${smoke.stdout ?? ""}${smoke.stderr ?? ""}`.slice(
      -500
    );

    const chat = spawnSync(
      "curl",
      [
        "-s",
        "-o",
        path.join(OUT, "chat-a.json"),
        "-w",
        "%{http_code}",
        "-X",
        "POST",
        `http://127.0.0.1:${PORT_A}/api/dime/chat`,
        "-H",
        "content-type: application/json",
        "-d",
        '{"messages":[{"role":"user","content":"x"}]}',
      ],
      { encoding: "utf8" }
    );
    checks.chat_status = chat.stdout.trim();
    let structured = false;
    try {
      structured = !!JSON.parse(
        readFileSync(path.join(OUT, "chat-a.json"), "utf8")
      ).error;
    } catch {}
    checks.chat_structured_401 = chat.stdout.trim() === "401" && structured;

    await new Promise(r => setTimeout(r, STABILITY_WINDOW_MS));
    const state = containerState(id);
    checks.no_crash_loop = state.running && state.restarts === 0;

    const logs = docker(["logs", name], { timeout_ms: 30_000 });
    checks.listen_line = /Server listening/.test(logs);
    checks.no_secret_leak = !logs.includes(secret);
    writeFileSync(path.join(OUT, "profile-a.log"), logs.slice(-20_000));

    const stop = spawnSync(
      "docker",
      ["stop", "-t", String(STOP_GRACE_S), name],
      {
        encoding: "utf8",
        timeout: (STOP_GRACE_S + 15) * 1000,
      }
    );
    checks.stopped_within_grace = stop.status === 0;
    checks.exit_code = containerState(id).exit_code;

    const ok =
      checks.health_up &&
      checks.smoke_ok &&
      checks.chat_structured_401 &&
      checks.no_crash_loop &&
      checks.listen_line &&
      checks.no_secret_leak &&
      checks.stopped_within_grace;
    return { ok, checks };
  } finally {
    destroyOwned(name, marker);
  }
}

/**
 * Profile B — healthy system on the digest-bound MySQL fixture.
 * Adds: reconciled migration replay, /health at the exact candidate commit,
 * graceful SIGTERM (exit 0), database connections closed, zero residue.
 */
export async function profileB({
  tag,
  commitSha,
  marker,
  worktree,
  negKillMysql = false,
  expectedCommitOverride = null,
}) {
  const checks = {};
  const secret = randomBytes(36).toString("base64");
  const name = `cv-p08b-${marker}`;
  let mysql = null;
  let appStarted = false;
  try {
    mysql = await startOwnedMysql(marker);
    checks.mysql_ready = true;

    // migrations from the provisioned candidate, against the fixture
    const mig = spawnSync("pnpm", ["db:migrate:reconciled"], {
      cwd: worktree,
      encoding: "utf8",
      timeout: 600_000,
      env: {
        ...process.env,
        DATABASE_URL: "mysql://root@127.0.0.1:3306/dime_test",
      },
    });
    checks.migrations_ok = mig.status === 0;
    if (!checks.migrations_ok) {
      checks.migrations_tail = `${mig.stdout ?? ""}${mig.stderr ?? ""}`.slice(
        -400
      );
      return { ok: false, checks };
    }

    const id = startApp({
      tag,
      name,
      port: PORT_B,
      dbUrl: "mysql://root@host.docker.internal:3306/dime_test",
      commitSha,
      marker,
      secret,
    });
    appStarted = true;

    const health = await pollHealth(PORT_B);
    checks.health_up = health.up;
    if (!health.up) {
      checks.app_logs_tail = tryDocker(["logs", name]).out.slice(-600);
      return { ok: false, checks };
    }

    if (negKillMysql) {
      // NEG03 — WE kill the database mid-run. Whatever happens next is an
      // infrastructure condition by construction, never a candidate verdict.
      mysql.destroy();
      mysql = null;
      await new Promise(r => setTimeout(r, 5000));
      const state = containerState(id);
      checks.neg03_app_survives_probe = state.running;
      return { ok: true, checks, classification: "INFRA-FAIL(SYNTHETIC)" };
    }

    const smoke = spawnSync(
      "node",
      [
        path.join(worktree, "scripts/smoke-deploy.mjs"),
        `http://127.0.0.1:${PORT_B}`,
      ],
      {
        encoding: "utf8",
        timeout: 300_000,
        env: {
          ...process.env,
          EXPECTED_COMMIT: expectedCommitOverride ?? commitSha,
        },
      }
    );
    checks.smoke_ok = smoke.status === 0;
    checks.smoke_tail = `${smoke.stdout ?? ""}${smoke.stderr ?? ""}`.slice(
      -500
    );

    await new Promise(r => setTimeout(r, STABILITY_WINDOW_MS));
    const state = containerState(id);
    checks.no_crash_loop = state.running && state.restarts === 0;

    const logs = docker(["logs", name], { timeout_ms: 30_000 });
    checks.listen_line = /Server listening/.test(logs);
    checks.no_secret_leak = !logs.includes(secret);
    // background jobs must respect gating in this environment (no live
    // provider calls): any explicit crash from a scheduler would show here.
    checks.no_unhandled_rejection = !/UnhandledPromiseRejection|FATAL/i.test(
      logs
    );
    writeFileSync(path.join(OUT, "profile-b.log"), logs.slice(-20_000));

    const stop = spawnSync(
      "docker",
      ["stop", "-t", String(STOP_GRACE_S), name],
      {
        encoding: "utf8",
        timeout: (STOP_GRACE_S + 15) * 1000,
      }
    );
    checks.stopped_within_grace = stop.status === 0;
    checks.graceful_exit_0 = containerState(name).exit_code === 0;

    // connections closed: only this probe's own session may remain
    const plist = docker([
      "exec",
      `cv-mysql-${marker}`,
      "mysql",
      "-uroot",
      "-N",
      "-e",
      "SELECT COUNT(*) FROM information_schema.processlist WHERE user NOT IN ('event_scheduler') AND id <> CONNECTION_ID();",
    ]);
    checks.db_connections_closed = Number(plist.trim()) === 0;

    const ok =
      checks.health_up &&
      checks.smoke_ok &&
      checks.no_crash_loop &&
      checks.listen_line &&
      checks.no_secret_leak &&
      checks.no_unhandled_rejection &&
      checks.stopped_within_grace &&
      checks.graceful_exit_0 &&
      checks.db_connections_closed;
    return { ok, checks };
  } finally {
    if (appStarted) destroyOwned(name, marker);
    if (mysql) mysql.destroy();
  }
}

// ---------------------------------------------------------------------------
// CLN01 — zero residue, proven from a docker inventory diff per run.
// ---------------------------------------------------------------------------
export function residueReport(before) {
  const after = inventory();
  const newContainers = after.containers.filter(
    c => !before.containers.some(b => b.id === c.id)
  );
  const newVolumes = after.volumes.filter(v => !before.volumes.includes(v));
  return {
    zero: newContainers.length === 0 && newVolumes.length === 0,
    new_containers: newContainers,
    new_volumes: newVolumes,
  };
}

// ---------------------------------------------------------------------------
// Negatives.
// ---------------------------------------------------------------------------
export function neg01BrokenDockerfile(worktree, marker) {
  const poisoned = path.join(OUT, `neg01-${marker}`);
  rmSync(poisoned, { recursive: true, force: true });
  cpSync(worktree, poisoned, { recursive: true });
  const df = path.join(poisoned, "Dockerfile");
  writeFileSync(
    df,
    readFileSync(df, "utf8") + "\nRUN exit 41 # p06-poison-style NEG01 marker\n"
  );
  const build = buildCandidate(poisoned, `cv-p08-neg01:${marker}`);
  rmSync(poisoned, { recursive: true, force: true });
  tryDocker(["rmi", `cv-p08-neg01:${marker}`]);
  return {
    ok: build.ok === false,
    detail: "build failed before any runtime gate could execute",
    tail: build.tail.slice(-200),
  };
}

async function main() {
  const mode = process.argv[2] ?? "all";
  mkdirSync(OUT, { recursive: true });
  mkdirSync(EVIDENCE, { recursive: true });
  const tools = bootstrapTools();
  const before = inventory();

  // P01 is the sole identity authority — committed-mode candidate.
  const handle = runSnapshot({ mode: "committed", keepRunDir: true });
  const worktree = handle.paths.worktree;
  const identity = handle.snapshot.identity;
  const marker = `p08-${Date.now().toString(36)}`;
  const tag = `dime-cleanroom:${identity.merge_commit_sha.slice(0, 12)}`;
  const results = { identity, marker, tag, gates: {} };

  try {
    console.log(
      `[p08] candidate ${identity.merge_commit_sha.slice(0, 12)} on base ${identity.base_sha.slice(0, 12)}`
    );
    const prov = provisionCandidate(worktree);
    console.log(`[p08] provisioned: ${prov.ok} in ${prov.duration_ms}ms`);
    if (!prov.ok)
      throw Object.assign(new Error("PROVISIONING_FAILED"), { code: "INFRA" });

    results.gates.images = recordImageIdentities();
    console.log(`[p08] T01/T02 image identities recorded`);

    const build = buildCandidate(worktree, tag);
    results.gates.build = build;
    console.log(
      `[p08] T03 build: ${build.ok} (${(build.duration_ms / 1000).toFixed(1)}s) id=${build.image_id?.slice(7, 19)}`
    );
    if (!build.ok) {
      console.log(build.tail);
      throw new Error("BUILD_FAILED — candidate defect");
    }
    writeFileSync(
      path.join(OUT, "image-id.txt"),
      `${build.image_id}\n${tag}\n`
    );

    if (mode === "all" || mode === "build") {
      results.gates.trivy = trivyGate(tools, tag);
      console.log(
        `[p08] T04 trivy CRITICAL/fixable: ${results.gates.trivy.ok ? "PASS" : "FAIL"}`
      );
      results.gates.sbom = sbomGate(tools, tag);
      console.log(
        `[p08] T05 sbom: ${results.gates.sbom.ok ? "PASS" : "FAIL"} (${results.gates.sbom.packages ?? 0} packages)`
      );
    }

    if (mode === "all" || mode === "profiles" || mode === "gate") {
      const rounds = mode === "gate" ? 3 : 1;
      results.gates.rounds = [];
      for (let round = 1; round <= rounds; round += 1) {
        const a = await profileA({
          tag,
          commitSha: identity.merge_commit_sha,
          marker: `${marker}r${round}a`,
          worktree,
        });
        console.log(
          `[p08] T06 profile A round ${round}: ${a.ok ? "PASS" : "FAIL"} ${JSON.stringify(a.checks)}`
        );
        const b = await profileB({
          tag,
          commitSha: identity.merge_commit_sha,
          marker: `${marker}r${round}b`,
          worktree,
        });
        console.log(
          `[p08] T07 profile B round ${round}: ${b.ok ? "PASS" : "FAIL"} ${JSON.stringify(b.checks)}`
        );
        results.gates.rounds.push({ round, a, b });
        if (!a.ok || !b.ok) break;
      }
    }

    if (mode === "all" || mode === "negatives") {
      results.gates.neg01 = neg01BrokenDockerfile(worktree, marker);
      console.log(
        `[p08] NEG01 broken Dockerfile rejected: ${results.gates.neg01.ok}`
      );
      const neg02 = await profileB({
        tag,
        commitSha: identity.merge_commit_sha,
        marker: `${marker}n2`,
        worktree,
        expectedCommitOverride: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
      });
      results.gates.neg02 = {
        ok: neg02.checks.smoke_ok === false,
        detail:
          "wrong EXPECTED_COMMIT must fail the smoke build-identity check",
        checks: neg02.checks,
      };
      console.log(
        `[p08] NEG02 wrong EXPECTED_COMMIT rejected: ${results.gates.neg02.ok}`
      );
      const neg03 = await profileB({
        tag,
        commitSha: identity.merge_commit_sha,
        marker: `${marker}n3`,
        worktree,
        negKillMysql: true,
      });
      results.gates.neg03 = {
        ok: neg03.classification === "INFRA-FAIL(SYNTHETIC)",
        classification: neg03.classification,
        checks: neg03.checks,
      };
      console.log(`[p08] NEG03 mysql killed mid-run → ${neg03.classification}`);
    }
  } finally {
    tryDocker(["rmi", tag]);
    disposeSnapshot(handle);
    results.residue = residueReport(before);
    console.log(`[p08] CLN01 zero residue: ${results.residue.zero}`);
    writeFileSync(
      path.join(OUT, "p08-results.json"),
      JSON.stringify(results, null, 2) + "\n"
    );
  }
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
) {
  main().catch(error => {
    console.error(
      `[p08] ${error.code === "INFRA" ? "INFRA-FAIL" : "STOP"}: ${error.message}`
    );
    process.exitCode = error.code === "INFRA" ? 10 : 1;
  });
}
