#!/usr/bin/env node
/**
 * p06/tools.mjs — governed tool identity + bootstrap (P06.T01 tool law).
 *
 * Every external scanner/tool a P06 gate depends on resolves to an EXACT
 * identity derived from the repository's own CI configuration — never
 * "latest", never a silently-substituted developer-global copy.
 *
 * Derivation chains (each recorded in the identity object):
 *   semgrep       03-semgrep.yml          env SEMGREP_VERSION
 *   zizmor        05-workflow-security.yml env ZIZMOR_VERSION
 *   osv-scanner   ci.yml#security-audit   release URL in the provisioning step   (v2.4.0)
 *   osv-scanner   12-nightly #full-osv    release URL in the provisioning step   (v2.2.4)
 *   gitleaks      gitleaks.yml → gitleaks-action@e0c47f4f dist: GITLEAKS_VERSION || "8.24.3"
 *   trivy         09/12 workflows → trivy-action@ed142fd  input default: v0.70.0
 *   syft          09-artifact → sbom-action@e22c389       dist const VERSION7 = v1.42.3
 *
 * Resolution policy, in order:
 *   1. An existing verifier-owned install under .ci-verify/tools/ whose
 *      recorded provenance still hash-verifies → reuse.
 *   2. A host binary whose --version output matches the derived version
 *      EXACTLY → recognized explicitly (path + version output + binary
 *      sha256 recorded). This is not silent substitution: the recognition
 *      is an identity-verified decision in the evidence.
 *   3. Download the exact release asset for darwin/arm64, verify against
 *      the release's published checksums file where the project ships one
 *      (gitleaks, trivy, syft do; osv-scanner does not — first-fetch
 *      measured sha256 recorded as provenance with that caveat), verify
 *      --version output, install into verifier-owned storage.
 *   4. Anything else → the tool is UNRESOLVED and every gate needing it is
 *      BLOCKED. Never guess, never fall back to latest.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, "..", "..", "..");
export const TOOLS_ROOT = path.join(REPO_ROOT, ".ci-verify", "tools");
const sha256 = buf => createHash("sha256").update(buf).digest("hex");

// Byte-regex read of workflow sources — declared in P02's YAML_ALLOWLIST.
// This module never parses YAML; it extracts exactly the identity pins the
// frozen contract does not carry (workflow-level env versions, setup-node
// pin) plus pins the contract DOES carry (release URLs, action SHAs), kept
// in one place so the isolation boundary stays a single declared file.
const wf = name =>
  readFileSync(path.join(REPO_ROOT, ".github/workflows", name), "utf8");

/** Contract runtime pins (node major from setup-node, pnpm from packageManager). */
export function contractRuntimePins() {
  const ci = wf("ci.yml");
  const pkg = JSON.parse(
    readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")
  );
  const nodeMajor = ci.match(/node-version:\s*"?(\d+)"?/)?.[1] ?? null;
  const pnpmPin = (pkg.packageManager ?? "").replace(/^pnpm@/, "") || null;
  return { node_major: nodeMajor, pnpm: pnpmPin };
}

/**
 * Derive the full governed-tool identity set from current CI configuration.
 * Action-derived pins carry their derivation chain: the workflow pins the
 * action SHA; the action source (fetched once, sha256-recorded in evidence)
 * pins the tool version.
 */
