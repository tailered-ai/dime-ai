#!/usr/bin/env node
/**
 * placement.mjs — P05.T02: the fixture-placement and poison-containment law,
 * made executable.
 *
 * THE LAW (frozen): poison exists ONLY as inert patch bytes (or equivalent
 * non-live fixture data) under an approved self-test fixture root, until the
 * runner applies it inside a disposable candidate worktree. The tracked
 * repository must NEVER contain poison as a live workflow / migration /
 * source / configuration file in a path a real gate scans — otherwise the PR
 * introducing ASSURANCE would fail its own production gates, and worse, a
 * green run could be red for reasons nobody intended.
 *
 * Scope grounding: P00.T05 proved the GitHub Actions security scan reads
 * `.github/workflows/**` (and the composite-action roots); gitleaks scans
 * the tree; the migration-immutability gate scans `drizzle/**`. Those are
 * the sensitive roots this validator refuses to let fixture material near.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

export class PlacementError extends Error {
  constructor(reason, detail = {}) {
    super(reason);
    this.name = "PlacementError";
    this.reason = reason;
    Object.assign(this, detail);
  }
}

/** Repo-relative roots real gates scan. A live fixture here is a violation. */
export const SENSITIVE_ROOTS = [
  ".github/workflows",
  ".github/actions",
  ".github/CODEOWNERS",
  "drizzle",
];

/** The only places fixture material may live, both inert-by-construction. */
export const APPROVED_FIXTURE_ROOTS = [
  "scripts/ci/selftest/fixtures",
  "scripts/ci/selftest/test-fixtures",
];

/**
 * File shapes that are INERT by storage mode: patch bytes and expectation
 * metadata. Anything else inside a fixture directory is treated as
 * potentially LIVE and refused — extension alone is never trusted for
 * poison-bearing formats.
 */
export const INERT_FIXTURE_FILES = new Set([
  "poison.patch",
  "expect.json",
  // P06 fixtures carry their expectation as `fixture.json` rather than P05's
  // `expect.json`. It is the same class of artifact — a declarative manifest
  // read by the ASSURANCE harness, never executed and never applied to a
  // sensitive root — so it is inert on the same grounds. Omitting it made the
  // containment audit undercount inert files (9 against 12 fixtures) and fail
  // for a naming difference rather than for any live poison.
  "fixture.json",
  "README.md",
]);

/**
 * Content signatures of the poison families ASSURANCE uses. Matching one is
 * NOT a verdict (P05.AUD01 classifies) — but a LIVE-format file under a
 * sensitive root matching one is an immediate refusal.
 */
