# DEF-027 — CLOSED

**Severity:** HIGH · **Detected by:** P05.T03 (DEF-023 remediation preflight)
**Authorized by:** AMD-008

## DETECT

`zizmor --min-severity high --format plain .github/workflows/` on the clean
repository exited **14**:
`99 findings (47 ignored, 51 suppressed): … 1 high`, the single HIGH being
`zizmor/bot-conditions` at `.github/workflows/auto-merge-dependabot.yml:27`.
Preserved: `PREFIX-DEF027-clean-plain.txt`, `PREFIX-auto-merge-dependabot.yml`.

## ROOT CAUSE

**The workflow condition, not the scanner.** The job's identity guard read:

```
if: github.actor == 'dependabot[bot]' && github.event.pull_request.user.login == 'dependabot[bot]'
```

`github.actor` is attacker-influenceable — on a workflow re-run it becomes
whoever re-ran it. It was also redundant: it was ANDed with the PR-author
check, which is authoritative. zizmor detected this correctly and rated it
HIGH. The file's own comment already said *"actor alone is spoofable via
re-runs; the PR author check is not"* — the code simply did not follow its own
reasoning.

The finding stayed invisible in production because `05-workflow-security` ran
only zizmor's SARIF form, which exits 0 regardless of findings (DEF-023).

## CORRECT

Removed the redundant spoofable clause; kept the authoritative one:

```
if: github.event.pull_request.user.login == 'dependabot[bot]'
```

Nothing suppressed, ignored, allowlisted, or downgraded. Diff is one condition
line plus its comment. Verified unchanged by structured comparison: triggers,
permissions, job id, job name, `uses:` SHA pins, step-level `if:` guards, and
the `--auto --squash` merge flags.

## TARGETED RETEST

| Check | Result |
| --- | --- |
| `zizmor --min-severity high --format plain .github/workflows/` | **exit 0** |
| Blocking findings | **0 high** |
| `zizmor/bot-conditions` present | **no** |
| Newly introduced HIGH findings | **none** (SARIF blocking-result set empty) |
| SARIF generation | succeeds, exit 0 |

Preserved: `POSTFIX-DEF027-clean-plain.txt`,
`POSTFIX-DEF027-clean-sarif.json`.

## REGRESSION

`scripts/ci/selftest/dependabot-guard.test.ts` — **9/9**. It reads the
workflow as bytes (never parses YAML, so P02 stays the only YAML boundary),
extracts the job condition, and evaluates it against controlled contexts.
Proven: the patch-only guard, `--auto`/`--squash` merge behaviour, triggers,
permissions, job identity, and SHA pinning are all preserved.
`check-github-actions-security.mjs` PASS (40 workflows, 120 action refs, 25
production secret refs, 0 failures).

## NEGATIVE VALIDATION

The guard's behaviour, evaluated rather than argued:

| PR author | actor | Result | Meaning |
| --- | --- | --- | --- |
| `dependabot[bot]` | `dependabot[bot]` | **runs** | normal case preserved |
| `dependabot[bot]` | a human | **runs** | the one behavioural change: a human re-run no longer disables the job |
| `attacker` | `dependabot[bot]` (spoofed) | **refuses** | **the security property** — spoofing the actor cannot satisfy the guard |
| `attacker` | `attacker` | **refuses** | human PRs still skipped |

No row that previously skipped for a security reason now runs. The evaluator
also throws on any construct it cannot judge (`UNEVALUATABLE_TERM`,
`UNKNOWN_CONTEXT`), so a future rewrite into an unrecognised shape fails loudly
instead of being silently approved.

## EVIDENCE

`AMD-008-rationale.md` · `PREFIX-auto-merge-dependabot.yml` ·
`PREFIX-DEF027-clean-plain.txt` · `POSTFIX-DEF027-clean-plain.txt` ·
`POSTFIX-DEF027-clean-sarif.json` · `DEF027-guard-tests.txt` ·
`DRIFT-after-dependabot-fix.txt`

Workflow SHA-256: `ec503bf7147b…` → `cc1fdaa050d8…`

## CLOSE

Clean-tree zizmor enforcement is green, the finding is gone at its source, and
the Dependabot identity guard is strictly no weaker than before — provably
stronger against actor spoofing, since the spoofable input is no longer
consulted.
