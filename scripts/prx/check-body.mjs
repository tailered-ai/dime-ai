// PRX v1.1 body-gate CLI — thin wrapper over body-check.mjs
// (import-safe: importing this module runs nothing; SOL-PRX-008).
//
// usage:
//   node scripts/prx/check-body.mjs <file>|-
//     [--mode=audit|advisory|enforcing] [--json] [--extract-prose <file>]
//
// Exit codes: 0 = no blocking findings for the mode; 1 = blocking findings
// (enforcing mode only); 2 = usage or tool error.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { checkBody, extractProse } from "./body-check.mjs";
import { parseModeState, resolveVerdict } from "./modes.mjs";

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));

export function defaultMode() {
  return parseModeState(readFileSync(join(MODULE_DIR, "prx-mode.json"), "utf8"))
    .mode;
}

export function main(argv = process.argv.slice(2)) {
  const args = [...argv];
  let mode;
  let json = false;
  let prosePath;
  let input;
  while (args.length > 0) {
    const a = args.shift();
    if (a === "--json") json = true;
    else if (a.startsWith("--mode=")) mode = a.slice("--mode=".length);
    else if (a === "--extract-prose") prosePath = args.shift();
    else if (input === undefined) input = a;
    else {
      process.stderr.write(`unexpected argument: ${a}\n`);
      return 2;
    }
  }
  if (input === undefined) {
    process.stderr.write(
      "usage: check-body.mjs <file>|- [--mode=...] [--json] " +
        "[--extract-prose <file>]\n"
    );
    return 2;
  }
  try {
    mode = mode ?? defaultMode();
    const text =
      input === "-"
        ? readFileSync(0, "utf8")
        : readFileSync(resolve(input), "utf8");
    if (prosePath !== undefined) {
      writeFileSync(resolve(prosePath), extractProse(text));
    }
    const findings = checkBody(text);
    const verdict = resolveVerdict(mode, findings);
    if (json) {
      process.stdout.write(
        `${JSON.stringify({ findings, verdict }, null, 2)}\n`
      );
    } else {
      for (const f of findings) {
        const loc = f.line === undefined ? "" : ` line ${f.line}`;
        process.stdout.write(
          `${f.level.toUpperCase()} ${f.rule}${loc}: ${f.message}\n`
        );
      }
      const errors = findings.filter(f => f.level === "error").length;
      process.stdout.write(
        `PRX body gate: ${errors} error(s), ${findings.length - errors} ` +
          `advisory; mode=${mode}; exit=${verdict.exitCode}\n`
      );
    }
    return verdict.exitCode;
  } catch (err) {
    process.stderr.write(`prx/check-body: ${err.message}\n`);
    return 2;
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  process.exitCode = main();
}
