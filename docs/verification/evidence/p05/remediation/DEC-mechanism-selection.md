# DEF-023 remediation — mechanism selection

Evaluated from first principles against the two candidate mechanisms, before
editing anything. Measured on zizmor 1.29.0.

## The invariant to establish

If zizmor reports one or more findings at or above the configured blocking
severity, the required `05-workflow-security` check must terminate non-zero.
Zero blocking findings may pass. Scanner errors must fail. SARIF generation
and upload must be preserved.

## Option A — second plain-format enforcement run (SELECTED)

Generate SARIF for upload as today, then run zizmor a second time with the
same scope and severity threshold in a format whose process exit status is
proven to reflect findings, capturing that status directly.

Measured, exit codes captured without a pipe:

| Command (same input, same flags) | Exit |
| --- | --- |
| `zizmor --min-severity high --format plain .github/workflows/` | **14** |
| `zizmor --min-severity high --format sarif .github/workflows/` | **0** |

- Uses the scanner's OWN severity semantics. Nothing to drift.
- No policy is reimplemented in YAML, so there is no second definition of
  "blocking" to keep in sync when zizmor's rules or severities change.
- Deterministic and trivially auditable: one command, one exit status.
- Cost: the scan runs twice (~3–5s each on this repository).

## Option B — SARIF-result assertion (REJECTED)

Generate SARIF once, parse it, fail if blocking findings exist, fail if the
SARIF is malformed/absent/truncated.

Rejected because it **reimplements scanner policy**. The workflow would have
to decide what counts as blocking by mapping SARIF `level` values back to
zizmor severities — a second source of truth that can silently diverge the
moment zizmor changes how it emits levels, filters by `--min-severity`, or
represents suppressions. It also adds parsing/IO failure modes that must each
be independently proven fail-closed, enlarging the security-sensitive surface
to audit.

Its only advantage is a single scan, which buys a few seconds.

## Decision

**Option A.** The frozen guidance is explicit — prefer native scanner exit
semantics over reimplementing scanner policy unless repository constraints
make that unsafe or ambiguous. No such constraint exists here: plain mode's
exit status is measured, deterministic, and already the semantics the
workflow's (incorrect) comment assumed it was getting.

The duplication Option A introduces is a repeated *scan*; the duplication
Option B introduces is a repeated *policy*. Policy duplication is the one that
rots.
