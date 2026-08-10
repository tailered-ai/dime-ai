# AMD-008 rationale — authorized Dependabot identity-condition correction

## Authorized action

Remove the redundant, spoofable `github.actor == 'dependabot[bot]'` clause
from the job condition in `.github/workflows/auto-merge-dependabot.yml`,
preserving `github.event.pull_request.user.login == 'dependabot[bot]'`.

## Reason

zizmor's `bot-conditions` audit rates `github.actor` as spoofable: on a
re-run the actor becomes whoever triggered the re-run, so an attacker who can
cause a re-run can satisfy that half of the condition. It is also **redundant**
here — it is ANDed with the PR-author check, which is authoritative and
attacker-uncontrollable.

The workflow's own comment already stated this before the change:
*"actor alone is spoofable via re-runs; the PR author check is not."* The code
did not follow its own reasoning.

## Intended effect

Eliminate the repository's single HIGH `bot-conditions` finding (DEF-027)
**without weakening Dependabot identity enforcement**, so the now fail-closed
`05-workflow-security` gate (DEF-023) has a legitimately green control state.

## Effect on the guard — proven, not asserted

Both before and after, the job runs only when the pull request's author is
`dependabot[bot]`. Truth table over the two operands:

| PR author is dependabot | actor is dependabot | BEFORE (`actor && author`) | AFTER (`author`) |
| --- | --- | --- | --- |
| yes | yes | run | run |
| yes | no (e.g. human re-run) | skip | **run** |
| no | yes (spoofed) | skip | skip |
| no | no | skip | skip |

One row changes: a Dependabot-authored PR whose workflow is re-run by a human
now still runs. That is the intended behaviour — the PR author is what the
gate is about, and re-running a Dependabot PR should not silently disable the
patch-only guard. Crucially, **no row that previously skipped for security
reasons now runs**: the spoofable-actor row (author ≠ dependabot, actor
spoofed) still skips, because the authoritative clause is retained.

Nothing downstream weakens: the patch-only guard
(`steps.meta.outputs.update-type == 'version-update:semver-patch'`) and
branch protection's independent-approval requirement are untouched.

## Rejected alternatives

| Alternative | Why rejected |
| --- | --- |
| Suppress/allowlist the finding (`zizmor: ignore`, config baseline) | Silencing a real finding to obtain green is the exact failure mode this program exists to eliminate |
| Lower zizmor's severity threshold | Hides an entire severity class to fix one finding |
| Revert the DEF-023 fail-closed enforcement | Restores the false-green required check |
| Re-scope DEF-023 to P06 | Leaves a live false-green required check in production indefinitely |
| Alter repository protection / rulesets | Explicitly forbidden, and unrelated to the finding |

## Blast radius

One `if:` condition in one job, plus its adjacent comment. No trigger, job
name, permission, action pin, step, merge logic, or other workflow touched.

## Rollback

Restore the prior condition
(`github.actor == 'dependabot[bot]' && github.event.pull_request.user.login == 'dependabot[bot]'`)
if regression evidence shows the guard's semantics changed unexpectedly. The
prior file is preserved byte-for-byte at
`PREFIX-auto-merge-dependabot.yml`.
