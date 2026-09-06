#!/usr/bin/env node
/**
 * plan.mjs — `pnpm ci:verify:deploy:plan`
 *
 * Derives and validates every binding a deployment decision needs, refuses
 * loudly with exact reasons, and writes .ci-verify/deploy/plan.json. Creates
 * no infrastructure and never mutates a target.
 *
 * Exit codes: 0 PLANNED · 2 REFUSED · 10 INFRA (docker unreachable)
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CONTRACT_PATH,
  PLAN_PATH,
  REPO_ROOT,
  docker,
  identity,
  journal,
  loadContract,
  prCertificateState,
  sha256File,
  writeJson,
} from "./lib.mjs";

export function buildPlan() {
  const refusals = [];
  const infra = [];

  const { contract, sha256: contractSha } = loadContract();
  const id = identity();
  if (id.dirty_tracked) refusals.push("DIRTY_TRACKED_TREE");

  const dockerProbe = docker(["version", "--format", "{{.Server.Version}}"]);
  if (dockerProbe.status !== 0) {
    infra.push("DOCKER_UNREACHABLE: rehearsal target needs the local daemon");
  }

  // Migration state — the deploy-order law (#370 class). Added SQL between
  // base and head demands a db-push receipt BEFORE any dependent deploy.
  const diff = execFileSync(
    "git",
    [
      "diff",
      "--name-status",
      `${id.base_sha}...${id.head_sha}`,
      "--",
      "drizzle",
    ],
    { cwd: REPO_ROOT, encoding: "utf8" }
  );
  const newSql = diff
    .split("\n")
    .filter(l => l.startsWith("A") && /\.sql$/.test(l))
    .map(l => l.split(/\s+/)[1]);
  const receipt = (process.env.CI_VERIFY_DBPUSH_RUN_ID ?? "").trim();
  if (newSql.length > 0 && !receipt) {
    refusals.push(
      `MIGRATION_RECEIPT_MISSING: ${newSql.length} new migration(s) without CI_VERIFY_DBPUSH_RUN_ID`
    );
  }

  // PR certificate — recorded here; REQUIRED at issue time.
  const prCert = prCertificateState();

  // Targets. Production is recorded and refused; rehearsal must exist.
  const prod = contract.targets.production;
  const rehearsal = contract.targets.rehearsal;
  if (!prod?.project_id || !prod?.service_id || !prod?.environment_id) {
    refusals.push("PRODUCTION_TARGET_AMBIGUOUS: contract snapshot incomplete");
  }
  if (rehearsal?.provider !== "local-docker") {
    refusals.push("REHEARSAL_TARGET_MISSING");
  }
  const mysqlEvidence = path.join(
    REPO_ROOT,
    "docs/verification/evidence/p08/P08-ENTRY.json"
  );
  if (!existsSync(mysqlEvidence)) {
    refusals.push("REHEARSAL_DB_EVIDENCE_MISSING: p08 fixture digest record");
  }

  const plan = {
    schema: "ci-verify/deploy-plan.v1",
    planned_at: new Date().toISOString(),
    verdict: infra.length ? "INFRA" : refusals.length ? "REFUSED" : "PLANNED",
    refusals,
    infra,
    bindings: {
      repository: contract.repository,
      protected_branch: contract.protected_branch,
      head_sha: id.head_sha,
      base_sha: id.base_sha,
      merge_tree_sha: id.merge_tree_sha,
      dirty_tracked: id.dirty_tracked,
      lockfile_sha256: sha256File(path.join(REPO_ROOT, "pnpm-lock.yaml")),
      dockerfile_sha256: sha256File(path.join(REPO_ROOT, "Dockerfile")),
      contract_sha256: contractSha,
      contract_version: contract.version,
      pr_certificate: prCert,
      required_contexts: prCert.present
        ? (JSON.parse(
            readFileSync(
              path.join(
                REPO_ROOT,
                ".ci-verify/certificate/LOCAL_READY_FOR_PR.json"
              ),
              "utf8"
            )
          ).bindings?.required_contexts ?? null)
        : null,
    },
    migration: {
      new_sql: newSql,
      receipt_present: receipt.length > 0,
      receipt_note: receipt
        ? "operator attests the run id targets this branch (contract known_limit)"
        : null,
    },
    targets: {
      production: {
        ...prod,
        execution_state: "REFUSED_WITHOUT_AUTHORIZATION_RECEIPT",
      },
      rehearsal,
    },
    docker_server_version: dockerProbe.stdout.trim() || null,
  };
  return plan;
}

function main() {
  if (!existsSync(CONTRACT_PATH)) {
    console.log("[deploy:plan] REFUSED: CONTRACT_MISSING");
    process.exitCode = 2;
    return;
  }
  const plan = buildPlan();
  writeJson(PLAN_PATH, plan);
  journal({ step: "plan", verdict: plan.verdict, refusals: plan.refusals });
  for (const r of [...plan.infra, ...plan.refusals])
    console.log(`[deploy:plan] REFUSED: ${r}`);
  console.log(
    `[deploy:plan] ${plan.verdict} head=${plan.bindings.head_sha.slice(0, 12)} base=${plan.bindings.base_sha.slice(0, 12)} -> ${PLAN_PATH}`
  );
  process.exitCode =
    plan.verdict === "PLANNED" ? 0 : plan.verdict === "REFUSED" ? 2 : 10;
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
) {
  try {
    main();
  } catch (error) {
    console.error(`[deploy:plan] ${error.message}`);
    process.exitCode = 2;
  }
}
