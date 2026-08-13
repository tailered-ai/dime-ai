#!/usr/bin/env node
/**
 * p05-audit.mjs — P05.AUD01 (fixture-placement / tracked-tree poison audit)
 * and P05.AUD02 (architectural isolation from P01–P04).
 *
 * AUD01 answers one question with evidence rather than grep output: does any
 * poison exist in the tracked tree as a LIVE file, anywhere a real gate would
 * read it? Every signature hit is CLASSIFIED — inert fixture, test canary,
 * legitimate pre-existing source, or violation — because raw matches are not
 * a verdict (the DEF-009 lesson).
 *
 * AUD02 proves P05 orchestrates rather than reimplements: no second snapshot
 * resolver, YAML parser, contract loader, registry, executor, process runner,
 * cleanup engine, ledger writer, or acceptance predicate.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  POISON_SIGNATURES,
  SENSITIVE_ROOTS,
  APPROVED_FIXTURE_ROOTS,
  INERT_FIXTURE_FILES,
  scanTreeForLivePoison,
} from "./placement.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, "..", "..", "..");

/** P05's own runtime modules — the surface AUD02 governs. */
export const P05_RUNTIME_MODULES = [
  "scripts/ci/selftest/fixture.mjs",
  "scripts/ci/selftest/placement.mjs",
  "scripts/ci/selftest/assurance.mjs",
  "scripts/ci/selftest/coverage.mjs",
  "scripts/ci/selftest/p05-audit.mjs",
];

/**
 * Files that legitimately contain poison-shaped strings for a declared,
 * auditable reason. Each entry states WHY, so the classification is a
 * judgement on record rather than an allowlist that silently grows.
 */
export const CLASSIFIED_CANARIES = [
  {
    file: "scripts/ci/selftest/placement.mjs",
    classification: "TEST_CANARY",
    reason:
      "the detector's own signature table — it must contain the patterns it detects",
  },
  {
    file: ".github/workflows/01-pr-proof-contract.yml",
    classification: "SAFE_ENV_MEDIATED_REFERENCE",
    reason:
      "pre-existing github.event.pull_request references reach the shell ONLY " +
      "through env: (the template-injection-safe form zizmor enforces); the " +
      "DEF-074 modification added checkout depth + tool provisioning, not the " +
      "signature — which predates this initiative",
  },
  {
    file: ".github/workflows/07-coverage-patch.yml",
    classification: "SAFE_ENV_MEDIATED_REFERENCE",
    reason:
      "pre-existing github.event.pull_request references reach the shell ONLY " +
      "through env:; the DEF-074 modification added tool provisioning, not " +
      "the signature — which predates this initiative",
  },
  {
    file: "scripts/ci/selftest/p05-audit.mjs",
    classification: "TEST_CANARY",
    reason: "imports and reports the signature table; contains no live poison",
  },
  {
    file: "scripts/ci/selftest/p05.test.ts",
    classification: "TEST_CANARY",
    reason:
      "drives the negatives; every poison string it holds is a controlled " +
      "in-memory double or lives under a temp root, never a live repo file",
  },
];

/** Every P05 poison carries this marker. It is the containment tripwire. */
export const P05_POISON_MARKER = /p05[-_]poison/i;

/** Extensions a real gate would execute, scan, or type-check. */
const SCANNABLE = /\.(ya?ml|ts|tsx|mts|mjs|cjs|js|sql|sh|py)$/;

function trackedFiles() {
  return execFileSync("git", ["-C", REPO_ROOT, "ls-files", "-z"], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  })
    .split("\0")
    .filter(Boolean);
}

/**
 * Paths this initiative touches, as WORKING-TREE state.
 *
 * This deliberately resolves NO refs. An earlier version asked git for
 * `origin/main...HEAD`, which duplicated the base resolution P01 owns and was
 * a genuine architectural violation (DEF-025) that the provenance audit
 * caught. The containment guarantee does not depend on it: the marker rule
 * scans every tracked file regardless of scope, and the initiative rule
 * matters precisely while changes are still uncommitted.
 */
