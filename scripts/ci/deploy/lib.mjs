/**
 * lib.mjs — shared machinery for the deployment control plane.
 *
 * Laws carried here:
 *   - identity comes from P01 (snapshot.mjs) only; no raw rev-parse here
 *   - every subprocess result keeps its TRUE exit and signal
 *   - variable NAMES may be recorded; values never are
 *   - one active deployment operation per target (lease + idempotency key)
 *   - evidence is append-only; failed evidence is never overwritten
 */
import { execFileSync, spawnSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveBase, resolveHead, writeMergeTree } from "../snapshot.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, "..", "..", "..");
export const CONTRACT_PATH = path.join(HERE, "deploy-contract.json");
export const OUT_DIR = path.join(REPO_ROOT, ".ci-verify", "deploy");
export const PLAN_PATH = path.join(OUT_DIR, "plan.json");
export const REHEARSAL_PATH = path.join(OUT_DIR, "rehearsal.json");
export const DEPLOYMENTS_LOG = path.join(OUT_DIR, "deployments.jsonl");
export const CERT_PATH = path.join(OUT_DIR, "DEPLOYMENT_READINESS.json");
export const CERT_PIN_PATH = path.join(OUT_DIR, "DEPLOYMENT_READINESS.sha256");
export const LEASE_ROOT = path.join(OUT_DIR, "lease");

export function sha256Hex(buf) {
  return createHash("sha256").update(buf).digest("hex");
}
export function sha256File(p) {
  return sha256Hex(readFileSync(p));
}

export function loadContract(contractPath = CONTRACT_PATH) {
  const raw = readFileSync(contractPath);
  const contract = JSON.parse(raw.toString("utf8"));
  if (contract.schema !== "ci-verify/deployment-contract.v1") {
    throw new Error(`CONTRACT_SCHEMA_UNKNOWN: ${contract.schema}`);
  }
  for (const key of [
    "artifact",
    "process",
    "health",
    "shutdown",
    "migration",
    "targets",
    "rollout",
    "authorization",
    "freshness",
  ]) {
    if (!contract[key]) throw new Error(`CONTRACT_MISSING_SECTION: ${key}`);
  }
  // Missing start, process, health, or rollback is BLOCKED — never invented.
  if (!contract.artifact.start_cmd?.length)
    throw new Error("CONTRACT_MISSING_START_COMMAND");
  if (!contract.health.path) throw new Error("CONTRACT_MISSING_HEALTH_PATH");
  if (!contract.rollout.rollback?.mechanism)
    throw new Error("CONTRACT_MISSING_ROLLBACK");
  return { contract, sha256: sha256Hex(raw) };
}

export function identity() {
  const head_sha = resolveHead(REPO_ROOT);
  const base_sha = resolveBase(REPO_ROOT, { fetch: false }).base_sha;
  const merge_tree_sha = writeMergeTree(
    REPO_ROOT,
    base_sha,
    head_sha
  ).merge_tree_sha;
  const dirty =
    execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    }).trim().length > 0;
  return { head_sha, base_sha, merge_tree_sha, dirty_tracked: dirty };
}

/** True-exit subprocess wrapper. Never derives a verdict through a pipe. */
export function run(cmd, args, options = {}) {
  const res = spawnSync(cmd, args, {
    encoding: "utf8",
    timeout: options.timeout ?? 120_000,
    cwd: options.cwd ?? REPO_ROOT,
    env: options.env ?? process.env,
    maxBuffer: 64 * 1024 * 1024,
  });
  return {
    cmd: [cmd, ...args].join(" "),
    status: res.status,
    signal: res.signal,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
  };
}

export function docker(args, options = {}) {
  return run("docker", args, options);
}

export function journal(event) {
  mkdirSync(OUT_DIR, { recursive: true });
  appendFileSync(
    path.join(OUT_DIR, "journal.jsonl"),
    JSON.stringify({ at: new Date().toISOString(), ...event }) + "\n"
  );
}

export function recordDeployment(record) {
  mkdirSync(OUT_DIR, { recursive: true });
  appendFileSync(
    DEPLOYMENTS_LOG,
    JSON.stringify({ at: new Date().toISOString(), ...record }) + "\n"
  );
}

export function writeJson(p, value) {
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(value, null, 2) + "\n");
}
export function readJson(p) {
  return JSON.parse(readFileSync(p, "utf8"));
}

// ---------------------------------------------------------------------------
// Deployment lease — one active operation per target, idempotency-key bound.
// ---------------------------------------------------------------------------
export function deriveIdempotencyKey(parts) {
  return sha256Hex(Buffer.from(JSON.stringify(parts)));
}

