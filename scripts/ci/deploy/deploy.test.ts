/**
 * Deployment control plane — dockerless unit + refusal suite.
 *
 * Live-path proof (images, health, smoke, rollback, residue) belongs to the
 * rehearsal itself; certificate tamper/freshness negatives run live against
 * the issued certificate in the P9 verification chain. This file proves the
 * pure laws: contract validation refuses missing sections, the lease admits
 * one holder per target, idempotency keys are input-bound, and production
 * execution refuses with and without a receipt.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  acquireDeployLease,
  deriveIdempotencyKey,
  loadContract,
  releaseDeployLease,
} from "./lib.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..", "..");
const READINESS = path.join(HERE, "readiness.mjs");
const FIX = path.join(os.tmpdir(), `deploy-contract-fix-${process.pid}`);

function contractFixture(mutate: (c: Record<string, unknown>) => void) {
  const c = JSON.parse(
    readFileSync(path.join(HERE, "deploy-contract.json"), "utf8")
  );
  mutate(c);
  mkdirSync(FIX, { recursive: true });
  const p = path.join(
    FIX,
    `contract-${Math.random().toString(36).slice(2)}.json`
  );
  writeFileSync(p, JSON.stringify(c));
  return p;
}

afterEach(() => {
  rmSync(FIX, { recursive: true, force: true });
  releaseDeployLease("test-target");
});

describe("DEPLOY.CONTRACT — validation refuses missing contracts", () => {
  it("CON01 the real contract loads and hashes", () => {
    const { contract, sha256 } = loadContract();
    expect(contract.schema).toBe("ci-verify/deployment-contract.v1");
    expect(sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("CON02 a missing health path is BLOCKED, never invented", () => {
    const p = contractFixture(c => {
      (c.health as Record<string, unknown>).path = "";
    });
    expect(() => loadContract(p)).toThrow(/CONTRACT_MISSING_HEALTH_PATH/);
  });

  it("CON03 a missing start command is BLOCKED", () => {
    const p = contractFixture(c => {
      (c.artifact as Record<string, unknown>).start_cmd = [];
    });
    expect(() => loadContract(p)).toThrow(/CONTRACT_MISSING_START_COMMAND/);
  });

  it("CON04 a missing rollback mechanism is BLOCKED", () => {
    const p = contractFixture(c => {
      delete (c.rollout as Record<string, unknown>).rollback;
    });
    expect(() => loadContract(p)).toThrow(/CONTRACT_MISSING_ROLLBACK/);
  });

  it("CON05 a missing section is BLOCKED", () => {
    const p = contractFixture(c => {
      delete (c as Record<string, unknown>).migration;
    });
    expect(() => loadContract(p)).toThrow(
      /CONTRACT_MISSING_SECTION: migration/
    );
  });

  it("CON06 an unknown schema is refused", () => {
    const p = contractFixture(c => {
      (c as Record<string, unknown>).schema = "something/else.v9";
    });
    expect(() => loadContract(p)).toThrow(/CONTRACT_SCHEMA_UNKNOWN/);
  });
});

describe("DEPLOY.LEASE — one active operation per target", () => {
  it("LSE01 acquire, refuse second, release, reacquire", () => {
    const key = deriveIdempotencyKey({ t: "test-target", h: "aaa" });
    acquireDeployLease("test-target", key);
    expect(() => acquireDeployLease("test-target", key)).toThrow(
      /DEPLOY_LEASE_HELD/
    );
    releaseDeployLease("test-target");
    expect(() => acquireDeployLease("test-target", key)).not.toThrow();
    releaseDeployLease("test-target");
  });

  it("LSE02 an expired dead-owner lease is recovered; a live one is not", () => {
    const dir = path.join(REPO_ROOT, ".ci-verify/deploy/lease/test-target");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, "owner.json"),
      JSON.stringify({
        target: "test-target",
        pid: 999999, // dead
        acquired_at: Date.now() - 10_000,
        expires_at: Date.now() - 5_000, // expired
      })
    );
    expect(() => acquireDeployLease("test-target", "k1")).not.toThrow();
    releaseDeployLease("test-target");

    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, "owner.json"),
      JSON.stringify({
        target: "test-target",
        pid: process.pid, // alive
        acquired_at: Date.now(),
        expires_at: Date.now() + 60_000,
      })
    );
    expect(() => acquireDeployLease("test-target", "k2")).toThrow(
      /DEPLOY_LEASE_HELD/
    );
    rmSync(dir, { recursive: true, force: true });
  });

  it("IDM01 idempotency keys are input-bound and deterministic", () => {
    const a = deriveIdempotencyKey({ target: "t", head: "h1", contract: "c" });
    const b = deriveIdempotencyKey({ target: "t", head: "h1", contract: "c" });
    const c = deriveIdempotencyKey({ target: "t", head: "h2", contract: "c" });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});

describe("DEPLOY.AUTH — production execution refuses", () => {
  function execute(args: string[]) {
    return spawnSync("node", [READINESS, "execute", ...args], {
      encoding: "utf8",
      timeout: 15_000,
    });
  }

  it("AUTH01 no receipt refuses with exit 6", () => {
    const r = execute([]);
    expect(r.status).toBe(6);
    expect(r.stdout).toContain("NO_AUTHORIZATION_RECEIPT");
  });

  it("AUTH02 a malformed receipt refuses with exit 2", () => {
    mkdirSync(FIX, { recursive: true });
    const p = path.join(FIX, "receipt-bad.json");
    writeFileSync(p, "{not json");
    const r = execute(["--receipt", p]);
    expect(r.status).toBe(2);
    expect(r.stdout).toContain("RECEIPT_MALFORMED");
  });

  it("AUTH03 a receipt missing required fields refuses with exit 2", () => {
    mkdirSync(FIX, { recursive: true });
    const p = path.join(FIX, "receipt-incomplete.json");
    writeFileSync(
      p,
      JSON.stringify({
        schema: "ci-verify/deploy-authorization.v1",
        authorizer: "someone",
      })
    );
    const r = execute(["--receipt", p]);
    expect(r.status).toBe(2);
    expect(r.stdout).toContain("RECEIPT_INVALID");
  });

  it("AUTH04 an expired receipt refuses with exit 2", () => {
    mkdirSync(FIX, { recursive: true });
    const p = path.join(FIX, "receipt-expired.json");
    writeFileSync(
      p,
      JSON.stringify({
        schema: "ci-verify/deploy-authorization.v1",
        authorizer: "human",
        target: {},
        source_head: "a".repeat(40),
        artifact_digest: "sha256:x",
        readiness_certificate_sha256: "b".repeat(64),
        window: {},
        blast_radius: "service",
        rollout: "cutover",
        prior_deployment: "x",
        rollback_plan: "redeploy prior",
        stop_conditions: [],
        expires_at: "2020-01-01T00:00:00Z",
      })
    );
    const r = execute(["--receipt", p]);
    expect(r.status).toBe(2);
    expect(r.stdout).toContain("RECEIPT_EXPIRED");
  });

  it("AUTH05 even a structurally valid receipt cannot execute in this qualification", () => {
    mkdirSync(FIX, { recursive: true });
    const p = path.join(FIX, "receipt-valid.json");
    writeFileSync(
      p,
      JSON.stringify({
        schema: "ci-verify/deploy-authorization.v1",
        authorizer: "human owner",
        target: { provider: "railway" },
        source_head: "a".repeat(40),
        artifact_digest: "sha256:x",
        readiness_certificate_sha256: "b".repeat(64),
        window: { start: "now", end: "later" },
        blast_radius: "entire service",
        rollout: "single-replica cutover",
        prior_deployment: "5bb7e28b",
        rollback_plan: "redeploy prior artifact",
        stop_conditions: ["health 503"],
        expires_at: "2099-01-01T00:00:00Z",
      })
    );
    const r = execute(["--receipt", p]);
    expect(r.status).toBe(7);
    expect(r.stdout).toContain("PRODUCTION_EXECUTION_NOT_ENABLED");
  });
});