export function initiativeFiles() {
  const files = new Set();
  // `--untracked-files=all` matters: without it git collapses a wholly-new
  // directory to one entry, and the individual fixture files this audit must
  // prove inert would never be scanned.
  const status = execFileSync(
    "git",
    [
      "-C",
      REPO_ROOT,
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
    ],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }
  );
  for (const entry of status.split("\0")) {
    if (entry.length > 3) files.add(entry.slice(3));
  }
  return files;
}

/**
 * P05.AUD01 — poison containment.
 *
 * The question is NOT "does the repository contain the string `secrets.X`" —
 * every real workflow does, and every historical migration may legitimately
 * DROP a table. The question is: **did P05 put live poison anywhere a gate
 * would read it?** (DEF-024.) Two independent rules answer it:
 *
 *   1. MARKER RULE — every P05 poison carries `p05-poison`. If that marker
 *      appears in a LIVE executable/scannable file anywhere in the tree, the
 *      containment law is broken, whatever the path.
 *   2. INITIATIVE RULE — a file this initiative added or modified under a
 *      gate-scanned root (.github/workflows, .github/actions, CODEOWNERS,
 *      drizzle) carrying any poison signature is a violation.
 *
 * Pre-existing repository content that merely matches a signature is
 * CLASSIFIED and counted, never treated as a P05 violation.
 */
export function auditPoisonContainment(options = {}) {
  const initiative = options.initiative ?? initiativeFiles();
  // Tracked files ALONE would not see this initiative's not-yet-committed
  // fixture patches — the very files whose inertness must be proven.
  const files =
    options.files ?? [...new Set([...trackedFiles(), ...initiative])].sort();
  const violations = [];
  const classified = [];
  for (const rel of files) {
    const abs = path.join(REPO_ROOT, rel);
    if (!existsSync(abs)) continue;
    const stat = statSync(abs);
    if (!stat.isFile() || stat.size > 4 * 1024 * 1024) continue;
    let text;
    try {
      text = readFileSync(abs, "utf8");
    } catch {
      continue; // binary/unreadable — no textual poison to carry
    }
    const hits = POISON_SIGNATURES.filter(sig => sig.re.test(text));
    if (hits.length === 0) continue;
    const signatures = hits.map(h => h.id);
    const underSensitive = SENSITIVE_ROOTS.some(
      root => rel === root || rel.startsWith(root + path.sep)
    );
    const underApproved = APPROVED_FIXTURE_ROOTS.some(root =>
      rel.startsWith(root + path.sep)
    );
    const inert = underApproved && INERT_FIXTURE_FILES.has(path.basename(rel));
    const declared = CLASSIFIED_CANARIES.find(entry => entry.file === rel);
    const isDocumentation = rel.startsWith("docs/") || rel.endsWith(".md");
    const carriesMarker = P05_POISON_MARKER.test(text);

    if (inert) {
      classified.push({
        file: rel,
        signatures,
        classification: "INERT_FIXTURE",
      });
    } else if (declared) {
      classified.push({
        file: rel,
        signatures,
        classification: declared.classification,
        reason: declared.reason,
      });
    } else if (isDocumentation) {
      classified.push({
        file: rel,
        signatures,
        classification: "DOCUMENTED_FINDING",
        reason: "evidence/documentation — never executed or scanned by a gate",
      });
    } else if (carriesMarker && SCANNABLE.test(rel)) {
      violations.push({
        file: rel,
        signatures,
        classification: "LIVE_POISON_VIOLATION",
        detail:
          "P05 poison marker present in a live executable/scannable file — " +
          "poison escaped inert storage",
      });
    } else if (underApproved) {
      violations.push({
        file: rel,
        signatures,
        classification: "LIVE_POISON_VIOLATION",
        detail:
          "file inside an approved fixture root is not one of the inert " +
          `storage shapes (${[...INERT_FIXTURE_FILES].join(", ")})`,
      });
    } else if (underSensitive && initiative.has(rel)) {
      violations.push({
        file: rel,
        signatures,
        classification: "LIVE_POISON_VIOLATION",
        detail:
          "this initiative added or modified a gate-scanned file carrying a " +
          "poison signature",
      });
    } else {
      // Pre-existing repository content that happens to match. Reported for
      // human judgement, never auto-cleared, never a P05 violation — P05 did
      // not put it there and does not own it.
      classified.push({
        file: rel,
        signatures,
        classification: "LEGITIMATE_EXISTING_SOURCE",
      });
    }
  }
  return {
    ok: violations.length === 0,
    violations,
    classified,
    files_scanned: files.length,
    initiative_files: initiative.size,
  };
}

