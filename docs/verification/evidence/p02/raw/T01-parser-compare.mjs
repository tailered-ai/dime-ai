// P02.T01 — authoritative parser comparison: js-yaml (P00 discovery parser)
// vs yaml@2.9.0 (P02 accepted parser). Deep semantic comparison of the parsed
// document tree per file and per JSON path, NOT aggregate counts.
//
// js-yaml is reached through its pnpm store path: it is a transitive package,
// not a declared dependency (that is precisely why DEC-004 chose `yaml`). This
// is acceptable for a one-off comparison artifact and is NOT used by the
// extractor.
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { parse as yamlParse } from "yaml";

const [, , candidateRoot, jsYamlPath] = process.argv;
const { load: jsYamlLoad } = await import(jsYamlPath);

const dir = path.join(candidateRoot, ".github/workflows");
const files = readdirSync(dir).filter(f => /\.ya?ml$/.test(f)).sort();

const canon = node => {
  if (Array.isArray(node)) return node.map(canon);
  if (node && typeof node === "object") {
    const out = {};
    for (const k of Object.keys(node).sort()) out[k] = canon(node[k]);
    return out;
  }
  return typeof node === "string" ? node.replace(/\r\n/g, "\n") : node;
};

function diffPaths(a, b, at = "$", acc = []) {
  const ta = a === null ? "null" : Array.isArray(a) ? "array" : typeof a;
  const tb = b === null ? "null" : Array.isArray(b) ? "array" : typeof b;
  if (ta !== tb) { acc.push({ path: at, jsyaml: `${ta}:${JSON.stringify(a)?.slice(0,80)}`, yaml: `${tb}:${JSON.stringify(b)?.slice(0,80)}` }); return acc; }
  if (ta === "array") {
    if (a.length !== b.length) acc.push({ path: at, jsyaml: `len ${a.length}`, yaml: `len ${b.length}` });
    for (let i = 0; i < Math.max(a.length, b.length); i += 1) diffPaths(a[i], b[i], `${at}[${i}]`, acc);
    return acc;
  }
  if (ta === "object") {
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
    for (const k of keys) {
      if (!(k in a)) { acc.push({ path: `${at}.${k}`, jsyaml: "(absent)", yaml: "(present)" }); continue; }
      if (!(k in b)) { acc.push({ path: `${at}.${k}`, jsyaml: "(present)", yaml: "(absent)" }); continue; }
      diffPaths(a[k], b[k], `${at}.${k}`, acc);
    }
    return acc;
  }
  if (a !== b) acc.push({ path: at, jsyaml: JSON.stringify(a)?.slice(0,120), yaml: JSON.stringify(b)?.slice(0,120) });
  return acc;
}

let totalDiffs = 0;
const report = [];
for (const f of files) {
  const src = readFileSync(path.join(dir, f), "utf8");
  let A, B, err = null;
  try { A = canon(jsYamlLoad(src)); } catch (e) { err = `js-yaml threw: ${e.message}`; }
  try { B = canon(yamlParse(src)); } catch (e) { err = (err ? err + " | " : "") + `yaml threw: ${e.message}`; }
  if (err) { report.push({ file: f, error: err }); totalDiffs += 1; continue; }
  const d = diffPaths(A, B);
  totalDiffs += d.length;
  report.push({ file: f, differences: d.length, detail: d.slice(0, 10) });
}

console.log("P02.T01 — DEEP PARSER COMPARISON (per file, per JSON path)");
console.log(`files compared      : ${files.length}`);
console.log(`total differences   : ${totalDiffs}`);
console.log("");
for (const r of report) {
  if (r.error) { console.log(`${r.file}: ERROR ${r.error}`); continue; }
  if (r.differences > 0) {
    console.log(`${r.file}: ${r.differences} difference(s)`);
    for (const d of r.detail) console.log(`   ${d.path}\n     js-yaml: ${d.jsyaml}\n     yaml   : ${d.yaml}`);
  }
}
if (totalDiffs === 0) console.log("RESULT: ZERO semantic differences — both parsers produce identical document trees for all 40 workflows.");
else console.log("RESULT: DIFFERENCES FOUND — classify each before P02.T01 may PASS.");
process.exit(totalDiffs === 0 ? 0 : 1);
