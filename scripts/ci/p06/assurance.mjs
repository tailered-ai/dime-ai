#!/usr/bin/env node
/**
 * p06/assurance.mjs — P06 ASSURANCE: prove each mandatory, locally
 * executable P06 gate can actually REJECT a defect, for the RIGHT reason,
 * at the RIGHT step, and returns green when the defect is removed.
 *
 * The cycle, per fixture (P05's law, applied to P06's wired runner):
 *
 *   1. CONTROL-BEFORE   run the gate on the clean candidate  → must PASS
 *   2. ARM              apply inert poison inside the candidate ONLY
 *   3. POISON           run the SAME gate                     → must FAIL
 *   4. TARGET           the failing step index must be the declared one
 *   5. REASON           every declared reason signature must match the
 *                       structured evidence (step stdout/stderr/result)
 *   6. RESTORE          remove the poison
 *   7. CONTROL-AFTER    run the gate again                    → must PASS
 *
 * Anything less is BROKEN_GATE with a subcode — never a silent pass. A gate
 * that cannot be proven is UNPROVEN, and P06 cannot accept while a mandatory
 * locally executable gate is UNPROVEN.
 *
 * Poison containment: fixture bytes live under this fixtures/ tree as inert
 * patches/manifests, are applied ONLY inside a disposable candidate worktree,
 * and are removed before the control-after leg. The gitleaks canary secret is
 * stored SPLIT across JSON parts and joined only in memory inside the
 * candidate, so no committed byte of this repository ever matches a live
 * secret pattern.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runSnapshot, disposeSnapshot } from "../snapshot.mjs";
import { loadVerifiedContract } from "../registry.mjs";
import { deriveScope } from "./scope.mjs";
import { runOneGate } from "./run-gates.mjs";
import { measureCapabilities, provisionCandidate } from "./capability.mjs";
import { bootstrapTools } from "./tools.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, "..", "..", "..");
export const FIXTURES_DIR = path.join(
  REPO_ROOT,
  "scripts/ci/selftest/fixtures"
);
const sha256 = buf => createHash("sha256").update(buf).digest("hex");

/** Frozen BROKEN_GATE subcodes — each names a distinct failure of proof. */
export const BROKEN_SUBCODES = [
  "CONTROL_NOT_GREEN",
  "POISON_NOT_REJECTED",
  "WRONG_TARGET",
  "WRONG_REASON",
  "NON_DETECTOR_STATUS",
  "NON_RESTORING",
  "ARM_FAILED",
  "POISON_TRUNCATED",
];

/**
 * Independent reconstruction of what a new-file patch MUST produce.
 *
 * `git apply` honours the hunk header's declared line count and silently
 * DROPS surplus body lines — a mis-counted `@@ -0,0 +1,N @@` yields a
 * truncated, weaker poison that can still "apply cleanly" and then fail to
 * trip the rule it was written for. That is a false ASSURANCE proof, so the
 * applied bytes are verified against the patch's own `+` lines rather than
 * trusted. (Found live: a 9-line count over 10 body lines dropped the
 * `uses:` line, so the unpinned-action poison tripped only the permissions
 * rule.)
 */
export function expectedPatchBytes(patchText) {
  const out = {};
  let current = null;
  let inHunk = false;
  for (const line of patchText.split("\n")) {
    const header = line.match(/^\+\+\+ b\/(.+)$/);
    if (header) {
      current = header[1];
      out[current] = [];
      inHunk = false;
      continue;
    }
    if (line.startsWith("@@")) {
      inHunk = true;
      continue;
    }
    if (inHunk && current && line.startsWith("+"))
      out[current].push(line.slice(1));
  }
  return Object.fromEntries(
    Object.entries(out).map(([file, lines]) => [file, `${lines.join("\n")}\n`])
  );
}