// ---------------------------------------------------------------------------
// P05.AUD02 — architectural isolation.
// ---------------------------------------------------------------------------

/**
 * Each rule names a control-plane mechanism, the module that OWNS it, and the
 * import P05 must use instead of reimplementing it.
 */
export const ISOLATION_RULES = [
  {
    id: "snapshot/sha-resolution",
    owner: "scripts/ci/snapshot.mjs",
    forbidden: [
      /execFileSync\(\s*["']git["']\s*,\s*\[[^\]]*["']rev-parse["']/,
      /["']worktree["']\s*,\s*["']add["']/,
      /commit-tree/,
    ],
  },
  {
    id: "yaml-parsing",
    owner: "scripts/ci/contract-extract.mjs",
    forbidden: [
      /from\s+["']yaml["']/,
      /require\(["']yaml["']\)/,
      /parseDocument/,
    ],
  },
  {
    id: "contract-loading",
    owner: "scripts/ci/registry.mjs",
    forbidden: [/contract\.frozen\.json/, /contract\.sha256/],
  },
  {
    id: "registry-construction",
    owner: "scripts/ci/registry.mjs",
    forbidden: [/isParityEligible|REQUIRED_CONTEXTS\s*=/],
  },
  {
    id: "result-taxonomy",
    owner: "scripts/ci/result.mjs",
    forbidden: [/GATE_STATUSES\s*=\s*\[/, /TERMINAL_CONTRIBUTION\s*=/],
  },
  {
    id: "execution",
    owner: "scripts/ci/proc.mjs + scripts/ci/executor.mjs",
    forbidden: [/\bspawn\s*\(/, /GHA_DEFAULT_SHELL\s*=/],
  },
  {
    id: "cleanup",
    owner: "scripts/ci/teardown.mjs",
    forbidden: [/\brmSync\s*\(/, /process\.kill\s*\(/],
  },
  {
    id: "ledger",
    owner: "scripts/ci/ledger.mjs",
    forbidden: [/ci-verify-ledger\.json/, /acceptPhase|acceptance_met/],
  },
];

/** Imports that PROVE P05 consumes the owning modules. */
export const REQUIRED_INTEGRATIONS = [
  { what: "P01 snapshot", re: /from\s+"\.\.\/snapshot\.mjs"/ },
  { what: "P02/P03 contract+registry", re: /from\s+"\.\.\/registry\.mjs"/ },
  { what: "P03 result taxonomy", re: /from\s+"\.\.\/result\.mjs"/ },
  { what: "P04 executor", re: /from\s+"\.\.\/executor\.mjs"/ },
  { what: "P04 teardown", re: /from\s+"\.\.\/teardown\.mjs"/ },
];

function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map(line => line.replace(/(^|[^:])\/\/.*$/, "$1"))
    .join("\n");
}

/** Remove string-literal CONTENT so prose can never look like a call. */
function stripStrings(source) {
  return source
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
    .replace(/`(?:[^`\\]|\\[\s\S])*`/g, match => match.replace(/[^`\n]/g, ""));
}

function isRuleDefinitionRow(line) {
  return (
    /^\s*(forbidden:|\{?\s*re:|\s*\/)/.test(line) ||
    /^\s*\/.*\/,?\s*$/.test(line)
  );
}

export function auditArchitecturalIsolation(options = {}) {
  const modules = options.modules ?? P05_RUNTIME_MODULES;
  const findings = [];
  const integrations = [];
  for (const rel of modules) {
    const raw = readFileSync(path.join(REPO_ROOT, rel), "utf8");
    const code = stripStrings(stripComments(raw));
    const lines = code.split("\n");
    for (const rule of ISOLATION_RULES) {
      for (let i = 0; i < lines.length; i += 1) {
        if (!rule.forbidden.some(re => re.test(lines[i]))) continue;
        // A DECLARATION row (this file's own rule table) is not a use. The
        // exemption is per-ROW, never per-file: exempting the whole audit
        // file is how a real violation hides inside the detector — which is
        // exactly what happened in DEF-025, where this module's own
        // `origin/main...HEAD` call went unseen here and was caught only by
        // P01's provenance audit.
        if (isRuleDefinitionRow(lines[i])) continue;
        findings.push({
          file: rel,
          line: i + 1,
          mechanism: rule.id,
          owner: rule.owner,
          detail: "P05 reimplements a mechanism another phase owns",
        });
      }
    }
  }
  const runner = readFileSync(
    path.join(REPO_ROOT, "scripts/ci/selftest/assurance.mjs"),
    "utf8"
  );
  for (const required of REQUIRED_INTEGRATIONS) {
    const present = required.re.test(runner);
    integrations.push({ integration: required.what, present });
    if (!present) {
      findings.push({
        file: "scripts/ci/selftest/assurance.mjs",
        mechanism: required.what,
        detail: "missing the canonical integration it must consume",
      });
    }
  }
  return { ok: findings.length === 0, findings, integrations, modules };
}

function main() {
  const containment = auditPoisonContainment();
  console.log(
    `[p05-audit] AUD01 scanned ${containment.files_scanned} tracked file(s): ` +
      `violations=${containment.violations.length} classified=${containment.classified.length}`
  );
  const byClass = containment.classified.reduce((acc, item) => {
    acc[item.classification] = (acc[item.classification] ?? 0) + 1;
    return acc;
  }, {});
  for (const [k, v] of Object.entries(byClass)) {
    console.log(`[p05-audit]   ${k}: ${v}`);
  }
  for (const item of containment.classified) {
    console.log(
      `[p05-audit]   ${item.classification} ${item.file} [${item.signatures.join(",")}]` +
        (item.reason ? ` — ${item.reason}` : "")
    );
  }
  for (const item of containment.violations) {
    console.error(`[p05-audit]   VIOLATION ${JSON.stringify(item)}`);
  }
  console.log(
    containment.ok
      ? "[p05-audit] AUD01 PASS — zero live poison in the tracked tree; all fixture poison is inert patch bytes"
      : "[p05-audit] AUD01 FAIL"
  );

  const isolation = auditArchitecturalIsolation();
  console.log(
    `[p05-audit] AUD02 modules=${isolation.modules.length} findings=${isolation.findings.length}`
  );
  for (const item of isolation.integrations) {
    console.log(
      `[p05-audit]   integration ${item.present ? "present" : "MISSING"}: ${item.integration}`
    );
  }
  for (const item of isolation.findings) {
    console.error(`[p05-audit]   FINDING ${JSON.stringify(item)}`);
  }
  console.log(
    isolation.ok
      ? "[p05-audit] AUD02 PASS — P05 orchestrates P01-P04 and duplicates none of them"
      : "[p05-audit] AUD02 FAIL"
  );

  if (!containment.ok || !isolation.ok) process.exitCode = 1;
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
) {
  try {
    main();
  } catch (error) {
    console.error(`[p05-audit] ${error.reason ?? error.message}`);
    process.exitCode = 1;
  }
}
