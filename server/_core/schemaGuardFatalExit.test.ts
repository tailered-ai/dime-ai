/**
 * The terminal proof that SCHEMA_GUARD_FATAL actually kills the process.
 *
 * Everything else in this repo asserts the DECISION: `expect(exitSpy)
 * .toHaveBeenCalledWith(1)`. That proves `process.exit` was invoked. It does not
 * prove the operating system reaped the process with a nonzero status — and the
 * nonzero status is the only part Railway's healthcheck can see. A stubbed
 * `process.exit` returns; a real one does not, and code after it does not run.
 *
 * So these spawn a real child (`tsx server/_core/__fixtures__/
 * schemaGuardFatalChild.ts`) and assert on the exit code the OS reports.
 *
 * Safety: the child injects a fake inspector through assertSchemaCurrent's seam.
 * No database connection is opened, and no production data is reachable. Drift
 * is never induced against a real database — that is deliberate, per the
 * closeout plan: production proves only the healthy side.
 */
import { describe, it, expect } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";

const run = promisify(execFile);
const CHILD = resolve(__dirname, "__fixtures__/schemaGuardFatalChild.ts");
const repoRoot = resolve(__dirname, "../..");

type Run = { code: number; out: string };

async function spawnChild(
  scenario: string,
  fatal: "1" | undefined,
  extraEnv: Record<string, string> = {}
): Promise<Run> {
  try {
    const { stdout, stderr } = await run("npx", ["tsx", CHILD], {
      cwd: repoRoot,
      env: {
        ...process.env,
        SCHEMA_GUARD_TEST_SCENARIO: scenario,
        ...(fatal ? { SCHEMA_GUARD_FATAL: fatal } : {}),
        ANALYTICS_ROLE: scenario === "store" ? "store" : "",
        ...extraEnv,
      },
      timeout: 120_000,
    });
    return { code: 0, out: `${stdout}\n${stderr}` };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return {
      code: typeof e.code === "number" ? e.code : -1,
      out: `${e.stdout ?? ""}\n${e.stderr ?? ""}`,
    };
  }
}

describe("SCHEMA_GUARD_FATAL — real process termination", () => {
  it("[FX-1] confirmed drift + FATAL=1 terminates the process with a nonzero code", async () => {
    const r = await spawnChild("drift", "1");

    expect(r.code).toBe(1);
    expect(r.out).toContain("[VERIFY] FAIL");
    expect(r.out).toContain("refusing to serve with a stale schema");
    expect(r.out).not.toContain("[VERIFY] PASS");
    // The decisive assertion: execution stopped. A stubbed exit would have
    // let the child fall through and print this.
    expect(r.out).not.toContain("CHILD_REACHED_END");
  }, 180_000);

  it("[FX-2] a valid read of an EMPTY database also terminates — confirmed, not unknown", async () => {
    const r = await spawnChild("empty", "1");

    expect(r.code).toBe(1);
    expect(r.out).toContain("[VERIFY] FAIL");
    expect(r.out).not.toContain("CHILD_REACHED_END");
  }, 180_000);

  it("[FX-3] verified clean + FATAL=1 exits 0 and reaches the end", async () => {
    const r = await spawnChild("clean", "1");

    expect(r.code).toBe(0);
    expect(r.out).toContain("[VERIFY] PASS");
    expect(r.out).toContain("CHILD_RESULT_STATUS=pass");
    expect(r.out).toContain("CHILD_REACHED_END=1");
    expect(r.out).not.toContain("refusing to serve");
  }, 180_000);

  it("[FX-4] UNAVAILABLE + FATAL=1 does NOT terminate, and does not claim PASS", async () => {
    // Fail-open. An unverifiable check must not decide a healthy deployment
    // cannot serve. This is the case that would crash-loop production if the
    // guard treated "we don't know" as "it's broken".
    const r = await spawnChild("unavailable", "1");

    expect(r.code).toBe(0);
    expect(r.out).toContain("[VERIFY] UNAVAILABLE");
    expect(r.out).toContain("CHILD_RESULT_STATUS=unavailable");
    expect(r.out).not.toContain("[VERIFY] PASS");
    expect(r.out).not.toContain("refusing to serve");
  }, 180_000);

  it("[FX-6] confirmed drift that LOSES the preflight timeout never kills the process", async () => {
    // The OS-level half of [SO-6]. Armed, bounded at 50ms, with an inspection
    // that returns real drift at 400ms — then the child deliberately stays alive
    // another 600ms. If the losing promise could still reach process.exit, this
    // child would die with code 1 and never print the survival marker.
    //
    // Together with [FX-1] this pins BOTH halves of the contract:
    //   fast confirmed drift  -> fail closed (exit 1)
    //   timed-out inspection  -> fail open, and STAY open
    const r = await spawnChild("slow-drift", "1", {
      SCHEMA_GUARD_MODE: "preflight",
      SCHEMA_GUARD_TEST_TIMEOUT_MS: "50",
    });

    expect(r.code).toBe(0);
    expect(r.out).toContain("[VERIFY] UNAVAILABLE");
    expect(r.out).toContain("inspection-timeout");
    expect(r.out).toContain("CHILD_RESULT_STATUS=unavailable");
    expect(r.out).toContain("CHILD_SURVIVED_PAST_LOSER=1");
    expect(r.out).not.toContain("refusing to serve");
    expect(r.out).not.toContain("[VERIFY] FAIL");
  }, 180_000);

  it("[FX-5] confirmed drift WITHOUT the flag keeps serving", async () => {
    const r = await spawnChild("drift", undefined);

    expect(r.code).toBe(0);
    expect(r.out).toContain("[VERIFY] FAIL");
    expect(r.out).toContain("CHILD_RESULT_STATUS=fail");
    expect(r.out).toContain("CHILD_REACHED_END=1");
  }, 180_000);
});