export const POISON_SIGNATURES = [
  { id: "p05-marker", re: /p05[-_]poison/i },
  // P06 fixtures mark their poison with a p06 prefix (p06Poison…,
  // p06-…-assurance-poison, "P06 ASSURANCE poison"). Without this signature
  // the containment audit could not SEE most P06 poison at all: it classifies
  // only signature-matching files, so P06 material was passing through
  // unexamined rather than being proven inert. That is the exact hole this
  // audit exists to close, so the family is registered here.
  { id: "p06-marker", re: /p06[-_]?poison|P06 ASSURANCE poison/i },
  {
    id: "template-injection",
    re: /\$\{\{\s*github\.event\.(issue|pull_request|comment|review)\./,
  },
  { id: "unpinned-uses", re: /^\s*uses:\s*[^#\n]+@(main|master|v\d+)\s*$/m },
  { id: "secret-reference", re: /\$\{\{\s*secrets\.[A-Z0-9_]+\s*\}\}/ },
  {
    id: "destructive-sql",
    re: /\b(DROP\s+TABLE|TRUNCATE\s+TABLE|DELETE\s+FROM\s+\w+\s*;)/i,
  },
];

function walkFiles(dir, acc = []) {
  for (const entry of readdirSync(dir).sort()) {
    const abs = path.join(dir, entry);
    if (statSync(abs).isDirectory()) walkFiles(abs, acc);
    else acc.push(abs);
  }
  return acc;
}

/**
 * Validate ONE fixture directory's storage mode. Called by the runner BEFORE
 * any candidate exists, so a live-poison fixture fails the framework — a
 * verifier-safety failure — before any real gate could stumble on it.
 */
export function validateFixtureStorage(fixtureDir, options = {}) {
  const repoRoot = options.repoRoot ?? process.cwd();
  const rel = path.relative(repoRoot, fixtureDir);
  const underApproved = APPROVED_FIXTURE_ROOTS.some(
    root => rel === root || rel.startsWith(root + path.sep)
  );
  if (!underApproved) {
    throw new PlacementError("LIVE_POISON_FIXTURE", {
      fixtureDir: rel,
      detail: `fixture directory is outside the approved roots (${APPROVED_FIXTURE_ROOTS.join(", ")})`,
    });
  }
  for (const sensitiveRoot of SENSITIVE_ROOTS) {
    if (rel === sensitiveRoot || rel.startsWith(sensitiveRoot + path.sep)) {
      throw new PlacementError("LIVE_POISON_FIXTURE", {
        fixtureDir: rel,
        detail: `fixture directory sits inside sensitive root ${sensitiveRoot}`,
      });
    }
  }
  const violations = [];
  for (const abs of walkFiles(fixtureDir)) {
    const name = path.basename(abs);
    if (INERT_FIXTURE_FILES.has(name)) continue;
    // Any non-inert file inside a fixture is stored in a LIVE format. A
    // workflow-shaped or SQL-shaped file is exactly how poison escapes.
    violations.push({
      file: path.relative(repoRoot, abs),
      reason: "LIVE_POISON_FIXTURE",
      detail: `only ${[...INERT_FIXTURE_FILES].join(", ")} may exist inside a fixture directory; found live-format file`,
    });
  }
  if (violations.length) {
    throw new PlacementError("LIVE_POISON_FIXTURE", { violations });
  }
  return { ok: true, fixtureDir: rel };
}

/**
 * Tree-level containment: given a set of repo-relative paths (an initiative
 * diff, or a whole-tree scan), refuse any LIVE file under a sensitive root
 * that carries a poison signature. Inert storage (.patch bytes, expect.json)
 * under the approved roots is legal BY DESIGN and reported as such.
 */
export function scanTreeForLivePoison(paths, options = {}) {
  const repoRoot = options.repoRoot ?? process.cwd();
  const findings = [];
  const classified = [];
  for (const rel of paths) {
    const abs = path.join(repoRoot, rel);
    // No check-then-use: the read IS the probe (EISDIR/ENOENT -> skip).
    let text;
    try {
      text = readFileSync(abs, "utf8");
    } catch {
      continue; // directory, vanished, or unreadable — nothing to classify
    }
    const hits = POISON_SIGNATURES.filter(sig => sig.re.test(text));
    if (hits.length === 0) continue;
    const underApproved = APPROVED_FIXTURE_ROOTS.some(root =>
      rel.startsWith(root + path.sep)
    );
    const underSensitive = SENSITIVE_ROOTS.some(
      root => rel === root || rel.startsWith(root + path.sep)
    );
    const inert = underApproved && INERT_FIXTURE_FILES.has(path.basename(rel));
    if (underSensitive) {
      findings.push({
        file: rel,
        signatures: hits.map(h => h.id),
        classification: "LIVE_POISON_VIOLATION",
      });
    } else if (inert) {
      classified.push({
        file: rel,
        signatures: hits.map(h => h.id),
        classification: "INERT_FIXTURE",
      });
    } else {
      // Anything else needs a human-auditable classification (test canary vs
      // legitimate existing source). Reported, never auto-cleared.
      classified.push({
        file: rel,
        signatures: hits.map(h => h.id),
        classification: "NEEDS_CLASSIFICATION",
      });
    }
  }
  return { ok: findings.length === 0, findings, classified };
}