export function deriveToolIdentities() {
  const semgrep = wf("03-semgrep.yml").match(
    /SEMGREP_VERSION:\s*"([^"]+)"/
  )?.[1];
  const zizmor = wf("05-workflow-security.yml").match(
    /ZIZMOR_VERSION:\s*"([^"]+)"/
  )?.[1];
  const osvSecurityAudit = wf("ci.yml").match(
    /osv-scanner\/releases\/download\/v([\d.]+)\/osv-scanner_linux_amd64/
  )?.[1];
  const osvFull = wf("12-nightly-verification.yml").match(
    /osv-scanner\/releases\/download\/v([\d.]+)\/osv-scanner_linux_amd64/
  )?.[1];
  const gitleaksActionSha = wf("gitleaks.yml").match(
    /gitleaks\/gitleaks-action@([0-9a-f]{40})/
  )?.[1];
  const trivyActionSha = wf("09-artifact-build-and-smoke.yml").match(
    /aquasecurity\/trivy-action@([0-9a-f]{40})/
  )?.[1];
  const sbomActionSha = wf("09-artifact-build-and-smoke.yml").match(
    /anchore\/sbom-action@([0-9a-f]{40})/
  )?.[1];

  for (const [name, value] of Object.entries({
    semgrep,
    zizmor,
    osvSecurityAudit,
    osvFull,
    gitleaksActionSha,
    trivyActionSha,
    sbomActionSha,
  })) {
    if (!value) throw new Error(`TOOL_IDENTITY_UNDERIVABLE: ${name}`);
  }

  // Action-internal pins. Measured from the pinned action sources
  // (docs/verification/evidence/p06/action-sources/); a change in the
  // action SHA above invalidates these and MUST re-derive.
  const ACTION_INTERNAL_PINS = {
    e0c47f4f8be36e29cdc102c57e68cb5cbf0e8d1e: { gitleaks: "8.24.3" },
    ed142fd0673e97e23eac54620cfb913e5ce36c25: { trivy: "0.70.0" },
    e22c389904149dbc22b58101806040fa8d37a610: { syft: "1.42.3" },
  };
  const gitleaksVersion =
    ACTION_INTERNAL_PINS[gitleaksActionSha]?.gitleaks ?? null;
  const trivyVersion = ACTION_INTERNAL_PINS[trivyActionSha]?.trivy ?? null;
  const syftVersion = ACTION_INTERNAL_PINS[sbomActionSha]?.syft ?? null;
  for (const [name, value] of Object.entries({
    gitleaksVersion,
    trivyVersion,
    syftVersion,
  })) {
    if (!value)
      throw new Error(
        `ACTION_PIN_MOVED: ${name} — the workflow now pins an action SHA ` +
          `whose internal tool version has not been re-derived; refresh ` +
          `ACTION_INTERNAL_PINS from the new action source before running`
      );
  }

  return [
    {
      id: "semgrep",
      version: semgrep,
      version_cmd: ["semgrep", "--version"],
      version_expect: semgrep,
      derived_from: "03-semgrep.yml env SEMGREP_VERSION",
    },
    {
      id: "zizmor",
      version: zizmor,
      version_cmd: ["zizmor", "--version"],
      version_expect: `zizmor ${zizmor}`,
      derived_from: "05-workflow-security.yml env ZIZMOR_VERSION",
    },
    {
      id: "osv-scanner@security-audit",
      binary: "osv-scanner",
      version: osvSecurityAudit,
      version_cmd: ["osv-scanner", "--version"],
      version_expect_re: `osv-scanner version:\\s*${osvSecurityAudit.replaceAll(".", "\\.")}`,
      derived_from: "ci.yml#security-audit provisioning-step release URL",
      download: {
        url: `https://github.com/google/osv-scanner/releases/download/v${osvSecurityAudit}/osv-scanner_darwin_arm64`,
        kind: "binary",
        checksums_url: null,
      },
    },
    {
      id: "osv-scanner@full-osv",
      binary: "osv-scanner",
      version: osvFull,
      version_cmd: ["osv-scanner", "--version"],
      version_expect_re: `osv-scanner version:\\s*${osvFull.replaceAll(".", "\\.")}`,
      derived_from:
        "12-nightly-verification.yml#full-osv provisioning-step release URL",
      download: {
        url: `https://github.com/google/osv-scanner/releases/download/v${osvFull}/osv-scanner_darwin_arm64`,
        kind: "binary",
        checksums_url: null,
      },
    },
    {
      id: "gitleaks",
      version: gitleaksVersion,
      version_cmd: ["gitleaks", "version"],
      version_expect: gitleaksVersion,
      derived_from: `gitleaks.yml → gitleaks-action@${gitleaksActionSha} dist (GITLEAKS_VERSION || "8.24.3")`,
      download: {
        url: `https://github.com/gitleaks/gitleaks/releases/download/v${gitleaksVersion}/gitleaks_${gitleaksVersion}_darwin_arm64.tar.gz`,
        kind: "tar.gz",
        member: "gitleaks",
        checksums_url: `https://github.com/gitleaks/gitleaks/releases/download/v${gitleaksVersion}/gitleaks_${gitleaksVersion}_checksums.txt`,
        checksums_key: `gitleaks_${gitleaksVersion}_darwin_arm64.tar.gz`,
      },
    },
    {
      id: "trivy",
      version: trivyVersion,
      version_cmd: ["trivy", "--version"],
      version_expect_re: `Version:\\s*${trivyVersion.replaceAll(".", "\\.")}`,
      derived_from: `09/12 workflows → trivy-action@${trivyActionSha} input default v${trivyVersion}`,
      download: {
        url: `https://github.com/aquasecurity/trivy/releases/download/v${trivyVersion}/trivy_${trivyVersion}_macOS-ARM64.tar.gz`,
        kind: "tar.gz",
        member: "trivy",
        checksums_url: `https://github.com/aquasecurity/trivy/releases/download/v${trivyVersion}/trivy_${trivyVersion}_checksums.txt`,
        checksums_key: `trivy_${trivyVersion}_macOS-ARM64.tar.gz`,
      },
    },
    {
      id: "syft",
      version: syftVersion,
      version_cmd: ["syft", "--version"],
      version_expect_re: `syft\\s+${syftVersion.replaceAll(".", "\\.")}`,
      derived_from: `09-artifact → sbom-action@${sbomActionSha} dist VERSION7 v${syftVersion}`,
      download: {
        url: `https://github.com/anchore/syft/releases/download/v${syftVersion}/syft_${syftVersion}_darwin_arm64.tar.gz`,
        kind: "tar.gz",
        member: "syft",
        checksums_url: `https://github.com/anchore/syft/releases/download/v${syftVersion}/syft_${syftVersion}_checksums.txt`,
        checksums_key: `syft_${syftVersion}_darwin_arm64.tar.gz`,
      },
    },
  ];
}

