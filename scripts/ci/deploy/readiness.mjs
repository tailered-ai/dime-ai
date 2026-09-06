#!/usr/bin/env node
/**
 * readiness.mjs — `pnpm ci:verify:deploy:issue|verify` (+ the execute refusal)
 *
 * The deployment-readiness certificate. Issue binds every input the contract
 * names; verify RECOMPUTES every binding from disk and live identity and
 * answers with an explicit freshness ladder — never one flat VALID:
 *
 *   REFUSED                 missing/unreadable/expired inputs
 *   VOID(field)             a binding no longer matches its recorded value
 *   HISTORICALLY_GATE_VALID gates were proved for the recorded head; the
 *                           repo has moved (or the defect law changed)
 *   STALE_SECURITY_EVIDENCE evidence older than the contract window
 *   STALE_TARGET_EVIDENCE   target snapshot older than the contract window
 *   CURRENTLY_GATE_VALID    everything recomputes AND is fresh, now
 *
 * `execute` exists ONLY to prove the refusal law: no authorization receipt
 * means refusal, and production execution is not enabled in this
 * qualification even WITH a structurally valid receipt. It never mutates.
 *
 * Exit codes: issue 0/2 · verify 0 CURRENT, 3 HISTORICAL, 4 STALE, 2 VOID,
 * 5 REFUSED · execute 6 NO_RECEIPT, 7 NOT_ENABLED, 2 INVALID_RECEIPT
 */
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CERT_PATH,
  CERT_PIN_PATH,
  PLAN_PATH,
  REHEARSAL_PATH,
  REPO_ROOT,
  identity,
  journal,
  loadContract,
  prCertificateState,
  readJson,
  run,
  sha256File,
  sha256Hex,
  writeJson,
} from "./lib.mjs";

const TRIVY_PATH = path.join(REPO_ROOT, ".ci-verify/p08/trivy.table");
const SBOM_PATH = path.join(REPO_ROOT, ".ci-verify/p08/sbom.spdx.json");
const QUEUE_PATH = path.join(
  REPO_ROOT,
  "docs/verification/GRADUATION-RISK-QUEUE.md"
);
const LEDGER_PATH = path.join(
  REPO_ROOT,
  "docs/verification/ci-verify-ledger.json"
);

function openBlockingDefects() {
  const ledger = readJson(LEDGER_PATH);
  const queue = existsSync(QUEUE_PATH) ? readFileSync(QUEUE_PATH, "utf8") : "";
  const open = (ledger.defects ?? []).filter(d => d.status !== "CLOSED");
  return {
    open: open.map(d => `${d.id}(${d.severity})`),
    blocking: open
      .filter(d => /MEDIUM|HIGH|CRITICAL/.test(d.severity))
      .filter(d => !queue.includes(d.id))
      .map(d => `${d.id}(${d.severity})`),
  };
}

