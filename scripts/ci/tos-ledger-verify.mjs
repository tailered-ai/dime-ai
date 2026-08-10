// CI integrity gate for committed one-shot execution ledgers (plan-eng-review
// MEDIUM-4): a hand-edited events.jsonl must block, not merge silently. Offline
// and deterministic — re-derives every hash in the chain.
import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// The ledger kernel ships in its own PR; until it is on this branch there is
// nothing to verify. Dynamic import keeps the two changes independently
// mergeable in either order.
const kernelPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "one-shot",
  "ledger.mjs"
);
if (!existsSync(kernelPath)) {
  console.log(
    "tos-ledger-verify: scripts/one-shot/ledger.mjs is not on this branch — nothing to verify (pass)."
  );
  process.exit(0);
}
const { runsRoot, verifyRun } = await import(kernelPath);

const root = runsRoot();
if (!existsSync(root)) {
  console.log(
    "tos-ledger-verify: no os/one-shot/runs directory — nothing to verify (pass)."
  );
  process.exit(0);
}
const runs = readdirSync(root, { withFileTypes: true })
  .filter(entry => entry.isDirectory())
  .map(entry => entry.name);
let failed = 0;
for (const runId of runs) {
  if (!existsSync(join(root, runId, "run-manifest.json"))) {
    console.error(
      `✖ ${runId}: run directory has no run-manifest.json.\n  Why it matters: a run without its immutable manifest cannot be audited.\n  Fix: restore the manifest from git history or remove the stray directory.`
    );
    failed += 1;
    continue;
  }
  const result = verifyRun(runId);
  if (result.ok) {
    console.log(`✔ ${runId}: ${result.stats.events} events, chain intact.`);
  } else {
    failed += 1;
    console.error(
      `✖ ${runId}: ledger integrity FAILED (${result.errors.length} violation(s)).\n` +
        result.errors.map(error => `  - ${error}`).join("\n") +
        "\n  Why it matters: the event ledger is append-only evidence; any edit, deletion, or reorder after append is indistinguishable from history rewriting.\n  Fix: never edit events.jsonl by hand — restore the file from git history and append a correcting event instead."
    );
  }
}
console.log(
  `tos-ledger-verify: ${runs.length - failed} of ${runs.length} committed run(s) verified.`
);
process.exit(failed === 0 ? 0 : 1);
