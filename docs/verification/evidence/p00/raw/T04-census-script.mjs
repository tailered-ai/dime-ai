// P00.T04 one-off construct census. Deliberately NOT placed in the repo:
// authoring scripts/ci/ contract-extractor files is P02 work, not P00's.
import { readFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";
const YAML_PATH = process.argv[3];
const { load } = await import(YAML_PATH);
const ROOT = process.argv[2];
const WF = path.join(ROOT, ".github", "workflows");

const files = readdirSync(WF).filter(f => f.endsWith(".yml") || f.endsWith(".yaml")).sort();
const count = (m, k) => m.set(k, (m.get(k) ?? 0) + 1);
const wfKeys = new Map(), triggers = new Map(), jobKeys = new Map(),
      stepKeys = new Map(), exprs = new Map(), usesKind = new Map(),
      shells = new Map();
let jobs = 0, steps = 0, reusable = 0, parseErrors = [];
const EXPR = /\$\{\{\s*([A-Za-z_][A-Za-z0-9_]*)/g;

for (const f of files) {
  const raw = readFileSync(path.join(WF, f), "utf8");
  let doc;
  try { doc = load(raw); } catch (e) { parseErrors.push(`${f}: ${e.message}`); continue; }
  for (const k of Object.keys(doc ?? {})) count(wfKeys, k === true ? "on" : String(k));
  const on = doc?.on ?? doc?.true; // js-yaml 1.1 maps bare `on:` to boolean true
  if (on === null || on === undefined) count(triggers, "(none)");
  else if (typeof on === "string") count(triggers, on);
  else if (Array.isArray(on)) on.forEach(t => count(triggers, String(t)));
  else Object.keys(on).forEach(t => count(triggers, t));
  for (const [, job] of Object.entries(doc?.jobs ?? {})) {
    jobs++;
    for (const k of Object.keys(job ?? {})) count(jobKeys, k);
    if (job?.uses) reusable++;
    for (const st of job?.steps ?? []) {
      steps++;
      for (const k of Object.keys(st ?? {})) count(stepKeys, k);
      if (st?.shell) count(shells, st.shell);
      if (st?.uses) count(usesKind, /@[0-9a-f]{40}$/.test(st.uses) ? "sha-pinned" : "tag-or-branch");
    }
  }
  for (const m of raw.matchAll(EXPR)) count(exprs, m[1]);
}
const tbl = (title, m) => {
  console.log(`\n### ${title} (${m.size} distinct)`);
  console.log("| Construct | Occurrences |");
  console.log("| --- | --- |");
  [...m.entries()].sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0])).forEach(([k,v])=>console.log(`| \`${k}\` | ${v} |`));
};
console.log(`Workflow files: ${files.length}`);
console.log(`Jobs: ${jobs}  Steps: ${steps}  Reusable-workflow job calls (job.uses): ${reusable}`);
console.log(`Parse errors: ${parseErrors.length ? parseErrors.join("; ") : "NONE"}`);
const actionsDir = path.join(ROOT, ".github", "actions");
console.log(`Local composite actions (.github/actions): ${existsSync(actionsDir) ? readdirSync(actionsDir).join(", ") || "(empty dir)" : "DIRECTORY ABSENT"}`);
console.log("\n### Workflow file list");
files.forEach((f,i)=>console.log(`${String(i+1).padStart(2," ")}. ${f}`));
tbl("Workflow-level keys", wfKeys);
tbl("Trigger types (on:)", triggers);
tbl("Job-level keys", jobKeys);
tbl("Step-level keys", stepKeys);
tbl("Expression context roots (${{ X.… }})", exprs);
tbl("uses: ref pinning", usesKind);
tbl("Explicit step shells", shells);