export function issue() {
  const refusals = [];
  const { contract, sha256: contractSha } = loadContract();
  const id = identity();
  if (id.dirty_tracked) refusals.push("DIRTY_TRACKED_TREE");

  for (const [label, p] of [
    ["PLAN_MISSING", PLAN_PATH],
    ["REHEARSAL_MISSING", REHEARSAL_PATH],
    ["TRIVY_EVIDENCE_MISSING", TRIVY_PATH],
    ["SBOM_EVIDENCE_MISSING", SBOM_PATH],
  ]) {
    if (!existsSync(p)) refusals.push(label);
  }
  if (refusals.length) return { status: "REFUSED", refusals };

  const plan = readJson(PLAN_PATH);
  const rehearsal = readJson(REHEARSAL_PATH);
  if (plan.bindings.head_sha !== id.head_sha) refusals.push("STALE_PLAN_HEAD");
  if (rehearsal.head_sha !== id.head_sha) refusals.push("STALE_REHEARSAL_HEAD");
  if (rehearsal.verdict !== "REHEARSED")
    refusals.push(`REHEARSAL_NOT_GREEN: ${rehearsal.verdict}`);
  if (!rehearsal.steps?.rollback?.ok) refusals.push("ROLLBACK_NOT_PROVED");
  if (!rehearsal.steps?.teardown?.zero_residue)
    refusals.push("REHEARSAL_RESIDUE_NOT_ZERO");

  const prCert = prCertificateState();
  if (!prCert.present || prCert.verify_status !== "VALID")
    refusals.push(
      `PR_CERTIFICATE_NOT_VALID: ${prCert.verify_status ?? "absent"}`
    );

  const ledgerVerify = run("node", ["scripts/ci/ledger.mjs", "verify"], {
    timeout: 120_000,
  });
  if (ledgerVerify.status !== 0) refusals.push("LEDGER_VERIFY_FAILED");

  const defects = openBlockingDefects();
  if (defects.blocking.length)
    refusals.push(`OPEN_DEFECTS: ${defects.blocking.join(", ")}`);

  if (refusals.length) return { status: "REFUSED", refusals };

  const now = new Date();
  const cert = {
    schema: "ci-verify/deployment-readiness.v1",
    issued_at: now.toISOString(),
    expires_at: new Date(
      now.getTime() +
        contract.freshness.readiness_certificate_max_age_hours * 3_600_000
    ).toISOString(),
    bindings: {
      repository: contract.repository,
      protected_branch: contract.protected_branch,
      source: {
        head_sha: id.head_sha,
        base_sha: id.base_sha,
        merge_tree_sha: id.merge_tree_sha,
        candidate_is_protected_main_head: id.head_sha === id.base_sha,
      },
      pr_certificate: {
        sha256: prCert.sha256,
        head_sha: prCert.head_sha,
        verify_status: prCert.verify_status,
      },
      artifact: {
        candidate_image_id: rehearsal.steps.images.candidate.image_id,
        prior_image_id: rehearsal.steps.images.prior.image_id,
        dockerfile_sha256: sha256File(path.join(REPO_ROOT, "Dockerfile")),
        lockfile_sha256: sha256File(path.join(REPO_ROOT, "pnpm-lock.yaml")),
      },
      security: {
        trivy_sha256: sha256File(TRIVY_PATH),
        trivy_scanned_at: statSync(TRIVY_PATH).mtime.toISOString(),
        sbom_sha256: sha256File(SBOM_PATH),
      },
      contract: { sha256: contractSha, version: contract.version },
      plan_sha256: sha256File(PLAN_PATH),
      rehearsal: {
        journal_sha256: sha256File(REHEARSAL_PATH),
        verdict: rehearsal.verdict,
        health: rehearsal.steps.candidate_health.ok,
        smoke: rehearsal.steps.smoke.ok,
        shutdown_graceful: rehearsal.steps.candidate_shutdown.exit_code === 0,
        prior_shutdown_contract_met:
          rehearsal.steps.prior_shutdown.contract_met,
        rollback: rehearsal.steps.rollback.ok,
        zero_residue: rehearsal.steps.teardown.zero_residue,
        deployment_ids: rehearsal.deployments.map(d => d.deployment_id),
        idempotency_key: rehearsal.idempotency_key,
      },
      target_production: {
        ...contract.targets.production,
      },
      target_snapshot_recorded_at:
        contract.targets.production.snapshot_recorded_at,
      variable_names_sha256: sha256Hex(
        Buffer.from(JSON.stringify(contract.variables.production_names))
      ),
      migration: {
        new_sql: plan.migration.new_sql,
        receipt_present: plan.migration.receipt_present,
        plan_hash: sha256Hex(
          Buffer.from(JSON.stringify(plan.migration.new_sql))
        ),
      },
      open_defects: defects.open,
      ready_for_deployment: false,
      ready_for_deployment_reason:
        id.head_sha === id.base_sha
          ? "candidate equals protected-main head"
          : `CANDIDATE_NOT_PROTECTED_MAIN_HEAD: head ${id.head_sha.slice(0, 12)} != origin/main ${id.base_sha.slice(0, 12)} — readiness for a branch candidate attests rehearsal only`,
    },
  };
  cert.bindings.ready_for_deployment = id.head_sha === id.base_sha;
  const bytes = JSON.stringify(cert, null, 2) + "\n";
  writeFileSync(CERT_PATH, bytes);
  writeFileSync(
    CERT_PIN_PATH,
    `${sha256Hex(Buffer.from(bytes))}  DEPLOYMENT_READINESS.json\n`
  );
  journal({ step: "readiness-issued", sha256: sha256Hex(Buffer.from(bytes)) });
  return { status: "ISSUED", sha256: sha256Hex(Buffer.from(bytes)), cert };
}

