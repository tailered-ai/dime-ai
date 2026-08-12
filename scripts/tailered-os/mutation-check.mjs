#!/usr/bin/env node
// TOS-009 — mutation check for the load-bearing authority controls.
//
// A test that exists is not a test that protects. Round 1 shipped a 49-test
// battery in which SIX security controls could be deleted outright with the
// whole suite still green (PR #509, entry-bar item 3). This script is the
// standing proof that that is no longer true: it deletes each control in turn
// and requires the suite to go RED.
//
// Usage:  node scripts/tailered-os/mutation-check.mjs [--list]
// Exit 0 only when every mutant is killed. CI-safe: it always restores the
// working tree, including on crash or SIGINT.
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const WRITER = join(HERE, "lifecycle-writer.mjs");
const KERNEL = join(HERE, "lifecycle.mjs");
const AUTHORITY = join(HERE, "authority.mjs");

// Each mutant deletes ONE protection by making its guard unreachable. `kills`
// names the test whose failure proves the protection was load-bearing.
const MUTANTS = [
  {
    id: "M1",
    control: "execute-time authority re-read: the FLAG half",
    finding: "NEW2-OG6-0017",
    file: WRITER,
    from: "recheck.manifest.safety.notionWriteOperationsAuthorized !== true",
    to: "false",
    kills: "MUTANT 1 ",
    // Declared equivalent, with proof rather than assertion. Disarming ALWAYS
    // changes the grant fingerprint, because (a) the fingerprint's first element
    // is the flag itself and (b) the manifest validator forbids a dormant grant,
    // so flag:false with the grant intact cannot even load. Deleting this half
    // alone therefore changes no observable behaviour. M1x below mutates BOTH
    // halves at once and MUST be killed — that is what proves the execute-time
    // kill switch is load-bearing rather than decorative.
    equivalent:
      "subsumed by M2: the fingerprint includes the flag, and the loader rejects flag:false with a grant present, so no input distinguishes this mutant. Proven load-bearing as a pair by M1x.",
  },
  {
    id: "M1x",
    control:
      "execute-time authority re-read: BOTH halves (the real kill switch)",
    finding: "NEW2-OG6-0017 + NEW3-OG6-0027",
    file: WRITER,
    from: `  if (
    recheck.error ||
    recheck.manifest.safety.notionWriteOperationsAuthorized !== true
  )`,
    to: "  if (false)",
    also: {
      from: "grantFingerprint(recheck.manifest) !== mint.grant_fingerprint",
      to: "false",
    },
    kills: "MUTANT 1 ",
  },
  {
    id: "M2",
    control:
      "execute-time grant fingerprint (canonical, not per-path, authority)",
    finding: "NEW3-OG6-0027",
    file: WRITER,
    from: "grantFingerprint(recheck.manifest) !== mint.grant_fingerprint",
    to: "false",
    kills: "MUTANT 1b",
  },
  {
    id: "M3",
    control: "capability TTL",
    finding: "NEW2-OG6-0017",
    file: WRITER,
    from: "if (age > CAPABILITY_TTL_MS || age < 0)",
    to: "if (false)",
    kills: "MUTANT 2 ",
  },
  {
    id: "M4",
    control: "closed option surface (no caller-selectable authority path)",
    finding: "entry-bar 2",
    file: WRITER,
    from: "if (unknownOptions.length > 0)",
    to: "if (false)",
    kills: "MUTANT 3 ",
  },
  {
    id: "M5",
    control: "write target derived from the once-read plan",
    finding: "NEW2-OG6-0013",
    file: WRITER,
    from: "page_id: safe.task_id,",
    to: "page_id: plan.task_id,",
    kills: "MUTANT 4 ",
  },
  {
    id: "M6",
    control: "undo bound to a registered capability",
    finding: "NEW-OG6-0008",
    file: WRITER,
    from: "if (!AUTHORIZED_CAPABILITIES.has(origin))",
    to: "if (false)",
    kills: "MUTANT 5 ",
  },
  {
    id: "M7",
    control: "deploy decision is human authority",
    finding: "NEW2-OG6-0018",
    file: KERNEL,
    from: `        "consequence_ref",
        "observed_via",
      ],
      authority: "human",`,
    to: `        "consequence_ref",
        "observed_via",
      ],
      authority: "machine",`,
    kills: "MUTANT 6 ",
  },
  // The Round 2 controls. Round 1's lesson was that new protections arrive
  // unproven, so these are held to the same bar as the six inherited ones.
  {
    id: "M8",
    control:
      "writer requires a MINTED authority fact (human authority derived)",
    finding: "NEW3-OG6-0024",
    file: WRITER,
    from: "    if (!isAuthorityFact(token))",
    to: "    if (false)",
    kills: "NEW3-OG6-0024 — a forged look-alike",
  },
  {
    id: "M9",
    control: "authority facts are single-use",
    finding: "NEW2-OG6-0017",
    file: AUTHORITY,
    from: "  if (meta.consumed)",
    to: "  if (false)",
    kills: "one authenticated human act authorizes ONE transition",
  },
  {
    id: "M10",
    control: "reviewer allowlist (default deny on identity)",
    finding: "NEW3-OG6-0024",
    file: AUTHORITY,
    from: "  if (!ALLOWED_HUMAN_REVIEWERS.includes(name))",
    to: "  if (false)",
    kills: "identity substitution fails four ways",
  },
  {
    id: "M11",
    control: "approval must be of the CURRENT reviewable head",
    finding: "NEW3-OG6-0024",
    file: AUTHORITY,
    from: "  if (String(review.commit_id) !== headSha)",
    to: "  if (false)",
    kills: "an approval of an older commit is stale",
  },
  {
    id: "M12",
    control: "armed grant bytes must equal the bytes the LOADER read (A1)",
    finding: "A1 / entry-bar 1",
    file: AUTHORITY,
    from: "  if (raw.manifest_at_merge !== raw.manifest_loaded)",
    to: "  if (false)",
    kills: "an UNCOMMITTED edit cannot arm",
  },
  // Round-2 adversarial + independent-verification findings. Same bar: a fix
  // with no test that fails without it is not a fix.
  {
    id: "M15",
    control: "the merged manifest must CONTAIN this grant (A2)",
    finding: "A2",
    file: AUTHORITY,
    from: "  if (Number(mergedGrant.activationPullRequest) !== prNumber)",
    to: "  if (false)",
    kills: "blob equality is not enough",
    // Equivalent, with proof rather than assertion — same shape as M1.
    // `prNumber` IS `grant.activationPullRequest` (read at the top of
    // deriveOwnerGrantFact), so once the field-by-field grant comparison holds,
    // mergedGrant.activationPullRequest === grant.activationPullRequest ===
    // prNumber necessarily. No input distinguishes this mutant. It is kept as
    // cheap defence in depth and for a far clearer error message; M16 proves
    // the surrounding "the merge must actually have armed" law is load-bearing.
    equivalent:
      "logically implied by the grant field-equality check, because prNumber is read from the very grant being compared. Kept for the clearer message; the class is covered by M16 and by the equality check itself.",
  },
  {
    id: "M16",
    control: "the merge must actually have granted authority (A2)",
    finding: "A2",
    file: AUTHORITY,
    from: "  if (merged?.safety?.notionWriteOperationsAuthorized !== true)",
    to: "  if (false)",
    kills: "blob equality is not enough",
  },
  {
    id: "M17",
    control: "human authority must be about THIS task's PR (R2-02)",
    finding: "R2-02",
    file: WRITER,
    from: "      if (Number(fact.pr_number) !== Number(safe.pr_number))",
    to: "      if (false)",
    kills: "authenticated evidence must be about THIS task",
  },
  {
    id: "M18",
    control: "an unblock comment must name this task (R2-02)",
    finding: "R2-02",
    file: WRITER,
    from: "      if (!names)",
    to: "      if (false)",
    kills: "an unblock must name this task",
  },
  {
    id: "M19",
    control: "confinement re-verified against the source system (R2-04)",
    finding: "R2-04",
    file: WRITER,
    from: "  const confinement = confinementProblem(target, authorizedPlan);",
    to: "  const confinement = null;",
    kills: "confinement is verified against the record the transport returns",
  },
  {
    id: "M20",
    control: "the live Execution State decides, not the caller (A5b)",
    finding: "A5b",
    file: WRITER,
    from: '  if (liveState !== "" && liveState !== expected)',
    to: "  if (false)",
    kills: "the source system decides what state a record is in",
  },
  {
    id: "M21",
    control: "per-trigger write surface (A3)",
    finding: "A3",
    file: WRITER,
    from: "    const stray = Object.keys(writes).filter(",
    to: "    const stray = [].filter(",
    kills: "a trigger may only write the properties it derives",
  },
  {
    id: "M22",
    control: "captured priors are validated (A5)",
    finding: "A5",
    file: WRITER,
    from: "    if (priorProblem)",
    to: "    if (false)",
    kills: "an unvalidated prior would become an unvalidated write",
  },
  {
    id: "M23",
    control: "undo reverts on the page its origin wrote (A7)",
    finding: "A7",
    file: WRITER,
    from: "    if (safe.task_id !== origin.task_id)",
    to: "    if (false)",
    kills: "an undo may not land on a different page",
  },
  {
    id: "M24",
    control: "undoing a human decision needs derived evidence (A6)",
    finding: "A6",
    file: WRITER,
    from: "      if (usableUndo.ok !== true) return usableUndo;",
    to: "      if (false) return usableUndo;",
    kills: "a machine may not walk back a human decision",
  },
  {
    id: "M25",
    control: "the snapshot is read exactly once (A5/A11)",
    finding: "A5",
    file: WRITER,
    from: "  snapshot = snapshotted2.snapshot;",
    to: "  snapshot = snapshot;",
    kills: "a two-faced snapshot",
  },
  {
    id: "M13",
    control: "terminal Verified requires FETCHED proof",
    finding: "runbook unsound #5",
    file: WRITER,
    from: '  if (safe.trigger === "post_merge_verified") {',
    to: "  if (false) {",
    kills: "Phase 10 — Verified is unreachable on an unfetched proof URL",
  },
  {
    id: "M14",
    control: "plan evidence must AGREE with the derived fact",
    finding: "NEW3-OG6-0024",
    file: WRITER,
    from: "    if (disagreement) return disagreement;",
    to: "    if (false) return disagreement;",
    kills: "the plan may not overrule the fact",
  },
];

