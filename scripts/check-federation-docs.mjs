#!/usr/bin/env node
/**
 * check-federation-docs.mjs — keep the design/engineering federation skills honest
 * about the repo they govern.
 *
 * WHY THIS EXISTS. The federations are always-loaded routing documents: an agent acts
 * on them without re-deriving their claims. That makes a stale sentence in them more
 * expensive than a stale comment in code, and a 2026-08-07 review found the failure
 * modes are boringly repetitive:
 *
 *   - Dangling paths. `routing.md` pointed at a YAML template that had been deleted
 *     from it; `dime-mapping.md` kept pointing at the old location.
 *   - Ordinal drift. Two rows cited "deploy-smoke check #5" and "smoke check #8"; a
 *     check inserted at position 2 silently shifted both. A third place claimed the
 *     script had 8 checks when it had 13, a fourth claimed 6.
 *   - Record-schema drift. The evidence-record template renamed the standard's
 *     `artifact_digest` to `artifact` and dropped four of §21.3's five `verification`
 *     subfields, so records validated against nothing.
 *   - The invocability trap. The routing table advertised `architect-backend-systems`
 *     as "Skill tool" when it lives only in `.agents/skills/`, which Claude Code does
 *     not register — the Lead row for architecture work pointed at a name that cannot
 *     resolve.
 *
 * Each of those is mechanically detectable, so this gate detects them. It deliberately
 * does NOT encode one-off assertions about the wording of any particular fix; those
 * belong in the PR that made them. Every rule here is an invariant that should hold for
 * as long as the federations exist.
 *
 * SCOPE NOTE on YAML. The repo has no YAML parser dependency, so the record-template
 * check is STRUCTURAL (top-level `key:` at column 0, `  key:` for nested), not a full
 * parse. It is enough to catch field drift against the vendored standard, which is the
 * failure this gate exists for. It would not catch an exotic YAML syntax error.
 *
 * Usage:  node scripts/check-federation-docs.mjs
 * Exit 0 = every invariant holds. Exit 1 = violations, listed with file and reason.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const ROOT = process.cwd();

const ENG = ".claude/skills/engineering-federation";
const DESIGN = ".claude/skills/design-federation";

/** Docs this gate governs. Add a federation reference file here when you create one. */
export const GOVERNED_DOCS = [
  `${ENG}/SKILL.md`,
  `${ENG}/references/routing.md`,
  `${ENG}/references/dime-mapping.md`,
  `${DESIGN}/SKILL.md`,
  `${DESIGN}/references/routing.md`,
  `${DESIGN}/references/registry.md`,
  `${DESIGN}/references/evidence-bundle.md`,
  ".claude/commands/eng-loop.md",
  ".claude/commands/ui-loop.md",
];

/**
 * Additional ACTIVE surfaces checked for dangling references only.
 *
 * These get rule 1 (no dangling paths) and nothing else — the ordinal, record-
 * fidelity and routing rules are federation-specific and would be nonsense here.
 *
 * Why these three and not "all of os/ and docs/", measured on 23aafc55a:
 *
 *   os/*.md            (2 files)   0 dangling   -> governed
 *   docs/*.md          (2 files)   0 dangling   -> governed
 *   docs/audits/*-evidence/summary.md (8)  0 dangling -> governed
 *   os/decisions/*.md  (17 files)  130 dangling -> NOT governed, see below
 *   os/** (all md)     (80 files)  220 dangling -> NOT governed
 *
 * DECISION RECORDS ARE DELIBERATELY EXCLUDED. A decision record argues about
 * work that may never be built: DR-006 alone cites 16 paths that do not exist,
 * DR-010 cites 11, and DR-010 was subsequently CUT — those citations are
 * correct for the genre and always will be. Governing them would need a ~130
 * entry permanent allowlist, which is the "make the scan pass" anti-pattern this
 * gate exists to avoid. The cost is real and is stated in the closeout PR: a
 * stale path citation inside a DR (the `observe-crons.mjs` drift found by hand
 * on 2026-08-08) is still not mechanically caught.
 *
 * Evidence summaries ARE governed. They describe work that shipped, so their
 * references are claims about the current repository, and they are exactly where
 * the 2026-08-09 hand-verified links lived.
 */
const ACTIVE_DOC_GLOBS = [
  { dir: "os", depth: 1, match: /\.md$/ },
  { dir: "docs", depth: 1, match: /\.md$/ },
  { dir: "docs/audits", depth: 2, match: /^summary\.md$/ },
];

