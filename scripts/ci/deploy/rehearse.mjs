#!/usr/bin/env node
/**
 * rehearse.mjs — `pnpm ci:verify:deploy:rehearse`
 *
 * Full non-production deployment rehearsal on the EXISTING local-docker
 * target (Section 15): record prior deployment -> deploy prior -> verify ->
 * graceful cutover to the candidate -> health + smoke + stability + secret
 * scan -> controlled failure -> rollback to prior -> verify restoration ->
 * teardown -> zero residue. Provider status alone is never proof: every
 * verification is an independent read (/health commit, smoke suite, docker
 * state, logs).
 *
 * Negative mode: `--neg-wrong-commit` proves the smoke gate reddens when the
 * candidate serves a different commit than expected (the false-green class).
 *
 * Exit codes: 0 REHEARSED · 1 FAIL · 2 REFUSED · 10 INFRA
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildCandidate } from "../p08/run-p08.mjs";
import { startOwnedMysql } from "../p07/mysql.mjs";
import { resolveHead } from "../snapshot.mjs";
import {
  cleanEnv,
  OUT_DIR,
  PLAN_PATH,
  REHEARSAL_PATH,
  REPO_ROOT,
  acquireDeployLease,
  deriveIdempotencyKey,
  destroyOwned,
  docker,
  dockerInventory,
  journal,
  loadContract,
  newMarker,
  newSecret,
  pollHealth,
  readJson,
  recordDeployment,
  releaseDeployLease,
  residueDiff,
  run,
  writeJson,
} from "./lib.mjs";

const TARGET = "local-docker";
const PORTS = { prior: 3921, candidate: 3922, rollback: 3923 };

function ensureImage(sha, role) {
  const tag = `cvdep-${role}:${sha.slice(0, 12)}`;
  const probe = docker(["image", "inspect", "--format", "{{.Id}}", tag]);
  if (probe.status === 0) {
    return { tag, image_id: probe.stdout.trim(), cached: true };
  }
  const wt = path.join(OUT_DIR, `wt-${role}-${sha.slice(0, 12)}`);
  rmSync(wt, { recursive: true, force: true });
  execFileSync("git", ["worktree", "add", "--detach", wt, sha], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  try {
    const built = buildCandidate(wt, tag);
    if (!built.ok) {
      const err = new Error(`IMAGE_BUILD_FAILED: ${role} ${sha.slice(0, 12)}`);
      err.detail = built.tail;
      throw err;
    }
    return { tag, image_id: built.image_id, cached: false };
  } finally {
    execFileSync("git", ["worktree", "remove", "--force", wt], {
      cwd: REPO_ROOT,
    });
  }
}

async function healthCommit(port) {
  const res = await fetch(`http://127.0.0.1:${port}/health`, {
    signal: AbortSignal.timeout(5000),
  });
  const body = await res.json();
  return { status: res.status, commit: body.commit ?? null, body };
}

function containerState(name) {
  const res = docker([
    "inspect",
    "--format",
    "{{.State.Status}} {{.State.ExitCode}} {{.RestartCount}}",
    name,
  ]);
  if (res.status !== 0) return null;
  const [status, exit, restarts] = res.stdout.trim().split(/\s+/);
  return { status, exit_code: Number(exit), restarts: Number(restarts) };
}

function gracefulStop(name) {
  const stop = docker(["stop", "-t", "25", name], { timeout: 60_000 });
  const state = containerState(name);
  return { stopped: stop.status === 0, exit_code: state?.exit_code ?? null };
}

async function main() {
  const negWrongCommit = process.argv.includes("--neg-wrong-commit");
  const keyFlagIdx = process.argv.indexOf("--idempotency-key");
  const { contract } = loadContract();

  if (!existsSync(PLAN_PATH)) {
    console.log("[deploy:rehearse] REFUSED: PLAN_MISSING — run plan first");
    process.exitCode = 2;
    return;
  }
  const plan = readJson(PLAN_PATH);
  const head = resolveHead(REPO_ROOT);
  if (plan.verdict !== "PLANNED") {
    console.log(
      `[deploy:rehearse] REFUSED: PLAN_NOT_PLANNED (${plan.verdict})`
    );
    process.exitCode = 2;
    return;
  }
  if (plan.bindings.head_sha !== head) {
    console.log(
      `[deploy:rehearse] REFUSED: STALE_PLAN plan=${plan.bindings.head_sha.slice(0, 12)} head=${head.slice(0, 12)}`
    );
    process.exitCode = 2;
    return;
  }
  const planAgeH = (Date.now() - Date.parse(plan.planned_at)) / 3_600_000;
  if (planAgeH > 24) {
    console.log(
      `[deploy:rehearse] REFUSED: PLAN_EXPIRED (${planAgeH.toFixed(1)}h)`
    );
    process.exitCode = 2;
    return;
  }

  const derivedKey = deriveIdempotencyKey({
    target: TARGET,
    head,
    contract: plan.bindings.contract_sha256,
  });
  if (keyFlagIdx !== -1) {
    const supplied = process.argv[keyFlagIdx + 1];
    if (supplied !== derivedKey) {
      console.log(
        "[deploy:rehearse] REFUSED: IDEMPOTENCY_KEY_INPUT_MISMATCH — supplied key does not match the derived inputs"
      );
      process.exitCode = 2;
      return;
    }
  }

  mkdirSync(OUT_DIR, { recursive: true });
  acquireDeployLease(TARGET, derivedKey);
  const marker = newMarker();
  const secret = newSecret();
  const before = dockerInventory();
  const record = {
    schema: "ci-verify/deploy-rehearsal.v1",
    started_at: new Date().toISOString(),
    target: TARGET,
    head_sha: head,
    base_sha: plan.bindings.base_sha,
    idempotency_key: derivedKey,
    marker,
    mode: negWrongCommit ? "NEG_WRONG_COMMIT" : "FULL",
    steps: {},
    deployments: [],
  };
  let mysql = null;
  let verdict = "FAIL";
  try {
    // Images: the prior version is the real base commit, never a relabel.
    const prior = ensureImage(plan.bindings.base_sha, "prior");
    const cand = ensureImage(head, "cand");
    record.steps.images = { prior, candidate: cand };
    journal({ step: "images", prior: prior.tag, candidate: cand.tag });

    // Database fixture + committed-migration replay (profile-B pattern).
    mysql = await startOwnedMysql(marker);
    const replay = run("pnpm", ["db:migrate:reconciled"], {
      timeout: 300_000,
      env: cleanEnv({
        DATABASE_URL: "mysql://root@127.0.0.1:3306/dime_test",
      }),
    });
    record.steps.migrations = {
      ok: replay.status === 0,
      tail: replay.stdout.split("\n").filter(Boolean).slice(-3),
      stderr_tail: replay.stderr.split("\n").filter(Boolean).slice(-3),
    };
    if (replay.status !== 0) throw new Error("MIGRATION_REPLAY_FAILED");
    const dbUrl = "mysql://root@host.docker.internal:3306/dime_test";

    // 1) Deploy PRIOR — this is the "current deployment" being upgraded.
    const priorName = `cvdep-prior-${marker}`;
    const started = docker([
      "run",
      "-d",
      "--name",
      priorName,
      "--label",
      `ci-verify-owner=${marker}`,
      "--add-host",
      "host.docker.internal:host-gateway",
      "-p",
      `127.0.0.1:${PORTS.prior}:3000`,
      "-e",
      "NODE_ENV=production",
      "-e",
      "PORT=3000",
      "-e",
      `APP_SESSION_SECRET=${secret}`,
      "-e",
      `DATABASE_URL=${dbUrl}`,
      "-e",
      `RAILWAY_GIT_COMMIT_SHA=${plan.bindings.base_sha}`,
      prior.tag,
    ]);
    if (started.status !== 0)
      throw new Error(`PRIOR_START_FAILED: ${started.stderr.slice(0, 300)}`);
    const priorHealth = await pollHealth(
      `http://127.0.0.1:${PORTS.prior}/health`
    );
    const priorIdent = await healthCommit(PORTS.prior);
    const priorOk =
      priorHealth.ok &&
      priorIdent.commit !== null &&
      plan.bindings.base_sha.startsWith(priorIdent.commit.slice(0, 7));
    record.steps.prior_deploy = {
      ok: priorOk,
      health: priorHealth.ok,
      serving_commit: priorIdent.commit,
    };
    record.deployments.push({
      deployment_id: started.stdout.trim(),
      role: "prior",
      image_id: prior.image_id,
      commit: plan.bindings.base_sha,
    });
    recordDeployment(record.deployments.at(-1));
    if (!priorOk) throw new Error("PRIOR_DEPLOY_UNHEALTHY");

    // 2) Cutover: stop prior, start candidate. The prior artifact is
    //    immutable history — its exit code is RECORDED, not asserted: main
    //    predates the DEF-063 graceful-shutdown fix and exits 137 here,
    //    which is exactly the production behavior this branch repairs. The
    //    shutdown CONTRACT is asserted on the candidate (step 4b).
    const cutover = gracefulStop(priorName);
    record.steps.prior_shutdown = {
      ...cutover,
      contract_met: cutover.exit_code === 0,
      note:
        cutover.exit_code === 0
          ? null
          : "prior artifact (protected-main head) lacks DEF-063 graceful shutdown — recorded production behavior, repaired by the candidate",
    };
    if (!cutover.stopped) throw new Error("PRIOR_STOP_FAILED");

    const candName = `cvdep-cand-${marker}`;
    const cstart = docker([
      "run",
      "-d",
      "--name",
      candName,
      "--label",
      `ci-verify-owner=${marker}`,
      "--add-host",
      "host.docker.internal:host-gateway",
      "-p",
      `127.0.0.1:${PORTS.candidate}:3000`,
      "-e",
      "NODE_ENV=production",
      "-e",
      "PORT=3000",
      "-e",
      `APP_SESSION_SECRET=${secret}`,
      "-e",
      `DATABASE_URL=${dbUrl}`,
      "-e",
      `RAILWAY_GIT_COMMIT_SHA=${head}`,
      cand.tag,
    ]);
    if (cstart.status !== 0)
      throw new Error(`CANDIDATE_START_FAILED: ${cstart.stderr.slice(0, 300)}`);
    const candHealth = await pollHealth(
      `http://127.0.0.1:${PORTS.candidate}/health`
    );
    record.steps.candidate_health = { ok: candHealth.ok };
    if (!candHealth.ok) throw new Error("CANDIDATE_UNHEALTHY");
    record.deployments.push({
      deployment_id: cstart.stdout.trim(),
      role: "candidate",
      image_id: cand.image_id,
      commit: head,
    });
    recordDeployment(record.deployments.at(-1));

    // 3) Smoke with EXPECTED_COMMIT — the identity gate. In negative mode we
    //    expect the WRONG commit to redden the suite (intended red).
    const expected = negWrongCommit ? plan.bindings.base_sha : head;
    const smoke = run(
      "node",
      ["scripts/smoke-deploy.mjs", `http://127.0.0.1:${PORTS.candidate}`],
      { timeout: 300_000, env: cleanEnv({ EXPECTED_COMMIT: expected }) }
    );
    if (negWrongCommit) {
      record.steps.smoke_negative = {
        intended_red: smoke.status !== 0,
        true_exit: smoke.status,
      };
      if (smoke.status === 0)
        throw new Error("NEG_WRONG_COMMIT_DID_NOT_REDDEN");
      verdict = "NEGATIVE_PROVEN";
      record.finished_at = new Date().toISOString();
      record.verdict = verdict;
      writeJson(path.join(OUT_DIR, "rehearsal-neg-wrong-commit.json"), record);
      console.log(
        `[deploy:rehearse] NEGATIVE_PROVEN — wrong EXPECTED_COMMIT reddened the smoke gate (exit ${smoke.status})`
      );
      return;
    }
    record.steps.smoke = { ok: smoke.status === 0, true_exit: smoke.status };
    if (smoke.status !== 0) throw new Error("SMOKE_FAILED");

    // 4) Stability window + crash-loop + secret-leak checks.
    await new Promise(r => setTimeout(r, 12_000));
    const stable = containerState(candName);
    const logs = docker(["logs", candName], { timeout: 30_000 });
    const leak = logs.stdout.includes(secret) || logs.stderr.includes(secret);
    record.steps.stability = {
      running: stable?.status === "running",
      restarts: stable?.restarts ?? null,
      secret_leak: leak,
    };
    if (stable?.status !== "running" || (stable?.restarts ?? 1) !== 0)
      throw new Error("CANDIDATE_NOT_STABLE");
    if (leak) throw new Error("SECRET_LEAK_IN_LOGS");

    // 4b) The shutdown CONTRACT, asserted on the candidate: SIGTERM drain
    //     must exit 0 (DEF-063). Then restart the same container so the
    //     controlled-failure step has a live deployment to crash.
    const candStop = gracefulStop(candName);
    record.steps.candidate_shutdown = candStop;
    if (!candStop.stopped || candStop.exit_code !== 0)
      throw new Error(
        `CANDIDATE_SHUTDOWN_NOT_GRACEFUL: exit=${candStop.exit_code}`
      );
    const restart = docker(["start", candName]);
    if (restart.status !== 0) throw new Error("CANDIDATE_RESTART_FAILED");
    const restartHealth = await pollHealth(
      `http://127.0.0.1:${PORTS.candidate}/health`
    );
    record.steps.candidate_restart = { ok: restartHealth.ok };
    if (!restartHealth.ok) throw new Error("CANDIDATE_RESTART_UNHEALTHY");

    // 5) Controlled failure: hard-kill the candidate (crash simulation).
    const killed = docker(["kill", candName]);
    const deadState = containerState(candName);
    record.steps.controlled_failure = {
      killed: killed.status === 0,
      exit_code: deadState?.exit_code ?? null,
    };
    if (killed.status !== 0) throw new Error("CONTROLLED_KILL_FAILED");

    // 6) Rollback: redeploy the PRIOR artifact; verify restored identity.
    const rbName = `cvdep-rb-${marker}`;
    const rstart = docker([
      "run",
      "-d",
      "--name",
      rbName,
      "--label",
      `ci-verify-owner=${marker}`,
      "--add-host",
      "host.docker.internal:host-gateway",
      "-p",
      `127.0.0.1:${PORTS.rollback}:3000`,
      "-e",
      "NODE_ENV=production",
      "-e",
      "PORT=3000",
      "-e",
      `APP_SESSION_SECRET=${secret}`,
      "-e",
      `DATABASE_URL=${dbUrl}`,
      "-e",
      `RAILWAY_GIT_COMMIT_SHA=${plan.bindings.base_sha}`,
      prior.tag,
    ]);
    if (rstart.status !== 0)
      throw new Error(`ROLLBACK_START_FAILED: ${rstart.stderr.slice(0, 300)}`);
    const rbHealth = await pollHealth(
      `http://127.0.0.1:${PORTS.rollback}/health`
    );
    const rbIdent = await healthCommit(PORTS.rollback);
    const rbOk =
      rbHealth.ok &&
      rbIdent.commit !== null &&
      plan.bindings.base_sha.startsWith(rbIdent.commit.slice(0, 7));
    record.steps.rollback = {
      ok: rbOk,
      health: rbHealth.ok,
      serving_commit: rbIdent.commit,
      artifact_restored: true,
    };
    record.deployments.push({
      deployment_id: rstart.stdout.trim(),
      role: "rollback",
      image_id: prior.image_id,
      commit: plan.bindings.base_sha,
    });
    recordDeployment(record.deployments.at(-1));
    if (!rbOk) throw new Error("ROLLBACK_UNHEALTHY");
    // Rollback runs the PRIOR artifact: exit code recorded, stop asserted
    // (same immutable-history law as the cutover step).
    const rbStop = gracefulStop(rbName);
    record.steps.rollback_shutdown = {
      ...rbStop,
      contract_met: rbStop.exit_code === 0,
    };
    if (!rbStop.stopped) throw new Error("ROLLBACK_STOP_FAILED");

    verdict = "REHEARSED";
  } catch (error) {
    record.error = error.message;
    if (error.code === "INFRA" || error.code === "RUNTIME_UNAVAILABLE")
      verdict = "INFRA";
    journal({ step: "rehearse-error", error: error.message });
  } finally {
    const removed = destroyOwned(marker);
    if (mysql?.destroy) {
      try {
        mysql.destroy();
      } catch {
        /* already gone via label sweep */
      }
    }
    const residue = residueDiff(before);
    record.steps.teardown = {
      removed_containers: removed.length,
      residue,
      zero_residue:
        residue.new_containers.length === 0 && residue.new_volumes.length === 0,
    };
    record.finished_at = new Date().toISOString();
    record.verdict = verdict;
    writeJson(REHEARSAL_PATH, record);
    journal({ step: "rehearse-done", verdict, residue });
    releaseDeployLease(TARGET);
  }
  console.log(
    `[deploy:rehearse] ${verdict} — steps: ${Object.entries(record.steps)
      .map(([k, v]) => `${k}=${v.ok ?? v.zero_residue ?? v.stopped ?? "·"}`)
      .join(" ")}`
  );
  process.exitCode =
    verdict === "REHEARSED" || verdict === "NEGATIVE_PROVEN"
      ? 0
      : verdict === "INFRA"
        ? 10
        : 1;
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
) {
  main().catch(error => {
    console.error(`[deploy:rehearse] ${error.message}`);
    process.exitCode = error.code === "INFRA" ? 10 : 1;
  });
}
