// TOS-007 — Task → Claude execution context resolver.
//
// One canonical Notion Task URL in, one deterministic, bounded, versioned
// execution packet out. The authority manifest is the ONLY identifier root
// (loadControlPlaneManifest); no Notion id is hardcoded here. The packet is the
// minimum execution context — never a company-wide dump, never secrets.
//
// Data sources are pluggable because credentials are governed separately:
//   --source fixture:<dir>   deterministic snapshots (CI + tests; dir holds
//                            task-<32hex>.json files exported from live records)
//   --source api             Notion REST API; requires NOTION_API_TOKEN and
//                            fails CLOSED with a named owner gate when absent.
// Every failure mode prints what happened, why it matters, and what to do.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadControlPlaneManifest } from "../tailered-os-control-plane.mjs";

export const PACKET_SCHEMA_VERSION = 1;

// Same id semantics as scripts/ci/tos-notion-context.mjs (TOS-006, separate
// branch); consolidate into one shared helper once both scopes are on main.
export function extractNotionId(text) {
  const match = String(text ?? "").match(
    /\b(?:[0-9a-fA-F]{32}|[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\b/
  );
  return match ? match[0].replace(/-/g, "").toLowerCase() : null;
}

export class ResolveError extends Error {
  constructor(code, what, why, fix) {
    super(`${code}: ${what}`);
    this.code = code;
    this.what = what;
    this.why = why;
    this.fix = fix;
  }
  render() {
    return `TOS-007 context resolution failed — ${this.code}\n  What: ${this.what}\n  Why it matters: ${this.why}\n  Fix: ${this.fix}`;
  }
}

// Standing constraints embedded in every packet: the executor must see its
// authority ceiling without loading any other document.
const FORBIDDEN_ACTIONS = Object.freeze([
  "Merging without the required human approval, or weakening branch protection",
  "Modifying Dime production infrastructure (Railway config, Cloudflare, Stripe)",
  "Security, legal, or license-posture exceptions",
  "Spending money or personnel actions",
  "Writing secrets into Notion, Git, logs, PR bodies, or evidence",
  "Writing any non-Tailered-OS Notion record, deleting or archiving records",
]);

const HUMAN_GATES = Object.freeze([
  "Merge approval where branch protection requires human review (PREZ)",
  "Production deployment go/no-go (PREZ)",
  "Credential provisioning through 1Password / approved brokers (PREZ)",
  "License and security judgments (PREZ)",
]);

function fixtureSource(dir) {
  return {
    mode: `fixture:${dir}`,
    getPage(pageId) {
      const path = join(dir, `task-${pageId}.json`);
      if (!existsSync(path)) return null;
      return JSON.parse(readFileSync(path, "utf8"));
    },
  };
}

function apiSource() {
  const token = process.env.NOTION_API_TOKEN;
  if (!token) {
    throw new ResolveError(
      "connector-unauthorized",
      "source is 'api' but NOTION_API_TOKEN is not set.",
      "the resolver fails closed rather than borrowing a broader credential — credential presence is governed by PREZ, not discovered by tools.",
      "ask PREZ to provision a least-privilege Notion integration token (read-only, Tasks database scope) via 1Password, or run with --source fixture:<dir>."
    );
  }
  return {
    mode: "api",
    async getPage(pageId) {
      const response = await fetch(
        `https://api.notion.com/v1/pages/${pageId}`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            "Notion-Version": "2022-06-28",
          },
        }
      );
      if (response.status === 404) return null;
      if (!response.ok) {
        throw new ResolveError(
          "connector-error",
          `Notion API returned ${response.status} for page ${pageId}.`,
          "a partial read must not produce a confident packet.",
          "verify the integration has access to the Tasks database, then retry."
        );
      }
      return response.json();
    },
  };
}

export function parseSource(spec) {
  if (spec === "api") return apiSource();
  if (spec?.startsWith("fixture:")) return fixtureSource(spec.slice(8));
  throw new ResolveError(
    "bad-source",
    `unknown --source "${spec}".`,
    "the data source determines which credential law applies.",
    "use --source fixture:<dir> or --source api."
  );
}

