# DEF-023 — the required `05-workflow-security` check cannot reject

**Severity:** HIGH · **Status: OPEN** · **Remediation owner: P06.T05 + owner
decision** (the fix edits a production CI workflow, which is outside P05's
authorized scope)

**Detected by:** P05.T03, during seed-gate feasibility — the first thing the
ASSURANCE framework did with a real gate was prove one cannot reject.

## The finding

`.github/workflows/05-workflow-security.yml#zizmor` is a **required** status
check (registry: `required=Y`). Its scan step is:

```
zizmor --min-severity high --format sarif .github/workflows/ > zizmor.sarif
# zizmor exits non-zero when findings >= min-severity exist; a scan
# crash also exits non-zero. Either way this step fails — fail-closed.
```

That comment is wrong. Measured on zizmor 1.29.0, same input, same flags,
exit codes captured directly (never through a pipe):

| Command | Exit |
| --- | --- |
| `zizmor --min-severity high --format plain .github/workflows/` | **14** |
| `zizmor --min-severity high --format sarif .github/workflows/` | **0** |

The SARIF the gate produces *contains the finding* —
`ruleId: zizmor/template-injection`, `level: error`, `results: 1` — and the
step still exits 0. The job then uploads the SARIF to code scanning, which
raises an alert but does not fail the check.

**Consequence:** a required workflow-security gate is green regardless of
High-severity workflow-security findings. It fails only if zizmor itself
crashes. This is the same class as the already-recorded
`codeql-green-check-hides-alerts` lesson: a green check that hides its own
alerts.

## How it was proven

A poison fixture (`workflow-template-injection`) introduces a direct
interpolation of `github.event.issue.title` into a `run:` block — the textbook
template-injection that zizmor rates High. The full cycle ran through the
canonical framework:

- poison applied inside a disposable candidate, exactly one declared path;
- the gate's own contract command executed via the P04 pathway;
- **poison leg result: PASS, exit 0**;
- declared reason signature matched inside `zizmor.sarif`
  (`zizmor/template-injection`) — the detector *did* see it;
- control restored byte-for-byte; control leg PASS.

Detector fires, gate stays green. Recorded as
`verdict: FINDING_CONFIRMED`, never as proof.

Raw evidence: `raw/DEF-023-zizmor-sarif.json` (the SARIF, 1 result),
`raw/DEF-023-zizmor-plain.txt` (the plain-format report), and the fixture at
`scripts/ci/selftest/fixtures/workflow-template-injection/`.

## Why it is still OPEN

The fix edits a production CI workflow. P05's authorization forbids
implementing P06 gates or amending a gate to make a fixture pass — and
amending this one would do exactly that. Editing it is also a change that
takes effect on merge, so it is owner-scoped.

What P05 *did* do, inside its authority, is make the weakness impossible to
lose or ignore:

- the gate carries `cannot_reject: true` and `proof_state: UNPROVEN` in the
  machine coverage table and in `assurance.json`;
- a `finding`-applicability fixture can **never** be counted as proof —
  `P05.NEG03` proves a `FINDING_CONFIRMED` record forces `UNPROVEN` and, once
  the gate is graduated, `BROKEN_GATE(UNPROVEN) → VERIFIER_BROKEN`;
- therefore **P06 cannot graduate this gate while it remains unable to
  reject** — the coverage law will block it.

## Recommended remediation (owner decision)

Make the step fail on findings while keeping the SARIF upload, e.g. run the
scan twice (SARIF for upload, plain for the gate) or check the SARIF result
count. Either restores fail-closed behaviour without losing code-scanning
integration. Not applied here.
