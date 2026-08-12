#!/usr/bin/env node
/**
 * p09/run-p09.mjs — HARDENING: the four operational blind spots P06-P08
 * could not see, in risk order. HARDENING results are NEVER merged into the
 * PARITY verdict (P09.AUD01): they carry class:"HARDENING" end to end.
 *
 *   T02 deploy-order      new drizzle/*.sql in the candidate diff demands a
 *                         db-push receipt BEFORE merge (DEC-002=BLOCKING —
 *                         the 2026-08-05 #370 auth outage class)
 *   T03 schema-type-drift drizzle-kit's own diff engine as the oracle: the
 *                         schema TS versus the migration snapshots must be a
 *                         NO-OP (the migration-0134 class — SchemaGuard
 *                         checks presence, not type; this checks both)
 *   T04 knip              dead exports/dependencies/files ratchet, pinned
 *                         via dlx, config-scoped
 *   T05 a11y              vendored axe-core 4.10.3 driven by Playwright
 *                         against the BUILT client, serious+critical must be
 *                         zero against the ratchet baseline
 *
 * Negatives run the p08 pattern: poison a DISPOSABLE COPY, never a fixture
 * file in a live format (the P05 placement law).
 *
 * Usage: node scripts/ci/p09/run-p09.mjs [all|deploy-order|drift|knip|a11y|negatives]
 */
import { execFileSync, spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { runSnapshot, disposeSnapshot } from "../snapshot.mjs";
import { provisionCandidate } from "../p06/capability.mjs";
import { buildGatePathEnv } from "../p06/run-gates.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..", "..");
const OUT = path.join(REPO_ROOT, ".ci-verify", "p09");
const KNIP_VERSION = "5.44.0";
const TS_VERSION = "5.9.3"; // repo devDependency pin
const AXE = path.join(HERE, "vendor", "axe.min.js");
const A11Y_PORT = 3913;

function git(args, cwd = REPO_ROOT) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

// ---------------------------------------------------------------------------
// T02 — deploy-order. BLOCKING (DEC-002): a candidate whose diff versus base
// introduces migration files fails until a db-push receipt is supplied.
// The receipt is CI_VERIFY_DBPUSH_RUN_ID (a db-push.yml run id recorded by
// the operator after running the manual workflow) — the gate stays local and
// deterministic; receipt verification against GitHub is the operator's
// documented step, mirrored in the failure message.
// ---------------------------------------------------------------------------
export function deployOrderGate({ worktree, baseSha }) {
  const diff = git(
    ["diff", "--name-status", `${baseSha}...HEAD`, "--", "drizzle"],
    worktree
  );
  const added = diff
    .split("\n")
    .filter(Boolean)
    .map(l => l.split("\t"))
    .filter(([status, file]) => status === "A" && /\.sql$/.test(file))
    .map(([, file]) => file);
  if (added.length === 0) {
    return { class: "HARDENING", gate: "deploy-order", verdict: "PASS", added };
  }
  const receipt = process.env.CI_VERIFY_DBPUSH_RUN_ID ?? null;
  if (receipt) {
    return {
      class: "HARDENING",
      gate: "deploy-order",
      verdict: "PASS",
      added,
      receipt,
      note: "migration present WITH a db-push receipt — verify the run id targets this branch before merge",
    };
  }
  return {
    class: "HARDENING",
    gate: "deploy-order",
    verdict: "FAIL",
    added,
    reason:
      `DEPLOY_ORDER: ${added.length} new migration file(s) in the candidate ` +
      `diff (${added.join(", ")}) with no db-push receipt. Law: schema ` +
      `changes ride the manual db-push.yml workflow BEFORE dependent code ` +
      `merges (the #370 outage class). Run db-push.yml on this branch, then ` +
      `re-run with CI_VERIFY_DBPUSH_RUN_ID=<run id>.`,
  };
}

