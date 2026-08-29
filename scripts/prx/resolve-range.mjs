// PRX v1.1 audit-range resolution — FAIL CLOSED (remediation R2).
// Replaces the workflow's rejected fail-open pattern
//   git merge-base "$BASE" "$HEAD" || echo "$BASE"
// which silently substituted a different audit range whenever merge-base
// failed. This module is the exact code CI executes (the workflow calls it
// from the selected policy tree), not a bash mirror, so its tests cover the
// shipped behavior directly. Import-safe: importing runs nothing.
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { SHA40_RE } from "./rules.mjs";

function runGit(repoDir, args) {
  return execFileSync("git", ["-C", repoDir, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

// Resolves the merge base of the two authenticated event SHAs, or throws.
// Every failure mode is a hard error — a merge-base failure must produce a
// red tool failure and must never silently substitute another range.
// deps.git is injectable ONLY so tests can prove the output validation
// rejects malformed git output; production callers pass nothing.
export function resolveAuditRange(repoDir, baseSha, headSha, deps = {}) {
  const git = deps.git ?? runGit;
  for (const [name, sha] of [
    ["base", baseSha],
    ["head", headSha],
  ]) {
    if (typeof sha !== "string" || !SHA40_RE.test(sha)) {
      throw new Error(
        `${name} SHA ${JSON.stringify(sha)} is not a full 40-hex commit SHA`
      );
    }
  }
  for (const [name, sha] of [
    ["base", baseSha],
    ["head", headSha],
  ]) {
    try {
      git(repoDir, ["cat-file", "-e", `${sha}^{commit}`]);
    } catch {
      throw new Error(
        `${name} commit ${sha} does not exist in the repository at ${repoDir}`
      );
    }
  }
  let mergeBase;
  try {
    mergeBase = git(repoDir, ["merge-base", baseSha, headSha]).trim();
  } catch {
    throw new Error(
      `unable to resolve the merge base of ${baseSha} and ${headSha} (unrelated histories or corrupt repository)`
    );
  }
  if (!SHA40_RE.test(mergeBase)) {
    throw new Error(
      `merge-base output ${JSON.stringify(mergeBase.slice(0, 80))} is not a full 40-hex commit SHA`
    );
  }
  try {
    git(repoDir, ["merge-base", "--is-ancestor", mergeBase, headSha]);
  } catch {
    throw new Error(
      `resolved merge base ${mergeBase} is not an ancestor of head ${headSha}`
    );
  }
  return { mergeBase, range: `${mergeBase}..${headSha}` };
}

// CLI: prints the merge base to stdout on success (exit 0); resolution
// failures exit 1 with the reason on stderr; usage errors exit 2.
export function main(argv = process.argv.slice(2)) {
  const args = [...argv];
  let repo;
  let base;
  let head;
  while (args.length > 0) {
    const a = args.shift();
    if (a === "--repo") repo = args.shift();
    else if (a === "--base") base = args.shift();
    else if (a === "--head") head = args.shift();
    else {
      process.stderr.write(`unexpected argument: ${a}\n`);
      return 2;
    }
  }
  if (repo === undefined || base === undefined || head === undefined) {
    process.stderr.write(
      "usage: resolve-range.mjs --repo <dir> --base <sha40> --head <sha40>\n"
    );
    return 2;
  }
  try {
    const { mergeBase } = resolveAuditRange(resolve(repo), base, head);
    process.stdout.write(`${mergeBase}\n`);
    return 0;
  } catch (err) {
    process.stderr.write(`prx/resolve-range: ${err.message}\n`);
    return 1;
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  process.exitCode = main();
}