/** Resolve ACTIVE_DOC_GLOBS to repo-relative file paths, sorted and deduped. */
export function listActiveDocs(root = ROOT) {
  const out = new Set();
  /** `depth` is how many directory levels remain; files count only at depth 1. */
  const walk = (rel, depth, match) => {
    const abs = path.join(root, rel);
    if (!existsSync(abs)) return;
    for (const entry of readdirSync(abs, { withFileTypes: true })) {
      const childRel = `${rel}/${entry.name}`;
      if (entry.isDirectory()) {
        if (depth > 1) walk(childRel, depth - 1, match);
      } else if (depth === 1 && match.test(entry.name)) {
        out.add(childRel);
      }
    }
  };
  for (const g of ACTIVE_DOC_GLOBS) walk(g.dir, g.depth, g.match);
  return [...out].sort();
}

const RECORD_TEMPLATE = `${ENG}/references/record-template.yaml`;
const VENDORED_STANDARD = `${ENG}/references/production-grade-engineering-architecture.md`;
const SMOKE_SCRIPT = "scripts/smoke-deploy.mjs";

// ── 1. Dangling references ──────────────────────────────────────────────────
// Repo-relative paths cited in prose. Anchored on known top-level roots so prose
// like "server/routers.ts" is caught while "e.g. foo/bar" noise is not. Trailing
// punctuation and markdown/backtick wrappers are stripped by the caller.
const PATH_ROOTS =
  "\\.claude|\\.agents|\\.github|server|client|shared|scripts|drizzle|docs|design-system|dime-ai|os|ml|references|config";
const PATH_RE = new RegExp(
  `(?:^|[\\s\`(\\[|])((?:${PATH_ROOTS})\\/[A-Za-z0-9._\\/-]+\\.[A-Za-z0-9]+)`,
  "g"
);

