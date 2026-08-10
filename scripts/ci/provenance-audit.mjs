#!/usr/bin/env node
/**
 * provenance-audit.mjs — P01.AUD01 enforcement of the P01.T08 invariant.
 *
 * `snapshot.mjs` is the SOLE owner of verification SHA resolution. No other
 * verifier module may call `git rev-parse`, recompute a base, infer HEAD, or
 * substitute another commit identity. This audit makes that enforceable rather
 * than aspirational.
 *
 * Two deliberate anti-false-conclusion measures:
 *
 *  1. Comments are STRIPPED before matching. A blanket text search would flag
 *     prose that merely mentions `rev-parse` and would train a reader to
 *     ignore the audit. String literals are still matched on purpose — a git
 *     argument IS a string literal.
 *  2. Files are CLASSIFIED, not lumped together. Implementation code must be
 *     clean. Tests, docs and controlled negative fixtures legitimately name
 *     these patterns and are reported separately, never as violations.
 *
 * A legitimate exception must be added to ALLOWLIST with a written reason,
 * which is itself asserted by the test suite.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, "..", "..");

/** Direct git identity-resolution surfaces that belong only to snapshot.mjs. */
export const GIT_IDENTITY_PATTERNS = [
  { id: "rev-parse", re: /\brev-parse\b/ },
  { id: "merge-base", re: /\bmerge-base\b/ },
  { id: "merge-tree", re: /\bmerge-tree\b/ },
  { id: "commit-tree", re: /\bcommit-tree\b/ },
  { id: "symbolic-ref", re: /\bsymbolic-ref\b/ },
  { id: "remote-tracking-ref", re: /\borigin\/(main|master)\b/ },
  { id: "committer-time-format", re: /--format=%ct\b/ },
  { id: "for-each-ref", re: /\bfor-each-ref\b/ },
  { id: "fetch-head", re: /\bFETCH_HEAD\b/ },
];

/** Explicit, reasoned exceptions. Asserted by the test suite. */
export const ALLOWLIST = [
  {
    file: "scripts/ci/snapshot.mjs",
    reason:
      "P01.T08 — this IS the provenance API. It is the single owner of SHA " +
      "resolution; every other module must consume snapshot.json instead.",
  },
  {
    file: "scripts/ci/provenance-audit.mjs",
    reason:
      "The audit must name the patterns it forbids in order to detect them. " +
      "It performs no SHA resolution of its own.",
  },
  {
    file: "scripts/ci/selftest/p05-audit.mjs",
    reason:
      "P05.AUD02's isolation table must NAME the provenance patterns it " +
      "forbids P05 from using. Its own git calls are `ls-files` and " +
      "`status` only — neither resolves a SHA or a ref. Added after DEF-025, " +
      "where this module's genuine `origin/main...HEAD` call was caught here " +
      "and removed; the allowlist covers the declaration table, not that bug.",
  },
];

/**
 * A module can only BYPASS the provenance API if it can actually resolve
 * identity itself — which requires invoking a subprocess. A declarative
 * registry that merely contains the string "origin/main" in prose cannot.
 *
 * Without this precondition the audit raised a false violation on
 * `blueprint.mjs`, whose PB entry checklist reads "…cut from origin/main"
 * (DEF-009). A checker that cries wolf on prose trains its reader to ignore
 * it, so precision here is a correctness requirement, not a convenience.
 *
 * Known limitation, stated rather than hidden: a subprocess invoked through a
 * fully dynamic command string would not be detected. The negative fixture
 * (P01.NEG04) uses the ordinary, detectable form.
 */
