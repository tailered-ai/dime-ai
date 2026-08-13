// PRX v1.1 commit-gate CLI — thin wrapper over commit-check.mjs
// (import-safe: importing this module runs nothing; SOL-PRX-008).
//
// usage:
//   node scripts/prx/check-commit.mjs <file>|-
//     [--governed] [--merge] [--bot] [--mode=audit|advisory|enforcing]
//     [--json]
//   node scripts/prx/check-commit.mjs --range <base>..<head> [--repo <dir>]
//     [--mode=...] [--json]
//
// Exit codes: 0 = no blocking findings for the mode; 1 = blocking findings
// (enforcing mode only); 2 = usage or tool error.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { checkCommit } from "./commit-check.mjs";
import { parseModeState, resolveVerdict } from "./modes.mjs";

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));

export function defaultMode() {
  return parseModeState(readFileSync(join(MODULE_DIR, "prx-mode.json"), "utf8"))
    .mode;
}

export function listCommits(repoDir, range) {
  const raw = execFileSync(
    "git",
    ["-C", repoDir, "log", "--format=%H%x00%P%x00%an%x00%ae%x00%B%x1e", range],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }
  );
  const commits = [];
  for (const rec of raw.split("\x1e")) {
    if (rec.trim() === "") continue;
    const [sha, parents, authorName, authorEmail, message] = rec
      .replace(/^\n/, "")
      .split("\x00");
    if (message === undefined) continue;
    commits.push({
      sha,
      isMerge: parents.trim().split(/\s+/).filter(Boolean).length > 1,
      authorIsBot: /\[bot\]/i.test(`${authorName} ${authorEmail}`),
      message,
    });
  }
  return commits;
}

function printFindings(label, findings) {
  for (const f of findings) {
    const loc = f.line === undefined ? "" : ` line ${f.line}`;
    process.stdout.write(
      `${f.level.toUpperCase()} ${f.rule}${label}${loc}: ${f.message}\n`
    );
  }
}

export function main(argv = process.argv.slice(2)) {
  const args = [...argv];
  const flags = { governed: false, merge: false, bot: false, json: false };
  let mode;
  let range;
  let repo = ".";
  let input;
  while (args.length > 0) {
    const a = args.shift();
    if (a === "--governed") flags.governed = true;
    else if (a === "--merge") flags.merge = true;
    else if (a === "--bot") flags.bot = true;
    else if (a === "--json") flags.json = true;
    else if (a.startsWith("--mode=")) mode = a.slice("--mode=".length);
    else if (a === "--range") range = args.shift();
    else if (a === "--repo") repo = args.shift();
    else if (input === undefined) input = a;
    else {
      process.stderr.write(`unexpected argument: ${a}\n`);
      return 2;
    }
  }
  try {
    mode = mode ?? defaultMode();
    const results = [];
    if (range !== undefined) {
      if (!/^[0-9a-fA-F~^]+\.\.[0-9a-fA-F~^]+$/.test(range ?? "")) {
        process.stderr.write("--range requires <baseSha>..<headSha>\n");
        return 2;
      }
      for (const c of listCommits(resolve(repo), range)) {
        results.push({
          id: c.sha.slice(0, 7),
          findings: checkCommit(c.message, {
            isMerge: c.isMerge,
            authorIsBot: c.authorIsBot,
          }),
        });
      }
    } else {
      if (input === undefined) {
        process.stderr.write(
          "usage: check-commit.mjs <file>|- [--governed] [--merge] [--bot] " +
            "[--mode=...] [--json] | --range <base>..<head> [--repo <dir>]\n"
        );
        return 2;
      }
      const text =
        input === "-"
          ? readFileSync(0, "utf8")
          : readFileSync(resolve(input), "utf8");
      results.push({
        id: input,
        findings: checkCommit(text, {
          governed: flags.governed,
          isMerge: flags.merge,
          authorIsBot: flags.bot,
        }),
      });
    }
    const all = results.flatMap(r => r.findings);
    const verdict = resolveVerdict(mode, all);
    if (flags.json) {
      process.stdout.write(
        `${JSON.stringify({ results, verdict }, null, 2)}\n`
      );
    } else {
      for (const r of results) printFindings(` [${r.id}]`, r.findings);
      const errors = all.filter(f => f.level === "error").length;
      process.stdout.write(
        `PRX commit gate: ${errors} error(s), ${all.length - errors} ` +
          `advisory; mode=${mode}; exit=${verdict.exitCode}\n`
      );
    }
    return verdict.exitCode;
  } catch (err) {
    process.stderr.write(`prx/check-commit: ${err.message}\n`);
    return 2;
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  process.exitCode = main();
}
