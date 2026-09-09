#!/usr/bin/env node
/**
 * fixture.mjs — P05.T01: the canonical ASSURANCE fixture contract.
 *
 * A fixture is TWO inert files under an approved fixture root:
 *
 *   <root>/<fixture-id>/poison.patch   — unified diff, applied ONLY inside a
 *                                        disposable P01 candidate worktree
 *   <root>/<fixture-id>/expect.json    — versioned expectation metadata
 *
 * Nothing under a fixture directory is ever a LIVE workflow/migration/source
 * file (P05.T02 enforces that). Fixture identity is content-derived: the
 * poison bytes are hash-pinned in expect.json, so hand-editing either file
 * is detectable. No absolute paths, run ids, wall-clock values, usernames,
 * or hostnames participate in fixture identity.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

export const FIXTURE_SCHEMA_VERSION = "1.0.0";

/** Reason-pattern sources the matcher understands. */
export const REASON_SOURCES = ["stdout", "stderr", "result_reason", "artifact"];

export class FixtureError extends Error {
  constructor(reason, detail = {}) {
    super(reason);
    this.name = "FixtureError";
    this.reason = reason;
    Object.assign(this, detail);
  }
}

const sha256 = buf => createHash("sha256").update(buf).digest("hex");

/**
 * Extract the repo-relative paths a unified diff touches, and refuse the
 * dangerous shapes outright: absolute paths, `..` traversal, `.git/`
 * administrative mutation, and Windows drive prefixes. Patch application is
 * treated as hostile input even though we author our own fixtures.
 */
export function parsePatchPaths(patchText) {
  const paths = new Set();
  for (const line of patchText.split("\n")) {
    const match = line.match(/^(?:---|\+\+\+)\s+(?:([ab])\/)?(\S+)/);
    if (!match) continue;
    const candidate = match[2];
    if (candidate === "/dev/null") continue;
    if (!match[1]) {
      // A ---/+++ header without the a/ b/ prefix is either absolute or a
      // nonstandard patch; both are refused rather than guessed at.
      throw new FixtureError("PATCH_PATH_UNPREFIXED", { line });
    }
    if (path.isAbsolute(candidate) || /^[A-Za-z]:[\\/]/.test(candidate)) {
      throw new FixtureError("PATCH_PATH_ABSOLUTE", { candidate });
    }
    const segments = candidate.split("/");
    if (segments.includes("..")) {
      throw new FixtureError("PATCH_PATH_TRAVERSAL", { candidate });
    }
    if (segments[0] === ".git") {
      throw new FixtureError("PATCH_PATH_GIT_ADMIN", { candidate });
    }
    paths.add(candidate);
  }
  if (paths.size === 0) {
    throw new FixtureError("PATCH_EMPTY", {
      detail: "no file paths found in the poison patch",
    });
  }
  return [...paths].sort();
}

const REQUIRED_FIELDS = [
  "schema_version",
  "fixture_id",
  "expected_gate",
  "expected_reason",
  "expected_status",
  "target_class",
  "target_contract_id",
  "applicability",
  "control_expectation",
  "required_execution_mode",
  "fixture_sha256",
  "command_step_indexes",
  "expected_changed_paths",
];

/**
 * `seed`  — a proof: the gate MUST reject the poison for the declared reason.
 * `negative-control` — drives a deliberate framework failure mode.
 * `finding` — a gate empirically proven UNABLE to reject. The cycle still
 *   runs (the observation IS the evidence), but coverage may never count it
 *   as proof; it marks the gate UNPROVEN so no later phase can graduate it
 *   while the weakness stands.
 */
export const APPLICABILITIES = ["seed", "negative-control", "finding"];

/**
 * Reject an "overly broad" reason pattern: it must be a real detector
 * signature, not something that matches everything red.
 */
export function assertReasonPattern(pattern, fixtureId) {
  if (!REASON_SOURCES.includes(pattern?.source)) {
    throw new FixtureError("REASON_SOURCE_UNKNOWN", {
      fixture_id: fixtureId,
      source: pattern?.source,
    });
  }
  if (pattern.source === "artifact" && !pattern.artifact_path) {
    throw new FixtureError("REASON_ARTIFACT_PATH_REQUIRED", {
      fixture_id: fixtureId,
    });
  }
  if (typeof pattern?.regex !== "string" || pattern.regex.length < 6) {
    throw new FixtureError("REASON_TOO_BROAD", {
      fixture_id: fixtureId,
      detail: "regex missing or shorter than 6 characters",
    });
  }
  let compiled;
  try {
    compiled = new RegExp(pattern.regex, pattern.flags ?? "");
  } catch (error) {
    throw new FixtureError("REASON_REGEX_INVALID", {
      fixture_id: fixtureId,
      detail: error.message,
    });
  }
  if (compiled.test("") || compiled.test("ok") || compiled.test("exit 1")) {
    // Matching nothing-in-particular is how a wrong reason slips through.
    throw new FixtureError("REASON_TOO_BROAD", {
      fixture_id: fixtureId,
      detail: "regex matches trivial output (empty / 'ok' / 'exit 1')",
    });
  }
  return compiled;
}

/**
 * Load and structurally validate one fixture directory. Contract-level
 * validation (does the gate exist, is it locally executable) is separate —
 * `validateAgainstRegistry` — so structural failures are reported precisely.
 */
