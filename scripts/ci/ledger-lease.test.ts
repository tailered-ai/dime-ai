/**
 * Ledger lease + atomic settlement — the Section-9 concurrency matrix
 * (DEF-071 never-regress anchors).
 *
 * The pre-fix writer lost 19 of 20 concurrent updates and detected the
 * corruption only after the fact (closure-audit scenario H2). The law now:
 * no writer mutates before lease ownership; settlement is staged (marker +
 * temp + fsync) and lands by atomic renames; a writer killed at ANY point
 * leaves a state the next lease holder settles unambiguously; recovery is
 * possible only for an expired lease whose owner PID is dead on this host
 * and whose repository matches.
 *
 * Every test runs the REAL CLI in a sandboxed copy of scripts/ci +
 * docs/verification — no mocks of the thing under test.
 */
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..");

let SB: string;
const led = () => path.join(SB, "docs/verification/ci-verify-ledger.json");
const pin = () => path.join(SB, "docs/verification/ci-verify-ledger.sha256");
const docsDir = () => path.join(SB, "docs/verification");
const lockDir = () => path.join(SB, "docs/verification/ci-verify-ledger.lock");
const cli = () => path.join(SB, "scripts/ci/ledger.mjs");

function sha256(buf: Buffer) {
  return createHash("sha256").update(buf).digest("hex");
}

function run(args: string[], env: Record<string, string> = {}) {
  return spawnSync("node", [cli(), ...args], {
    encoding: "utf8",
    timeout: 15_000,
    env: { ...process.env, ...env },
  });
}

function openDefect(id: string, env: Record<string, string> = {}) {
  return run(["defect", "open", id, "--severity", "LOW", "--title", id], env);
}

function ledgerJson() {
  return JSON.parse(readFileSync(led(), "utf8"));
}

function pinMatches() {
  return (
    readFileSync(pin(), "utf8").trim().split(/\s+/)[0] ===
    sha256(readFileSync(led()))
  );
}

function residue() {
  return readdirSync(docsDir()).filter(
    f => f.includes("lock") || f.includes(".tmp-")
  );
}

function hasDefect(id: string) {
  return ledgerJson().defects.some((d: { id: string }) => d.id === id);
}

beforeAll(() => {
  SB = realpathSync(
    (() => {
      // mkdtemp: unpredictable, 0700 — the js/insecure-temporary-file class
      const d = mkdtempSync(path.join(os.tmpdir(), "ledger-lease-"));
      mkdirSync(path.join(d, "scripts"), { recursive: true });
      mkdirSync(path.join(d, "docs"), { recursive: true });
      cpSync(path.join(REPO_ROOT, "scripts/ci"), path.join(d, "scripts/ci"), {
        recursive: true,
      });
      cpSync(
        path.join(REPO_ROOT, "docs/verification"),
        path.join(d, "docs/verification"),
        { recursive: true }
      );
      return d;
    })()
  );
});

afterAll(() => {
  rmSync(SB, { recursive: true, force: true });
});

