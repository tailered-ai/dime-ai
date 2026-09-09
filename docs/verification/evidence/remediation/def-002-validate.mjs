// DEF-002 corrective validation: RULESETS.md must agree EXACTLY with live
// GitHub. Kept as evidence so the check is reproducible, not narrated.
import fs from "node:fs";
import { execFileSync } from "node:child_process";

const md = fs.readFileSync("docs/verification/RULESETS.md", "utf8");
const gh = a => execFileSync("gh", a, { encoding: "utf8" });
const block = (heading, source = md) =>
  source.split(heading)[1].split("```")[1].trim().split("\n");
// DEF-006: split on the ANNOTATION COLUMN (2+ spaces), never on "(" — context
// names legitimately contain parentheses, e.g. "Secret Scan (gitleaks)".
const contextName = line => line.trim().split(/\s{2,}/)[0].trim();

const documented = block("### Required status checks ENFORCED TODAY").map(contextName).filter(Boolean);
const documentedGrad = block("### Still GRADUATING").map(contextName).filter(Boolean);
const endState = block("### Required status checks (end state)").map(contextName).filter(Boolean);

const live = JSON.parse(gh(["api", "repos/tailered-ai/dime-ai/rulesets/18701573"]))
  .rules.find(r => r.type === "required_status_checks")
  .parameters.required_status_checks.map(c => c.context);

const eq = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
const derivedGrad = endState.filter(c => !live.includes(c));

console.log(`documented enforced   (${documented.length}): ${documented.join(", ")}`);
console.log(`live enforced         (${live.length}): ${live.join(", ")}`);
console.log(`MATCH enforced        : ${eq(documented, live)}`);
console.log("");
console.log(`documented graduating (${documentedGrad.length}): ${documentedGrad.join(", ")}`);
console.log(`derived   graduating  (${derivedGrad.length}): ${derivedGrad.join(", ")}`);
console.log(`MATCH graduating      : ${eq(documentedGrad, derivedGrad)}`);
console.log("");
console.log(`end-state count       : ${endState.length} (expect 14)`);
console.log(`9 + 5 == 14           : ${live.length + documentedGrad.length === endState.length}`);

let classic = "UNEXPECTED_SUCCESS";
try {
  gh(["api", "repos/tailered-ai/dime-ai/branches/main/protection"]);
} catch (e) {
  classic = /404|Branch not protected/.test(String(e.stderr || e.message)) ? "ABSENT(404)" : "ERROR";
}
const docSaysAbsent = /Classic branch protection is ABSENT/.test(md);
console.log(`classic protection    : ${classic}   (doc asserts ABSENT: ${docSaysAbsent})`);

const mq = JSON.parse(gh(["api", "graphql", "-f",
  'query=query { repository(owner:"tailered-ai", name:"dime-ai") { mergeQueue(branch:"main") { id } } }']));
const docSaysNoQueue = /Merge queue — NOT enabled/.test(md);
console.log(`live mergeQueue       : ${JSON.stringify(mq.data.repository.mergeQueue)}   (doc asserts NOT enabled: ${docSaysNoQueue})`);

const ok =
  eq(documented, live) && eq(documentedGrad, derivedGrad) &&
  endState.length === 14 && classic === "ABSENT(404)" && docSaysAbsent &&
  mq.data.repository.mergeQueue === null && docSaysNoQueue;
console.log("");
console.log(`OVERALL: ${ok ? "DOCUMENTATION AND LIVE EVIDENCE AGREE EXACTLY" : "MISMATCH"}`);
process.exit(ok ? 0 : 1);