export function loadFixture(fixtureDir) {
  const expectPath = path.join(fixtureDir, "expect.json");
  const patchPath = path.join(fixtureDir, "poison.patch");
  if (!existsSync(expectPath)) {
    throw new FixtureError("EXPECT_MISSING", { fixtureDir });
  }
  if (!existsSync(patchPath)) {
    throw new FixtureError("PATCH_MISSING", { fixtureDir });
  }
  let expect;
  try {
    expect = JSON.parse(readFileSync(expectPath, "utf8"));
  } catch (error) {
    throw new FixtureError("EXPECT_MALFORMED", {
      fixtureDir,
      detail: error.message,
    });
  }
  for (const field of REQUIRED_FIELDS) {
    if (expect[field] === undefined || expect[field] === null) {
      throw new FixtureError("EXPECT_FIELD_MISSING", { fixtureDir, field });
    }
  }
  if (expect.schema_version !== FIXTURE_SCHEMA_VERSION) {
    throw new FixtureError("SCHEMA_UNSUPPORTED", {
      fixtureDir,
      declared: expect.schema_version,
      supported: FIXTURE_SCHEMA_VERSION,
    });
  }
  if (!APPLICABILITIES.includes(expect.applicability)) {
    throw new FixtureError("APPLICABILITY_UNKNOWN", {
      fixtureDir,
      value: expect.applicability,
    });
  }
  if (expect.fixture_id !== path.basename(fixtureDir)) {
    throw new FixtureError("FIXTURE_ID_MISMATCH", {
      fixtureDir,
      declared: expect.fixture_id,
    });
  }
  if (expect.expected_gate !== expect.target_contract_id) {
    throw new FixtureError("TARGET_ID_AMBIGUOUS", {
      fixtureDir,
      expected_gate: expect.expected_gate,
      target_contract_id: expect.target_contract_id,
    });
  }
  const patchBytes = readFileSync(patchPath);
  if (patchBytes.length === 0) {
    throw new FixtureError("PATCH_EMPTY", { fixtureDir });
  }
  const actualSha = sha256(patchBytes);
  if (actualSha !== expect.fixture_sha256) {
    throw new FixtureError("FIXTURE_HASH_MISMATCH", {
      fixtureDir,
      pinned: expect.fixture_sha256,
      actual: actualSha,
    });
  }
  const patchText = patchBytes.toString("utf8");
  const patchPaths = parsePatchPaths(patchText);
  const declared = [...expect.expected_changed_paths].sort();
  if (JSON.stringify(patchPaths) !== JSON.stringify(declared)) {
    throw new FixtureError("CHANGED_PATHS_MISMATCH", {
      fixtureDir,
      patch_paths: patchPaths,
      declared,
    });
  }
  const reasons = Array.isArray(expect.expected_reason)
    ? expect.expected_reason
    : [expect.expected_reason];
  if (reasons.length === 0) {
    throw new FixtureError("REASON_TOO_BROAD", {
      fixtureDir,
      detail: "no reason patterns declared",
    });
  }
  for (const pattern of reasons) {
    assertReasonPattern(pattern, expect.fixture_id);
  }
  if (
    !Array.isArray(expect.command_step_indexes) ||
    expect.command_step_indexes.length === 0 ||
    !expect.command_step_indexes.every(index => Number.isInteger(index))
  ) {
    throw new FixtureError("COMMAND_STEPS_INVALID", { fixtureDir });
  }
  if (expect.control_expectation?.status === undefined) {
    throw new FixtureError("CONTROL_EXPECTATION_UNDEFINED", { fixtureDir });
  }
  return {
    dir: fixtureDir,
    id: expect.fixture_id,
    expect,
    patch_path: patchPath,
    patch_sha256: actualSha,
    patch_text: patchText,
    changed_paths: patchPaths,
    reasons,
  };
}

/**
 * Contract-level validation: the target must exist EXACTLY ONCE in the
 * PARITY registry, be locally executable, and the declared command steps
 * must be real run-steps of that contract entry.
 */
export function validateAgainstRegistry(fixture, registry, contract) {
  const matches = registry.entries.filter(
    entry => entry.gate_id === fixture.expect.expected_gate
  );
  if (matches.length === 0) {
    throw new FixtureError("TARGET_GATE_UNKNOWN", {
      fixture_id: fixture.id,
      expected_gate: fixture.expect.expected_gate,
    });
  }
  if (matches.length > 1) {
    throw new FixtureError("TARGET_ID_AMBIGUOUS", {
      fixture_id: fixture.id,
      expected_gate: fixture.expect.expected_gate,
    });
  }
  const entry = matches[0];
  if (entry.runnability === "CI-ONLY") {
    throw new FixtureError("TARGET_CI_ONLY", {
      fixture_id: fixture.id,
      expected_gate: fixture.expect.expected_gate,
    });
  }
  const check = contract.checks.find(
    item => item.check_id === fixture.expect.expected_gate
  );
  const commands = [];
  let stepEnv = {};
  for (const index of fixture.expect.command_step_indexes) {
    const step = check.steps[index];
    if (!step || typeof step.run !== "string" || step.run.length === 0) {
      throw new FixtureError("COMMAND_STEP_NOT_RUNNABLE", {
        fixture_id: fixture.id,
        step_index: index,
      });
    }
    commands.push(step.run);
    // Step-declared env is CONTRACT-OWNED and travels with the command.
    stepEnv = { ...stepEnv, ...(step.env ?? {}) };
  }
  return { entry, check, command: commands.join("\n"), step_env: stepEnv };
}

/** Discover fixture directories under a root (sorted, deterministic). */
export function discoverFixtures(root) {
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .sort()
    .map(name => path.join(root, name))
    .filter(dir => statSync(dir).isDirectory());
}
