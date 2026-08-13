/**
 * ledger-lock.mjs — pre-write exclusion + atomic settlement for the canonical
 * ledger. Closes the lost-update class the 2026-08-12 closure audit measured
 * live (20 concurrent writers -> 1 survivor, corruption detected only AFTER
 * the fact). The law here is Section 9 of the 2026-08-13 qualification:
 * no writer mutates before lease ownership; settlement is atomic; recovery is
 * possible only for an expired lease whose owner PID is absent on this host
 * and whose repository matches; every kill point leaves a state a recoverer
 * can classify unambiguously.
 *
 * Mechanism:
 *   lease   = atomic mkdir of docs/verification/ci-verify-ledger.lock with an
 *             owner.json binding {repository, pid, hostname, run, expiry}.
 *   settle  = write a marker INSIDE the lock dir binding the new ledger
 *             sha256 and every (tmp, final, sha256) target; write + fsync all
 *             temps; then rename ledger -> pin -> md; remove the marker last.
 *   recover = the winner of an atomic RENAME of the stale lock dir (single
 *             recoverer by construction) compares the live ledger sha256 to
 *             the marker: equal -> roll FORWARD (finish remaining renames);
 *             different -> roll BACK (delete temps). A completed pin is only
 *             ever written from a marker that proves the bytes came from a
 *             leased settlement, so tamper-evidence survives recovery.
 */
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
  appendFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..");
const DOCS = path.join(REPO_ROOT, "docs", "verification");
export const LOCK_DIR = path.join(DOCS, "ci-verify-ledger.lock");
const OWNER_FILE = "owner.json";
const MARKER_FILE = "settlement.json";
const RECOVERY_LOG = path.join(
  REPO_ROOT,
  ".ci-verify",
  "ledger-recovery.jsonl"
);

const TTL_MS = () => Number(process.env.CI_VERIFY_LEDGER_TTL_MS ?? 120_000);
const TIMEOUT_MS = () =>
  Number(process.env.CI_VERIFY_LEDGER_LOCK_TIMEOUT_MS ?? 30_000);

let HELD = null; // module-level lease token; persist() refuses without it