function measureVersion(cmd, cwdPath) {
  try {
    const out = execFileSync(cmd[0], cmd.slice(1), {
      encoding: "utf8",
      timeout: 30_000,
      env: cwdPath
        ? { ...process.env, PATH: `${cwdPath}:${process.env.PATH}` }
        : process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return out.trim();
  } catch (error) {
    if (error.stdout || error.stderr)
      return `${error.stdout ?? ""}${error.stderr ?? ""}`.trim();
    return null;
  }
}

function versionMatches(tool, output) {
  if (output == null) return false;
  if (tool.version_expect_re)
    return new RegExp(tool.version_expect_re).test(output);
  return output.includes(tool.version_expect);
}

function hostBinaryPath(binary) {
  try {
    return execFileSync("command", ["-v", binary], {
      shell: "/bin/bash",
      encoding: "utf8",
    }).trim();
  } catch {
    return null;
  }
}

function curl(url, outPath) {
  execFileSync(
    "curl",
    [
      "--fail",
      "--silent",
      "--show-error",
      "--location",
      "--proto",
      "=https",
      "--tlsv1.2",
      "--output",
      outPath,
      url,
    ],
    { timeout: 300_000 }
  );
}

function download(tool) {
  const binary = tool.binary ?? tool.id;
  const dir = path.join(
    TOOLS_ROOT,
    tool.id.replace(/[^A-Za-z0-9._@-]/g, "_"),
    tool.version,
    "bin"
  );
  const binPath = path.join(dir, binary);
  const provPath = path.join(path.dirname(dir), "provenance.json");
  if (existsSync(binPath) && existsSync(provPath)) {
    const prov = JSON.parse(readFileSync(provPath, "utf8"));
    if (sha256(readFileSync(binPath)) === prov.binary_sha256) {
      const out = measureVersion([binPath, ...tool.version_cmd.slice(1)]);
      if (versionMatches(tool, out))
        return { dir, binPath, provenance: prov, reused: true };
    }
    rmSync(path.dirname(dir), { recursive: true, force: true });
  }
  mkdirSync(dir, { recursive: true });
  const staging = path.join(dir, `.staging-${process.pid}`);
  mkdirSync(staging, { recursive: true });
  try {
    const assetName = tool.download.url.split("/").at(-1);
    const assetPath = path.join(staging, assetName);
    curl(tool.download.url, assetPath);
    const assetSha = sha256(readFileSync(assetPath));

    let checksumVerified = false;
    let checksumsSource = null;
    if (tool.download.checksums_url) {
      const checksumsPath = path.join(staging, "checksums.txt");
      curl(tool.download.checksums_url, checksumsPath);
      const line = readFileSync(checksumsPath, "utf8")
        .split("\n")
        .find(l => l.includes(tool.download.checksums_key));
      if (!line)
        throw new Error(
          `CHECKSUM_ENTRY_MISSING: ${tool.download.checksums_key}`
        );
      const expected = line.trim().split(/\s+/)[0];
      if (expected !== assetSha)
        throw new Error(
          `CHECKSUM_MISMATCH: ${tool.id} expected ${expected} got ${assetSha}`
        );
      checksumVerified = true;
      checksumsSource = tool.download.checksums_url;
    }

    let extractedPath;
    if (tool.download.kind === "tar.gz") {
      execFileSync(
        "tar",
        ["-xzf", assetPath, "-C", staging, tool.download.member],
        {
          timeout: 120_000,
        }
      );
      extractedPath = path.join(staging, tool.download.member);
    } else {
      extractedPath = assetPath;
    }
    chmodSync(extractedPath, 0o755);
    const binSha = sha256(readFileSync(extractedPath));
    const versionOut = measureVersion([
      extractedPath,
      ...tool.version_cmd.slice(1),
    ]);
    if (!versionMatches(tool, versionOut))
      throw new Error(
        `VERSION_MISMATCH_AFTER_DOWNLOAD: ${tool.id} → ${JSON.stringify(versionOut?.slice(0, 120))}`
      );
    renameSync(extractedPath, binPath);
    const provenance = {
      tool: tool.id,
      version: tool.version,
      derived_from: tool.derived_from,
      source_url: tool.download.url,
      asset_sha256: assetSha,
      binary_sha256: binSha,
      checksum_verified_against_release: checksumVerified,
      checksums_source: checksumsSource,
      checksum_caveat: checksumVerified
        ? null
        : "project publishes no checksums file; first-fetch measured sha256 recorded (TOFU)",
      version_output: versionOut.slice(0, 200),
      fetched_at: new Date().toISOString(),
      platform: `${process.platform}/${process.arch}`,
    };
    writeFileSync(provPath, JSON.stringify(provenance, null, 2) + "\n");
    return { dir, binPath, provenance, reused: false };
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

/**
 * Resolve every governed tool. Returns { resolved: {id → resolution},
 * unresolved: [{id, reason}] }. A resolution carries `path_dir` when the
 * governed copy must shadow the host PATH (downloads), or null when the
 * host binary itself is the identity-verified copy.
 */
export function bootstrapTools(options = {}) {
  const identities = deriveToolIdentities();
  const wanted = options.only
    ? identities.filter(t => options.only.includes(t.id))
    : identities;
  const resolved = {};
  const unresolved = [];
  for (const tool of wanted) {
    const binary = tool.binary ?? tool.id;
    // 1./3. verifier-owned (existing or downloaded)
    if (tool.download) {
      // Prefer an exact host match ONLY if it is version-exact; otherwise
      // the governed download shadows it.
      const hostPath = hostBinaryPath(binary);
      const hostOut = hostPath ? measureVersion(tool.version_cmd) : null;
      if (hostPath && versionMatches(tool, hostOut)) {
        resolved[tool.id] = {
          mode: "host-recognized",
          binary,
          path: hostPath,
          path_dir: null,
          version_output: hostOut.slice(0, 200),
          binary_sha256: sha256(readFileSync(hostPath)),
          derived_from: tool.derived_from,
          version: tool.version,
        };
        continue;
      }
      try {
        const got = download(tool);
        resolved[tool.id] = {
          mode: got.reused ? "owned-reused" : "owned-downloaded",
          binary,
          path: got.binPath,
          path_dir: got.dir,
          version: tool.version,
          derived_from: tool.derived_from,
          provenance: got.provenance,
          host_shadowed: hostPath
            ? { path: hostPath, version_output: (hostOut ?? "").slice(0, 120) }
            : null,
        };
      } catch (error) {
        unresolved.push({
          id: tool.id,
          reason: `PROVISIONING_DOWNLOAD_FAILED: ${String(error.message).slice(0, 200)}`,
        });
      }
      continue;
    }
    // 2. host recognition for pipx-style pins
    const hostPath = hostBinaryPath(binary);
    const out = hostPath ? measureVersion(tool.version_cmd) : null;
    if (hostPath && versionMatches(tool, out)) {
      resolved[tool.id] = {
        mode: "host-recognized",
        binary,
        path: hostPath,
        path_dir: null,
        version_output: out.slice(0, 200),
        binary_sha256: sha256(readFileSync(hostPath)),
        derived_from: tool.derived_from,
        version: tool.version,
      };
    } else {
      unresolved.push({
        id: tool.id,
        reason: hostPath
          ? `VERSION_MISMATCH: want ${tool.version}, measured ${JSON.stringify((out ?? "").slice(0, 80))}`
          : `TOOL_ABSENT: ${binary} not on PATH and no governed download path defined`,
      });
    }
  }
  return { identities, resolved, unresolved };
}

async function main() {
  const outcome = bootstrapTools();
  for (const [id, r] of Object.entries(outcome.resolved)) {
    console.log(
      `[tools] ${id.padEnd(28)} ${r.mode.padEnd(17)} v${r.version}  ${r.path}`
    );
  }
  for (const u of outcome.unresolved) {
    console.log(`[tools] ${u.id.padEnd(28)} UNRESOLVED        ${u.reason}`);
  }
  if (outcome.unresolved.length) process.exitCode = 1;
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
) {
  main().catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}
