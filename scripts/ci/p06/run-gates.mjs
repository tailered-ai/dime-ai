#!/usr/bin/env node
/**
 * p06/run-gates.mjs — P06 gate execution under the wired boundary model
 * (DEF-031/032/033 corrective implementation).
 *
 * The previous runner joined a gate's steps into one command at the
 * candidate root and let any nonzero exit become FAIL. That produced three
 * classes of false verdict, now structurally impossible:
 *
 *   - provisioning failure surfacing as detector FAIL   (DEF-031)
 *   - wrong working directory                            (DEF-032)
 *   - skipped provisioning invalidating the detector     (DEF-033)
 *
 * Per gate this runner:
 *   1. classifies every contract step via boundary.mjs against MEASURED
 *      capability (capability.mjs) and governed tool identity (tools.mjs);
 *   2. writes a driver spec — per-step kind, execution mode, contract cwd,
 *      contract env, resolved GHA expressions, recorded adaptations;
 *   3. executes scripts/ci/p06/step-driver.mjs through the P04 executor;
 *   4. lifts the driver's journal into a P03 result under the frozen
 *      exit-code protocol, with a hard invariant: PASS/FAIL exists ONLY
 *      when the journal proves the detector validly began under a verified
 *      contract cwd. Any journal/exit anomaly fails closed to INFRA_FAIL.
 *
 * Recorded adaptations (original text always preserved in the spec):
 *   - governed-tool satisfaction of acquisition provisioning
 *     (pipx/curl+sudo installs) — §7 tool law;
 *   - full-osv single mixed step reduced to its detector lines under the
 *     governed osv-scanner v2.2.4 (authorized adaptation);
 *   - marketplace-action steps replaced by measured-equivalent adapters
 *     (trivy, syft, gitleaks) derived from the pinned action sources;
 *   - GHA expressions resolved ONLY from the P01 candidate identity.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runSnapshot, disposeSnapshot } from "../snapshot.mjs";
import { loadVerifiedContract } from "../registry.mjs";
import { makeResult } from "../result.mjs";
import { JsonlReporter, summarize, renderSummary } from "../reporter.mjs";
import { ExecutorRun } from "../executor.mjs";
import { deriveScope } from "./scope.mjs";
import {
  classifySteps,
  provisioningOutcome,
  PROVISIONING_PATTERNS,
} from "./boundary.mjs";
import { measureCapabilities, provisionCandidate } from "./capability.mjs";
import { hostLoadPreflight } from "./preflight.mjs";
import { bootstrapTools } from "./tools.mjs";
import { buildGitleaksAdapterStep } from "./adapters.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, "..", "..", "..");
const DRIVER = path.join(HERE, "step-driver.mjs");
const sha256 = buf => createHash("sha256").update(buf).digest("hex");

export const GATE_TIMEOUT_MS = {
  ".github/workflows/ci.yml#build": 900_000,
  ".github/workflows/01-pr-proof-contract.yml#proof": 2_400_000,
  ".github/workflows/03-semgrep.yml#advisory": 900_000,
  ".github/workflows/03-semgrep.yml#blocking": 900_000,
  ".github/workflows/10-ai-eval-critical.yml#deterministic": 900_000,
  ".github/workflows/ci.yml#typecheck": 600_000,
  ".github/workflows/ci.yml#security-audit": 600_000,
  ".github/workflows/12-nightly-verification.yml#full-osv": 600_000,
  ".github/workflows/09-artifact-build-and-smoke.yml#artifact": 2_400_000,
  ".github/workflows/12-nightly-verification.yml#full-container-scan": 1_800_000,
  ".github/workflows/dime-llm-validation.yml#validate": 900_000,
  ".github/workflows/gitleaks.yml#gitleaks": 300_000,
  default: 300_000,
};

/** Acquisition-class provisioning signatures — never executed locally. */
const ACQUISITION = new Set([
  "privilege-escalation",
  "download",
  "pkg-manager",
  "pipx-install",
  "go-install",
  "cargo-install",
  "archive-extract",
]);

