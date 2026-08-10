# DEF-023 — CLOSED

**Severity:** HIGH · **Detected by:** P05.T03, seed-gate feasibility
**Authorized by:** the DEF-023 remediation authorization + AMD-008 (DEF-027)

## DETECT

The first real gate the ASSURANCE framework touched turned out to be unable to
reject. `.github/workflows/05-workflow-security.yml#zizmor` is a **required**
status check, and it ran only:

```
zizmor --min-severity high --format sarif .github/workflows/ > zizmor.sarif
```

Measured on zizmor 1.29.0, identical input and flags, exit codes captured
directly (never through a pipe):

| Command | Exit |
| --- | --- |
| `--format plain` | **14** |
| `--format sarif` | **0**, with the finding present in `results` at `level: error` |

Demonstrated on the **real repository**, not a fixture: SARIF mode exited 0
while carrying `zizmor/bot-conditions` at `level: error`.

## ROOT CAUSE

**zizmor detected correctly.** The scanner found the issue and wrote it into
the SARIF. The defect was in the **gate's enforcement logic**: the workflow
treated scanner *process success* as *security success*. Because SARIF mode
exits 0 whether or not findings exist, actionable HIGH findings could coexist
with a green required status; the job failed only if the scanner crashed. The
step's own comment asserted fail-closed behaviour the implementation never
provided.

## CORRECT

Three parts, all required for the invariant to hold:

1. **Fail-closed enforcement** — a second zizmor invocation in plain format,
   same scope and threshold, as the verdict. Option A was selected over
   parsing the SARIF because plain mode's exit status *is* zizmor's severity
   semantics, so no second definition of "blocking" exists to drift
   (`DEC-mechanism-selection.md`). SARIF generation and upload are retained and
   explicitly demoted to reporting. No pipe, no `continue-on-error`, no
   `|| true`. Job name, permissions, and SHA pins unchanged.
2. **A legitimately green control state** — arming the gate exposed the
   repository's one pre-existing HIGH finding, which had been invisible
   precisely because of this defect. Fixed at source under AMD-008
   (`DEF-027-closure.md`), not suppressed.
3. **Contract reconciliation** — both workflow changes were regenerated
   through the canonical P02 extractor after the drift detector correctly
   flagged them.

## TARGETED RETEST — the full invariant

Proven through the P05 ASSURANCE framework against a fresh disposable
candidate built from the corrected committed HEAD, not by an ad hoc script:

| Stage | Result |
| --- | --- |
| Clean repository | zizmor plain enforcement **exit 0**, zero blocking findings |
| Poison applied (canonical template injection, exactly the declared path) | **FAIL, exit 14** |
| Intended detector fired | `error[template-injection]` matched |
| Poison path signature | `p05-poison-template-injection.yml` matched |
| Gate identity | exactly `.github/workflows/05-workflow-security.yml#zizmor` |
| Restoration | byte-identical; declared artifact `zizmor.sarif` removed |
| Control re-run, same gate | **PASS, exit 0** |
| Residue | candidate disposed; zero poison, zero owned resources |
| Verdict | **PROVEN** |

The failure was not caused by a missing tool, malformed command, workflow
parse error, unrelated finding, timeout, infrastructure state, hermeticity
uncertainty, or the wrong gate — each of those would have produced a distinct
`BROKEN_GATE` subcode instead.

## RELEVANT REGRESSION

Full `scripts/` surface, `tsc --noEmit`, prettier, ledger verify, contract
conformance (verify/doc/audit), registry fidelity, P01 provenance, P03/P04/P05
audits, `check-github-actions-security.mjs`, federation docs, frozen install —
exit codes in `CP03-checkpoint.md`.

## NEGATIVE RETEST

The gate is proven able to fail, and the framework proven unable to accept a
false proof. Beyond the poison leg above, the P05 suite re-runs
`WRONG_TARGET`, `WRONG_REASON`, `NON_RESTORING`, `NOT_A_DETECTOR_RESULT`
(TIMEOUT), `UNPROVEN → VERIFIER_BROKEN`, `LIVE_POISON_FIXTURE`, and the
false-assurance suite — each failing for its declared reason.

Historical proof that this gate could NOT reject before the fix is preserved
unchanged: `POSTFIX-zizmor-cycle.txt` shows `BROKEN_GATE(CONTROL_RED)` and the
earlier `FINDING_CONFIRMED` record shows the poison leg passing at exit 0.

## EVIDENCE

`DEF-023-finding.md` (original) · `DEC-mechanism-selection.md` ·
`PREFIX-05-workflow-security.yml` · `PREFIX-zizmor-repo-plain.txt` ·
`PREFIX-zizmor-repo-sarif.json` · `POSTFIX-zizmor-cycle.txt` (blocked state) ·
`POSTFIX-zizmor-PROVEN.txt` (proof) · `assurance.json` (4/4 PROVEN,
`ASSURANCE_GREEN`)

Workflow SHA-256: `c40e7194b599…` → `7bf7f454f7fa…`

## CLOSE

A required check that could not reject now rejects, for the intended detector,
and returns green on a clean tree. The zizmor gate is the **fourth** real
PROVEN ASSURANCE gate.