// Fixture record shape mirrors the connector's SQL row for a Task (flat keys),
// so fixtures can be exported 1:1 from live query results.
export function buildPacket(record, taskId, manifest, source) {
  if (record === null) {
    throw new ResolveError(
      "task-missing",
      `no Task found for id ${taskId}.`,
      "an executor must never start from an invented task.",
      "verify the URL is a Task page in the canonical Tasks database (config/tailered-os-control-plane.v1.json → notion.databases.tasks)."
    );
  }
  if (record.Status === "Archived") {
    throw new ResolveError(
      "task-archived",
      `Task ${taskId} is Archived.`,
      "archived work must not be silently resurrected by an agent.",
      "if this work should run again, a human un-archives it (recording Why Archived) first."
    );
  }
  const scopeId = record["Scope ID"];
  if (!scopeId || !/^TOS-\d{3}$/.test(scopeId)) {
    throw new ResolveError(
      "scope-id-malformed",
      `Task ${taskId} has Scope ID "${scopeId ?? "(empty)"}".`,
      "the Scope ID is the join key across ledger, tasks, and PRs; execution without it is untraceable.",
      "set the Task's Scope ID to TOS-### before promoting it to agent execution."
    );
  }
  const projectRefs = safeJsonArray(record.Project);
  if (projectRefs.length === 0) {
    throw new ResolveError(
      "project-relation-missing",
      `Task ${taskId} has no Project relation.`,
      "authority and reporting hang off the canonical project; an unparented task is orphaned work.",
      "relate the Task to the Tailered OS project, then re-resolve."
    );
  }
  const projectId = extractNotionId(projectRefs[0]);
  const canonicalProject = manifest.notion.taileredOsProject.id;
  if (projectId !== canonicalProject) {
    throw new ResolveError(
      "project-id-drift",
      `Task ${taskId} relates to project ${projectId}, not the canonical Tailered OS project.`,
      "identifier drift is how agents end up executing against the wrong control plane.",
      `expected ${canonicalProject} (config/tailered-os-control-plane.v1.json). If the canonical project genuinely moved, that is a control-plane migration, not a resolver override.`
    );
  }
  const owners = safeJsonArray(record.Owner);
  if (owners.length === 0) {
    throw new ResolveError(
      "owner-missing",
      `Task ${taskId} has no human Owner.`,
      "AI agents are executors, never accountable owners — ownerless tasks are not agent-executable.",
      "set the Task's Owner to the accountable human, then re-resolve."
    );
  }
  const workLink = record["Work Link"];
  if (workLink && !/^https?:\/\//.test(workLink)) {
    throw new ResolveError(
      "work-link-malformed",
      `Task ${taskId} Work Link "${workLink}" is not a URL.`,
      "a malformed work link breaks the GitHub↔Notion join the whole program depends on.",
      "set Work Link to the full PR/page URL (or clear it)."
    );
  }
  const now = new Date().toISOString().replace(/\.\d+Z$/, "Z");
  return {
    schema_version: PACKET_SCHEMA_VERSION,
    generated_at: now,
    source: { mode: source.mode, retrieved_at: now },
    repository: manifest.github.repository,
    authority: {
      manifest: "config/tailered-os-control-plane.v1.json",
      tailered_os_boundary: manifest.github.taileredOsBoundary,
      notion_write_default: manifest.safety.notionWriteOperationsAuthorized,
    },
    task: {
      id: taskId,
      url: manifest.notion.pageUrlTemplate.replace("{id}", taskId),
      name: record.Name ?? null,
      scope_id: scopeId,
      status: record.Status ?? null,
      execution_state: record["Execution State"] ?? null,
      execution_mode: record["Execution Mode"] ?? null,
      priority: record.Priority ?? null,
      human_owner: owners,
      ai_executor: safeJsonArray(record["AI Executor"]),
      work_link: workLink ?? null,
      waiting_on: safeJsonArray(record["Waiting On"]),
      why_blocked:
        record["Why It’s Blocked"] ?? record["Why It's Blocked"] ?? null,
      what_done_means: record["What Done Means"] ?? null,
      why_it_matters: record["Why It Matters"] ?? null,
      proof: record["Proof / Result"] ?? null,
    },
    project: {
      id: canonicalProject,
      name: manifest.notion.taileredOsProject.name,
      canonical: true,
    },
    forbidden_actions: [...FORBIDDEN_ACTIONS],
    human_gates: [...HUMAN_GATES],
    next_action: record["What Done Means"]
      ? `Execute toward: ${record["What Done Means"]}`
      : "Ask the human owner for the done-condition before executing (What Done Means is empty).",
  };
}

function safeJsonArray(value) {
  if (value == null || value === "") return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [String(parsed)];
  } catch {
    return [String(value)];
  }
}

export async function resolve(taskUrl, sourceSpec) {
  const manifest = loadControlPlaneManifest();
  const taskId = extractNotionId(taskUrl);
  if (!taskId) {
    throw new ResolveError(
      "task-url-malformed",
      `"${taskUrl}" contains no Notion page id.`,
      "the resolver only executes against one canonical Task page.",
      "paste the direct Notion Task URL (open the task → copy link)."
    );
  }
  const source = parseSource(sourceSpec);
  const record = await source.getPage(taskId);
  const packet = buildPacket(record, taskId, manifest, source);
  const rendered = JSON.stringify(packet);
  // Fail closed if anything credential-shaped ever reaches a packet.
  if (
    /(sk_live_|sk_test_|sk-ant-|ghp_[A-Za-z0-9]|github_pat_|AKIA[0-9A-Z]{16}|-----BEGIN|[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^@\s/]+@)/.test(
      rendered
    )
  ) {
    throw new ResolveError(
      "secret-shaped-content",
      "the resolved packet contains a credential-shaped value.",
      "execution packets travel into agent context and logs — secrets never ride along.",
      "remove the credential-shaped value from the Notion record; secrets belong in 1Password."
    );
  }
  return packet;
}

const invokedDirectly =
  process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (invokedDirectly) {
  const args = process.argv.slice(2);
  const argOf = flag => {
    const index = args.indexOf(flag);
    return index === -1 ? null : args[index + 1];
  };
  const task = argOf("--task");
  const source = argOf("--source") ?? "api";
  if (!task) {
    console.error(
      "usage: context.mjs --task <NOTION_TASK_URL> [--source fixture:<dir>|api]"
    );
    process.exit(2);
  }
  const startedAt = process.hrtime.bigint();
  resolve(task, source)
    .then(packet => {
      const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
      console.log(JSON.stringify(packet, null, 2));
      console.error(
        `resolved ${packet.task.scope_id} in ${elapsedMs.toFixed(1)}ms (source ${packet.source.mode}, payload ${JSON.stringify(packet).length} bytes)`
      );
    })
    .catch(error => {
      console.error(
        error instanceof ResolveError
          ? error.render()
          : String(error?.stack ?? error)
      );
      process.exit(1);
    });
}
