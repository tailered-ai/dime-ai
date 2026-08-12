/**
 * P06 validation suite — boundary model, step driver, verdict lifting,
 * governed tools, and the 18-case negative program (§13).
 *
 *   P06.BND01-06   execution-boundary classification (provisioning vs
 *                  detector, secret dependence, cwd derivation)
 *   P06.DRV01-12   step-driver semantics: per-step cwd fidelity, escape
 *                  refusal, provisioning-failure protocol, GHA env files
 *   P06.LIFT01-08  verdict lifting + the hard invariant (no PASS/FAIL
 *                  without journal-proven detector execution)
 *   P06.TOOL01-04  governed tool identity derivation and refusal
 *   P06.NEG*       the remaining §13 negative cases not covered above
 *
 * Every driver test runs the REAL driver binary in a scratch worktree —
 * no mocks of the thing under test.
 */
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
// @ts-expect-error — plain .mjs module without type declarations
import {
  classifySteps,
  classifyCheck,
  secretDependence,
  provisioningOutcome,
  isProvisioningStep,
} from "./boundary.mjs";
// @ts-expect-error — plain .mjs module without type declarations
import {
  analyzeMixed,
  buildDriverSteps,
  liftVerdict,
  resolveExpressions,
} from "./run-gates.mjs";
// @ts-expect-error — plain .mjs module without type declarations
import { deriveToolIdentities } from "./tools.mjs";
// @ts-expect-error — plain .mjs module without type declarations
import { loadVerifiedContract } from "../registry.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DRIVER = path.join(HERE, "step-driver.mjs");
const SCRATCH = mkdtempSync(path.join(tmpdir(), "p06-suite-"));
afterAll(() => {
  rmSync(SCRATCH, { recursive: true, force: true });
});

let seq = 0;
function scratchWorktree(): {
  worktree: string;
  stepDir: string;
  specPath: string;
} {
  const root = path.join(SCRATCH, `case-${(seq += 1)}`);
  const worktree = path.join(root, "worktree");
  const stepDir = path.join(root, "steps");
  mkdirSync(worktree, { recursive: true });
  mkdirSync(stepDir, { recursive: true });
  return { worktree, stepDir, specPath: path.join(root, "spec.json") };
}

function runDriver(
  spec: Record<string, unknown>,
  stepDir: string,
  specPath: string
) {
  writeFileSync(specPath, JSON.stringify(spec, null, 2));
  const child = spawnSync("node", [DRIVER, specPath], {
    encoding: "utf8",
    env: { ...process.env, CI_VERIFY_STEP_DIR: stepDir },
    timeout: 60_000,
  });
  const journalPath = path.join(stepDir, "steps.json");
  const journal = existsSync(journalPath)
    ? JSON.parse(readFileSync(journalPath, "utf8"))
    : null;
  return {
    exit: child.status,
    journal,
    stdout: child.stdout,
    stderr: child.stderr,
  };
}