/** Which governed tool satisfies acquisition provisioning per gate. */
const GATE_TOOL_IDS = {
  ".github/workflows/03-semgrep.yml#advisory": ["semgrep"],
  ".github/workflows/03-semgrep.yml#blocking": ["semgrep"],
  ".github/workflows/05-workflow-security.yml#zizmor": ["zizmor"],
  ".github/workflows/ci.yml#security-audit": ["osv-scanner@security-audit"],
  ".github/workflows/12-nightly-verification.yml#full-osv": [
    "osv-scanner@full-osv",
  ],
  ".github/workflows/09-artifact-build-and-smoke.yml#artifact": [
    "trivy",
    "syft",
  ],
  ".github/workflows/12-nightly-verification.yml#full-container-scan": [
    "trivy",
  ],
  ".github/workflows/gitleaks.yml#gitleaks": ["gitleaks"],
};

/** Gates whose detectors need outbound network (registries/OSV API/docker pulls). */
const NETWORK_GATES = new Set([
  ".github/workflows/03-semgrep.yml#advisory",
  ".github/workflows/ci.yml#security-audit",
  ".github/workflows/12-nightly-verification.yml#full-osv",
  ".github/workflows/09-artifact-build-and-smoke.yml#artifact",
  ".github/workflows/12-nightly-verification.yml#full-container-scan",
  ".github/workflows/dime-llm-validation.yml#validate",
]);

/** Resolve GHA expressions strictly from P01 candidate identity. */
/**
 * Gate PATH construction — a NEVER-REGRESS invariant (regression anchors in
 * p06.test.ts ENV01/ENV02): governed downloaded tools first (so e.g. host
 * gitleaks 8.30.1 can never shadow the governed 8.24.3), then the
 * orchestrator's own node (the measured 22.x matching CI's setup-node pin —
 * /usr/local/bin holds a stale node 24 that must never shadow it), then GNU
 * tar (ubuntu-runner parity for `tar --sort=name`, which bsdtar rejects),
 * then repo/user bins, and only after ALL of those the inherited PATH.
 * Shared by the P07 runner — one source of truth for tool identity order.
 */
export const GNU_TAR_DIR = "/opt/homebrew/opt/gnu-tar/libexec/gnubin";
export function buildGatePathEnv(governedDirs = []) {
  return [
    ...governedDirs,
    path.dirname(process.execPath),
    GNU_TAR_DIR,
    path.join(REPO_ROOT, "node_modules", ".bin"),
    `${process.env.HOME}/.local/bin`,
    process.env.PATH,
  ].join(":");
}

export function resolveExpressions(text, ctx) {
  if (typeof text !== "string") return text;
  return text
    .replaceAll("${{ github.sha }}", ctx.merge_commit_sha)
    .replaceAll("${{ github.event.pull_request.head.sha }}", ctx.head_sha)
    .replaceAll("${{ github.event.pull_request.base.ref || 'main' }}", "main")
    .replaceAll("${{ github.actor }}", "ci-verify-local")
    .replaceAll("${{ github.run_id }}", ctx.run_marker);
}

/**
 * A provisioning-classified step whose text ALSO contains substantive
 * non-provisioning lines is MIXED: its failure cannot be attributed without
 * reading output, so it fails closed to INFRA_FAIL, never FAIL.
 */
