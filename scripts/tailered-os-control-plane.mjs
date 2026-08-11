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
  decisions: "46ec53110ccc496296a7438203324d21",
  risks: "a4a37320164d408c8f0df5dfe7cb2ba1",
  releases: "f86c2987ec7e43dfa71b2dce14664467",
  knowledge: "694ec08d2e544cc797157a24824bbd1d",
});

// Data-source ids of the four databases above (connector-verified 2026-08-10).
// A database's page id and data-source id are different identifiers for the
// same object; query tools need the data-source id. Pinned so a manifest edit
// cannot silently repoint the prose either.
export const CANONICAL_DATA_SOURCES = Object.freeze({
  decisions: "e987f7e3-59bd-4c36-9a1d-253c6840b4d9",
  risks: "e6538397-ee1b-407e-bd7e-5a9e80d9b529",
  releases: "1eebcf06-a0c3-4aba-9bb8-d550ad37961d",
  knowledge: "456f7bbc-8f8a-4648-95ca-b561ac68bd11",
});

const NOTION_ID = /^[0-9a-f]{32}$/;
// Calendar-shaped, not just digit-shaped: 9999-99-99 must not pass.
const ISO_DATE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
// Cheap tripwire against credential-shaped values ever landing in the manifest.
// Includes passworded connection URIs — the class .gitleaks.toml documents the
// default rules missing — plus test/restricted key prefixes and JWT shape.
export const SECRETISH =
  /(sk_live_|sk_test_|rk_live_|sk-ant-|ghp_[A-Za-z0-9]|github_pat_|xox[bpc]-|xapp-|AKIA[0-9A-Z]{16}|eyJ[A-Za-z0-9_-]{10,}|-----BEGIN|[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^@\s/]+@)/;

function invariant(condition, message) {
  if (!condition) throw new Error(`tailered-os-control-plane: ${message}`);
}

// The schema's additionalProperties:false, enforced for real: an agent reading a
// key the validator does not pin must never receive it with a "validated" stamp.
function assertOnlyKeys(obj, allowed, label) {
  const unknown = Object.keys(obj).filter(key => !allowed.includes(key));
  invariant(
    unknown.length === 0,
    `${label} has unknown key(s): ${unknown.join(", ")}`
  );
}

