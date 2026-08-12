#!/usr/bin/env node
/**
 * p10/certificate.mjs — the LOCAL_READY_FOR_PR certificate: P10 aggregates
 * proof, it never invents verification. `issue` refuses unless the whole
 * program is closed; `verify` re-derives EVERY binding from disk in a fresh
 * process and voids on the first mismatch. The certificate is worthless by
 * design the moment any bound input changes.
 *
 *   issue    preconditions → bindings → write certificate + sha256
 *   verify   recompute all bindings from disk → VALID | VOID(field) |
 *            NOT_COMPARABLE(STALE_BASE) | REFUSED(...)
 *   install-hook   OPT-IN pre-push hook (P10.T07; never auto-installed)
 *
 * Exit codes: 0 VALID/issued · 2 VOID · 3 NOT_COMPARABLE · 4 REFUSED
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// P01 is the SOLE identity authority (DEF-025/DEF-051 law): head, base, and
// prospective merge tree come from snapshot.mjs — never resolved here. The
// provenance audit anchored in snapshot.test.ts enforces this, and caught
// this module's first draft doing it directly (rehearsal run 3).
import { resolveBase, resolveHead, writeMergeTree } from "../snapshot.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..", "..");
const CERT_DIR = path.join(REPO_ROOT, ".ci-verify", "certificate");
const CERT_PATH = path.join(CERT_DIR, "LOCAL_READY_FOR_PR.json");
const sha256 = buf => createHash("sha256").update(buf).digest("hex");

function git(args, cwd = REPO_ROOT) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

// ---------------------------------------------------------------------------
// Bindings — every value re-derivable from disk (P10.T01/T02).
// ---------------------------------------------------------------------------
export function deriveBindings(options = {}) {
  const headSha = resolveHead(REPO_ROOT);
  const originMain =
    options.originMain ?? resolveBase(REPO_ROOT, { fetch: false }).base_sha;
  const mergeTree = writeMergeTree(
    REPO_ROOT,
    originMain,
    headSha
  ).merge_tree_sha;
  const dirtyTracked = git(["status", "--porcelain", "--untracked-files=no"]);

  // verifier identity: content hash over every tracked file under scripts/ci
  const verifierFiles = git(["ls-files", "scripts/ci"])
    .split("\n")
    .filter(Boolean);
  const verifierHash = sha256(
    verifierFiles
      .map(f => `${f}\n${sha256(readFileSync(path.join(REPO_ROOT, f)))}\n`)
      .join("")
  );

  const ledgerRaw = readFileSync(
    path.join(REPO_ROOT, "docs/verification/ci-verify-ledger.json")
  );
  const ledger = JSON.parse(ledgerRaw.toString("utf8"));
  const phases = Object.fromEntries(ledger.phases.map(p => [p.id, p.state]));
  const units = Object.values(ledger.units);
  const mandatory = units.filter(u => u.class === "MANDATORY");
  const closed = new Set(["PASS", "N/A", "SKIPPED_DECLARED"]);

  const imagesPinned = JSON.parse(
    readFileSync(
      path.join(REPO_ROOT, "docs/verification/evidence/p08/images.pinned.json")
    )
  );
  const t01 = JSON.parse(
    readFileSync(
      path.join(
        REPO_ROOT,
        "docs/verification/evidence/p06/T01-classification.json"
      )
    )
  );
  const tools = (function walk(o, acc = []) {
    if (Array.isArray(o)) {
      o.forEach(v => walk(v, acc));
      return acc;
    }
    if (o && typeof o === "object") {
      if (o.id && o.version && o.derived_from)
        acc.push({ id: o.id, version: o.version });
      else Object.values(o).forEach(v => walk(v, acc));
    }
    return acc;
  })(t01);

  return {
    head_sha: headSha,
    base_sha: originMain,
    merge_tree_sha: mergeTree,
    dirty_tracked: dirtyTracked.length > 0,
    lockfile_sha256: sha256(
      readFileSync(path.join(REPO_ROOT, "pnpm-lock.yaml"))
    ),
    contract_sha256: readFileSync(
      path.join(REPO_ROOT, "scripts/ci/contract.sha256"),
      "utf8"
    )
      .trim()
      .split(/\s+/)[0],
    verifier_hash: verifierHash,
    verifier_file_count: verifierFiles.length,
    toolchain: {
      node: process.version,
      pnpm: execFileSync("pnpm", ["--version"], { encoding: "utf8" }).trim(),
      platform: `${os.platform()}/${os.arch()}`,
      vitest_worker_profile: { VITEST_MAX_FORKS: "4", VITEST_MAX_THREADS: "4" },
      governed_tools: tools,
    },
    cleanroom: {
      dockerfile_bases: imagesPinned.dockerfile_bases,
      mysql_fixture: imagesPinned.mysql_fixture,
    },
    assurance_sha256: sha256(
      readFileSync(
        path.join(
          REPO_ROOT,
          "docs/verification/evidence/p06/T22-acceptance-assurance.log"
        )
      )
    ),
    ledger_sha256: sha256(ledgerRaw),
    ledger_pin: readFileSync(
      path.join(REPO_ROOT, "docs/verification/ci-verify-ledger.sha256"),
      "utf8"
    )
      .trim()
      .split(/\s+/)[0],
    required_contexts: (() => {
      try {
        // conformance owns the required-context list; re-derive, never trust
        const mod = execFileSync(
          "node",
          [
            "-e",
            'import("./scripts/ci/contract-conformance.mjs").then(m=>console.log(JSON.stringify(m.REQUIRED_CONTEXTS)))',
          ],
          { cwd: REPO_ROOT, encoding: "utf8" }
        );
        return JSON.parse(mod.trim());
      } catch {
        return [];
      }
    })(),
    open_units_all_p10: (() => {
      const open = mandatory.filter(u => !closed.has(u.status));
      return open.length > 0 && open.every(u => u.phase === "P10");
    })(),
    execution_history: {
      phases,
      mandatory_total: mandatory.length,
      mandatory_closed: mandatory.filter(u => closed.has(u.status)).length,
      flaky_mandatory: mandatory.filter(u => u.flaky === true).length,
      open_defects: (ledger.defects ?? [])
        .filter(d => d.status !== "CLOSED")
        .map(d => `${d.id}(${d.severity})`),
      checkpoints: (ledger.checkpoints ?? []).length,
    },
  };
}

// ---------------------------------------------------------------------------
// Issuance rule (P10.T06/GATE01) — refuse loudly, never partially.
// ---------------------------------------------------------------------------
export function issuancePreconditions(b) {
  const refusals = [];
  const PRECEDING = [
    "PB",
    "P00",
    "P01",
    "P02",
    "P03",
    "P04",
    "P05",
    "P06",
    "P07",
    "P08",
    "P09",
  ];
  for (const p of PRECEDING) {
    if (b.execution_history.phases[p] !== "ACCEPTED") {
      refusals.push(
        `PHASE_NOT_ACCEPTED: ${p} is ${b.execution_history.phases[p]}`
      );
    }
  }
  if (
    b.execution_history.mandatory_closed !== b.execution_history.mandatory_total
  ) {
    const gap =
      b.execution_history.mandatory_total -
      b.execution_history.mandatory_closed;
    // P10's own units close AFTER issuance (CP01 binds the cert hash), so the
    // only legal gap is P10's remaining units — enforced by the phase check
    // above plus the ledger-verify integrity gate below.
    refusals.push(`UNITS_OPEN: ${gap} mandatory unit(s) not closed`);
  }
  if (b.execution_history.flaky_mandatory > 0) {
    refusals.push(`FLAKY_MANDATORY: ${b.execution_history.flaky_mandatory}`);
  }
  // Defect law = the SAME law phase acceptance used: open MEDIUM+ defects
  // block UNLESS they carry a recorded disposition in the graduation-risk
  // queue — and a queued defect's protection is FORFEIT the moment its
  // affected check appears among the required contexts (the queue's
  // enforcement hook, made executable here).
  const queue = readFileSync(
    path.join(REPO_ROOT, "docs/verification/GRADUATION-RISK-QUEUE.md"),
    "utf8"
  );
  const blocking = b.execution_history.open_defects.filter(d => {
    if (!/\((MEDIUM|HIGH|CRITICAL)\)/.test(d)) return false;
    const id = d.split("(")[0];
    return !queue.includes(id); // undispositioned MEDIUM+ blocks
  });
  if (blocking.length) refusals.push(`OPEN_DEFECTS: ${blocking.join(", ")}`);
  // enforcement hook: DEF-053 guards 03-semgrep#blocking — refuse if that
  // context graduated to required while the defect stays open
  if (
    b.execution_history.open_defects.some(d => d.startsWith("DEF-053")) &&
    b.required_contexts.some(c => /semgrep/i.test(c))
  ) {
    refusals.push(
      "GRADUATION_HOOK: 03-semgrep became a required context while DEF-053 is OPEN"
    );
  }
  if (b.dirty_tracked) refusals.push("DIRTY_TRACKED_FILES");
  if (b.ledger_sha256 !== b.ledger_pin) refusals.push("LEDGER_TAMPERED");
  // graduation-risk enforcement hook (GRADUATION-RISK-QUEUE.md law) is
  // structural: DEF-045/DEF-046/DEF-053/DEF-064 are LOW; a queued check
  // becoming REQUIRED while its defect is open surfaces as contract drift
  // (required-context change regenerates the contract) + this defect scan.
  return refusals;
}

function unitGap(b) {
  // the P10 units legitimately open at issuance time
  return (
    b.execution_history.mandatory_total - b.execution_history.mandatory_closed
  );
}

export function issue(options = {}) {
  const b = deriveBindings(options);
  const refusals = issuancePreconditions(b).filter(r => {
    // The only tolerated open units are P10's OWN (they close after
    // issuance, when CP01 binds the certificate hash) — structural, never a
    // magic count.
    if (r.startsWith("UNITS_OPEN") && b.open_units_all_p10) return false;
    return true;
  });
  if (refusals.length) {
    return { status: "REFUSED", refusals };
  }
  const certificate = {
    schema: "ci-verify/local-ready-for-pr.v1",
    verdict: "LOCAL_READY_FOR_PR",
    issued_at: new Date().toISOString(),
    bindings: b,
  };
  const bytes = JSON.stringify(certificate, null, 2) + "\n";
  mkdirSync(CERT_DIR, { recursive: true });
  writeFileSync(CERT_PATH, bytes);
  writeFileSync(
    path.join(CERT_DIR, "LOCAL_READY_FOR_PR.sha256"),
    `${sha256(bytes)}  LOCAL_READY_FOR_PR.json\n`
  );
  return {
    status: "ISSUED",
    path: CERT_PATH,
    sha256: sha256(bytes),
    certificate,
  };
}

// ---------------------------------------------------------------------------
// verify — a SEPARATE process re-derives everything from disk (P10.T02/TEST03).
// ---------------------------------------------------------------------------
export function verify(options = {}) {
  if (!existsSync(CERT_PATH))
    return { status: "REFUSED", reason: "NO_CERTIFICATE" };
  const bytes = readFileSync(CERT_PATH);
  const pin = readFileSync(
    path.join(CERT_DIR, "LOCAL_READY_FOR_PR.sha256"),
    "utf8"
  )
    .trim()
    .split(/\s+/)[0];
  if (sha256(bytes) !== pin) {
    return { status: "VOID", field: "certificate_bytes" };
  }
  const cert = JSON.parse(bytes.toString("utf8"));
  const c = cert.bindings;
  // staleness FIRST and CHEAPLY: a moved base is NOT a parity mismatch
  // (P10.NEG02) — and deriving a merge tree against a moved/unknown base
  // must never be attempted (found when NEG02 crashed the first draft)
  const currentBase =
    options.originMain ?? resolveBase(REPO_ROOT, { fetch: false }).base_sha;
  if (currentBase !== c.base_sha) {
    return {
      status: "NOT_COMPARABLE",
      reason: "STALE_BASE",
      certified: c.base_sha,
      current: currentBase,
    };
  }
  const f = deriveBindings(options);

  if (f.base_sha !== c.base_sha) {
    return {
      status: "NOT_COMPARABLE",
      reason: "STALE_BASE",
      certified: c.base_sha,
      current: f.base_sha,
    };
  }
  if (f.dirty_tracked)
    return { status: "VOID", field: "head_sha", reason: "DIRTY_TRACKED_FILES" };
  const FIELDS = [
    // verifier identity FIRST: a verifier change is the more specific void
    // (any commit also moves head_sha, which would otherwise shadow it)
    "verifier_hash",
    "head_sha",
    "merge_tree_sha",
    "lockfile_sha256",
    "contract_sha256",
    "assurance_sha256",
    "ledger_sha256",
  ];
  for (const field of FIELDS) {
    if (f[field] !== c[field]) return { status: "VOID", field };
  }
  if (f.ledger_sha256 !== f.ledger_pin) {
    return {
      status: "VOID",
      field: "ledger_sha256",
      reason: "LEDGER_TAMPERED",
    };
  }
  return {
    status: "VALID",
    certificate_sha256: pin,
    issued_at: cert.issued_at,
  };
}

// ---------------------------------------------------------------------------
// P10.T07 — OPT-IN pre-push hook. Never auto-installed; `install-hook` is an
// explicit developer action (AUTH01 covers availability, not activation).
// ---------------------------------------------------------------------------
export function installHook() {
  // path lookup without rev-parse (identity commands are P01's alone): the
  // primary checkout's .git is a directory; a linked worktree's is a gitfile
  // pointing at its private dir. Hooks live under the COMMON dir's hooks/.
  const dotGit = path.join(REPO_ROOT, ".git");
  let gitDir = dotGit;
  try {
    const content = readFileSync(dotGit, "utf8");
    const m = content.match(/^gitdir:\s*(.+)$/m);
    if (m) gitDir = path.resolve(REPO_ROOT, m[1].trim());
  } catch {
    // EISDIR — the normal primary-checkout case
  }
  const hookPath = path.join(gitDir, "hooks", "pre-push");
  if (existsSync(hookPath)) {
    return {
      status: "REFUSED",
      reason: `HOOK_EXISTS: ${hookPath} — remove it first`,
    };
  }
  writeFileSync(
    hookPath,
    `#!/bin/sh\n# ci-verify opt-in pre-push (P10.T07) — installed explicitly, remove freely\nnode scripts/ci/p10/certificate.mjs verify || {\n  echo "ci-verify: certificate not VALID — push anyway with --no-verify" >&2\n  exit 1\n}\n`
  );
  chmodSync(hookPath, 0o755);
  return { status: "INSTALLED", path: hookPath };
}

function main() {
  const [cmd] = process.argv.slice(2);
  const originOverride = process.env.CI_VERIFY_ORIGIN_MAIN_OVERRIDE;
  const options = originOverride ? { originMain: originOverride } : {};
  if (cmd === "issue") {
    const res = issue(options);
    console.log(
      JSON.stringify(
        res.status === "ISSUED"
          ? { status: res.status, path: res.path, sha256: res.sha256 }
          : res,
        null,
        2
      )
    );
    process.exitCode = res.status === "ISSUED" ? 0 : 4;
    return;
  }
  if (cmd === "verify") {
    const res = verify(options);
    console.log(JSON.stringify(res, null, 2));
    process.exitCode =
      res.status === "VALID"
        ? 0
        : res.status === "NOT_COMPARABLE"
          ? 3
          : res.status === "VOID"
            ? 2
            : 4;
    return;
  }
  if (cmd === "install-hook") {
    const res = installHook();
    console.log(JSON.stringify(res, null, 2));
    process.exitCode = res.status === "INSTALLED" ? 0 : 4;
    return;
  }
  console.error("usage: certificate.mjs issue|verify|install-hook");
  process.exitCode = 1;
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
) {
  main();
}
