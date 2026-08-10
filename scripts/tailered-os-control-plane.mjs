// Loader + invariant validator for config/tailered-os-control-plane.v1.json —
// the machine-readable authority map for the Tailered OS organizational control
// plane (Notion surfaces, GitHub boundary, safety posture). Follows the
// dime-agent-access.mjs pattern: the .schema.json sibling is documentation; this
// file is the enforcement. Fail loudly rather than silently using a stale map.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const CONTROL_PLANE_MANIFEST_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "config",
  "tailered-os-control-plane.v1.json"
);

// Owner-verified canonical identifiers (2026-08-10). Changing any of these is a
// deliberate control-plane migration, not a routine edit.
export const CANONICAL = Object.freeze({
  workspaceRootPage: "3b49673313e781569b59ff6f9ea0e4f1",
  taileredOsProject: "3b89673313e7814da8a4ccfa9a21c969",
  commandCenter: "3b89673313e78114b9afd915c61d78a5",
  communicationStandard: "3b89673313e78126896ae70b5f756795",
  executionContract: "3b89673313e78145bcb8fc9552bd727e",
  tasks: "96228d0d4aca436e8527053a27f7472c",
  projects: "888202aaf938497a91075121646e4cb4",
  aiSystemsRegistry: "8673b8ac6f424acebc53b6cbf0698251",
});

const NOTION_ID = /^[0-9a-f]{32}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
// Cheap tripwire against credential-shaped values ever landing in the manifest.
const SECRETISH =
  /(sk_live_|sk-ant-|ghp_[A-Za-z0-9]|github_pat_|xox[bp]-|AKIA[0-9A-Z]{16}|-----BEGIN)/;

function invariant(condition, message) {
  if (!condition) throw new Error(`tailered-os-control-plane: ${message}`);
}

function validateNode(node, label) {
  invariant(node && typeof node === "object", `${label} missing`);
  invariant(
    typeof node.name === "string" && node.name.length > 0,
    `${label}.name must be a non-empty string`
  );
  invariant(
    NOTION_ID.test(node.id ?? ""),
    `${label}.id must be a 32-hex Notion id`
  );
  invariant(
    typeof node.verified === "boolean",
    `${label}.verified must be a boolean`
  );
  if (node.verified) {
    invariant(
      ISO_DATE.test(node.verifiedOn ?? ""),
      `${label} is verified but verifiedOn is not an ISO date`
    );
  }
  invariant(
    typeof node.source === "string" && node.source.length > 0,
    `${label}.source must state where the identifier came from`
  );
}

export function validateControlPlaneManifest(manifest) {
  invariant(
    manifest && typeof manifest === "object",
    "manifest must be an object"
  );
  invariant(
    manifest.$schema === "./tailered-os-control-plane.schema.json",
    "$schema must point at the sibling schema"
  );
  invariant(manifest.schemaVersion === 1, "schemaVersion must be 1");
  invariant(
    manifest.kind === "tailered-os-control-plane",
    "kind must be tailered-os-control-plane"
  );

  const boundaries = manifest.authorityBoundaries;
  for (const key of [
    "notion",
    "github",
    "railway",
    "stripe",
    "credentialBrokers",
  ]) {
    invariant(
      typeof boundaries?.[key] === "string" && boundaries[key].length > 0,
      `authorityBoundaries.${key} must be a non-empty string`
    );
  }

  const notion = manifest.notion;
  invariant(
    notion?.pageUrlTemplate === "https://app.notion.com/p/{id}",
    "notion.pageUrlTemplate drifted"
  );

  const surfaces = {
    workspaceRootPage: notion?.workspaceRootPage,
    taileredOsProject: notion?.taileredOsProject,
    commandCenter: notion?.commandCenter,
    communicationStandard: notion?.communicationStandard,
    executionContract: notion?.executionContract,
    tasks: notion?.databases?.tasks,
    projects: notion?.databases?.projects,
    aiSystemsRegistry: notion?.databases?.aiSystemsRegistry,
  };
  for (const [key, node] of Object.entries(surfaces)) {
    validateNode(node, `notion.${key}`);
    invariant(
      node.id === CANONICAL[key],
      `notion.${key}.id (${node?.id}) does not match the owner-verified canonical id — control-plane drift`
    );
    invariant(
      node.verified === true,
      `notion.${key} must be verified:true (owner-canonical surface)`
    );
  }
  invariant(
    notion.workspaceRootPage.name === "Tailered Team Home",
    "workspaceRootPage.name must be 'Tailered Team Home' (stale 'Dime AI — Operations HQ' naming is a drift signal)"
  );

  for (const key of ["decisions", "risks", "releases", "knowledge"]) {
    validateNode(notion?.databases?.[key], `notion.databases.${key}`);
  }

  const ids = [
    ...Object.values(surfaces).map(node => node.id),
    ...["decisions", "risks", "releases", "knowledge"].map(
      key => notion.databases[key].id
    ),
  ];
  invariant(
    new Set(ids).size === ids.length,
    "notion ids must be unique — a duplicate means a mis-pasted identifier"
  );

  invariant(
    manifest.github?.repository === "tailered-ai/dime-ai",
    "github.repository drifted from tailered-ai/dime-ai"
  );
  invariant(
    manifest.github?.taileredOsBoundary === "platform/tailered-os/",
    "github.taileredOsBoundary drifted"
  );
  invariant(
    manifest.github?.foundationPullRequest === 496,
    "github.foundationPullRequest drifted"
  );

  const safety = manifest.safety;
  invariant(
    safety?.notionWriteOperationsAuthorized === false,
    "safety.notionWriteOperationsAuthorized must be false"
  );
  invariant(
    safety?.secretMaterialAllowed === false,
    "safety.secretMaterialAllowed must be false"
  );
  invariant(
    safety?.manualGithubMirroringAllowed === false,
    "safety.manualGithubMirroringAllowed must be false"
  );

  invariant(
    !SECRETISH.test(JSON.stringify(manifest)),
    "manifest contains a credential-shaped value"
  );
  return manifest;
}

export function loadControlPlaneManifest(path = CONTROL_PLANE_MANIFEST_PATH) {
  return validateControlPlaneManifest(JSON.parse(readFileSync(path, "utf8")));
}