export function verify() {
  if (!existsSync(CERT_PATH) || !existsSync(CERT_PIN_PATH))
    return { state: "REFUSED", reason: "NO_CERTIFICATE" };
  const bytes = readFileSync(CERT_PATH);
  const pinned = readFileSync(CERT_PIN_PATH, "utf8").trim().split(/\s+/)[0];
  if (sha256Hex(bytes) !== pinned)
    return { state: "VOID", field: "certificate_bytes" };
  let cert;
  try {
    cert = JSON.parse(bytes.toString("utf8"));
  } catch {
    return { state: "REFUSED", reason: "UNPARSEABLE" };
  }
  const b = cert.bindings;
  if (Date.now() > Date.parse(cert.expires_at))
    return { state: "REFUSED", reason: "EXPIRED", issued_at: cert.issued_at };

  // Evidence artifacts: recorded hash must still match the recorded bytes.
  for (const [field, p, recorded] of [
    ["rehearsal.journal_sha256", REHEARSAL_PATH, b.rehearsal.journal_sha256],
    ["security.trivy_sha256", TRIVY_PATH, b.security.trivy_sha256],
    ["security.sbom_sha256", SBOM_PATH, b.security.sbom_sha256],
    ["plan_sha256", PLAN_PATH, b.plan_sha256],
  ]) {
    if (!existsSync(p)) return { state: "REFUSED", reason: `MISSING:${field}` };
    if (sha256File(p) !== recorded) return { state: "VOID", field };
  }
  const { sha256: contractSha } = loadContract();
  if (contractSha !== b.contract.sha256)
    return { state: "VOID", field: "contract.sha256" };

  const id = identity();
  if (id.dirty_tracked) return { state: "VOID", field: "dirty_tracked" };

  const defects = openBlockingDefects();
  const defectLawHolds = defects.blocking.length === 0;

  if (id.head_sha !== b.source.head_sha || !defectLawHolds) {
    return {
      state: "HISTORICALLY_GATE_VALID",
      certified_head: b.source.head_sha,
      current_head: id.head_sha,
      reason:
        id.head_sha !== b.source.head_sha
          ? "HEAD_MOVED"
          : `DEFECT_LAW_NOW_FAILS: ${defects.blocking.join(", ")}`,
      issued_at: cert.issued_at,
    };
  }
  if (
    sha256File(path.join(REPO_ROOT, "pnpm-lock.yaml")) !==
    b.artifact.lockfile_sha256
  )
    return { state: "VOID", field: "artifact.lockfile_sha256" };
  if (
    sha256File(path.join(REPO_ROOT, "Dockerfile")) !==
    b.artifact.dockerfile_sha256
  )
    return { state: "VOID", field: "artifact.dockerfile_sha256" };

  const prNow = prCertificateState();
  if (prNow.verify_status !== "VALID")
    return {
      state: "HISTORICALLY_GATE_VALID",
      reason: `PR_CERTIFICATE_NOW: ${prNow.verify_status}`,
      issued_at: cert.issued_at,
    };

  const { contract } = loadContract();
  const secAgeH =
    (Date.now() - Date.parse(b.security.trivy_scanned_at)) / 3_600_000;
  if (secAgeH > contract.freshness.security_scan_max_age_hours)
    return {
      state: "STALE_SECURITY_EVIDENCE",
      scanned_at: b.security.trivy_scanned_at,
      age_hours: Math.round(secAgeH * 10) / 10,
    };
  const targetAgeH =
    (Date.now() - Date.parse(b.target_snapshot_recorded_at)) / 3_600_000;
  if (targetAgeH > contract.freshness.target_snapshot_max_age_hours)
    return {
      state: "STALE_TARGET_EVIDENCE",
      recorded_at: b.target_snapshot_recorded_at,
      age_hours: Math.round(targetAgeH * 10) / 10,
    };

  return {
    state: "CURRENTLY_GATE_VALID",
    structural: "STRUCTURALLY_VALID",
    certificate_sha256: pinned,
    issued_at: cert.issued_at,
    ready_for_deployment: b.ready_for_deployment,
    ready_for_deployment_reason: b.ready_for_deployment_reason,
  };
}