if (process.argv.includes("--list")) {
  for (const m of MUTANTS) console.log(`${m.id}\t${m.finding}\t${m.control}`);
  process.exit(0);
}

const originals = new Map();
for (const file of new Set(MUTANTS.map(m => m.file)))
  originals.set(file, readFileSync(file, "utf8"));

let restored = false;
function restore() {
  if (restored) return;
  restored = true;
  for (const [file, text] of originals) writeFileSync(file, text);
}
process.on("exit", restore);
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => process.exit(130));

function runSuite() {
  const result = spawnSync(
    process.execPath,
    [
      join(ROOT, "node_modules", "vitest", "vitest.mjs"),
      "run",
      "scripts/tailered-os/",
      "--reporter=dot",
    ],
    { cwd: ROOT, encoding: "utf8", timeout: 300_000 }
  );
  return {
    code: result.status,
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
  };
}

console.log("baseline (unmutated) …");
const baseline = runSuite();
if (baseline.code !== 0) {
  console.error("BASELINE IS RED — fix the suite before mutation-testing it.");
  console.error(baseline.output.slice(-3000));
  process.exit(2);
}
console.log("baseline GREEN\n");

const survivors = [];
const misfires = [];
for (const mutant of MUTANTS) {
  if (mutant.equivalent) {
    console.log(
      `${mutant.id}  EQUIVALENT  ${mutant.control}\n      ${mutant.equivalent}`
    );
    continue;
  }
  const source = originals.get(mutant.file);
  const edits = [
    { from: mutant.from, to: mutant.to },
    ...(mutant.also ? [mutant.also] : []),
  ];
  const occurrences = Math.min(
    ...edits.map(edit => source.split(edit.from).length - 1)
  );
  if (occurrences !== 1) {
    // A mutation that does not apply proves nothing; say so loudly rather than
    // counting it as a kill.
    misfires.push({ ...mutant, occurrences });
    console.log(
      `${mutant.id}  MISFIRE  anchor matched ${occurrences}× — not applied`
    );
    continue;
  }
  let mutated = source;
  for (const edit of edits) mutated = mutated.replace(edit.from, edit.to);
  writeFileSync(mutant.file, mutated);
  const { code, output } = runSuite();
  writeFileSync(mutant.file, source);

  const killed = code !== 0;
  const namedTestFailed = output.includes(mutant.kills);
  if (!killed) {
    survivors.push(mutant);
    console.log(`${mutant.id}  SURVIVED  ${mutant.control}`);
  } else if (!namedTestFailed) {
    // Killed, but not by the test that claims to protect it. That is still a
    // kill, and it is worth knowing the attribution is off.
    console.log(`${mutant.id}  killed (by another test)  ${mutant.control}`);
  } else {
    console.log(`${mutant.id}  KILLED  ${mutant.control}`);
  }
}

restore();
// Restoration is checked against the bytes this script read, NOT against git:
// the harness runs on a working tree that legitimately has uncommitted work,
// and `git status` would flag that as a restore failure.
const unrestored = [...originals].filter(
  ([file, text]) => readFileSync(file, "utf8") !== text
);

const killed =
  MUTANTS.filter(m => !m.equivalent).length -
  survivors.length -
  misfires.length;
const scored = MUTANTS.filter(m => !m.equivalent).length;
console.log(
  `\n${killed}/${scored} killed (${MUTANTS.length - scored} declared equivalent)`
);
if (unrestored.length > 0) {
  console.error(
    "working tree not restored: " + unrestored.map(([f]) => f).join(", ")
  );
  process.exit(2);
}
if (misfires.length > 0) {
  console.error(
    `MISFIRED: ${misfires.map(m => m.id).join(", ")} — anchors are stale.`
  );
  process.exit(2);
}
if (survivors.length > 0) {
  console.error(
    `SURVIVORS: ${survivors.map(m => `${m.id} (${m.control})`).join("; ")}`
  );
  process.exit(1);
}
console.log(
  "0 survivors — every load-bearing control has a test that fails without it."
);