describe("P03.LEASE — exclusion and settlement", () => {
  it("LEASE01 twenty concurrent writers, twenty exact survivors", async () => {
    const children = Array.from(
      { length: 20 },
      (_, i) =>
        new Promise<number>(resolve => {
          const c = spawn(
            "node",
            [
              cli(),
              "defect",
              "open",
              `DEF-LA-${String(i + 1).padStart(2, "0")}`,
              "--severity",
              "LOW",
              "--title",
              `probe ${i + 1}`,
            ],
            {
              stdio: "ignore",
              env: {
                ...process.env,
                // Assert serialization correctness, not ambient-load latency:
                // under a saturated host the default 30s lock budget can
                // expire while earlier writers hold the lease legitimately.
                CI_VERIFY_LEDGER_LOCK_TIMEOUT_MS: "120000",
              },
            }
          );
          c.on("exit", code => resolve(code ?? -1));
        })
    );
    const codes = await Promise.all(children);
    expect(codes.filter(c => c === 0).length).toBe(20);
    const survivors = ledgerJson().defects.filter((d: { id: string }) =>
      d.id.startsWith("DEF-LA-")
    ).length;
    expect(survivors).toBe(20);
    expect(pinMatches()).toBe(true);
    expect(residue()).toEqual([]);
  }, 120_000);

  it("LEASE02 duplicate ID is refused PRE-mutation under concurrency", async () => {
    const results = await Promise.all(
      [0, 1].map(
        () =>
          new Promise<{ code: number; err: string }>(resolve => {
            const c = spawn(
              "node",
              [
                cli(),
                "defect",
                "open",
                "DEF-LB-DUP",
                "--severity",
                "LOW",
                "--title",
                "dup",
              ],
              { stdio: ["ignore", "ignore", "pipe"] }
            );
            let err = "";
            c.stderr!.on("data", d => (err += d));
            c.on("exit", code => resolve({ code: code ?? -1, err }));
          })
      )
    );
    const oks = results.filter(r => r.code === 0);
    const refusals = results.filter(
      r => r.code !== 0 && r.err.includes("DEFECT_ID_REUSED")
    );
    expect(oks.length).toBe(1);
    expect(refusals.length).toBe(1);
    const entries = ledgerJson().defects.filter(
      (d: { id: string }) => d.id === "DEF-LB-DUP"
    ).length;
    expect(entries).toBe(1);
  }, 60_000);

  const KILL_MATRIX: Array<[string, boolean]> = [
    ["before-temp", false],
    ["after-temp", false],
    ["before-replace", false],
    ["after-ledger-replace", true],
    ["after-pin", true],
  ];
  for (const [kp, expectApplied] of KILL_MATRIX) {
    it(`LEASE03 kill at ${kp} settles ${expectApplied ? "forward" : "back"}`, () => {
      const killed = openDefect(`DEF-KP-${kp}`, {
        CI_VERIFY_LEDGER_KILL_POINT: kp,
        CI_VERIFY_LEDGER_TTL_MS: "200",
      });
      expect(killed.status).toBe(97);
      const next = openDefect(`DEF-POST-${kp}`);
      expect(next.status).toBe(0);
      expect(hasDefect(`DEF-KP-${kp}`)).toBe(expectApplied);
      expect(hasDefect(`DEF-POST-${kp}`)).toBe(true);
      expect(pinMatches()).toBe(true);
      expect(residue()).toEqual([]);
      const recovery = path.join(SB, ".ci-verify/ledger-recovery.jsonl");
      expect(existsSync(recovery)).toBe(true);
    }, 60_000);
  }

  it("LEASE04 stale lease (dead PID, expired) is recovered and recorded", () => {
    mkdirSync(lockDir());
    writeFileSync(
      path.join(lockDir(), "owner.json"),
      JSON.stringify({
        schema: "ci-verify/ledger-lease.v1",
        repository: SB,
        pid: 999999,
        hostname: os.hostname(),
        run_id: "test-stale",
        acquired_at: Date.now() - 10_000,
        expires_at: Date.now() - 5_000,
      })
    );
    const r = openDefect("DEF-STALE-RECOVERY");
    expect(r.status).toBe(0);
    expect(hasDefect("DEF-STALE-RECOVERY")).toBe(true);
    expect(existsSync(lockDir())).toBe(false);
    const recovery = readFileSync(
      path.join(SB, ".ci-verify/ledger-recovery.jsonl"),
      "utf8"
    );
    expect(recovery).toContain("test-stale");
  });

  it("LEASE05 a live holder is never preempted: waiter times out fail-closed", () => {
    mkdirSync(lockDir());
    writeFileSync(
      path.join(lockDir(), "owner.json"),
      JSON.stringify({
        schema: "ci-verify/ledger-lease.v1",
        repository: SB,
        pid: process.pid, // alive
        hostname: os.hostname(),
        run_id: "test-live-holder",
        acquired_at: Date.now(),
        expires_at: Date.now() + 60_000,
      })
    );
    try {
      const before = sha256(readFileSync(led()));
      const r = openDefect("DEF-MUST-NOT-EXIST", {
        CI_VERIFY_LEDGER_LOCK_TIMEOUT_MS: "400",
      });
      expect(r.status).not.toBe(0);
      expect(r.stderr).toContain("LEDGER_LOCK_TIMEOUT");
      expect(sha256(readFileSync(led()))).toBe(before);
      expect(hasDefect("DEF-MUST-NOT-EXIST")).toBe(false);
    } finally {
      rmSync(lockDir(), { recursive: true, force: true });
    }
  });

  it("LEASE06 dead-PID but NOT-expired lease is not stolen", () => {
    mkdirSync(lockDir());
    writeFileSync(
      path.join(lockDir(), "owner.json"),
      JSON.stringify({
        schema: "ci-verify/ledger-lease.v1",
        repository: SB,
        pid: 999999, // dead
        hostname: os.hostname(),
        run_id: "test-unexpired",
        acquired_at: Date.now(),
        expires_at: Date.now() + 60_000, // not expired
      })
    );
    try {
      const r = openDefect("DEF-UNEXPIRED-STEAL", {
        CI_VERIFY_LEDGER_LOCK_TIMEOUT_MS: "400",
      });
      expect(r.status).not.toBe(0);
      expect(hasDefect("DEF-UNEXPIRED-STEAL")).toBe(false);
    } finally {
      rmSync(lockDir(), { recursive: true, force: true });
    }
  });

  it("LEASE07 wrong-repository lease is never recovered here", () => {
    mkdirSync(lockDir());
    writeFileSync(
      path.join(lockDir(), "owner.json"),
      JSON.stringify({
        schema: "ci-verify/ledger-lease.v1",
        repository: "/somewhere/else/entirely",
        pid: 999999,
        hostname: os.hostname(),
        run_id: "test-wrong-repo",
        acquired_at: Date.now() - 10_000,
        expires_at: Date.now() - 5_000,
      })
    );
    try {
      const r = openDefect("DEF-WRONG-REPO", {
        CI_VERIFY_LEDGER_LOCK_TIMEOUT_MS: "400",
      });
      expect(r.status).not.toBe(0);
      expect(hasDefect("DEF-WRONG-REPO")).toBe(false);
      expect(existsSync(lockDir())).toBe(true); // untouched
    } finally {
      rmSync(lockDir(), { recursive: true, force: true });
    }
  });

  it("LEASE08 read-only evidence directory fails closed before any change", () => {
    const before = sha256(readFileSync(led()));
    chmodSync(docsDir(), 0o555);
    try {
      const r = openDefect("DEF-READONLY-FS");
      expect(r.status).not.toBe(0);
    } finally {
      chmodSync(docsDir(), 0o755);
    }
    expect(sha256(readFileSync(led()))).toBe(before);
    expect(hasDefect("DEF-READONLY-FS")).toBe(false);
    expect(residue()).toEqual([]);
  });

  it("LEASE09 corrupt ledger or pin refuses BEFORE mutation", () => {
    const goodLedger = readFileSync(led());
    const goodPin = readFileSync(pin());
    writeFileSync(led(), "{not json");
    try {
      const r1 = openDefect("DEF-CORRUPT-LEDGER");
      expect(r1.status).not.toBe(0);
      expect(r1.stderr).toMatch(/LEDGER_TAMPERED|LEDGER_CORRUPT/);
    } finally {
      writeFileSync(led(), goodLedger);
    }
    writeFileSync(pin(), `${"0".repeat(64)}  ci-verify-ledger.json\n`);
    try {
      const r2 = openDefect("DEF-CORRUPT-PIN");
      expect(r2.status).not.toBe(0);
      expect(r2.stderr).toContain("LEDGER_TAMPERED");
    } finally {
      writeFileSync(pin(), goodPin);
    }
    expect(hasDefect("DEF-CORRUPT-LEDGER")).toBe(false);
    expect(hasDefect("DEF-CORRUPT-PIN")).toBe(false);
    expect(pinMatches()).toBe(true);
  });

  it("LEASE10 twenty readers stay green across five concurrent writers", async () => {
    const writers = Array.from(
      { length: 5 },
      (_, i) =>
        new Promise<number>(resolve => {
          const c = spawn(
            "node",
            [
              cli(),
              "defect",
              "open",
              `DEF-RW-${i}`,
              "--severity",
              "LOW",
              "--title",
              `rw ${i}`,
            ],
            {
              stdio: "ignore",
              env: {
                ...process.env,
                // Assert serialization correctness, not ambient-load latency:
                // under a saturated host the default 30s lock budget can
                // expire while earlier writers hold the lease legitimately.
                CI_VERIFY_LEDGER_LOCK_TIMEOUT_MS: "120000",
              },
            }
          );
          c.on("exit", code => resolve(code ?? -1));
        })
    );
    const readers = Array.from(
      { length: 20 },
      () =>
        new Promise<number>(resolve => {
          const c = spawn("node", [cli(), "verify"], {
            stdio: "ignore",
            env: {
              ...process.env,
              CI_VERIFY_LEDGER_LOCK_TIMEOUT_MS: "120000",
            },
          });
          c.on("exit", code => resolve(code ?? -1));
        })
    );
    const [wCodes, rCodes] = await Promise.all([
      Promise.all(writers),
      Promise.all(readers),
    ]);
    expect(wCodes.every(c => c === 0)).toBe(true);
    expect(rCodes.every(c => c === 0)).toBe(true);
    const final = run(["verify"]);
    expect(final.status).toBe(0);
    expect(residue()).toEqual([]);
  }, 120_000);
});
