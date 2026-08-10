// TOS-006 — GitHub↔Notion PR contract validator (static, offline).
//
// Every Tailered-OS-scoped PR must carry a structured "## Notion context" block
// binding it to its canonical Notion Project + Task, a Scope ID, an accountable
// HUMAN owner, and decision/deployment classifications. Identifiers come ONLY
// from config/tailered-os-control-plane.v1.json via the TOS-001 validator —
// nothing is hardcoded here. Zero network calls: existence of the Task page is
// deliberately not checked (the link is the traceability mechanism; the archived
// Notion GitHub Sync is NOT relied on, no bot writes anything, org-wide mode is
// not enabled).
//
// Non-Tailered-OS PRs are a no-op by changed-path scoping, decided in-job so the
// check can safely become a Required status check without stranding Dime PRs.
import { readFileSync } from "node:fs";
import { loadControlPlaneManifest } from "../tailered-os-control-plane.mjs";

// The Tailered OS scope set. A PR touching ANY of these paths is in scope.
export const TOS_SCOPE_PATTERNS = Object.freeze([
  /^platform\/tailered-os\//,
  /^config\/tailered-os-control-plane/,
  /^scripts\/tailered-os/,
  /^scripts\/ci\/tos-/,
  /^scripts\/one-shot\//,
  /^os\/one-shot\//,
  /^\.github\/workflows\/tailered-os\.yml$/,
  /^\.github\/workflows\/13-tos-notion-context\.yml$/,
]);

export const DECISION_CLASSES = Object.freeze([
  "routine",
  "material",
  "owner-gated",
]);
export const DEPLOYMENT_CONSEQUENCES = Object.freeze([
  "none",
  "dime-runtime",
  "tailered-os-runtime",
]);

// Accountable ownership is human. Common machine-actor names are rejected so an
// agent can never be pasted in as the owner of record.
const MACHINE_OWNER =
  /\b(claude|fable|opus|sonnet|gpt|codex|copilot|agent|bot|ai)\b/i;

export function isTosScoped(changedFiles) {
  return changedFiles.some(file =>
    TOS_SCOPE_PATTERNS.some(pattern => pattern.test(file))
  );
}