function step(overrides: Record<string, unknown>) {
  return {
    index: 0,
    kind: "DETECTOR",
    mode: "execute",
    cwd: ".",
    env: {},
    provisioning_signatures: [],
    run: "true",
    adapted_run: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
describe("P06.BND boundary classification", () => {
  it("BND01: install/setup commands classify as provisioning, checks as detector", () => {
    expect(isProvisioningStep("pnpm install --frozen-lockfile")).toContain(
      "node-deps"
    );
    expect(isProvisioningStep('pipx install "semgrep==1.0"')).toContain(
      "pipx-install"
    );
    expect(
      isProvisioningStep("sudo install -m 0755 x /usr/local/bin/x")
    ).toContain("privilege-escalation");
    expect(isProvisioningStep("curl -sSfL https://x -o y")).toContain(
      "download"
    );
    expect(isProvisioningStep("npx tsc --noEmit")).toBeNull();
    expect(isProvisioningStep("npx vitest run x.test.ts")).toBeNull();
  });

  it("BND02: secret dependence is derived from the contract, never assumed", () => {
    const bound = secretDependence({
      steps: [{ env: { GITHUB_TOKEN: "${{ secrets.GITHUB_TOKEN }}" } }],
    });
    expect(bound.length).toBe(1);
    const free = secretDependence({ steps: [{ run: "echo hello" }] });
    expect(free.length).toBe(0);
  });

  it("BND03: #proof and ci#test carry ZERO secret references in the frozen contract (DEF-033 corrected diagnosis)", () => {
    const { contract } = loadVerifiedContract();
    for (const id of [
      ".github/workflows/01-pr-proof-contract.yml#proof",
      ".github/workflows/ci.yml#test",
    ]) {
      const check = contract.checks.find(
        (c: { check_id: string }) => c.check_id === id
      );
      expect(check).toBeTruthy();
      expect(secretDependence(check)).toEqual([]);
    }
  });

  it("BND04: gitleaks IS the only P06 required check with secret references", () => {
    const { contract } = loadVerifiedContract();
    const check = contract.checks.find(
      (c: { check_id: string }) =>
        c.check_id === ".github/workflows/gitleaks.yml#gitleaks"
    );
    expect(secretDependence(check).length).toBeGreaterThan(0);
  });

  it("BND05: job-default working-directory flows to steps; step override supersedes (§4.5/§4.6)", () => {
    const { steps } = classifySteps({
      defaults: { run: { "working-directory": "ml/dime-1.0" } },
      steps: [
        { run: "uv run pytest -q" },
        { run: "echo elsewhere", "working-directory": "scripts" },
      ],
    });
    expect(steps[0].effective_cwd).toBe("ml/dime-1.0");
    expect(steps[1].effective_cwd).toBe("scripts");
  });

  it("BND06: dime-llm-validation carries ml/dime-1.0 from the real contract (DEF-032)", () => {
    const { contract } = loadVerifiedContract();
    const check = contract.checks.find(
      (c: { check_id: string }) =>
        c.check_id === ".github/workflows/dime-llm-validation.yml#validate"
    );
    const { job_default_cwd, steps } = classifySteps(check);
    expect(job_default_cwd).toBe("ml/dime-1.0");
    for (const s of steps) expect(s.effective_cwd).toBe("ml/dime-1.0");
  });

  it("BND07: a fully secret-bound job classifies nonlocal, never executable (§13.10)", () => {
    const verdict = classifyCheck(
      {
        steps: [{ run: "deploy --token ${{ secrets.PROD_TOKEN }}" }],
      },
      { runnability: "LOCAL", required_tools: [] },
      { provisioning: {}, tools: {} }
    );
    expect(verdict.execution_class).toBe("NOT_LOCALLY_EXECUTABLE");
    expect(verdict.reason_code).toBe("SECRET_BOUND");
  });
});

// ---------------------------------------------------------------------------
describe("P06.DRV step-driver semantics", () => {
  it("DRV01: detector executes at the contract cwd, not the candidate root (§4)", () => {
    const { worktree, stepDir, specPath } = scratchWorktree();
    mkdirSync(path.join(worktree, "sub"));
    writeFileSync(path.join(worktree, "sub", "marker.txt"), "here");
    const { exit, journal } = runDriver(
      {
        gate_id: "t",
        worktree,
        gha: {},
        steps: [step({ cwd: "sub", run: "test -f marker.txt" })],
      },
      stepDir,
      specPath
    );
    expect(exit).toBe(0);
    expect(journal.steps[0].cwd_verified).toBe(true);
    expect(journal.steps[0].resolved_cwd.endsWith("/sub")).toBe(true);
  });

  it("DRV02: missing contract cwd refuses BEFORE any verdict (§4.2)", () => {
    const { worktree, stepDir, specPath } = scratchWorktree();
    const { exit, journal } = runDriver(
      {
        gate_id: "t",
        worktree,
        gha: {},
        steps: [step({ cwd: "does-not-exist" })],
      },
      stepDir,
      specPath
    );
    expect(exit).toBe(31);
    expect(journal.summary.reason).toContain("CWD_MISSING");
    expect(journal.steps[0].executed).toBe(false);
  });

  it("DRV03: `..` escape outside the candidate is rejected (§4.3)", () => {
    const { worktree, stepDir, specPath } = scratchWorktree();
    const { exit, journal } = runDriver(
      { gate_id: "t", worktree, gha: {}, steps: [step({ cwd: "../.." })] },
      stepDir,
      specPath
    );
    expect(exit).toBe(30);
    expect(journal.summary.reason).toContain("CWD_ESCAPES_CANDIDATE");
  });

  it("DRV04: symlink escape is rejected via realpath (§4.4)", () => {
    const { worktree, stepDir, specPath } = scratchWorktree();
    symlinkSync(tmpdir(), path.join(worktree, "sneaky"));
    const { exit, journal } = runDriver(
      { gate_id: "t", worktree, gha: {}, steps: [step({ cwd: "sneaky" })] },
      stepDir,
      specPath
    );
    expect(exit).toBe(30);
    expect(journal.summary.reason).toContain("CWD_ESCAPES_CANDIDATE");
  });

  it("DRV05: provisioning failure exits 10 and NO later step executes (§3)", () => {
    const { worktree, stepDir, specPath } = scratchWorktree();
    const { exit, journal } = runDriver(
      {
        gate_id: "t",
        worktree,
        gha: {},
        steps: [
          step({
            index: 0,
            kind: "PROVISIONING",
            provisioning_signatures: ["download"],
            run: "curl --fail --silent https://127.0.0.1:1/nothing -o x",
          }),
          step({ index: 1, run: "echo SHOULD_NEVER_RUN > leaked.txt" }),
        ],
      },
      stepDir,
      specPath
    );
    expect(exit).toBe(10);
    expect(journal.summary.detector_started).toBe(false);
    expect(existsSync(path.join(worktree, "leaked.txt"))).toBe(false);
  });

  it("DRV06: sudo-class provisioning failure maps to BLOCKED, never FAIL (§13.4)", () => {
    const { worktree, stepDir, specPath } = scratchWorktree();
    const { exit, journal } = runDriver(
      {
        gate_id: "t",
        worktree,
        gha: {},
        steps: [
          step({
            kind: "PROVISIONING",
            provisioning_signatures: ["privilege-escalation"],
            run: "sudo -n /usr/bin/true 2>/dev/null || exit 1",
          }),
        ],
      },
      stepDir,
      specPath
    );
    expect(exit).toBe(10);
    const lifted = liftVerdict({ status: "FAIL" }, exit, journal);
    expect(lifted.status).toBe("BLOCKED");
    expect(lifted.reason).toContain("PROVISIONING_REQUIRES_PRIVILEGE");
  });

  it("DRV07: download-class provisioning failure maps to INFRA_FAIL, never FAIL (§13.5)", () => {
    const { worktree, stepDir, specPath } = scratchWorktree();
    const { exit, journal } = runDriver(
      {
        gate_id: "t",
        worktree,
        gha: {},
        steps: [
          step({
            kind: "PROVISIONING",
            provisioning_signatures: ["download"],
            run: "exit 22",
          }),
        ],
      },
      stepDir,
      specPath
    );
    const lifted = liftVerdict({ status: "FAIL" }, exit, journal);
    expect(lifted.status).toBe("INFRA_FAIL");
    expect(lifted.reason).toContain("PROVISIONING_DOWNLOAD");
  });

  it("DRV08: detector finding after satisfied provisioning becomes FAIL (§3, §13.8)", () => {
    const { worktree, stepDir, specPath } = scratchWorktree();
    const { exit, journal } = runDriver(
      {
        gate_id: "t",
        worktree,
        gha: {},
        steps: [
          step({
            index: 0,
            kind: "PROVISIONING",
            mode: "satisfied",
            satisfied_by: "measured equivalence (test)",
          }),
          step({ index: 1, run: "echo finding; exit 1" }),
        ],
      },
      stepDir,
      specPath
    );
    expect(exit).toBe(20);
    const lifted = liftVerdict({ status: "FAIL" }, exit, journal);
    expect(lifted.status).toBe("FAIL");
  });

  it("DRV09: clean detector after satisfied provisioning becomes PASS (§3)", () => {
    const { worktree, stepDir, specPath } = scratchWorktree();
    const { exit, journal } = runDriver(
      {
        gate_id: "t",
        worktree,
        gha: {},
        steps: [
          step({
            index: 0,
            kind: "PROVISIONING",
            mode: "satisfied",
            satisfied_by: "measured equivalence (test)",
          }),
          step({ index: 1, run: "true" }),
        ],
      },
      stepDir,
      specPath
    );
    expect(exit).toBe(0);
    const lifted = liftVerdict({ status: "PASS" }, exit, journal);
    expect(lifted.status).toBe("PASS");
  });

  it("DRV10: output redirection cannot mask a detector exit (§13.9, DEF-023 class)", () => {
    const { worktree, stepDir, specPath } = scratchWorktree();
    const { exit } = runDriver(
      {
        gate_id: "t",
        worktree,
        gha: {},
        steps: [
          step({ run: "{ echo CRITICAL-finding; exit 3; } > report.sarif" }),
        ],
      },
      stepDir,
      specPath
    );
    expect(exit).toBe(20);
  });

  it("DRV11: malformed detector output fails closed, never PASS (§13.17)", () => {
    const { worktree, stepDir, specPath } = scratchWorktree();
    writeFileSync(path.join(worktree, "truncated.json"), "{");
    const { exit, journal } = runDriver(
      {
        gate_id: "t",
        worktree,
        gha: {},
        steps: [
          step({
            run: "node -e \"JSON.parse(require('fs').readFileSync('truncated.json','utf8'))\"",
          }),
        ],
      },
      stepDir,
      specPath
    );
    expect(exit).toBe(20);
    const lifted = liftVerdict({ status: "FAIL" }, exit, journal);
    expect(lifted.status).not.toBe("PASS");
  });

  it("DRV12: GITHUB_ENV handoff between steps works (proof contract §11)", () => {
    const { worktree, stepDir, specPath } = scratchWorktree();
    const { exit } = runDriver(
      {
        gate_id: "t",
        worktree,
        gha: { GITHUB_ACTOR: "ci-verify-local" },
        steps: [
          step({ index: 0, run: 'echo "TESTS_PASSED=1234" >> "$GITHUB_ENV"' }),
          step({
            index: 1,
            run: '[ "$TESTS_PASSED" = "1234" ] && [ "$GITHUB_ACTOR" = "ci-verify-local" ]',
          }),
        ],
      },
      stepDir,
      specPath
    );
    expect(exit).toBe(0);
  });

  it("DRV13: an unresolved ${{ }} expression refuses execution, never guesses (§ expression law)", () => {
    const { worktree, stepDir, specPath } = scratchWorktree();
    const { exit, journal } = runDriver(
      {
        gate_id: "t",
        worktree,
        gha: {},
        steps: [step({ run: "echo ${{ github.event.unknown_thing }}" })],
      },
      stepDir,
      specPath
    );
    expect(exit).toBe(32);
    expect(journal.summary.reason).toContain("EXPRESSION_UNRESOLVED");
    const lifted = liftVerdict({ status: "FAIL" }, exit, journal);
    expect(lifted.status).toBe("BLOCKED");
  });

  it("DRV15: undeclared-shell steps run WITHOUT pipefail — grep -q early-exit on a long stream is a PASS, exactly as in CI (DEF-039)", () => {
    const { worktree, stepDir, specPath } = scratchWorktree();
    const { exit } = runDriver(
      {
        gate_id: "t",
        worktree,
        gha: {},
        steps: [
          step({
            run: '{ echo "needle"; for i in $(seq 1 200000); do echo "haystack line $i"; done; } | grep -q "needle"',
          }),
        ],
      },
      stepDir,
      specPath
    );
    expect(exit).toBe(0);
  });

  it("DRV16: a step DECLARING shell:bash keeps GHA's explicit pipefail semantics", () => {
    const { worktree, stepDir, specPath } = scratchWorktree();
    const { exit } = runDriver(
      {
        gate_id: "t",
        worktree,
        gha: {},
        steps: [step({ shell: "bash", run: "false | true" })],
      },
      stepDir,
      specPath
    );
    expect(exit).toBe(20); // pipefail: the failing left side fails the step
  });

  it("DRV14: a gate whose steps never include a detector cannot report a verdict (§3)", () => {
    const { worktree, stepDir, specPath } = scratchWorktree();
    const { exit, journal } = runDriver(
      {
        gate_id: "t",
        worktree,
        gha: {},
        steps: [
          step({ kind: "PROVISIONING", mode: "satisfied", satisfied_by: "x" }),
        ],
      },
      stepDir,
      specPath
    );
    expect(exit).toBe(12);
    const lifted = liftVerdict({ status: "FAIL" }, exit, journal);
    expect(lifted.status).toBe("INFRA_FAIL");
  });
});

// ---------------------------------------------------------------------------
describe("P06.LIFT verdict lifting and the hard invariant", () => {
  const goodJournal = {
    summary: { detector_started: true, failed_step: null, reason: null },
    steps: [{ executed: true, cwd_verified: true, index: 0 }],
  };

  it("LIFT01: PASS requires journal-proven detector start (§3 hard invariant)", () => {
    const lifted = liftVerdict({ status: "PASS" }, 0, {
      summary: { detector_started: false },
      steps: [],
    });
    expect(lifted.status).toBe("INFRA_FAIL");
    expect(lifted.reason).toContain("HARD_INVARIANT");
  });

  it("LIFT02: FAIL requires journal-proven detector start (§3 hard invariant)", () => {
    const lifted = liftVerdict({ status: "FAIL" }, 20, {
      summary: { detector_started: false },
      steps: [],
    });
    expect(lifted.status).toBe("INFRA_FAIL");
  });

  it("LIFT03: unverified cwd voids PASS (§4.7 — bypass cannot ignore cwd metadata)", () => {
    const lifted = liftVerdict({ status: "PASS" }, 0, {
      summary: { detector_started: true },
      steps: [{ executed: true, cwd_verified: undefined, index: 0 }],
    });
    expect(lifted.status).toBe("INFRA_FAIL");
  });

  it("LIFT04: missing journal fails closed to INFRA_FAIL", () => {
    const lifted = liftVerdict({ status: "PASS" }, 0, null);
    expect(lifted.status).toBe("INFRA_FAIL");
  });

  it("LIFT05: a driver exit outside the protocol is an anomaly, never a verdict", () => {
    const lifted = liftVerdict(
      { status: "FAIL", reason: "EXIT_7" },
      7,
      goodJournal
    );
    expect(lifted.status).toBe("INFRA_FAIL");
    expect(lifted.reason).toContain("DRIVER_ANOMALY");
  });

  it("LIFT06: executor upgrade-only chain outranks a clean driver exit", () => {
    const lifted = liftVerdict(
      { status: "INFRA_FAIL", reason: "CLEANUP_FAILED: leaked process" },
      0,
      goodJournal
    );
    expect(lifted.status).toBe("INFRA_FAIL");
  });

  it("LIFT07: TIMEOUT stays TIMEOUT — never FAIL, never PASS", () => {
    const lifted = liftVerdict(
      { status: "TIMEOUT", reason: "deadline 100ms elapsed" },
      null,
      null
    );
    expect(lifted.status).toBe("TIMEOUT");
  });

  it("LIFT08: mixed-step failure is INFRA_FAIL with attribution caveat, never FAIL (§ mixed law)", () => {
    const lifted = liftVerdict({ status: "FAIL" }, 11, {
      summary: {
        detector_started: false,
        reason:
          "MIXED_STEP_FAILED: exit 1 (provisioning and detector share this step; attribution requires the captured output)",
      },
      steps: [],
    });
    expect(lifted.status).toBe("INFRA_FAIL");
    expect(lifted.reason).toContain("MIXED_STEP_FAILED");
  });
});

// ---------------------------------------------------------------------------
describe("P06.TOOL governed tool identity", () => {
  it("TOOL01: every identity derives from CI configuration with a recorded chain", () => {
    const identities = deriveToolIdentities();
    const ids = identities.map((t: { id: string }) => t.id);
    expect(ids).toContain("semgrep");
    expect(ids).toContain("zizmor");
    expect(ids).toContain("osv-scanner@security-audit");
    expect(ids).toContain("osv-scanner@full-osv");
    expect(ids).toContain("gitleaks");
    expect(ids).toContain("trivy");
    expect(ids).toContain("syft");
    for (const t of identities) {
      expect(t.version).toBeTruthy();
      expect(t.derived_from).toBeTruthy();
    }
  });

  it("TOOL02: the two osv-scanner identities are DISTINCT versions from distinct gates", () => {
    const identities = deriveToolIdentities();
    const a = identities.find(
      (t: { id: string }) => t.id === "osv-scanner@security-audit"
    );
    const b = identities.find(
      (t: { id: string }) => t.id === "osv-scanner@full-osv"
    );
    expect(a.version).not.toBe(b.version);
  });

  it("TOOL03: provisioningOutcome never returns FAIL or PASS", () => {
    for (const sigs of [
      ["privilege-escalation"],
      ["download"],
      ["node-deps"],
      [],
    ]) {
      const out = provisioningOutcome(sigs, "detail");
      expect(["BLOCKED", "INFRA_FAIL"]).toContain(out.status);
    }
  });

  it("TOOL04: expression resolution only substitutes candidate-identity expressions", () => {
    const ctx = {
      merge_commit_sha: "m".repeat(40),
      head_sha: "h".repeat(40),
      run_marker: "run-1",
    };
    expect(
      resolveExpressions("docker build -t dime-pr:${{ github.sha }} .", ctx)
    ).toContain("m".repeat(40));
    expect(resolveExpressions("x ${{ secrets.TOKEN }}", ctx)).toContain(
      "${{ secrets.TOKEN }}"
    ); // untouched → driver refuses later
  });
});

// ---------------------------------------------------------------------------
describe("P06.SPEC spec-construction totality (§13.18 partial-subcheck law)", () => {
  it("SPEC01: every contract run-step of every P06 gate appears in the driver spec exactly once", () => {
    const { contract } = loadVerifiedContract();
    const caps = {
      provisioning: {
        "node-deps": true,
        "playwright-install": true,
        "uv-sync": true,
        "pip-install": true,
      },
    };
    const tools = {
      resolved: {
        semgrep: { binary: "semgrep", version: "x", mode: "t" },
        zizmor: { binary: "zizmor", version: "x", mode: "t" },
        "osv-scanner@security-audit": {
          binary: "osv-scanner",
          version: "x",
          mode: "t",
        },
        "osv-scanner@full-osv": {
          binary: "osv-scanner",
          version: "x",
          mode: "t",
          path: "p",
        },
        gitleaks: { binary: "gitleaks", version: "x", mode: "t" },
        trivy: { binary: "trivy", version: "x", mode: "t" },
        syft: { binary: "syft", version: "x", mode: "t" },
      },
    };
    const ctx = {
      merge_commit_sha: "m".repeat(40),
      head_sha: "h".repeat(40),
      base_sha: "b".repeat(40),
      run_marker: "r",
    };
    for (const check of contract.checks) {
      const runIdx = check.steps
        .map((s: { run?: string }, i: number) =>
          typeof s.run === "string" && s.run.length ? i : null
        )
        .filter((i: number | null) => i !== null);
      if (!runIdx.length) continue;
      const steps = buildDriverSteps(check, {}, ctx, caps, tools);
      const got = steps
        .map((s: { index: number }) => s.index)
        .sort((a: number, b: number) => a - b);
      expect(got).toEqual(runIdx);
    }
  });

  it("SPEC02: satisfied mode is only ever granted WITH a recorded satisfaction note", () => {
    const { contract } = loadVerifiedContract();
    const caps = {
      provisioning: {
        "node-deps": true,
        "playwright-install": true,
        "uv-sync": true,
        "pip-install": true,
      },
    };
    const tools = { resolved: {} };
    const ctx = {
      merge_commit_sha: "m".repeat(40),
      head_sha: "h".repeat(40),
      base_sha: "b".repeat(40),
      run_marker: "r",
    };
    for (const check of contract.checks) {
      const steps = buildDriverSteps(check, {}, ctx, caps, tools);
      for (const s of steps) {
        if (s.mode === "satisfied") {
          expect(s.satisfied_by).toBeTruthy();
          expect(s.satisfied_by.length).toBeGreaterThan(20);
        }
      }
    }
  });

  it("SPEC03: unproven capability means the provisioning step EXECUTES — never silently assumed (§3)", () => {
    const { contract } = loadVerifiedContract();
    const check = contract.checks.find(
      (c: { check_id: string }) =>
        c.check_id === ".github/workflows/ci.yml#typecheck"
    );
    const noCaps = { provisioning: { "node-deps": false } };
    const steps = buildDriverSteps(
      check,
      {},
      {
        merge_commit_sha: "m".repeat(40),
        head_sha: "h".repeat(40),
        base_sha: "b".repeat(40),
        run_marker: "r",
      },
      noCaps,
      { resolved: {} }
    );
    const install = steps.find((s: { index: number }) => s.index === 3);
    expect(install.mode).toBe("execute");
  });

  it("SPEC04: mixed provisioning/detector text is detected (§ mixed law)", () => {
    expect(
      analyzeMixed("uv lock --check\nuv sync --frozen --dev\nuv pip check", [
        "uv-sync",
      ])
    ).toBe(true);
    expect(analyzeMixed("pnpm install --frozen-lockfile", ["node-deps"])).toBe(
      false
    );
  });
});