export function invokesSubprocess(source) {
  return (
    /\bexecFileSync\b|\bexecSync\b|\bspawnSync\b|\bexecFile\b|\bspawn\b|\bexec\b/.test(
      source
    ) && /["'`]git["'`]|\bnode:child_process\b|\bchild_process\b/.test(source)
  );
}

export function classify(rel) {
  if (ALLOWLIST.some(entry => entry.file === rel)) return "allowlisted";
  if (rel.includes("/fixtures/")) return "controlled-fixture";
  if (/\.(test|spec)\.(ts|mts|js|mjs)$/.test(rel)) return "test";
  if (/\.(md|txt|json)$/.test(rel)) return "doc";
  if (/\.(mjs|js|ts|mts)$/.test(rel)) return "implementation";
  return "other";
}

/** Strip line and block comments so prose cannot create a false violation. */
export function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map(line => line.replace(/(^|[^:])\/\/.*$/, "$1"))
    .join("\n");
}

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const abs = path.join(dir, entry);
    if (entry === "node_modules" || entry.startsWith(".")) continue;
    if (statSync(abs).isDirectory()) walk(abs, out);
    else out.push(abs);
  }
  return out;
}

export function auditProvenance(options = {}) {
  const root = options.root ?? REPO_ROOT;
  const scanDir = path.join(root, options.scanDir ?? "scripts/ci");
  const violations = [];
  const notes = [];
  const scanned = [];

  for (const abs of walk(scanDir)) {
    const rel = path.relative(root, abs);
    const kind = classify(rel);
    scanned.push({ file: rel, kind });
    if (kind === "allowlisted" || kind === "doc" || kind === "other") continue;

    const source = stripComments(readFileSync(abs, "utf8"));
    const canInvoke = invokesSubprocess(source);
    const effectiveKind =
      kind === "implementation" && !canInvoke ? "declaration-only" : kind;
    scanned[scanned.length - 1].kind = effectiveKind;
    scanned[scanned.length - 1].invokes_subprocess = canInvoke;

    for (const pattern of GIT_IDENTITY_PATTERNS) {
      const lines = source.split("\n");
      for (let index = 0; index < lines.length; index += 1) {
        if (!pattern.re.test(lines[index])) continue;
        const record = {
          file: rel,
          line: index + 1,
          pattern: pattern.id,
          kind: effectiveKind,
          text: lines[index].trim().slice(0, 160),
        };
        if (effectiveKind === "implementation") violations.push(record);
        else notes.push(record);
      }
    }
  }

  return {
    ok: violations.length === 0,
    violations,
    notes,
    scanned,
    allowlist: ALLOWLIST,
    counts: scanned.reduce((acc, item) => {
      acc[item.kind] = (acc[item.kind] ?? 0) + 1;
      return acc;
    }, {}),
  };
}

/**
 * Behavioural half of the audit: a consumer must be able to obtain every
 * identity value from snapshot.json alone, with no git invocation.
 */
export function auditConsumerIndependence(snapshot) {
  const required = [
    "head_sha",
    "base_sha",
    "merge_tree_sha",
    "merge_commit_sha",
    "parent_order",
  ];
  const missing = required.filter(
    key => snapshot?.identity?.[key] === undefined
  );
  return { ok: missing.length === 0, missing, required };
}

function main() {
  const result = auditProvenance();
  console.log(
    `[provenance-audit] scanned ${result.scanned.length} file(s): ` +
      Object.entries(result.counts)
        .map(([kind, count]) => `${kind}=${count}`)
        .join(" ")
  );
  for (const entry of ALLOWLIST) {
    console.log(
      `[provenance-audit] allowlisted ${entry.file} — ${entry.reason}`
    );
  }
  for (const note of result.notes) {
    console.log(
      `[provenance-audit] note (${note.kind}) ${note.file}:${note.line} ${note.pattern}`
    );
  }
  if (!result.ok) {
    console.error("[provenance-audit] FAIL — provenance API bypassed:");
    for (const violation of result.violations) {
      console.error(
        `  ${violation.file}:${violation.line} pattern=${violation.pattern} :: ${violation.text}`
      );
    }
    process.exit(1);
  }
  console.log(
    "[provenance-audit] PASS — no implementation module bypasses snapshot.mjs"
  );
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
) {
  main();
}