/** Every repo-relative file path a doc cites. */
export function extractCitedPaths(text) {
  const out = new Set();
  for (const m of text.matchAll(PATH_RE)) {
    let p = m[1].replace(/[).,;:`]+$/, "");
    // Placeholder segments (<page>.md, [slug], *-evidence) are patterns, not paths.
    if (/[<>\[\]*$]/.test(p)) continue;
    out.add(p);
  }
  return [...out];
}

/**
 * Paths a doc is ALLOWED to cite before they exist, each with the reason and the
 * condition that retires the allowance. Self-cleaning: if one of these starts existing,
 * the gate fails so the allowance gets removed rather than quietly outliving its reason.
 */
export const PLANNED_PATHS = {
  "shared/loop/evidenceRecord.ts":
    "DR-005 plans this zod schema; the docs frame it as planned, not current",
  "scripts/check-evidence-record.mjs":
    "DR-005 plans this validator; the docs frame it as planned, not current",
  // server/_core/clientIdentity.ts was here while it lived only on the
  // security/edge-identity-remediation branch. The allowance did its job: this gate
  // failed the moment the file became real, which is what forced the docs to stop
  // describing it as pending. Removed 2026-08-07 when that branch landed.
};

/**
 * Paths quoted as literal text that is itself wrong — quoting a defect is not committing
 * one. Keep this tiny; the reason must name what is being quoted.
 */
export const QUOTED_WRONG_PATHS = {
  "design-system/MASTER.md":
    "registry.md quotes uipro's own --persist help text to record that it disagrees with the code path",
};

/**
 * `references/foo.md` in a federation doc is skill-relative, not repo-relative, and the
 * /ui-loop and /eng-loop command files use the same shorthand for their skill's tree.
 * A citation resolves if it exists under the repo root, the citing doc's own directory,
 * or either federation root.
 */
export function resolveCitedPath(p, docRel, root = ROOT) {
  const bases = [
    root,
    path.join(root, path.dirname(docRel)),
    path.join(root, ENG),
    path.join(root, DESIGN),
  ];
  return bases.some(base => existsSync(path.join(base, p)));
}

/** Cited paths that do not exist and are not a declared planned/quoted exception. */
export function findDanglingPaths(text, docRel, root = ROOT) {
  return extractCitedPaths(text).filter(
    p =>
      !resolveCitedPath(p, docRel, root) &&
      !(p in PLANNED_PATHS) &&
      !(p in QUOTED_WRONG_PATHS)
  );
}

/** Declared-planned paths that now exist — the allowance is stale and must be removed. */
export function findStalePlannedPaths(root = ROOT) {
  return Object.keys(PLANNED_PATHS).filter(p => existsSync(path.join(root, p)));
}

// ── 2. Smoke-check citations ────────────────────────────────────────────────
// Rule the docs adopted 2026-08-07: cite checks BY NAME, never by count or ordinal,
// because inserting a check renumbers every ordinal after it without touching a doc.
const ORDINAL_RE = /check\s+#\d+|\b\d+\s+checks\b/gi;
/** Italic-quoted *"..."* spans — how the docs mark a verbatim check name. */
const QUOTED_RE = /\*"([^"]+)"\*/g;

export function findOrdinalCitations(text) {
  return [...text.matchAll(ORDINAL_RE)].map(m => m[0]);
}

export function extractQuotedCheckNames(text) {
  return [...text.matchAll(QUOTED_RE)].map(m => m[1]);
}

/** Prose wraps; the script does not. Compare on collapsed whitespace, not raw bytes. */
const collapse = s => s.replace(/\s+/g, " ").trim();

/** Quoted names that are not present verbatim in the smoke script. */
export function findUnmatchedCheckNames(text, smokeSource) {
  const haystack = collapse(smokeSource);
  return extractQuotedCheckNames(text).filter(
    n => !haystack.includes(collapse(n))
  );
}

// ── 3. Evidence-record fidelity ─────────────────────────────────────────────
// The vendored standard §21.3 is the schema authority (SKILL.md authority chain #3).
// The Dime template may ADD fields, but must not drop or rename one.

/** Fields + terminal-outcome enum declared by the standard's §21.3/§21.4 block. */
export function parseStandardRecord(standardText) {
  const block = standardText.match(
    /### 21\.3 Required agent evidence record\s*\n+```yaml\n([\s\S]*?)```/
  );
  if (!block)
    throw new Error("§21.3 YAML block not found in the vendored standard");
  return { ...parseYamlishKeys(block[1]), enum: parseOutcomeEnum(block[1]) };
}

/** Same shape, read from the Dime template. */
export function parseTemplateRecord(templateText) {
  return {
    ...parseYamlishKeys(templateText),
    enum: parseOutcomeEnum(templateText),
  };
}

/** Structural key scan: `key:` at column 0, `  key:` one level in. Comments ignored. */
export function parseYamlishKeys(text) {
  const top = [];
  const nested = [];
  for (const raw of text.split("\n")) {
    const line = raw.replace(/#.*$/, "");
    let m;
    if ((m = line.match(/^([A-Za-z_][A-Za-z0-9_]*):/))) top.push(m[1]);
    else if ((m = line.match(/^ {2}([A-Za-z_][A-Za-z0-9_]*):/)))
      nested.push(m[1]);
  }
  return { top, nested };
}

/** The seven terminal outcomes, wherever they are written as a `a | b | c` run. */
export function parseOutcomeEnum(text) {
  const m = text.match(/shipped[^\n]*(?:\n[^\n]*)?/);
  if (!m) return [];
  const window = text.slice(
    text.indexOf("shipped"),
    text.indexOf("shipped") + 400
  );
  const found = new Set();
  for (const token of window.matchAll(
    /\b(shipped|rejected|halted_attempts|halted_budget|halted_permission|halted_environment|failed_verification)\b/g
  )) {
    found.add(token[1]);
  }
  return [...found];
}

// ── 4. The invocability trap ────────────────────────────────────────────────
// `.agents/skills/` is the cross-platform tree; Claude Code registers nothing from it.
// A routing row that advertises such a name as "Skill tool" sends a Lead to a name that
// cannot resolve. (The converse — that `.claude/skills/` membership implies
// invocability — is ALSO false, but is not mechanically checkable from disk: it depends
// on the live roster. The docs state that caveat in prose.)
export function listDirNames(dir, root = ROOT) {
  const abs = path.join(root, dir);
  if (!existsSync(abs)) return [];
  return readdirSync(abs).filter(n =>
    statSync(path.join(abs, n)).isDirectory()
  );
}

/**
 * Table rows that claim "Skill tool" for a skill living only under `.agents/skills/`.
 * Returns the offending skill names.
 */
export function findMisadvertisedSkills(routingText, agentsOnly) {
  const bad = [];
  for (const line of routingText.split("\n")) {
    if (!line.startsWith("|") || !/skill tool/i.test(line)) continue;
    for (const name of agentsOnly) {
      if (line.includes(name)) bad.push(name);
    }
  }
  return bad;
}

// ── Runner ──────────────────────────────────────────────────────────────────
export function runChecks(root = ROOT) {
  const violations = [];
  const read = rel => readFileSync(path.join(root, rel), "utf8");
  const fail = (file, msg) => violations.push({ file, msg });

  // 1. No dangling references in any governed doc.
  for (const doc of GOVERNED_DOCS) {
    if (!existsSync(path.join(root, doc))) {
      fail(
        doc,
        "governed doc is missing — remove it from GOVERNED_DOCS or restore it"
      );
      continue;
    }
    for (const p of findDanglingPaths(read(doc), doc, root)) {
      fail(doc, `cites a path that does not exist: ${p}`);
    }
  }

  // 1a. Same rule over the ACTIVE os/ and docs/ surfaces. Dangling references
  // only — see ACTIVE_DOC_GLOBS for why decision records are excluded.
  for (const doc of listActiveDocs(root)) {
    for (const p of findDanglingPaths(read(doc), doc, root)) {
      fail(doc, `cites a path that does not exist: ${p}`);
    }
  }

  // 1b. A planned-path allowance must not outlive the thing it was waiting for.
  for (const p of findStalePlannedPaths(root)) {
    fail(
      "scripts/check-federation-docs.mjs",
      `${p} now exists — drop it from PLANNED_PATHS and make the docs describe it as real`
    );
  }

  // 2. Smoke-check citations: by name, verbatim, never by ordinal.
  const smoke = existsSync(path.join(root, SMOKE_SCRIPT))
    ? read(SMOKE_SCRIPT)
    : "";
  for (const doc of GOVERNED_DOCS) {
    if (!existsSync(path.join(root, doc))) continue;
    const text = read(doc);
    for (const ord of findOrdinalCitations(text)) {
      fail(
        doc,
        `cites a smoke check by ordinal/count ("${ord}") — cite it by name`
      );
    }
    if (smoke) {
      for (const name of findUnmatchedCheckNames(text, smoke)) {
        fail(
          doc,
          `quotes a smoke check absent from ${SMOKE_SCRIPT}: "${name}"`
        );
      }
    }
  }

  // 3. Evidence record matches the standard it claims to implement.
  if (existsSync(path.join(root, RECORD_TEMPLATE))) {
    const std = parseStandardRecord(read(VENDORED_STANDARD));
    const tpl = parseTemplateRecord(read(RECORD_TEMPLATE));
    for (const f of std.top) {
      if (!tpl.top.includes(f)) {
        fail(
          RECORD_TEMPLATE,
          `missing §21.3 field "${f}" (renaming counts as missing)`
        );
      }
    }
    for (const f of std.nested) {
      if (!tpl.nested.includes(f)) {
        fail(RECORD_TEMPLATE, `missing §21.3 verification subfield "${f}"`);
      }
    }
    for (const v of std.enum) {
      if (!tpl.enum.includes(v)) {
        fail(
          RECORD_TEMPLATE,
          `terminal-outcome enum is missing "${v}" (§21.4)`
        );
      }
    }
    if (/\t/.test(read(RECORD_TEMPLATE))) {
      fail(
        RECORD_TEMPLATE,
        "contains a tab — YAML forbids tabs for indentation"
      );
    }
  }

  // 4. No routing row advertises an `.agents/skills/`-only skill as Skill-invocable.
  const agentsOnly = listDirNames(".agents/skills", root).filter(
    n => !existsSync(path.join(root, ".claude/skills", n))
  );
  for (const doc of [`${ENG}/references/routing.md`, `${ENG}/SKILL.md`]) {
    if (!existsSync(path.join(root, doc))) continue;
    for (const name of findMisadvertisedSkills(read(doc), agentsOnly)) {
      fail(
        doc,
        `advertises "${name}" as Skill-invocable, but it lives only in .agents/skills/ — give a Read path`
      );
    }
  }

  return violations;
}

const isMain =
  process.argv[1] &&
  import.meta.url === `file://${path.resolve(process.argv[1])}`;
if (isMain) {
  const violations = runChecks();
  if (violations.length === 0) {
    console.log(
      "federation docs: OK — no dangling paths, ordinals, schema drift, or dead routing"
    );
    process.exit(0);
  }
  console.error(`federation docs: ${violations.length} violation(s)\n`);
  for (const v of violations) console.error(`  ${v.file}\n    ${v.msg}`);
  console.error(
    "\nThese docs are always-loaded routing surfaces — a stale line here is acted on."
  );
  process.exit(1);
}