export function acquireDeployLease(target, idempotencyKey, opts = {}) {
  const dir = path.join(LEASE_ROOT, target);
  mkdirSync(LEASE_ROOT, { recursive: true });
  const ttl = opts.ttlMs ?? 5_400_000;
  try {
    mkdirSync(dir);
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    let owner = null;
    try {
      owner = JSON.parse(readFileSync(path.join(dir, "owner.json"), "utf8"));
    } catch {
      /* unreadable */
    }
    const dead =
      owner &&
      (() => {
        try {
          process.kill(owner.pid, 0);
          return false;
        } catch (e) {
          return e.code === "ESRCH";
        }
      })();
    if (owner && Date.now() > owner.expires_at && dead) {
      rmSync(dir, { recursive: true, force: true });
      journal({ step: "lease-recovered", target, recovered_owner: owner });
      mkdirSync(dir);
    } else {
      throw new Error(
        `DEPLOY_LEASE_HELD: target=${target} by ${owner ? `pid ${owner.pid} key ${owner.idempotency_key?.slice(0, 12)}` : "unreadable owner"} — one active deployment per target`
      );
    }
  }
  const owner = {
    schema: "ci-verify/deploy-lease.v1",
    target,
    idempotency_key: idempotencyKey,
    pid: process.pid,
    hostname: os.hostname(),
    acquired_at: Date.now(),
    expires_at: Date.now() + ttl,
  };
  writeFileSync(
    path.join(dir, "owner.json"),
    JSON.stringify(owner, null, 1) + "\n"
  );
  return owner;
}

export function releaseDeployLease(target) {
  const dir = path.join(LEASE_ROOT, target);
  if (existsSync(path.join(dir, "owner.json")))
    unlinkSync(path.join(dir, "owner.json"));
  if (existsSync(dir)) rmdirSync(dir);
}

// ---------------------------------------------------------------------------
// Container helpers (rehearsal target). Ownership by label, like p08.
// ---------------------------------------------------------------------------
export function dockerInventory() {
  const c = docker(["ps", "-aq"]);
  const v = docker(["volume", "ls", "-q"]);
  return {
    containers: c.stdout.split("\n").filter(Boolean),
    volumes: v.stdout.split("\n").filter(Boolean),
  };
}

export function residueDiff(before) {
  const after = dockerInventory();
  return {
    new_containers: after.containers.filter(
      x => !before.containers.includes(x)
    ),
    new_volumes: after.volumes.filter(x => !before.volumes.includes(x)),
  };
}

export function destroyOwned(marker) {
  const owned = docker([
    "ps",
    "-aq",
    "--filter",
    `label=ci-verify-owner=${marker}`,
  ]);
  const ids = owned.stdout.split("\n").filter(Boolean);
  for (const id of ids) docker(["rm", "-fv", id]);
  return ids;
}

export function startAppContainer({
  name,
  image,
  hostPort,
  commitSha,
  dbUrl,
  marker,
  secret,
}) {
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
    `127.0.0.1:${hostPort}:3000`,
    "-e",
    "NODE_ENV=production",
    "-e",
    "PORT=3000",
    "-e",
    `APP_SESSION_SECRET=${secret}`,
    "-e",
    `DATABASE_URL=${dbUrl}`,
    "-e",
    `RAILWAY_GIT_COMMIT_SHA=${commitSha}`,
    image,
  ]);
}

export async function pollHealth(
  url,
  { budgetMs = 120_000, intervalMs = 2000 } = {}
) {
  const deadline = Date.now() + budgetMs;
  let last = null;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
      last = { status: res.status, body: await res.json().catch(() => null) };
      if (res.status === 200) return { ok: true, ...last };
    } catch (error) {
      last = { error: String(error?.cause?.code ?? error?.message ?? error) };
    }
    await new Promise(r => setTimeout(r, intervalMs));
  }
  return { ok: false, last };
}

export function newMarker() {
  return randomBytes(6).toString("hex");
}

export function newSecret() {
  return randomBytes(24).toString("hex");
}

/** Read + independently verify the PR certificate in a SEPARATE process. */
export function prCertificateState() {
  const certPath = path.join(
    REPO_ROOT,
    ".ci-verify/certificate/LOCAL_READY_FOR_PR.json"
  );
  if (!existsSync(certPath)) return { present: false };
  const bytes = readFileSync(certPath);
  const verify = run("node", ["scripts/ci/p10/certificate.mjs", "verify"], {
    timeout: 60_000,
  });
  let parsed = null;
  try {
    parsed = JSON.parse(verify.stdout);
  } catch {
    /* refusal text */
  }
  return {
    present: true,
    sha256: sha256Hex(bytes),
    head_sha: JSON.parse(bytes.toString("utf8")).bindings?.head_sha ?? null,
    verify_status: parsed?.status ?? `EXIT_${verify.status}`,
    verify_exit: verify.status,
  };
}
