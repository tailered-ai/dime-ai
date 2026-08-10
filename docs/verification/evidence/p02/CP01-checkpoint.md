# P02 CHECKPOINT — P02.CP01

| Field | Value |
| --- | --- |
| Branch | `feat/ci-verify-control-plane` |
| P02 execution-start HEAD | `b7f36723b20e1d0de87607b53d64ebf1601ecf49` |
| origin/main (freshly fetched at P02 time) | `4d644cf47d2ee8a1528e1efd8a79da5ce658d8c6` |
| Fresh prospective head_sha | `b7f36723b20e1d0de87607b53d64ebf1601ecf49` |
| base_sha | `4d644cf47d2ee8a1528e1efd8a79da5ce658d8c6` |
| merge_tree_sha | `c13873503ec3ca80bc7e8ab8f9dc3830c4984a95` |
| merge_commit_sha (deterministic) | `3b6b946d8134779a33e8bf9d3001168429a47252` |
| Ledger SHA-256 (pre-CP01) | `eb16d679f00cbe22dbdf8d17a8f2ee6e82303ad12fb344b7368dcf48eaaa4fcb` |
| Blueprint SHA-256 | `4728953d1f93c37349a1bdbca49fb9f0195823727b33b661ea85f0cb383e97bd` |
| Authorized impl source | `AMD-003` |
| Parser | `yaml@2.9.0` (pinned exactly; resolved 2.9.0) |
| Contract schema / canonicalizer | `1.0.0` / `1.0.0` |
| contract.frozen.json SHA-256 | `58087d2a8262064658cac283703777dce60e414f323fbb5f8b54fb6885e172d5` |

P01's pre-commit snapshot was NOT reused. The prospective merge above was
constructed fresh from current committed HEAD and a re-resolved origin/main.

## Corpus and census (authoritative, yaml@2.9.0)
Workflows **40** · jobs **51** · steps **257** · checks **51** · uses refs 120, all SHA-pinned · anchors/aliases 0 · explicit shells 0 · reusable-workflow calls 0 · composite actions 0.

Construct classes: 6 workflow keys, 5 triggers, 12 job keys, 7 step keys, 7 expression roots.

## P00-parser vs P02-parser comparison
Deep per-file, per-JSON-path comparison of js-yaml (P00 discovery) against
yaml@2.9.0 (P02 accepted) over all 40 workflows: **0 differences**, 0 parse
errors. Aggregate census categories also identical across both parsers once
counted with the same methodology. **No semantic disagreement to classify.**
Evidence: `raw/T01-parser-compare.txt` + the script that produced it.

## Runnability
{"LOCAL":18,"LOCAL+TOOL":11,"CI-ONLY":22} — LOCAL / LOCAL+TOOL / CI-ONLY. Every CI-ONLY check carries an explicit
reason; every one of the 257 steps is represented (none omitted).

## Context mapping
All **9** currently required contexts map to exactly one check. All **5**
graduating contexts are represented and are NOT marked required — ruleset state
and workflow existence are kept as separate facts.

## Unit closure
Tasks 8/8 · Positive 2/2 · Negative 4/4 · Regression 1/1 · Conformance 2/2 ·
Audit 1/1 · Evidence 3/3 · Gate 1/1 · Checkpoint 1/1 = **23/23 MANDATORY**.

## Tests
P02 suite **31/31**. Negatives by declared reason:
NEG01 `CONTRACT_GENERATION_FAILED` on `job_keys.container`, prior artifact
byte-preserved, control restores · NEG02 `CONTRACT_DRIFT` naming `ci.yml`,
plus not-represented detection, control restores · NEG03 pin mismatch only
(edit proven to change bytes, no other detector fires) · NEG04
`REQUIRED_CONTEXT_UNMAPPED: "TypeScript Check"` with the pin deliberately
re-computed so the mapping detector is isolated.

## Defects
Opened in P02: **3** — DEF-017 (HIGH, runnability conflated a CI-only side
effect with a CI-only verdict), DEF-018 (HIGH, required tools under-detected via
JSON-escaped matching), DEF-019 (HIGH, AMD-002 recorded a reason that never took
effect). All **CLOSED**. Ledger total **19 defects, 19 closed, 0 open**.

## Audit
Runtime YAML isolation: PASS. 10 files scanned, 2 allowlisted with written
reasons (the extractor, and conformance which reads workflow BYTES for hashing
without parsing). A fixture runtime module importing `yaml` is detected and
control restores green.

## Validation commands and direct exit codes
P02 suite 0 · P01 suite 0 (20/20) · PB suite 0 (35/35) · `vitest run scripts/`
0 (33 files, 479 tests) · `tsc --noEmit` 0 · `prettier --check scripts/ci/` 0 ·
`ledger verify` 0 · contract conformance 0 · CONTRACT.md conformance 0 ·
YAML isolation audit 0 · provenance audit 0 · actions-security 0 ·
federation docs 0 · `pnpm install --frozen-lockfile --ignore-scripts` 0.

## Audit results
Missing evidence NONE · contract drift NONE · infrastructure failures NONE ·
flaky NONE · inconclusive NONE · unexplained parser differences NONE ·
unsupported constructs NONE · partial contract generation NONE ·
required-context mapping gaps NONE · contract hash mismatch NONE ·
runtime YAML bypass NONE.

## Unrelated work
Fingerprint comparison in `p01/raw/`: P02 wrote nothing outside
`scripts/ci/`, `docs/verification/`, and `.prettierignore`.
`.claude/scripts/bootstrap-gstack.sh` continues to be rewritten by its
SessionStart hook (a third hash observed at P02 baseline); reported, never
adopted, never staged.

## ACCEPT(P02) — term by term
```
{
  "phase": "P02",
  "accepted": false,
  "reasons": [
    "UNITS_NOT_CLOSED: P02.CP01",
    "CHECKPOINT_NOT_RECORDED: P02.CP01"
  ],
  "terms": {
    "all_mandatory_closed": false,
    "all_gates_pass": true,
    "all_checkpoints_recorded": false,
    "all_authorizations_granted": true,
    "zero_blocking_open_defects": true,
    "evidence_complete": true,
    "zero_flaky_mandatory": true
  }
}
```
The sole outstanding reason is `P02.CP01`, recorded by this document.

## Decision
**PROCEED TO P03**