/** Merge backslash continuations so a wrapped command is ONE logical line. */
export function logicalLines(runText) {
  const merged = [];
  let current = "";
  for (const raw of runText.split("\n")) {
    const joined = current ? `${current} ${raw.trim()}` : raw;
    if (/\\\s*$/.test(raw)) {
      current = joined.replace(/\\\s*$/, "").trimEnd();
    } else {
      merged.push(joined);
      current = "";
    }
  }
  if (current) merged.push(current);
  return merged
    .map(l => l.trim())
    .filter(
      l =>
        l &&
        !l.startsWith("#") &&
        !/^(echo|set |chmod|export|trap |fi$|else$|then$|done$|do$|\}|\{|\[)/.test(
          l
        ) &&
        !/sha256sum|shasum/.test(l)
    );
}

export function analyzeMixed(runText, signatures) {
  if (!signatures?.length) return false;
  const detectorLines = logicalLines(runText).filter(
    l => !PROVISIONING_PATTERNS.some(p => p.re.test(l))
  );
  return detectorLines.length > 0;
}

/** Build the driver step list for one gate. */
export function buildDriverSteps(check, row, ctx, caps, tools) {
  const { steps } = classifySteps(check);
  const gateId = check.check_id;
  const out = [];

  const satisfy = (kind, note) => ({
    kind,
    mode: "satisfied",
    satisfied_by: note,
  });

  for (const step of steps) {
    const record = {
      index: step.index,
      kind: step.kind,
      provisioning_signatures: step.provisioning_signatures,
      cwd: step.effective_cwd ?? ".",
      env: {},
      run: step.run,
      adapted_run: null,
      adaptation_reason: null,
      mode: "execute",
    };
    // contract env: job-level env under step env, expressions resolved
    for (const [k, v] of Object.entries({
      ...(check.env ?? {}),
      ...(step.env ?? {}),
    })) {
      record.env[k] = resolveExpressions(String(v), ctx);
    }
    record.run = step.run; // contract text stays verbatim in the record
    const resolvedRun = resolveExpressions(step.run, ctx);

    if (step.kind === "PROVISIONING") {
      const sigs = step.provisioning_signatures;
      const mixed = analyzeMixed(step.run, sigs);
      if (mixed) record.kind = "MIXED";

      // --- authorized adaptation: full-osv mixed step ---------------------
      if (
        gateId === ".github/workflows/12-nightly-verification.yml#full-osv" &&
        sigs.includes("download")
      ) {
        const detectorLines = step.run
          .split("\n")
          .filter(
            l =>
              /^(osv-scanner scan|node scripts\/check-osv-scan)/.test(
                l.trim()
              ) || /^\s+--/.test(l)
          );
        // keep the scan invocation with its continuation lines
        const kept = [];
        let keep = false;
        for (const line of step.run.split("\n")) {
          const t = line.trim();
          if (
            /^osv-scanner scan/.test(t) ||
            /^node scripts\/check-osv-scan/.test(t)
          )
            keep = true;
          else if (
            keep &&
            !/^(-|\s)/.test(line) &&
            !/^\s/.test(line) &&
            t !== ""
          )
            keep = /\\$/.test(line);
          if (keep) kept.push(line);
          if (keep && !/\\$/.test(line)) keep = false;
        }
        record.kind = "DETECTOR";
        record.adapted_run = kept.join("\n");
        record.adaptation_reason =
          "acquisition lines (curl+sha256sum+chmod of the linux/amd64 release) replaced by " +
          "the governed osv-scanner v2.2.4 darwin/arm64 install; detector lines preserved verbatim. " +
          "Authorized adaptation — tool identity: " +
          (tools.resolved["osv-scanner@full-osv"]?.path ?? "UNRESOLVED");
        out.push({ ...record });
        continue;
      }

      // --- acquisition provisioning → governed tool satisfaction ----------
      // A step that acquires a tool and then asserts `<tool> --version` is
      // still pure acquisition: the version assert is exactly what governed
      // bootstrap already proved. Only NON-version detector lines make a
      // step genuinely mixed.
      const nonProvisioningLines = logicalLines(step.run).filter(
        l => !PROVISIONING_PATTERNS.some(p => p.re.test(l))
      );
      const onlyVersionAsserts =
        nonProvisioningLines.length > 0 &&
        nonProvisioningLines.every(l =>
          /--version\s*$|^\S+\s+version$/.test(l)
        );
      const effectivelyMixed = mixed && !onlyVersionAsserts;
      record.kind = effectivelyMixed
        ? "MIXED"
        : record.kind === "MIXED"
          ? "PROVISIONING"
          : record.kind;
      if (sigs.some(s => ACQUISITION.has(s)) && !effectivelyMixed) {
        const toolIds = GATE_TOOL_IDS[gateId] ?? [];
        const resolvedTools = toolIds
          .map(id => tools.resolved[id])
          .filter(Boolean);
        if (toolIds.length && resolvedTools.length === toolIds.length) {
          out.push({
            ...record,
            ...satisfy(
              "PROVISIONING",
              `governed tool(s) ${toolIds.join(", ")} identity-verified: ` +
                resolvedTools
                  .map(t => `${t.binary}@${t.version} (${t.mode})`)
                  .join("; ")
            ),
          });
        } else {
          // tool missing → step must remain and will fail → BLOCKED via protocol
          out.push({ ...record, run: resolvedRun });
        }
        continue;
      }

      // --- environment provisioning → measured capability -----------------
      const capMap = {
        "node-deps": caps.provisioning["node-deps"]
          ? "executed physically in the disposable candidate at snapshot time (pnpm install --frozen-lockfile --offline --ignore-scripts against the proven-consistent host store); python postinstall leg measured unconsumed by any detector"
          : null,
        "playwright-install": caps.provisioning["playwright-install"]
          ? "playwright browser build present in immutable cache (measured via playwright install --dry-run install location)"
          : null,
      };
      const satisfiable = sigs.every(s => capMap[s]);
      if (satisfiable && !mixed) {
        out.push({
          ...record,
          ...satisfy("PROVISIONING", sigs.map(s => capMap[s]).join(" | ")),
        });
        continue;
      }
      // execute provisioning inside the disposable candidate (e.g. uv sync)
      out.push({ ...record, run: resolvedRun, adapted_run: null });
      continue;
    }

    // DETECTOR
    out.push({ ...record, run: resolvedRun });
  }
  return out;
}

/** Gate-specific adapter step injection (trivy / syft / gitleaks). */
export function injectAdapters(gateId, driverSteps, check, ctx, tools) {
  const notes = [];
  if (gateId === ".github/workflows/09-artifact-build-and-smoke.yml#artifact") {
    const trivy = tools.resolved["trivy"];
    const syft = tools.resolved["syft"];
    const image = `dime-pr:${ctx.merge_commit_sha}`;
    const cacheDir = path.join(REPO_ROOT, ".ci-verify", "tools", "trivy-cache");
    const adapters = [];
    if (trivy) {
      adapters.push({
        index: 2.1,
        kind: "DETECTOR",
        mode: "execute",
        cwd: ".",
        env: {},
        provisioning_signatures: [],
        run: "(uses: aquasecurity/trivy-action — report tier)",
        adapted_run:
          `trivy image --format sarif --output trivy.sarif --severity CRITICAL,HIGH ` +
          `--exit-code 0 --ignore-unfixed --scanners vuln,secret,misconfig ` +
          `--cache-dir ${cacheDir} ${image}`,
        adaptation_reason:
          "trivy-action@ed142fd maps its inputs onto trivy CLI options 1:1; " +
          "inputs taken verbatim from the workflow `with:` block; governed trivy v0.70.0 " +
          "(the action's own pinned default)",
      });
      adapters.push({
        index: 3.1,
        kind: "DETECTOR",
        mode: "execute",
        cwd: ".",
        env: {},
        provisioning_signatures: [],
        run: "(uses: aquasecurity/trivy-action — blocking tier)",
        adapted_run:
          `trivy image --format table --severity CRITICAL --exit-code 1 ` +
          `--ignore-unfixed --scanners vuln,secret,misconfig ` +
          `--cache-dir ${cacheDir} ${image}`,
        adaptation_reason:
          "blocking tier: severity CRITICAL, exit-code 1, ignore-unfixed, " +
          "scanners vuln,secret,misconfig — verbatim from the workflow `with:` block",
      });
    }
    if (syft) {
      adapters.push({
        index: 5.1,
        kind: "DETECTOR",
        mode: "execute",
        cwd: ".",
        env: {},
        provisioning_signatures: [],
        run: "(uses: anchore/sbom-action)",
        adapted_run: `syft ${image} -o spdx-json=sbom.spdx.json`,
        adaptation_reason:
          "sbom-action@e22c389 runs syft against the image input with the format/output " +
          "inputs; upload-artifact:false in the workflow, so generation is the whole verdict; " +
          "governed syft v1.42.3 (the action dist's own pin)",
      });
    }
    notes.push(
      "steps 4 and 6 (codeql upload-sarif, upload-artifact) are CI plumbing that carries no " +
        "candidate verdict; recorded in the nonlocal audit"
    );
    const merged = [...driverSteps, ...adapters].sort(
      (a, b) => a.index - b.index
    );
    return { steps: merged, notes };
  }
  if (
    gateId ===
    ".github/workflows/12-nightly-verification.yml#full-container-scan"
  ) {
    const trivy = tools.resolved["trivy"];
    const cacheDir = path.join(REPO_ROOT, ".ci-verify", "tools", "trivy-cache");
    if (trivy) {
      const adapters = [
        {
          index: 2.1,
          kind: "DETECTOR",
          mode: "execute",
          cwd: ".",
          env: {},
          provisioning_signatures: [],
          run: "(uses: aquasecurity/trivy-action — nightly full scan)",
          adapted_run:
            `trivy image --format table --severity CRITICAL,HIGH,MEDIUM --exit-code 1 ` +
            `--scanners vuln,secret,misconfig,license --cache-dir ${cacheDir} dime-nightly:latest`,
          adaptation_reason:
            "inputs verbatim from the workflow `with:` block (ignore-unfixed:false is trivy's default)",
        },
      ];
      return {
        steps: [...driverSteps, ...adapters].sort((a, b) => a.index - b.index),
        notes: [],
      };
    }
    return {
      steps: driverSteps,
      notes: ["trivy unresolved — adapter not injected"],
    };
  }
  if (gateId === ".github/workflows/gitleaks.yml#gitleaks") {
    const step = buildGitleaksAdapterStep(ctx, tools);
    return { steps: [step], notes: step.equivalence_notes };
  }
  return { steps: driverSteps, notes: [] };
}

/**
 * Execute ONE P06 gate through the full wired path: boundary classification,
 * adapter injection, driver spec, governed PATH, P04 executor, journal, and
 * verdict lifting. The roster and the ASSURANCE framework both call this, so
 * a proof can never exercise a different path than production execution.
 */
export async function runOneGate({
  gateId,
  check,
  row,
  ctx,
  caps,
  tools,
  worktree,
  candidate,
  gha,
  outDir,
  runTag = null,
}) {
  const base = buildDriverSteps(check, row, ctx, caps, tools);
  const { steps: driverSteps, notes } = injectAdapters(
    gateId,
    base,
    check,
    ctx,
    tools
  );

  const dirName =
    gateId.replace(/[^A-Za-z0-9._-]/g, "_") + (runTag ? `__${runTag}` : "");
  const runsRoot = path.join(outDir, "exec");
  const specDir = path.join(outDir, "specs");
  mkdirSync(specDir, { recursive: true });
  const specPath = path.join(specDir, `${dirName}.json`);
  const driverSpec = {
    gate_id: gateId,
    worktree,
    candidate: ctx,
    gha,
    steps: driverSteps,
    adapter_notes: notes,
    // 09-artifact's log assertion reads container stdout that node flushes
    // lazily to the docker log driver; GHA's own 1-3s inter-step overhead is
    // what makes it pass in CI (measured: line present at +2.5s, absent at
    // +0.2s). Recorded adaptation.
    ...(gateId === ".github/workflows/09-artifact-build-and-smoke.yml#artifact"
      ? { inter_step_latency_ms: 2000 }
      : {}),
  };
  writeFileSync(specPath, JSON.stringify(driverSpec, null, 2) + "\n");

  const pathEnv = buildGatePathEnv(
    (GATE_TOOL_IDS[gateId] ?? [])
      .map(id => tools.resolved[id]?.path_dir)
      .filter(Boolean)
  );

  const run = new ExecutorRun({
    specs: [
      {
        gate_id: gateId,
        class: "PARITY",
        mandatory: row?.required ?? false,
        command: { shell: `node ${DRIVER} ${specPath}` },
        cwd: worktree,
        timeout_ms: GATE_TIMEOUT_MS[gateId] ?? GATE_TIMEOUT_MS.default,
        grace_ms: 5_000,
        network: NETWORK_GATES.has(gateId) ? "allow" : "inherit",
        env: {
          PATH: pathEnv,
          CI_VERIFY_STEP_DIR: path.join(runsRoot, "steps", dirName),
        },
        contract_check_id: gateId,
        runnability: row?.runnability ?? "LOCAL",
      },
    ],
    candidate,
    budget: { max_concurrency: 1 },
    runsRoot,
    lanesRoot: path.join(outDir, "lanes"),
  });
  const started = Date.now();
  const outcome = await run.execute();
  const raw = outcome.results[0];
  const stepDir = path.join(runsRoot, "steps", dirName);
  const journalPath = path.join(stepDir, "steps.json");
  const journal = existsSync(journalPath)
    ? JSON.parse(readFileSync(journalPath, "utf8"))
    : null;
  const driverExit = raw.attempts?.at(-1)?.exit_code ?? null;
  return {
    gateId,
    driverSteps,
    notes,
    raw,
    journal,
    journalPath,
    stepDir,
    driverExit,
    lift: liftVerdict(raw, driverExit, journal),
    run,
    specPath,
    duration_s: Number(((Date.now() - started) / 1000).toFixed(1)),
  };
}

export async function runP06Gates(options = {}) {
  const { contract, contract_sha256 } = loadVerifiedContract();
  const scope = deriveScope();
  const outDir = options.outDir ?? path.join(REPO_ROOT, ".ci-verify", "p06");
  mkdirSync(outDir, { recursive: true });

  // Governed tools + measured capability BEFORE any candidate exists.
  // DEF-049 anchor: refuse to start a roster on a host carrying orphaned
  // synthetic load generators — an INFRA refusal, never a verdict. Plain
  // high load is recorded only (concurrent legitimate work is normal; the
  // DEF-062 worker profile absorbs it).
  const preflight = hostLoadPreflight();
  console.log(
    `[p06] preflight: load ${preflight.loadavg["1m"].toFixed(1)}/${preflight.cores} cores, orphans ${preflight.orphans.length}`
  );
  if (preflight.refuse) {
    throw new Error(
      `HOST_PREFLIGHT_REFUSED: orphaned load generators detected — ` +
        preflight.orphans
          .map(o => `pid=${o.pid} ${o.comm} ${o.pcpu}% ${o.etime}`)
          .join(", ") +
        ` (DEF-049 class; kill them or investigate before any campaign)`
    );
  }

  const tools = bootstrapTools();
  const handle = runSnapshot({ mode: "committed", keepRunDir: true });
  const worktree = handle.paths.worktree;
  const candidate = handle.snapshot.identity;
  const caps = measureCapabilities(worktree);

  // Physical provisioning ONCE per candidate; its failure blocks every
  // node-deps gate (provisioning outcome), never a detector verdict.
  const provisioned = provisionCandidate(worktree);
  console.log(
    `[p06] candidate provisioning: ok=${provisioned.ok} in ${provisioned.duration_ms}ms`
  );
  // The in-candidate install is the AUTHORITY on node-deps satisfaction.
  caps.provisioning["node-deps"] = provisioned.ok;
  caps.candidate_install = provisioned;

  const ctx = {
    head_sha: candidate.head_sha,
    base_sha: candidate.base_sha,
    merge_commit_sha: candidate.merge_commit_sha,
    run_marker: `ci-verify-${Date.now()}`,
  };

  // P01 base discipline for diff-aware gates. P01 is the SOLE resolver of
  // branch provenance: it resolved origin/main when it built this candidate,
  // so candidate.base_sha IS the current base. An earlier version re-resolved
  // origin/main here, duplicating that authority — the DEF-025 defect class.
  // Staleness is now detected by comparing a caller-supplied recorded base
  // against the freshly constructed candidate's base, with no ref resolution.
  if (
    options.recordedBaseSha &&
    options.recordedBaseSha !== candidate.base_sha
  ) {
    disposeSnapshot(handle);
    throw new Error(
      `STALE_CANDIDATE: evidence base ${options.recordedBaseSha.slice(0, 12)} != current candidate base ${candidate.base_sha.slice(0, 12)}`
    );
  }

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

  // Docker ownership bookkeeping: images this run may create are removed at
  // the end ONLY if they did not pre-exist (developer resources untouched).
  const dockerImages = [
    `dime-pr:${ctx.merge_commit_sha}`,
    "dime-nightly:latest",
  ];
  const preExistingImages = new Set();
  let preExistingSmoke = false;
  try {
    for (const image of dockerImages) {
      const id = execFileSync("docker", ["images", "-q", image], {
        encoding: "utf8",
        timeout: 20_000,
      }).trim();
      if (id) preExistingImages.add(image);
    }
    preExistingSmoke = Boolean(
      execFileSync("docker", ["ps", "-aq", "--filter", "name=^dime-smoke$"], {
        encoding: "utf8",
        timeout: 20_000,
      }).trim()
    );
  } catch {
    /* daemon unavailable — docker gates will classify truthfully */
  }

  const results = [];
  const records = [];
  const only = options.only ?? null;
  try {
    for (const row of scope.rows.filter(r => r.owner === "P06")) {
      const gateId = row.gate_id;
      if (only && !only.includes(gateId)) continue;
      const check = contract.checks.find(c => c.check_id === gateId);

      // Non-executable classification comes from the CURRENT classification
      // artifact (T01); here only CI-only rows short-circuit — everything
      // else gets a driver spec and the driver/journal decides truthfully.
      if (row.executability === "CI_ONLY") {
        results.push(
          makeResult({
            gate_id: gateId,
            class: "PARITY",
            status: "CI_ONLY",
            mandatory: row.required,
            reason: row.reason ?? "declared CI-ONLY",
            evidence_path: path.join(outDir, "p06-results.jsonl"),
            contract_check_id: gateId,
            runnability: row.runnability,
          })
        );
        console.log(`[p06] CI_ONLY   ${gateId}`);
        continue;
      }

      const missingTools = (GATE_TOOL_IDS[gateId] ?? []).filter(
        id => !tools.resolved[id]
      );
      if (missingTools.length) {
        results.push(
          makeResult({
            gate_id: gateId,
            class: "PARITY",
            status: "BLOCKED",
            mandatory: row.required,
            reason: `GOVERNED_TOOL_UNRESOLVED: ${missingTools.join(", ")}`,
            evidence_path: path.join(outDir, "p06-results.jsonl"),
            contract_check_id: gateId,
            runnability: row.runnability,
          })
        );
        console.log(
          `[p06] BLOCKED   ${gateId} (tool: ${missingTools.join(",")})`
        );
        continue;
      }

      const executed = await runOneGate({
        gateId,
        check,
        row,
        ctx,
        caps,
        tools,
        worktree,
        candidate,
        gha,
        outDir,
      });
      const {
        driverSteps,
        notes,
        journal,
        journalPath,
        driverExit,
        lift,
        run,
        specPath,
      } = executed;
      const secs = executed.duration_s.toFixed(1);
      const result = makeResult({
        gate_id: gateId,
        class: "PARITY",
        status: lift.status,
        mandatory: row.required,
        reason: lift.reason,
        evidence_path: journalPath,
        contract_check_id: gateId,
        runnability: row.runnability,
      });
      results.push(result);
      records.push({
        gate_id: gateId,
        required: row.required,
        graduating: row.graduating,
        status: lift.status,
        reason: lift.reason,
        lift_kind: lift.kind,
        driver_exit: driverExit,
        raw_executor_status: executed.raw.status,
        duration_s: Number(secs),
        spec_sha256: sha256(readFileSync(specPath)),
        journal_sha256: journal ? sha256(readFileSync(journalPath)) : null,
        journal_summary: journal?.summary ?? null,
        steps:
          journal?.steps?.map(s => ({
            index: s.index,
            kind: s.kind,
            mode: s.mode,
            cwd: s.contract_cwd,
            cwd_verified: s.cwd_verified ?? null,
            executed: s.executed,
            exit_code: s.exit_code ?? null,
            duration_ms: s.duration_ms ?? null,
            satisfied_by: s.satisfied_by ?? null,
            adaptation: s.adaptation ?? null,
          })) ?? null,
        adapter_notes: notes,
        run_dir: run.runDir,
      });
      console.log(
        `[p06] ${lift.status.padEnd(10)} ${gateId}  (${secs}s, driver exit ${driverExit}, ${lift.kind})`
      );
    }
  } finally {
    disposeSnapshot(handle);
    // Remove verifier-created docker artifacts; never touch pre-existing ones.
    for (const image of dockerImages) {
      if (preExistingImages.has(image)) continue;
      try {
        const id = execFileSync("docker", ["images", "-q", image], {
          encoding: "utf8",
          timeout: 20_000,
        }).trim();
        if (id) {
          execFileSync("docker", ["rmi", "-f", image], { timeout: 60_000 });
          console.log(`[p06] cleaned verifier-created image ${image}`);
        }
      } catch {
        /* image absent or daemon gone — nothing owned remains */
      }
    }
    if (!preExistingSmoke) {
      try {
        const smoke = execFileSync(
          "docker",
          ["ps", "-aq", "--filter", "name=^dime-smoke$"],
          { encoding: "utf8", timeout: 20_000 }
        ).trim();
        if (smoke)
          execFileSync("docker", ["rm", "-f", "dime-smoke"], {
            timeout: 30_000,
          });
      } catch {
        /* nothing to clean */
      }
    }
  }

  const resultsPath = path.join(outDir, "p06-results.jsonl");
  writeFileSync(resultsPath, "");
  const reporter = new JsonlReporter(resultsPath);
  for (const r of results) reporter.write(r);
  const summary = summarize(results);
  writeFileSync(
    path.join(outDir, "p06-records.json"),
    JSON.stringify(
      {
        candidate,
        contract_sha256,
        capability: caps.provisioning,
        tools: Object.fromEntries(
          Object.entries(tools.resolved).map(([k, v]) => [
            k,
            { mode: v.mode, version: v.version, path: v.path },
          ])
        ),
        scope: scope.p06,
        records,
      },
      null,
      2
    ) + "\n"
  );
  return {
    candidate,
    contract_sha256,
    results,
    summary,
    records,
    outDir,
    tools,
    caps,
  };
}

/**
 * Map (executor result, driver exit, journal) → P03 status. The HARD
 * INVARIANT lives here: no PASS/FAIL without journal-proven detector start
 * under verified cwd. Everything unprovable fails closed.
 */
export function liftVerdict(raw, driverExit, journal) {
  // Executor-level abnormalities keep their own truthful status.
  if (
    [
      "TIMEOUT",
      "BLOCKED",
      "INFRA_FAIL",
      "CONTRACT_DRIFT",
      "BROKEN_GATE",
    ].includes(raw.status) &&
    driverExit == null
  ) {
    return { status: raw.status, reason: raw.reason, kind: "executor" };
  }
  if (raw.status === "TIMEOUT") {
    return { status: "TIMEOUT", reason: raw.reason, kind: "executor" };
  }
  const summaryReason = journal?.summary?.reason;
  const failedStep = journal?.summary?.failed_step;
  const cwdAllVerified = (journal?.steps ?? [])
    .filter(s => s.executed)
    .every(s => s.cwd_verified === true);

  switch (driverExit) {
    case 0: {
      if (raw.status !== "PASS") {
        // The executor's upgrade-only chain (cleanup failure, leaked
        // process, network downgrade) outranks a clean driver exit.
        return {
          status: raw.status,
          reason: raw.reason,
          kind: "executor-override",
        };
      }
      if (!journal?.summary?.detector_started || !cwdAllVerified) {
        return {
          status: "INFRA_FAIL",
          reason:
            "HARD_INVARIANT: driver exited 0 without journal-proven detector execution under verified cwd",
          kind: "invariant",
        };
      }
      return { status: "PASS", reason: null, kind: "detector" };
    }
    case 20: {
      if (!journal?.summary?.detector_started || !cwdAllVerified) {
        return {
          status: "INFRA_FAIL",
          reason:
            "HARD_INVARIANT: FAIL exit without journal-proven detector execution under verified cwd",
          kind: "invariant",
        };
      }
      return {
        status: "FAIL",
        reason: summaryReason ?? `detector failed at step ${failedStep}`,
        kind: "detector",
      };
    }
    case 10: {
      const failed = journal?.steps?.find(s => s.index === failedStep);
      const outcome = provisioningOutcome(
        failed?.provisioning_signatures ?? [],
        summaryReason ?? "provisioning step failed"
      );
      return {
        status: outcome.status,
        reason: outcome.reason,
        kind: "provisioning",
      };
    }
    case 11:
      return {
        status: "INFRA_FAIL",
        reason: summaryReason ?? "mixed provisioning/detector step failed",
        kind: "mixed",
      };
    case 12:
      return {
        status: "INFRA_FAIL",
        reason: summaryReason ?? "no detector executed",
        kind: "invariant",
      };
    case 30:
    case 31:
    case 32:
      return {
        status: "BLOCKED",
        reason: summaryReason ?? `driver refusal (exit ${driverExit})`,
        kind: "refusal",
      };
    default:
      return {
        status: "INFRA_FAIL",
        reason: `DRIVER_ANOMALY: exit ${driverExit} outside the frozen protocol (raw ${raw.status}: ${raw.reason ?? "n/a"})`,
        kind: "anomaly",
      };
  }
}

async function main() {
  const only = process.argv[2] ? process.argv.slice(2) : null;
  const outcome = await runP06Gates(only ? { only } : {});
  console.log("");
  console.log(renderSummary(outcome.summary));
  console.log("");
  const blocking = outcome.results.filter(
    r =>
      r.mandatory &&
      !["PASS", "CI_ONLY", "N/A", "SKIPPED_DECLARED"].includes(r.status)
  );
  console.log(
    `[p06] mandatory gates: ${outcome.results.filter(r => r.mandatory).length}; ` +
      `blocking: ${blocking.length}` +
      (blocking.length
        ? ` -> ${blocking.map(b => `${b.gate_id}=${b.status}`).join(", ")}`
        : "")
  );
  if (blocking.length) process.exitCode = 1;
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
) {
  main().catch(error => {
    console.error(`[p06] ${error.reason ?? error.message}`);
    console.error(error.stack);
    process.exitCode = 1;
  });
}