// Extract a Notion page id from a pasted URL: accepts app.notion.com/p/<id>,
// www.notion.so/<workspace>/<Slug>-<id>, dashed UUIDs, and bare ids. Matching is
// by the dash-normalized 32-hex id — never by exact URL-template comparison.
export function extractNotionId(text) {
  const match = text.match(
    /\b(?:[0-9a-fA-F]{32}|[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\b/
  );
  return match ? match[0].replace(/-/g, "").toLowerCase() : null;
}

function sectionOf(body, heading) {
  const lines = body.split(/\r?\n/);
  const start = lines.findIndex(line =>
    line.trim().toLowerCase().startsWith(`## ${heading}`.toLowerCase())
  );
  if (start === -1) return null;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex(line => /^##\s/.test(line));
  return rest.slice(0, end === -1 ? rest.length : end).join("\n");
}

function fieldOf(section, label) {
  const match = section.match(
    new RegExp(`^\\s*[-*]?\\s*${label}\\s*:\\s*(.*)$`, "im")
  );
  if (!match) return null;
  // Strip HTML comments (unfilled template placeholders read as empty).
  const value = match[1].replace(/<!--[\s\S]*?(-->|$)/g, "").trim();
  return value.length > 0 ? value : null;
}

function compliantBlock(manifest) {
  const projectUrl = manifest.notion.pageUrlTemplate.replace(
    "{id}",
    manifest.notion.taileredOsProject.id
  );
  return [
    "  ## Notion context",
    "",
    `  - Project: ${projectUrl}`,
    "  - Task: https://app.notion.com/p/<your task page id>",
    "  - Scope ID: TOS-006",
    "  - Human owner: PREZ",
    "  - Decision class: routine",
    "  - Deployment consequence: none",
  ].join("\n");
}

// Returns { inScope, errors: [{field, what, why, fix}] }.
export function evaluate(body, changedFiles, manifest) {
  if (!isTosScoped(changedFiles)) return { inScope: false, errors: [] };
  const errors = [];
  const fail = (field, what, why, fix) =>
    errors.push({ field, what, why, fix });

  const section = sectionOf(body ?? "", "Notion context");
  if (section === null) {
    fail(
      "Notion context",
      'the PR body has no "## Notion context" section.',
      "Tailered-OS-scoped changes must be traceable to their canonical Notion Project and Task — the pasted link IS the traceability mechanism (the Notion GitHub Sync integration is archived).",
      `add the section below to the PR description (Edit ▸ description), with your Task URL:\n${compliantBlock(manifest)}`
    );
    return { inScope: true, errors };
  }

  const projectValue = fieldOf(section, "Project");
  const canonicalProjectId = manifest.notion.taileredOsProject.id;
  if (!projectValue) {
    fail(
      "Project",
      '"Project" is missing or empty under "## Notion context".',
      "the Project line binds this PR to the one canonical Tailered OS project record.",
      `add "- Project: ${manifest.notion.pageUrlTemplate.replace("{id}", canonicalProjectId)}" (canonical id from config/tailered-os-control-plane.v1.json).`
    );
  } else {
    const projectId = extractNotionId(projectValue);
    if (projectId !== canonicalProjectId) {
      fail(
        "Project",
        `the Project URL resolves to id "${projectId ?? "none"}", which is not the canonical Tailered OS project.`,
        "a wrong project id silently detaches the PR from the control plane.",
        `use the canonical project (id ${canonicalProjectId}, pinned in config/tailered-os-control-plane.v1.json).`
      );
    }
  }

  const taskValue = fieldOf(section, "Task");
  const taskId = taskValue ? extractNotionId(taskValue) : null;
  if (!taskValue || !taskId) {
    fail(
      "Task",
      '"Task" is missing or does not contain a valid Notion page URL/id.',
      "every Tailered OS change executes against one canonical Task in the Tasks database — that page carries the owner, done-condition, and proof.",
      'add "- Task: <direct Notion Task URL>" (open the task in Notion and copy its link).'
    );
  } else if (taskId === canonicalProjectId) {
    fail(
      "Task",
      "the Task URL is the PROJECT page, not a Task page.",
      "the project record cannot carry per-change done-conditions and proof.",
      "paste the direct URL of the individual Task (a row in the Tasks database), not the project."
    );
  }

  const scopeValue = fieldOf(section, "Scope ID");
  if (!scopeValue || !/^TOS-\d{3}$/.test(scopeValue)) {
    fail(
      "Scope ID",
      `"Scope ID" is ${scopeValue ? `"${scopeValue}", which is not a valid TOS scope id` : "missing"}.`,
      "the Scope ID is how ledgers, tasks, and PRs join across systems.",
      'add "- Scope ID: TOS-###" matching the canonical Task\'s Scope ID field.'
    );
  }

  const ownerValue = fieldOf(section, "Human owner");
  if (!ownerValue || /^none$/i.test(ownerValue)) {
    fail(
      "Human owner",
      '"Human owner" is missing.',
      "AI agents are executors, never accountable owners — every Tailered OS change needs a human accountable for the outcome.",
      'add "- Human owner: <name>" (the accountable person, e.g. PREZ).'
    );
  } else if (MACHINE_OWNER.test(ownerValue)) {
    fail(
      "Human owner",
      `"${ownerValue}" names a machine actor.`,
      "AI agents are executors, never accountable owners.",
      "name the accountable HUMAN (the person answerable for this change)."
    );
  }

  const decisionValue = fieldOf(section, "Decision class");
  if (
    !decisionValue ||
    !DECISION_CLASSES.includes(decisionValue.toLowerCase())
  ) {
    fail(
      "Decision class",
      `"Decision class" is ${decisionValue ? `"${decisionValue}"` : "missing"}; expected one of: ${DECISION_CLASSES.join(" | ")}.`,
      "the decision class routes what may merge on green checks vs what needs explicit owner sign-off.",
      'add "- Decision class: routine" (or material / owner-gated when a human decision is embedded).'
    );
  }

  const deployValue = fieldOf(section, "Deployment consequence");
  if (
    !deployValue ||
    !DEPLOYMENT_CONSEQUENCES.includes(deployValue.toLowerCase())
  ) {
    fail(
      "Deployment consequence",
      `"Deployment consequence" is ${deployValue ? `"${deployValue}"` : "missing"}; expected one of: ${DEPLOYMENT_CONSEQUENCES.join(" | ")}.`,
      "merging dime-ai main IS a production deploy — every PR must state what its merge deploys.",
      'add "- Deployment consequence: none" (or dime-runtime / tailered-os-runtime).'
    );
  }

  return { inScope: true, errors };
}

export function formatReport(result, manifest) {
  if (!result.inScope) {
    return "TOS-006 Notion-context contract: no Tailered OS paths changed — contract not applicable to this PR (pass).";
  }
  if (result.errors.length === 0) {
    return "TOS-006 Notion-context contract: PASS — Project, Task, Scope ID, Human owner, Decision class, and Deployment consequence all valid against config/tailered-os-control-plane.v1.json.";
  }
  const blocks = result.errors.map(
    error =>
      `✖ ${error.field}: ${error.what}\n  Why it matters: ${error.why}\n  Fix: ${error.fix}`
  );
  return [
    `TOS-006 Notion-context contract: FAIL — ${result.errors.length} problem(s) in the PR body (not the code).`,
    "",
    ...blocks,
    "",
    "A compliant block looks like:",
    compliantBlock(manifest),
    "",
    "Canonical identifiers: config/tailered-os-control-plane.v1.json (enforced by scripts/tailered-os-control-plane.mjs). Editing the PR description re-runs this check.",
  ].join("\n");
}

const invokedDirectly =
  process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (invokedDirectly) {
  const args = process.argv.slice(2);
  const argOf = flag => {
    const index = args.indexOf(flag);
    return index === -1 ? null : args[index + 1];
  };
  const bodyFile = argOf("--body-file");
  const changedFile = argOf("--changed-files");
  if (!bodyFile || !changedFile) {
    console.error(
      "usage: tos-notion-context.mjs --body-file <path> --changed-files <path>"
    );
    process.exit(2);
  }
  const manifest = loadControlPlaneManifest();
  const body = readFileSync(bodyFile, "utf8");
  const changedFiles = readFileSync(changedFile, "utf8")
    .split("\n")
    .map(line => line.trim())
    .filter(Boolean);
  const result = evaluate(body, changedFiles, manifest);
  console.log(formatReport(result, manifest));
  process.exit(result.errors.length === 0 ? 0 : 1);
}