export function loadP06Fixtures() {
  return readdirSync(FIXTURES_DIR)
    .filter(d => d.startsWith("p06-"))
    .sort()
    .map(id => {
      const file = path.join(FIXTURES_DIR, id, "fixture.json");
      const bytes = readFileSync(file);
      const fixture = JSON.parse(bytes.toString("utf8"));
      return {
        ...fixture,
        dir: path.join(FIXTURES_DIR, id),
        sha256: sha256(bytes),
      };
    });
}

/** Apply a fixture's poison inside the candidate. Returns an undo record. */
export function arm(fixture, worktree) {
  const git = (...args) =>
    execFileSync("git", ["-C", worktree, ...args], { encoding: "utf8" });
  if (fixture.poison_mode === "patch") {
    const patch = path.join(fixture.dir, "poison.patch");
    const patchText = readFileSync(patch, "utf8");
    git("apply", "--whitespace=nowarn", patch);
    const changed = Object.entries(expectedPatchBytes(patchText));
    for (const [rel, expected] of changed) {
      const abs = path.join(worktree, rel);
      const actual = existsSync(abs) ? readFileSync(abs, "utf8") : null;
      if (actual !== expected) {
        const err = new Error(
          `POISON_TRUNCATED: ${rel} — git apply produced ${actual === null ? "no file" : `${actual.split("\n").length} line(s)`}, ` +
            `patch body declares ${expected.split("\n").length}; check the @@ hunk count`
        );
        err.subcode = "POISON_TRUNCATED";
        throw err;
      }
    }
    // Stage the poisoned paths. This is FIDELITY, not convenience: CI runs
    // against an actions/checkout tree in which every file is tracked, and
    // git-aware detectors behave accordingly — semgrep reports "Scan was
    // limited to files tracked by git" and silently skips untracked files,
    // so an unstaged poison would never be scanned and the gate would look
    // incapable of rejecting when it is not.
    for (const [rel] of changed) git("add", "--force", rel);
    return { mode: "patch", patch, staged: changed.map(([rel]) => rel) };
  }
  if (fixture.poison_mode === "overwrite") {
    const { path: rel, content } = fixture.poison_overwrite;
    const abs = path.join(worktree, rel);
    const original = readFileSync(abs);
    writeFileSync(abs, content);
    return { mode: "overwrite", rel, original };
  }
  if (fixture.poison_mode === "temp-commit") {
    // The canary is JOINED here, in memory, inside the disposable candidate,
    // and committed to an unreferenced commit so the gate's history scan can
    // see it. Nothing committed to this repository holds the joined value.
    const {
      path: rel,
      content_parts,
      content_template,
    } = fixture.poison_temp_commit;
    const abs = path.join(worktree, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(
      abs,
      content_template.replace("{JOINED}", content_parts.join(""))
    );
    git("add", "--force", rel);
    git(
      "-c",
      "user.email=ci-verify@local",
      "-c",
      "user.name=ci-verify",
      "commit",
      "-q",
      "-m",
      "P06 assurance canary (disposable candidate only)"
    );
    // The poison leg binds to the symbolic ref "HEAD", which git resolves
    // inside this disposable candidate. Reading the sha with rev-parse would
    // duplicate P01's exclusive authority over ref resolution (DEF-025), and
    // the symbolic form is exactly equivalent here.
    return { mode: "temp-commit", rel, head: "HEAD" };
  }
  if (fixture.poison_mode === "temp-commit-modify") {
    // Diff-aware detectors (immutable-migration, destructive-SQL) compare
    // BASE...HEAD, so their poison must be a COMMITTED modification — an
    // unstaged edit is invisible to `git diff --diff-filter=M`.
    const { path: rel, append } = fixture.poison_temp_commit_modify;
    const abs = path.join(worktree, rel);
    const original = readFileSync(abs);
    writeFileSync(abs, `${original.toString("utf8")}${append}`);
    git("add", "--force", rel);
    git(
      "-c",
      "user.email=ci-verify@local",
      "-c",
      "user.name=ci-verify",
      "commit",
      "-q",
      "-m",
      "P06 assurance: mutate an applied migration (disposable candidate only)"
    );
    return {
      mode: "temp-commit-modify",
      rel,
      head: "HEAD",
    };
  }
  throw new Error(`UNKNOWN_POISON_MODE: ${fixture.poison_mode}`);
}

export function restore(fixture, worktree, undo) {
  const git = (...args) =>
    execFileSync("git", ["-C", worktree, ...args], { encoding: "utf8" });
  if (undo.mode === "patch") {
    // Unstage first (the candidate is disposable and nothing else is staged),
    // then reverse the worktree change.
    git("reset", "-q");
    git("apply", "--reverse", "--whitespace=nowarn", undo.patch);
    return;
  }
  if (undo.mode === "overwrite") {
    writeFileSync(path.join(worktree, undo.rel), undo.original);
    return;
  }
  if (undo.mode === "temp-commit" || undo.mode === "temp-commit-modify") {
    git("reset", "--hard", "-q", "HEAD~1");
    if (undo.mode === "temp-commit") {
      const abs = path.join(worktree, undo.rel);
      if (existsSync(abs)) rmSync(abs, { force: true });
    }
    return;
  }
}

/** Match declared reason signatures against the structured evidence. */
export function matchReasons(fixture, evidence) {
  return fixture.expected_reason.map(pattern => {
    let text = "";
    if (pattern.source === "result_reason") text = evidence.result_reason ?? "";
    else if (pattern.source === "step_stdout") text = evidence.step_stdout;
    else if (pattern.source === "step_stderr") text = evidence.step_stderr;
    return {
      source: pattern.source,
      regex: pattern.regex,
      matched: new RegExp(pattern.regex).test(text),
    };
  });
}

function readStepCapture(stepDir, index, stream) {
  const file = path.join(stepDir, `step-${index}.${stream}`);
  return existsSync(file) ? readFileSync(file, "utf8") : "";
}

export async function runP06Assurance(options = {}) {
  const { contract } = loadVerifiedContract();
  const scope = deriveScope();
  const outDir =
    options.outDir ?? path.join(REPO_ROOT, ".ci-verify", "p06-assurance");
  mkdirSync(outDir, { recursive: true });
  const fixtures = loadP06Fixtures().filter(
    f => !options.only || options.only.includes(f.fixture_id)
  );

  const tools = bootstrapTools();
  const handle = runSnapshot({ mode: "committed", keepRunDir: true });
  const worktree = handle.paths.worktree;
  const candidate = handle.snapshot.identity;
  const caps = measureCapabilities(worktree);
  const provisioned = provisionCandidate(worktree);
  // The in-candidate install is the AUTHORITY on node-deps satisfaction.
  caps.provisioning["node-deps"] = provisioned.ok;
  console.log(`[assurance] candidate provisioned: ${provisioned.ok}`);

  const ctx = {
    head_sha: candidate.head_sha,
    base_sha: candidate.base_sha,
    merge_commit_sha: candidate.merge_commit_sha,
    run_marker: `assure-${Date.now().toString(36)}`,
  };
  const gha = {
    CI: "true",
    GITHUB_ACTIONS: "true",
    GITHUB_ACTOR: "ci-verify-local",
    GITHUB_SHA: ctx.merge_commit_sha,
    GITHUB_WORKFLOW_SHA: ctx.merge_commit_sha,
    GITHUB_RUN_ID: ctx.run_marker,
    GITHUB_REPOSITORY: "tailered-ai/dime-ai",
    GITHUB_EVENT_NAME: "pull_request",
    GITHUB_WORKSPACE: worktree,
  };

  const proofs = [];
  try {
    for (const fixture of fixtures) {
      const gateId = fixture.expected_gate;
      const check = contract.checks.find(c => c.check_id === gateId);
      const row = scope.rows.find(r => r.gate_id === gateId);
      const exec = (tag, extraCtx = {}) =>
        runOneGate({
          gateId,
          check,
          row,
          ctx: { ...ctx, ...extraCtx },
          caps,
          tools,
          worktree,
          candidate,
          gha,
          outDir,
          runTag: `${fixture.fixture_id}-${tag}`,
        });

      const proof = {
        fixture_id: fixture.fixture_id,
        fixture_sha256: fixture.sha256,
        gate_id: gateId,
        mandatory: row?.required ?? false,
        legs: {},
      };

      // Per-cycle cleanliness baseline. Comparing against a baseline rather
      // than against "empty" keeps one fixture's declared artifact from
      // reading as the next fixture's residue (observed: gitleaks' own
      // results.sarif surfacing inside the security-audit cycle).
      const sweepArtifacts = () => {
        for (const artifact of fixture.allowed_execution_artifacts ?? []) {
          const abs = path.join(worktree, artifact);
          if (existsSync(abs)) rmSync(abs, { recursive: true, force: true });
        }
      };
      const dirtyNow = () =>
        execFileSync(
          "git",
          ["-C", worktree, "status", "--porcelain=v1", "--untracked-files=all"],
          { encoding: "utf8" }
        ).trim();
      sweepArtifacts();
      const baselineDirty = dirtyNow();

      // 1. CONTROL-BEFORE
      const before = await exec("control-before");
      proof.legs.control_before = {
        status: before.lift.status,
        reason: before.lift.reason,
        duration_s: before.duration_s,
      };
      if (
        before.lift.status !== (fixture.control_expectation?.status ?? "PASS")
      ) {
        proof.verdict = "BROKEN_GATE";
        proof.subcode = "CONTROL_NOT_GREEN";
        proof.detail = `control-before was ${before.lift.status}: ${before.lift.reason}`;
        proofs.push(proof);
        console.log(
          `[assurance] ${fixture.fixture_id}: BROKEN_GATE(${proof.subcode})`
        );
        continue;
      }

      // 2. ARM
      let undo;
      try {
        undo = arm(fixture, worktree);
      } catch (error) {
        proof.verdict = "BROKEN_GATE";
        proof.subcode = error.subcode ?? "ARM_FAILED";
        proof.detail = String(error.message).slice(0, 300);
        proofs.push(proof);
        console.log(
          `[assurance] ${fixture.fixture_id}: BROKEN_GATE(${proof.subcode}) ${proof.detail}`
        );
        continue;
      }

      // 3. POISON leg. For the gitleaks canary the candidate HEAD moved, so
      // the adapter's range must bind to the new head — exactly what CI
      // would scan.
      let poisonCtx = {};
      if (undo.mode === "temp-commit") poisonCtx = { head_sha: undo.head };
      const poisoned = await exec("poison", poisonCtx);
      const failedStep = poisoned.journal?.summary?.failed_step ?? null;
      const stepDir = poisoned.stepDir;
      const evidence = {
        result_reason: poisoned.lift.reason,
        step_stdout:
          failedStep === null
            ? ""
            : readStepCapture(stepDir, failedStep, "stdout"),
        step_stderr:
          failedStep === null
            ? ""
            : readStepCapture(stepDir, failedStep, "stderr"),
      };
      const reasonOutcomes = matchReasons(fixture, evidence);
      proof.legs.poison = {
        status: poisoned.lift.status,
        reason: poisoned.lift.reason,
        failed_step: failedStep,
        duration_s: poisoned.duration_s,
        reason_matches: reasonOutcomes,
        journal_sha256: poisoned.journal
          ? sha256(readFileSync(poisoned.journalPath))
          : null,
      };

      let verdict = null;
      let subcode = null;
      let detail = null;
      if (poisoned.lift.status !== fixture.expected_status) {
        verdict = "BROKEN_GATE";
        subcode =
          poisoned.lift.status === "PASS"
            ? "POISON_NOT_REJECTED"
            : "NON_DETECTOR_STATUS";
        detail = `expected ${fixture.expected_status}, got ${poisoned.lift.status}: ${poisoned.lift.reason}`;
      } else if (
        fixture.expected_failed_step !== undefined &&
        failedStep !== fixture.expected_failed_step
      ) {
        verdict = "BROKEN_GATE";
        subcode = "WRONG_TARGET";
        detail = `expected failure at step ${fixture.expected_failed_step}, got ${failedStep}`;
      } else if (!reasonOutcomes.every(o => o.matched)) {
        verdict = "BROKEN_GATE";
        subcode = "WRONG_REASON";
        detail = `unmatched: ${reasonOutcomes
          .filter(o => !o.matched)
          .map(o => `${o.source}:${o.regex}`)
          .join(" | ")}`;
      }

      // 6. RESTORE (always attempted, even on a broken verdict). Artifacts a
      // gate legitimately writes must be DECLARED per fixture and are removed
      // here; anything undeclared left behind is NON_RESTORING, exactly as
      // P05 requires — an undeclared artifact is an unproven side effect.
      restore(fixture, worktree, undo);
      sweepArtifacts();
      const dirty = dirtyNow() === baselineDirty ? "" : dirtyNow();
      proof.legs.restore = {
        clean: dirty.length === 0,
        baseline_dirty: baselineDirty.slice(0, 200),
        declared_artifacts: fixture.allowed_execution_artifacts ?? [],
        residue: dirty.slice(0, 400),
      };

      // 7. CONTROL-AFTER
      const after = await exec("control-after");
      proof.legs.control_after = {
        status: after.lift.status,
        reason: after.lift.reason,
        duration_s: after.duration_s,
      };
      if (
        !verdict &&
        after.lift.status !== (fixture.control_expectation?.status ?? "PASS")
      ) {
        verdict = "BROKEN_GATE";
        subcode = "NON_RESTORING";
        detail = `control-after was ${after.lift.status}: ${after.lift.reason}`;
      }
      if (!verdict && dirty.length > 0) {
        verdict = "BROKEN_GATE";
        subcode = "NON_RESTORING";
        detail = `candidate not restored: ${dirty.slice(0, 200)}`;
      }

      proof.verdict = verdict ?? "PROVEN";
      proof.subcode = subcode;
      proof.detail = detail;
      proofs.push(proof);
      console.log(
        `[assurance] ${fixture.fixture_id.padEnd(38)} ${proof.verdict}${subcode ? `(${subcode}) ${detail}` : ""}`
      );
    }
  } finally {
    disposeSnapshot(handle);
  }

  // Coverage: every mandatory + locally executable P06 gate needs a proof.
  const proven = new Set(
    proofs.filter(p => p.verdict === "PROVEN").map(p => p.gate_id)
  );
  const mandatoryLocal = scope.rows.filter(
    r => r.owner === "P06" && r.required && r.executability === "EXECUTABLE"
  );
  const coverage = mandatoryLocal.map(r => ({
    gate_id: r.gate_id,
    state: proven.has(r.gate_id) ? "PROVEN" : "UNPROVEN",
  }));

  const artifact = {
    candidate: ctx,
    generated_at: new Date().toISOString(),
    proofs,
    coverage,
    unproven: coverage.filter(c => c.state === "UNPROVEN").map(c => c.gate_id),
    all_proven: coverage.every(c => c.state === "PROVEN"),
  };
  writeFileSync(
    path.join(outDir, "assurance.json"),
    JSON.stringify(artifact, null, 2) + "\n"
  );
  return artifact;
}

async function main() {
  const only = process.argv.slice(2);
  const artifact = await runP06Assurance(only.length ? { only } : {});
  console.log("");
  console.log(
    `[assurance] proofs: ${artifact.proofs.filter(p => p.verdict === "PROVEN").length}/${artifact.proofs.length} PROVEN`
  );
  console.log(
    `[assurance] mandatory local coverage: ${artifact.coverage.filter(c => c.state === "PROVEN").length}/${artifact.coverage.length}` +
      (artifact.unproven.length
        ? ` — UNPROVEN: ${artifact.unproven.join(", ")}`
        : "")
  );
  if (!artifact.all_proven || artifact.proofs.some(p => p.verdict !== "PROVEN"))
    process.exitCode = 1;
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
) {
  main().catch(error => {
    console.error(`[assurance] ${error.message}`);
    console.error(error.stack);
    process.exitCode = 1;
  });
}