function sha256(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function fsyncFile(filePath) {
  const fd = openSync(filePath, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function fsyncDirBestEffort(dirPath) {
  // Directory fsync is platform-dependent ("where supported" per the law);
  // macOS may refuse a directory fd — that refusal is not a settlement error.
  try {
    const fd = openSync(dirPath, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch {
    /* unsupported here */
  }
}

export function killPoint(name) {
  if (process.env.CI_VERIFY_LEDGER_KILL_POINT === name) {
    // Test-only crash injection: a hard exit with no cleanup, so the suite
    // can prove every interruption point settles unambiguously.
    process.exit(97);
  }
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== "ESRCH";
  }
}

function readOwner(dir) {
  try {
    return JSON.parse(readFileSync(path.join(dir, OWNER_FILE), "utf8"));
  } catch {
    return null;
  }
}

function recordRecovery(record) {
  mkdirSync(path.dirname(RECOVERY_LOG), { recursive: true });
  appendFileSync(RECOVERY_LOG, JSON.stringify(record) + "\n");
}

/**
 * Settle any half-finished write recorded in `dir`'s marker, then delete the
 * dir. Every state is classifiable: temps are written and fsynced BEFORE the
 * first rename, and a rename consumes its temp — so "final differs from the
 * marker AND its temp is gone" cannot occur for a leased settlement.
 */
function settleFromDir(dir) {
  const markerPath = path.join(dir, MARKER_FILE);
  let action = "rolled_back_none_staged";
  if (existsSync(markerPath)) {
    const marker = JSON.parse(readFileSync(markerPath, "utf8"));
    const live = existsSync(marker.ledger_final)
      ? sha256(readFileSync(marker.ledger_final))
      : null;
    if (live === marker.ledger_sha256) {
      // The ledger rename happened: the mutation is the record. Roll forward.
      for (const t of marker.targets) {
        const finalOk =
          existsSync(t.final) && sha256(readFileSync(t.final)) === t.sha256;
        if (!finalOk) {
          if (!existsSync(t.tmp)) {
            throw new Error(
              `LEDGER_SETTLEMENT_AMBIGUOUS: ${t.final} matches neither the ` +
                `marker nor a staged temp — manual inspection required`
            );
          }
          renameSync(t.tmp, t.final);
        } else if (existsSync(t.tmp)) {
          unlinkSync(t.tmp);
        }
      }
      action = "rolled_forward";
    } else {
      // The ledger rename never happened: nothing is visible. Roll back.
      for (const t of marker.targets) {
        if (existsSync(t.tmp)) unlinkSync(t.tmp);
      }
      action = "rolled_back";
    }
    unlinkSync(markerPath);
  }
  rmSync(dir, { recursive: true, force: true });
  fsyncDirBestEffort(DOCS);
  return action;
}

function tryRecover() {
  const owner = readOwner(LOCK_DIR);
  if (!owner) return false; // unreadable owner: fail closed, never steal
  const expired = Date.now() > owner.expires_at;
  const sameHost = owner.hostname === os.hostname();
  const sameRepo = owner.repository === REPO_ROOT;
  if (!expired || !sameHost) return false;
  if (!sameRepo) return false; // wrong-repo lease is never recovered here
  if (pidAlive(owner.pid)) return false;
  const claim = `${LOCK_DIR}.recovering-${process.pid}-${Date.now()}`;
  try {
    renameSync(LOCK_DIR, claim); // atomic: exactly one recoverer wins
  } catch {
    return false; // someone else won or the holder released; just retry
  }
  const action = settleFromDir(claim);
  recordRecovery({
    at: new Date().toISOString(),
    recovered_owner: owner,
    action,
    recovered_by_pid: process.pid,
  });
  return true;
}

export function acquireLease(runId = "cli") {
  const deadline = Date.now() + TIMEOUT_MS();
  for (;;) {
    try {
      mkdirSync(LOCK_DIR); // atomic exclusion point
      const owner = {
        schema: "ci-verify/ledger-lease.v1",
        repository: REPO_ROOT,
        pid: process.pid,
        hostname: os.hostname(),
        run_id: runId,
        acquired_at: Date.now(),
        expires_at: Date.now() + TTL_MS(),
      };
      const ownerPath = path.join(LOCK_DIR, OWNER_FILE);
      writeFileSync(ownerPath, JSON.stringify(owner, null, 1) + "\n");
      fsyncFile(ownerPath);
      HELD = owner;
      return owner;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      tryRecover();
      if (Date.now() >= deadline) {
        const holder = readOwner(LOCK_DIR);
        throw new Error(
          `LEDGER_LOCK_TIMEOUT: held by ${
            holder
              ? `pid ${holder.pid} (${holder.run_id}) expires ${new Date(holder.expires_at).toISOString()}`
              : "an unreadable owner — inspect " + LOCK_DIR
          }`
        );
      }
      sleepMs(40);
    }
  }
}

export function releaseLease() {
  if (!HELD) return;
  const markerPath = path.join(LOCK_DIR, MARKER_FILE);
  if (existsSync(markerPath)) unlinkSync(markerPath);
  const ownerPath = path.join(LOCK_DIR, OWNER_FILE);
  if (existsSync(ownerPath)) unlinkSync(ownerPath);
  rmdirSync(LOCK_DIR);
  HELD = null;
}

export function leaseHeld() {
  return HELD !== null;
}

/**
 * Atomic multi-file settlement under the held lease. `targets` is an ordered
 * list of {final, data}; the FIRST target must be the ledger itself — its
 * sha256 is the marker's roll-forward/roll-back discriminator.
 */
export function settle(targets) {
  if (!HELD) throw new Error("PERSIST_WITHOUT_LEASE: acquireLease() first");
  killPoint("before-temp");
  const staged = targets.map(t => ({
    final: t.final,
    tmp: `${t.final}.tmp-${process.pid}`,
    sha256: sha256(Buffer.from(t.data)),
  }));
  const marker = {
    schema: "ci-verify/ledger-settlement.v1",
    ledger_final: staged[0].final,
    ledger_sha256: staged[0].sha256,
    targets: staged,
    staged_at: new Date().toISOString(),
  };
  const markerPath = path.join(LOCK_DIR, MARKER_FILE);
  writeFileSync(markerPath, JSON.stringify(marker, null, 1) + "\n");
  fsyncFile(markerPath);
  for (let i = 0; i < targets.length; i++) {
    writeFileSync(staged[i].tmp, targets[i].data);
    fsyncFile(staged[i].tmp);
  }
  killPoint("after-temp");
  killPoint("before-replace");
  renameSync(staged[0].tmp, staged[0].final); // the ledger becomes visible
  killPoint("after-ledger-replace");
  renameSync(staged[1].tmp, staged[1].final); // the pin
  killPoint("after-pin");
  for (let i = 2; i < staged.length; i++) {
    renameSync(staged[i].tmp, staged[i].final);
  }
  unlinkSync(markerPath);
  fsyncDirBestEffort(DOCS);
}