function execute() {
  const idx = process.argv.indexOf("--receipt");
  if (idx === -1 || !process.argv[idx + 1]) {
    console.log(
      "[deploy:execute] REFUSED: NO_AUTHORIZATION_RECEIPT — production execution requires a receipt binding authorizer, target, source head, artifact digest, readiness certificate, window, blast radius, rollout, prior deployment, rollback, stops, and expiry"
    );
    process.exitCode = 6;
    return;
  }
  const receiptPath = process.argv[idx + 1];
  if (!existsSync(receiptPath)) {
    console.log(`[deploy:execute] REFUSED: RECEIPT_UNREADABLE ${receiptPath}`);
    process.exitCode = 2;
    return;
  }
  let receipt;
  try {
    receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
  } catch {
    console.log("[deploy:execute] REFUSED: RECEIPT_MALFORMED");
    process.exitCode = 2;
    return;
  }
  const { contract } = loadContract();
  const required = contract.authorization.receipt_schema.required_fields;
  const missing = required.filter(f => !(f in receipt));
  if (
    receipt.schema !== "ci-verify/deploy-authorization.v1" ||
    missing.length
  ) {
    console.log(
      `[deploy:execute] REFUSED: RECEIPT_INVALID missing=[${missing.join(", ")}]`
    );
    process.exitCode = 2;
    return;
  }
  if (Date.now() > Date.parse(receipt.expires_at)) {
    console.log("[deploy:execute] REFUSED: RECEIPT_EXPIRED");
    process.exitCode = 2;
    return;
  }
  console.log(
    "[deploy:execute] REFUSED: PRODUCTION_EXECUTION_NOT_ENABLED — this qualification proves the control plane and never deploys production; enabling execution is a separate owner-authorized change"
  );
  process.exitCode = 7;
}

function main() {
  const [cmd] = process.argv.slice(2);
  if (cmd === "issue") {
    const res = issue();
    if (res.status === "ISSUED") {
      console.log(
        `[deploy:issue] ISSUED sha256=${res.sha256} ready_for_deployment=${res.cert.bindings.ready_for_deployment}`
      );
      return;
    }
    for (const r of res.refusals) console.log(`[deploy:issue] REFUSED: ${r}`);
    process.exitCode = 2;
    return;
  }
  if (cmd === "verify") {
    const res = verify();
    console.log(JSON.stringify(res, null, 2));
    process.exitCode =
      res.state === "CURRENTLY_GATE_VALID"
        ? 0
        : res.state === "HISTORICALLY_GATE_VALID"
          ? 3
          : res.state.startsWith("STALE_")
            ? 4
            : res.state === "VOID"
              ? 2
              : 5;
    return;
  }
  if (cmd === "execute") return execute();
  console.error("usage: readiness.mjs issue|verify|execute [--receipt <path>]");
  process.exitCode = 2;
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
) {
  try {
    main();
  } catch (error) {
    console.error(`[deploy:readiness] ${error.message}`);
    process.exitCode = 2;
  }
}
