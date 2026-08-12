#!/usr/bin/env node
/**
 * p06/adapters.mjs — faithful local adapter for the gitleaks required check
 * (§ Outcome A), derived from the PINNED action source, not guessed.
 *
 * Measured from gitleaks/gitleaks-action@e0c47f4f8be36e29cdc102c57e68cb5cbf0e8d1e
 * (dist/index.js, sha256 recorded in docs/verification/evidence/p06/action-sources/):
 *
 *   - underlying binary: GITLEAKS_VERSION || "8.24.3"  → governed 8.24.3
 *   - scan command (pull_request event), verbatim from Scan():
 *       gitleaks detect --redact -v --exit-code=2
 *         --report-format=sarif --report-path=results.sarif --log-level=debug
 *         --log-opts=--no-merges --first-parent ${baseRef}^..${headRef}
 *   - baseRef = first commit of the PR (octokit pulls.listCommits data[0],
 *     ascending order); headRef = PR head sha
 *   - config auto-detected from .gitleaks.toml at the source root
 *   - exit 2 = leaks detected; 0 = clean; anything else = scan error
 *
 * GITHUB_TOKEN's role in the action is commit ENUMERATION (plus PR comments
 * / artifact upload, which carry no verdict). The action itself accepts a
 * BASE_REF env override, proving the range is env-derivable without the
 * API. Locally the P01 candidate identity supplies the same range:
 * data[0].sha ≡ the oldest commit of base..head, which
 * `git rev-list --reverse --topo-order base..head | head -1` yields from
 * the same git history the action would enumerate.
 */
import { execFileSync } from "node:child_process";

export function buildGitleaksAdapterStep(ctx, tools) {
  const gitleaks = tools.resolved["gitleaks"];
  const revList = execFileSync(
    "git",
    [
      "rev-list",
      "--reverse",
      "--topo-order",
      `${ctx.base_sha}..${ctx.head_sha}`,
    ],
    { encoding: "utf8" }
  )
    .trim()
    .split("\n")
    .filter(Boolean);
  if (revList.length === 0) {
    throw new Error(
      "GITLEAKS_RANGE_EMPTY: candidate has no commits over base — nothing to scan"
    );
  }
  const firstCommit = revList[0];
  const args = [
    "detect",
    "--redact",
    "-v",
    "--exit-code=2",
    "--report-format=sarif",
    "--report-path=results.sarif",
    "--log-level=debug",
    `--log-opts=--no-merges --first-parent ${firstCommit}^..${ctx.head_sha}`,
  ];
  return {
    index: 1.1,
    kind: "DETECTOR",
    mode: "execute",
    cwd: ".",
    env: {},
    provisioning_signatures: [],
    run: "(uses: gitleaks/gitleaks-action@e0c47f4f)",
    adapted_run: `gitleaks ${args.map(a => (a.includes(" ") ? `'${a}'` : a)).join(" ")}`,
    adaptation_reason:
      "faithful adapter: exact Scan() argv from the pinned action dist; " +
      `governed gitleaks ${gitleaks?.version ?? "UNRESOLVED"} (${gitleaks?.mode ?? "n/a"}); ` +
      `baseRef=${firstCommit.slice(0, 12)} (oldest commit of base..head, ≡ action's ` +
      `pulls.listCommits data[0]), headRef=${ctx.head_sha.slice(0, 12)}; ` +
      `range covers ${revList.length} commit(s)`,
    equivalence_notes: [
      `PR commit count ${revList.length}: the action reads data[0] of the ascending ` +
        "commit list, so pagination cannot change baseRef; equivalence holds for any count",
      "exit 2 = leaks (FAIL), 0 = clean (PASS), other = scan error (fails closed " +
        "as detector failure of a non-2 kind — same as CI, where any nonzero fails the job)",
      "GITHUB_TOKEN not supplied locally: its role (commit enumeration / PR comment) " +
        "carries no verdict; BASE_REF override in the action proves range is env-derivable",
    ],
  };
}