// ---------------------------------------------------------------------------
// T03 — schema type drift. drizzle-kit generate against a SCRATCH out-dir:
// any emitted statement means schema.ts and the committed migration
// snapshots disagree — presence OR type (the 0134 class). The candidate is
// never mutated; drizzle/meta stays untouched.
// ---------------------------------------------------------------------------
export function schemaDriftGate({ worktree }) {
  const scratch = path.join(OUT, `drift-${Date.now().toString(36)}`);
  mkdirSync(scratch, { recursive: true });
  try {
    // copy meta snapshots so generate diffs against the candidate's own
    // recorded state, but emits into the scratch dir
    cpSync(path.join(worktree, "drizzle", "meta"), path.join(scratch, "meta"), {
      recursive: true,
    });
    const config = path.join(scratch, "drift.config.ts");
    const schemas = JSON.parse(
      JSON.stringify(
        readFileSync(path.join(worktree, "drizzle.config.ts"), "utf8")
          .match(/schema:\s*\[([^\]]*)\]/s)?.[1]
          .split(",")
          .map(s => s.trim().replace(/['"]/g, ""))
          .filter(Boolean) ?? []
      )
    );
    // drizzle-kit prefixes `./` onto the out path, so an ABSOLUTE out
    // resolves to .//abs/... and crashes with ENOENT (found by NEG02 when
    // the poisoned control returned a vacuous PASS). out must be RELATIVE
    // to the generate cwd (the worktree).
    const relOut = path.relative(worktree, scratch);
    writeFileSync(
      config,
      `import { defineConfig } from "drizzle-kit";\n` +
        `export default defineConfig({\n` +
        `  dialect: "mysql",\n` +
        `  schema: ${JSON.stringify(schemas.map(s => path.join(worktree, s)))},\n` +
        `  out: ${JSON.stringify(relOut)},\n` +
        `});\n`
    );
    const res = spawnSync(
      "pnpm",
      ["exec", "drizzle-kit", "generate", `--config=${config}`],
      {
        cwd: worktree,
        encoding: "utf8",
        timeout: 300_000,
        env: { ...process.env, PATH: buildGatePathEnv() },
      }
    );
    const emitted = existsSync(scratch)
      ? execFileSync("find", [scratch, "-maxdepth", "1", "-name", "*.sql"], {
          encoding: "utf8",
        })
          .trim()
          .split("\n")
          .filter(Boolean)
      : [];
    const out = `${res.stdout ?? ""}${res.stderr ?? ""}`;
    if (res.status !== 0 && !/No schema changes/i.test(out)) {
      return {
        class: "HARDENING",
        gate: "schema-type-drift",
        verdict: "INFRA_FAIL",
        reason: `drizzle-kit generate failed: ${out.slice(-300)}`,
      };
    }
    if (emitted.length > 0) {
      const statements = readFileSync(emitted[0], "utf8").slice(0, 800);
      return {
        class: "HARDENING",
        gate: "schema-type-drift",
        verdict: "FAIL",
        reason:
          `SCHEMA_TYPE_DRIFT: drizzle-kit generate is NOT a no-op — the ` +
          `schema TS disagrees with the committed migration snapshots ` +
          `(presence or TYPE). Emitted:\n${statements}`,
      };
    }
    if (res.status !== 0) {
      return {
        class: "HARDENING",
        gate: "schema-type-drift",
        verdict: "INFRA_FAIL",
        reason: `drizzle-kit exited ${res.status} with no emitted SQL: ${out.slice(-200)}`,
      };
    }
    return {
      class: "HARDENING",
      gate: "schema-type-drift",
      verdict: "PASS",
      tool_tail: out.slice(-200),
    };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// T04 — knip, pinned via dlx, scoped by the checked-in config. Ratchet: the
// config makes the CURRENT tree green; new dead code reds.
// ---------------------------------------------------------------------------
export function knipGate({ worktree }) {
  // knip resolves its config INSIDE the project it scans; candidates built
  // before this config was committed do not carry it, so materialize the
  // HOST copy into the worktree (identical path) when absent.
  const relConfig = "scripts/ci/p09/knip.json";
  if (!existsSync(path.join(worktree, relConfig))) {
    mkdirSync(path.dirname(path.join(worktree, relConfig)), {
      recursive: true,
    });
    cpSync(path.join(REPO_ROOT, relConfig), path.join(worktree, relConfig));
  }
  const res = spawnSync(
    "pnpm",
    [
      // both packages pinned: dlx otherwise resolves knip's typescript peer
      // to the LATEST major (TS 7 dropped ts.getDefaultLibFilePath and knip
      // crashes) — found on the first control run
      `--package=knip@${KNIP_VERSION}`,
      `--package=typescript@${TS_VERSION}`,
      "dlx",
      "knip",
      "--config",
      relConfig,
      "--no-config-hints",
      "--reporter",
      "compact",
    ],
    {
      cwd: worktree,
      encoding: "utf8",
      timeout: 600_000,
      env: {
        ...process.env,
        PATH: buildGatePathEnv(),
        // knip's drizzle plugin loads drizzle.config.ts, which throws
        // without DATABASE_URL; a syntactically-valid stub keeps the config
        // side-effect-free and the gate hermetic (no DB is ever contacted)
        DATABASE_URL:
          process.env.DATABASE_URL ??
          "mysql://stub:stub@127.0.0.1:3306/stub",
      },
      maxBuffer: 32 * 1024 * 1024,
    }
  );
  const out = `${res.stdout ?? ""}${res.stderr ?? ""}`;
  writeFileSync(path.join(OUT, "knip.txt"), out.slice(-100_000));
  return {
    class: "HARDENING",
    gate: "knip",
    verdict: res.status === 0 ? "PASS" : "FAIL",
    tail: out.slice(-500),
  };
}

// ---------------------------------------------------------------------------
// T05 — a11y over the BUILT client: serve dist/public statically, drive the
// public routes with Playwright, inject vendored axe-core, fail on any
// serious/critical violation.
// ---------------------------------------------------------------------------
const MIME = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".json": "application/json",
};

export async function a11yGate({ distDir, routes = ["/", "/login"] }) {
  if (!existsSync(path.join(distDir, "index.html"))) {
    return {
      class: "HARDENING",
      gate: "a11y",
      verdict: "INFRA_FAIL",
      reason: `BUILT_CLIENT_MISSING: ${distDir}/index.html`,
    };
  }
  const server = createServer((req, res) => {
    const url = (req.url ?? "/").split("?")[0];
    let file = path.join(distDir, url === "/" ? "index.html" : url);
    if (!existsSync(file)) file = path.join(distDir, "index.html"); // SPA
    res.setHeader(
      "content-type",
      MIME[path.extname(file)] ?? "application/octet-stream"
    );
    res.end(readFileSync(file));
  });
  await new Promise(r => server.listen(A11Y_PORT, "127.0.0.1", r));
  try {
    const { chromium } = await import("playwright");
    const browser = await chromium.launch();
    const axeSource = readFileSync(AXE, "utf8");
    const violations = [];
    for (const route of routes) {
      const page = await browser.newPage();
      await page.goto(`http://127.0.0.1:${A11Y_PORT}${route}`, {
        waitUntil: "networkidle",
        timeout: 60_000,
      });
      await page.evaluate(axeSource);
      const result = await page.evaluate(async () => {
        // eslint-disable-next-line no-undef
        return await axe.run(document, {
          resultTypes: ["violations"],
          runOnly: { type: "tag", values: ["wcag2a", "wcag2aa"] },
        });
      });
      for (const v of result.violations) {
        if (v.impact === "serious" || v.impact === "critical") {
          violations.push({
            route,
            id: v.id,
            impact: v.impact,
            nodes: v.nodes.length,
            targets: v.nodes.slice(0, 3).map(n => n.target.join(" ")),
            help: v.help,
          });
        }
      }
      await page.close();
    }
    await browser.close();
    // Documented ratchet: violations listed in the checked-in baseline are
    // recorded (never hidden) but do not red the gate; anything NEW reds.
    const baselinePath = path.join(HERE, "a11y-baseline.json");
    const baseline = existsSync(baselinePath)
      ? JSON.parse(readFileSync(baselinePath, "utf8"))
      : [];
    const isBaselined = v =>
      baseline.some(
        b =>
          b.route === v.route &&
          b.id === v.id &&
          v.targets.every(t => b.targets.includes(t))
      );
    const fresh = violations.filter(v => !isBaselined(v));
    const baselined = violations.filter(isBaselined);
    writeFileSync(
      path.join(OUT, "a11y.json"),
      JSON.stringify({ fresh, baselined }, null, 2) + "\n"
    );
    return {
      class: "HARDENING",
      gate: "a11y",
      verdict: fresh.length === 0 ? "PASS" : "FAIL",
      violations: fresh,
      baselined: baselined.length,
    };
  } finally {
    server.close();
  }
}

// ---------------------------------------------------------------------------
// Negatives — poison DISPOSABLE COPIES only (placement law).
// ---------------------------------------------------------------------------
export function neg01SyntheticMigration(worktree, baseSha) {
  // The worktree is a DISPOSABLE detached candidate — committing the poison
  // there is contained by construction and disposed with the snapshot.
  writeFileSync(
    path.join(worktree, "drizzle", "9999_p09_neg01_synthetic.sql"),
    "-- p09 NEG01 synthetic migration (disposable candidate only)\nSELECT 1;\n"
  );
  git(["add", "drizzle/9999_p09_neg01_synthetic.sql"], worktree);
  git(
    [
      "-c", "user.email=ci-verify@local",
      "-c", "user.name=ci-verify",
      "commit", "-qm", "p09 NEG01 synthetic migration (disposable)",
    ],
    worktree
  );
  const res = deployOrderGate({ worktree, baseSha });
  return { ok: res.verdict === "FAIL", res };
}

export function neg03DeadExport(worktree) {
  // a brand-new unreferenced file inside the scanned scope is exactly the
  // dead-code class the gate exists to catch
  const dead = path.join(worktree, "scripts/ci/p09-neg03-dead.ts");
  writeFileSync(
    dead,
    "export const p09Neg03DeadExport = 41; // disposable-candidate poison\n"
  );
  try {
    const res = knipGate({ worktree });
    return { ok: res.verdict === "FAIL", res: { verdict: res.verdict } };
  } finally {
    rmSync(dead, { force: true });
  }
}

export async function neg04A11yPoison(worktree) {
  const dist = path.join(worktree, "dist", "public");
  const index = path.join(dist, "index.html");
  if (!existsSync(index)) {
    return { ok: false, res: { reason: "BUILT_CLIENT_MISSING_FOR_NEG04" } };
  }
  const original = readFileSync(index, "utf8");
  writeFileSync(
    index,
    original.replace(
      "</body>",
      '<p style="color:#8a8a8a;background:#9a9a9a;font-size:14px">p09 neg04 low-contrast poison</p></body>'
    )
  );
  try {
    const res = await a11yGate({ distDir: dist, routes: ["/"] });
    return {
      ok:
        res.verdict === "FAIL" &&
        res.violations?.some(v => v.id === "color-contrast"),
      res: { verdict: res.verdict, count: res.violations?.length },
    };
  } finally {
    writeFileSync(index, original);
  }
}

export function neg02TypeMismatch(worktree) {
  const schemaPath = path.join(worktree, "drizzle", "schema.ts");
  const original = readFileSync(schemaPath, "utf8");
  // widen one known varchar length — a pure TYPE change, no column add/drop
  const poisoned = original.replace(
    /varchar\("([a-zA-Z_]+)",\s*\{\s*length:\s*(\d+)\s*\}\)/,
    (m, name, len) => `varchar("${name}", { length: ${Number(len) + 7} })`
  );
  if (poisoned === original) {
    return { ok: false, res: { reason: "NO_VARCHAR_TO_POISON" } };
  }
  writeFileSync(schemaPath, poisoned);
  try {
    const res = schemaDriftGate({ worktree });
    return { ok: res.verdict === "FAIL", res };
  } finally {
    writeFileSync(schemaPath, original);
  }
}

async function main() {
  const mode = process.argv[2] ?? "all";
  mkdirSync(OUT, { recursive: true });
  const handle = runSnapshot({ mode: "committed", keepRunDir: true });
  const worktree = handle.paths.worktree;
  const identity = handle.snapshot.identity;
  const results = { identity, gates: {} };
  try {
    console.log(
      `[p09] candidate ${identity.merge_commit_sha.slice(0, 12)} on base ${identity.base_sha.slice(0, 12)}`
    );
    const prov = provisionCandidate(worktree);
    if (!prov.ok) throw new Error("PROVISIONING_FAILED");
    console.log(`[p09] provisioned in ${prov.duration_ms}ms`);

    if (mode === "all" || mode === "deploy-order") {
      results.gates.deploy_order = deployOrderGate({
        worktree,
        baseSha: identity.base_sha,
      });
      console.log(
        `[p09] T02 deploy-order: ${results.gates.deploy_order.verdict}`
      );
    }
    if (mode === "all" || mode === "drift") {
      results.gates.schema_drift = schemaDriftGate({ worktree });
      console.log(
        `[p09] T03 schema-type-drift: ${results.gates.schema_drift.verdict} ${results.gates.schema_drift.reason?.slice(0, 200) ?? ""}`
      );
    }
    if (mode === "all" || mode === "knip") {
      results.gates.knip = knipGate({ worktree });
      console.log(`[p09] T04 knip: ${results.gates.knip.verdict}`);
    }
    if (mode === "all" || mode === "a11y") {
      // build the client in the candidate (vite build) if dist is absent
      const dist = path.join(worktree, "dist", "public");
      if (!existsSync(path.join(dist, "index.html"))) {
        console.log(`[p09] building client for a11y…`);
        const build = spawnSync("pnpm", ["run", "build:client"], {
          cwd: worktree,
          encoding: "utf8",
          timeout: 900_000,
          env: { ...process.env, PATH: buildGatePathEnv() },
          maxBuffer: 64 * 1024 * 1024,
        });
        if (build.status !== 0) {
          throw new Error(
            `CLIENT_BUILD_FAILED: ${`${build.stdout}${build.stderr}`.slice(-300)}`
          );
        }
      }
      results.gates.a11y = await a11yGate({ distDir: dist });
      console.log(
        `[p09] T05 a11y: ${results.gates.a11y.verdict} (${results.gates.a11y.violations?.length ?? "-"} serious/critical)`
      );
    }
    if (mode === "all" || mode === "negatives") {
      results.gates.neg01 = neg01SyntheticMigration(worktree, identity.base_sha);
      console.log(`[p09] NEG01 synthetic migration reddens: ${results.gates.neg01.ok}`);
      results.gates.neg02 = neg02TypeMismatch(worktree);
      console.log(`[p09] NEG02 type mismatch reddens: ${results.gates.neg02.ok}`);
      results.gates.neg03 = neg03DeadExport(worktree);
      console.log(`[p09] NEG03 dead export reddens: ${results.gates.neg03.ok}`);
      if (!existsSync(path.join(worktree, "dist/public/index.html"))) {
        console.log(`[p09] building client for NEG04…`);
        spawnSync("pnpm", ["run", "build:client"], {
          cwd: worktree,
          encoding: "utf8",
          timeout: 900_000,
          env: { ...process.env, PATH: buildGatePathEnv() },
          maxBuffer: 64 * 1024 * 1024,
        });
      }
      results.gates.neg04 = await neg04A11yPoison(worktree);
      console.log(`[p09] NEG04 a11y poison reddens: ${results.gates.neg04.ok}`);
    }
  } finally {
    disposeSnapshot(handle);
    writeFileSync(
      path.join(OUT, "p09-results.json"),
      JSON.stringify(results, null, 2) + "\n"
    );
  }
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
) {
  main().catch(error => {
    console.error(`[p09] STOP: ${error.message}`);
    process.exitCode = 1;
  });
}
