// Guards the one known hazard of the starter's overlay model: scripts/deploy.mjs
// REPLACES whole sections of the upstream base wrangler configs (vars, services,
// kv_namespaces, r2_buckets, assets, ai on the Workshop; kv_namespaces on Context)
// rather than merging them. A submodule upgrade that adds a field inside a replaced
// section — or a new top-level key — would be silently dropped from the deployed
// config. This test pins the shape of those base configs to a reviewed golden;
// when it fails after a submodule bump, decide whether deploy.mjs must carry the
// new field, then regenerate with: UPDATE_GOLDEN=1 node --test scripts/upstream-drift.test.mjs
import { test } from "node:test";
import assert from "node:assert";
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseJsonc } from "jsonc-parser";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const GOLDEN_PATH = join(root, "scripts", "testdata", "upstream-config-shape.json");

const BASES = {
  workshop: "cloudflare-os/packages/workshop-backend/wrangler.jsonc",
  context: "cloudflare-os/packages/gatekeeper-context/wrangler.jsonc",
};

// The sections generateConfigs() assigns wholesale (see scripts/deploy.mjs).
const REPLACED_SECTIONS = {
  workshop: ["vars", "ai", "services", "kv_namespaces", "r2_buckets", "assets"],
  context: ["kv_namespaces"],
};

function shapeOf(relPath, replacedSections) {
  const config = parseJsonc(readFileSync(join(root, relPath), "utf8"));
  const shape = { topLevelKeys: Object.keys(config).sort(), replaced: {} };
  for (const section of replacedSections) {
    const value = config[section];
    if (value === undefined) {
      shape.replaced[section] = "absent";
    } else if (Array.isArray(value)) {
      shape.replaced[section] = value.map(entry =>
        entry && typeof entry === "object" ? Object.keys(entry).sort() : typeof entry
      );
    } else if (value && typeof value === "object") {
      shape.replaced[section] = Object.keys(value).sort();
    } else {
      shape.replaced[section] = typeof value;
    }
  }
  return shape;
}

test("upstream base configs match the reviewed golden shape", () => {
  const actual = {};
  for (const [name, relPath] of Object.entries(BASES)) {
    actual[name] = shapeOf(relPath, REPLACED_SECTIONS[name]);
  }
  if (process.env.UPDATE_GOLDEN) {
    writeFileSync(GOLDEN_PATH, JSON.stringify(actual, null, 2) + "\n");
    return;
  }
  const golden = JSON.parse(readFileSync(GOLDEN_PATH, "utf8"));
  assert.deepStrictEqual(
    actual,
    golden,
    "Upstream wrangler config shape changed. Review whether scripts/deploy.mjs must " +
      "carry the new/changed fields (its overlay REPLACES these sections), then " +
      "regenerate: UPDATE_GOLDEN=1 node --test scripts/upstream-drift.test.mjs"
  );
});