function validateNode(node, label) {
  invariant(node && typeof node === "object", `${label} missing`);
  assertOnlyKeys(
    node,
    ["name", "id", "verified", "verifiedOn", "source"],
    label
  );
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
  if (node.verifiedOn !== undefined) {
    invariant(
      ISO_DATE.test(node.verifiedOn),
      `${label}.verifiedOn is not a calendar date`
    );
  }
  if (node.verified) {
    invariant(
      node.verifiedOn !== undefined,
      `${label} is verified but carries no verifiedOn date`
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
  assertOnlyKeys(
    manifest,
    [
      "$schema",
      "schemaVersion",
      "kind",
      "authorityBoundaries",
      "notion",
      "github",
      "safety",
    ],
    "manifest"
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
  const boundaryKeys = [
    "notion",
    "github",
    "railway",
    "stripe",
    "credentialBrokers",
  ];
  invariant(
    boundaries && typeof boundaries === "object",
    "authorityBoundaries missing"
  );
  assertOnlyKeys(boundaries, boundaryKeys, "authorityBoundaries");
  for (const key of boundaryKeys) {
    invariant(
      typeof boundaries[key] === "string" && boundaries[key].length > 0,
      `authorityBoundaries.${key} must be a non-empty string`
    );
  }

  const notion = manifest.notion;
  invariant(notion && typeof notion === "object", "notion missing");
  assertOnlyKeys(
    notion,
    [
      "pageUrlTemplate",
      "workspaceRootPage",
      "taileredOsProject",
      "commandCenter",
      "communicationStandard",
      "executionContract",
      "databases",
    ],
    "notion"
  );
  invariant(
    notion.pageUrlTemplate === "https://app.notion.com/p/{id}",
    "notion.pageUrlTemplate drifted"
  );
  invariant(
    notion.databases && typeof notion.databases === "object",
    "notion.databases missing"
  );
  const databaseKeys = [
    "tasks",
    "projects",
    "aiSystemsRegistry",
    "decisions",
    "risks",
    "releases",
    "knowledge",
  ];
  assertOnlyKeys(notion.databases, databaseKeys, "notion.databases");

  const surfaces = {
    workspaceRootPage: notion.workspaceRootPage,
    taileredOsProject: notion.taileredOsProject,
    commandCenter: notion.commandCenter,
    communicationStandard: notion.communicationStandard,
    executionContract: notion.executionContract,
    tasks: notion.databases.tasks,
    projects: notion.databases.projects,
    aiSystemsRegistry: notion.databases.aiSystemsRegistry,
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
    const node = notion.databases[key];
    validateNode(node, `notion.databases.${key}`);
    invariant(
      node.id === CANONICAL[key],
      `notion.databases.${key}.id (${node?.id}) does not match the owner-verified canonical id — control-plane drift`
    );
    invariant(
      node.source.includes(CANONICAL_DATA_SOURCES[key]),
      `notion.databases.${key}.source must record its canonical data-source id ${CANONICAL_DATA_SOURCES[key]}`
    );
  }

  const ids = [
    ...Object.values(surfaces).map(node => node.id),
    ...["decisions", "risks", "releases", "knowledge"].map(
      key => notion.databases[key].id
    ),
  ];
  invariant(
    new Set(ids).size === ids.length,
    "notion ids must be unique — with the canonical eight individually pinned above, a duplicate means a mis-pasted database id"
  );

  invariant(
    manifest.github && typeof manifest.github === "object",
    "github missing"
  );
  assertOnlyKeys(
    manifest.github,
    ["repository", "taileredOsBoundary", "foundationPullRequest"],
    "github"
  );
  invariant(
    manifest.github.repository === "tailered-ai/dime-ai",
    "github.repository drifted from tailered-ai/dime-ai"
  );
  invariant(
    manifest.github.taileredOsBoundary === "platform/tailered-os/",
    "github.taileredOsBoundary drifted"
  );
  invariant(
    manifest.github.foundationPullRequest === 496,
    "github.foundationPullRequest drifted"
  );

  const safety = manifest.safety;
  invariant(safety && typeof safety === "object", "safety missing");
  assertOnlyKeys(
    safety,
    [
      "notionWriteOperationsAuthorized",
      "notionWriteAuthorization",
      "secretMaterialAllowed",
      "manualGithubMirroringAllowed",
    ],
    "safety"
  );
  // OG-006 (2026-08-11): write authority is no longer const-false, but a bare
  // `true` is still a SELF-grant and is refused — `true` is lawful only when
  // accompanied by the owner's decision record, pinned here so the grant is
  // evidence, not configuration. `false` must carry NO dormant grant.
  invariant(
    typeof safety.notionWriteOperationsAuthorized === "boolean",
    "safety.notionWriteOperationsAuthorized must be strictly boolean"
  );
  if (safety.notionWriteOperationsAuthorized === true) {
    const grant = safety.notionWriteAuthorization;
    invariant(
      grant && typeof grant === "object" && !Array.isArray(grant),
      "safety.notionWriteOperationsAuthorized is true without safety.notionWriteAuthorization — a bare true is a self-grant and is refused"
    );
    assertOnlyKeys(
      grant,
      ["decision", "grantedBy", "grantedOn", "actor", "scope"],
      "safety.notionWriteAuthorization"
    );
    invariant(
      /^https:\/\/app\.notion\.com\/p\/[0-9a-f]{32}$/.test(
        String(grant.decision)
      ),
      "safety.notionWriteAuthorization.decision must be a canonical Notion decision URL"
    );
    invariant(
      grant.grantedBy === "PREZ",
      "safety.notionWriteAuthorization.grantedBy must be PREZ"
    );
    invariant(
      ISO_DATE.test(String(grant.grantedOn)),
      "safety.notionWriteAuthorization.grantedOn must be a calendar date"
    );
    invariant(
      grant.actor === "AI-10",
      "safety.notionWriteAuthorization.actor must be AI-10 (the only approved writer actor)"
    );
    invariant(
      typeof grant.scope === "string" && grant.scope.length > 0,
      "safety.notionWriteAuthorization.scope must state the approved write scope"
    );
  } else {
    invariant(
      safety.notionWriteAuthorization === undefined,
      "safety.notionWriteAuthorization must be absent while write authority is false — no dormant grants"
    );
  }
  invariant(
    safety.secretMaterialAllowed === false,
    "safety.secretMaterialAllowed must be false"
  );
  invariant(
    safety.manualGithubMirroringAllowed === false,
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
