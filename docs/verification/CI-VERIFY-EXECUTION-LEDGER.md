# ci:verify — execution ledger

> GENERATED FILE. Do not edit by hand. Source of truth is
> `ci-verify-ledger.json`, written only by `scripts/ci/ledger.mjs`.
> Hand edits break `ci-verify-ledger.sha256` (LEDGER_TAMPERED) and are
> detected by `node scripts/ci/ledger.mjs verify`.

## Genesis — GEN-000 (self-attesting trust root)

| Field | Value |
| --- | --- |
| `blueprint_sha256` | `c6fedcf41a842f55786737e2f8cd64c938b2cd626ba3dfb0b5518dcbeb6d139d` |
| `blueprint_version` | `1.0.0` |
| `created_at` | `2026-08-10T08:18:18.478Z` |
| `git_head_at_bootstrap` | `unknown` |
| `ledger_impl_sha256` | `690ba34fb1e40871ea1a7d29f0c3afc28ed4ba2b05f81432a11cd9f96687873d` |
| `note` | `Trust root. Cannot be evidence-enforced by a writer that does not yet exist at bootstrap; verified retroactively by P03.NEG04 and bound into the P10 execution-history hash.` |
| `record_id` | `GEN-000` |
| `schema_version` | `1.0.0` |
| `self_attesting` | `true` |

## Phase roll-up (MANDATORY units only)

| Phase | Title | State | Closed / Total | Failed | Blocked |
| --- | --- | --- | --- | --- | --- |
| `PB` | Control-plane bootstrap | `ACCEPTED` | 15 / 15 | 0 | 0 |
| `P00` | Pre-flight resolution | `ACCEPTED` | 14 / 14 | 0 | 0 |
| `P01` | Snapshot resolution and prospective-merge materialization | `ACCEPTED` | 25 / 25 | 0 | 0 |
| `P02` | Contract extraction, freeze, conformance | `ACCEPTED` | 23 / 23 | 0 | 0 |
| `P03` | Registries, taxonomy, reporter, ledger integration | `ACCEPTED` | 24 / 24 | 0 | 0 |
| `P04` | Executor core | `ACCEPTED` | 30 / 30 | 0 | 0 |
| `P05` | ASSURANCE — the self-test framework | `ACCEPTED` | 27 / 27 | 0 | 0 |
| `P06` | PARITY — static, security, supply chain | `ACCEPTED` | 29 / 29 | 0 | 0 |
| `P07` | PARITY — test and data | `ACCEPTED` | 24 / 24 | 0 | 0 |
| `P08` | CLEANROOM — image identity, container build, dual runtime proof | `ACCEPTED` | 23 / 23 | 0 | 0 |
| `P09` | HARDENING | `ACCEPTED` | 17 / 17 | 0 | 0 |
| `P10` | Certificate, REMOTE reconciliation, LOCAL_READY_FOR_PR | `ACCEPTED` | 22 / 22 | 0 | 0 |

## PB — Control-plane bootstrap

**State:** `ACCEPTED`

**Assurance property:** The execution ledger exists, is tool-written, evidence-enforcing, tamper-evident, and covers every declared blueprint ID before any verifier work begins.

**Depends on:** none

**Progress (MANDATORY):** 15 / 15

**Entry checklist**

- [ ] Repository readable
- [ ] Node/pnpm/git versions captured in the execution baseline
- [ ] Branch feat/ci-verify-control-plane cut from origin/main

**Exit checklist**

- [ ] PB.T01..PB.T05 closed
- [ ] PB.TEST01, PB.TEST02 PASS
- [ ] PB.NEG01, PB.NEG02 PASS
- [ ] PB.GATE01 PASS
- [ ] PB.CP01 recorded

| ID | Kind | Class | Status | Attempts | Evidence | Title |
| --- | --- | --- | --- | --- | --- | --- |
| `PB.T01` | TASK | MANDATORY | `PASS` | 1 | `e53b58c7f35b` | Create scripts/ci/ledger.mjs — the sole ledger writer, with §0.3 evidence enforcement |
| `PB.T02` | TASK | MANDATORY | `PASS` | 1 | `ed22d5bef4d0` | Initialize docs/verification/ci-verify-ledger.json seeded with every declared P00-P10 ID at NOT_STARTED |
| `PB.T03` | TASK | MANDATORY | `PASS` | 1 | `3f79a2f1aea8` | Create self-attesting genesis record GEN-000 {schema_version, ledger_impl_sha256, blueprint_sha256, git_head_at_bootstrap, created_at} |
| `PB.T04` | TASK | MANDATORY | `PASS` | 1 | `2113ef73d9a5` | Generate docs/verification/ci-verify-ledger.sha256 |
| `PB.T05` | TASK | MANDATORY | `PASS` | 1 | `00e4feea2b04` | Generate docs/verification/CI-VERIFY-EXECUTION-LEDGER.md exclusively from the JSON |
| `PB.T06` | TASK | MANDATORY | `PASS` | 1 | `7a24220c6f06` `cc1cabc9dfb6` | Append-only amendment + sync mechanism: authorized-implementation-hash amendments (AMD-*) and additive unit sync, so a post-bootstrap correction never rewrites genesis GEN-000 |
| `PB.TEST01` | POSITIVE_VALIDATION | MANDATORY | `PASS` | 1 | `0587c98587b2` | Every blueprint ID appears in the initialized ledger exactly once |
| `PB.TEST02` | POSITIVE_VALIDATION | MANDATORY | `PASS` | 1 | `0587c98587b2` | Rendered markdown conforms exactly to the JSON (render is a pure function of state) |
| `PB.TEST03` | POSITIVE_VALIDATION | MANDATORY | `PASS` | 1 | `0d1ae9c510ec` `259a8c1302b7` | Full ACCEPT(P) predicate: table-driven proof that the complete conjunction returns true and every individual term is independently load-bearing |
| `PB.NEG01` | NEGATIVE_VALIDATION | MANDATORY | `PASS` | 1 | `0587c98587b2` | Duplicate ID in the blueprint FAILS initialization |
| `PB.NEG02` | NEGATIVE_VALIDATION | MANDATORY | `PASS` | 1 | `0587c98587b2` | A declared blueprint ID missing from the seed FAILS initialization |
| `PB.NEG03` | NEGATIVE_VALIDATION | MANDATORY | `PASS` | 1 | `0d1ae9c510ec` `86836244f622` | Acceptance negatives: one OPEN MEDIUM defect, one missing evidence hash, one failed gate, one ungranted authorization, and one FLAKY mandatory unit each independently force acceptance false |
| `PB.REG01` | REGRESSION | MANDATORY | `PASS` | 1 | `0d1ae9c510ec` `09cefe77e55b` | Regression: PB.TEST01/TEST02/NEG01/NEG02 and ledger verify still hold after the DEF-004 correction and the amendment mechanism |
| `PB.GATE01` | ACCEPTANCE_GATE | MANDATORY | `PASS` | 1 | `6114bb6ec53b` `d83d9a287106` | Genesis record, ledger sha256, and rendered ledger all exist and verify |
| `PB.CP01` | CHECKPOINT | MANDATORY | `PASS` | 1 | `7b75b64faad4` | P-BOOT checkpoint recorded with PROCEED / DO NOT PROCEED decision |

## P00 — Pre-flight resolution

**State:** `ACCEPTED`

**Assurance property:** Every blocking unknown that changes the shape of the contract is answered from direct repository/GitHub evidence, never inference.

**Depends on:** `PB`

**Progress (MANDATORY):** 14 / 14

**Entry checklist**

- [ ] PB ACCEPTED
- [ ] Repository readable
- [ ] gh authenticated
- [ ] Ledger initialized

**Exit checklist**

- [ ] P00.T01..P00.T05 PASS
- [ ] P00.EV01..P00.EV05 hashed
- [ ] P00.AUD01 PASS
- [ ] P00.GATE01 PASS
- [ ] P00.CP01 recorded

| ID | Kind | Class | Status | Attempts | Evidence | Title |
| --- | --- | --- | --- | --- | --- | --- |
| `P00.T01` | TASK | MANDATORY | `PASS` | 1 | `a24f1a67890c` `d2dda9552c87` | Determine whether the merge queue is ENABLED, versus workflows merely carrying merge_group: triggers |
| `P00.T02` | TASK | MANDATORY | `PASS` | 1 | `01fa94dc01d2` `adee1091a950` | Enumerate exactly which required status contexts are enforced TODAY versus still graduating |
| `P00.T03` | TASK | MANDATORY | `PASS` | 1 | `133374077d13` `7c092c9441f6` | Determine whether scripts/** is inside patch-coverage measurement scope |
| `P00.T04` | TASK | MANDATORY | `PASS` | 1 | `44e3ede97d9f` `8726b147de78` | Inventory GitHub Actions constructs across ALL workflows — the contract-parser construct census |
| `P00.T05` | TASK | MANDATORY | `PASS` | 1 | `4377d26dd8e1` `3a436c60ec11` | Determine the exact filesystem scope inspected by check-github-actions-security.mjs |
| `P00.AUD01` | AUDIT | MANDATORY | `PASS` | 1 | `1ad43be017c8` | Audit: every answer carries an exact command and preserved output — zero inferences |
| `P00.EV01` | EVIDENCE | MANDATORY | `PASS` | 1 | `a24f1a67890c` | Evidence artifact for P00.T01 |
| `P00.EV02` | EVIDENCE | MANDATORY | `PASS` | 1 | `01fa94dc01d2` | Evidence artifact for P00.T02 |
| `P00.EV03` | EVIDENCE | MANDATORY | `PASS` | 1 | `133374077d13` | Evidence artifact for P00.T03 |
| `P00.EV04` | EVIDENCE | MANDATORY | `PASS` | 1 | `44e3ede97d9f` | Evidence artifact for P00.T04 |
| `P00.EV05` | EVIDENCE | MANDATORY | `PASS` | 1 | `4377d26dd8e1` | Evidence artifact for P00.T05 |
| `P00.GATE01` | ACCEPTANCE_GATE | MANDATORY | `PASS` | 1 | `ad49823b6831` `1ad43be017c8` | Five of five pre-flight unknowns answered with verifiable evidence |
| `P00.CP01` | CHECKPOINT | MANDATORY | `PASS` | 1 | `9a0d5373db77` | P00 checkpoint report with binary PROCEED TO P01 / DO NOT PROCEED decision |
| `P00.CP02` | CHECKPOINT | MANDATORY | `PASS` | 1 | `56e2ba284da9` `2ddd2d159def` | P00 re-evaluation checkpoint after DEF-002/DEF-003/DEF-004 remediation, superseding P00.CP01 append-only |

## P01 — Snapshot resolution and prospective-merge materialization

**State:** `ACCEPTED`

**Assurance property:** Verification runs against the prospective merge of HEAD into origin/main, with deterministic, single-owner SHA provenance.

**Depends on:** `P00`

**Progress (MANDATORY):** 25 / 25

**Entry checklist**

- [ ] P00 ACCEPTED
- [ ] Scratch directory writable
- [ ] git >= 2.38 (merge-tree --write-tree)

**Exit checklist**

- [ ] P01.T01..P01.T09 closed
- [ ] P01.TEST01..TEST04 PASS
- [ ] P01.NEG01..NEG05 PASS
- [ ] P01.REG01, P01.CLN01, P01.AUD01 PASS
- [ ] P01.EV01, P01.EV02 hashed
- [ ] P01.GATE01 PASS
- [ ] P01.CP01 recorded

| ID | Kind | Class | Status | Attempts | Evidence | Title |
| --- | --- | --- | --- | --- | --- | --- |
| `P01.T01` | TASK | MANDATORY | `PASS` | 1 | `ab238d930369` `9b2c46d8aa79` | Run layout under the scratch directory (.ci-verify/runs/<run_id>/) |
| `P01.T02` | TASK | MANDATORY | `PASS` | 1 | `ab238d930369` `9b2c46d8aa79` | Base fetch and resolve (git fetch origin main; base_sha) |
| `P01.T03` | TASK | MANDATORY | `PASS` | 1 | `ab238d930369` `9b2c46d8aa79` | Head resolve plus dirty-tree policy (--committed default, --stash-probe advisory) |
| `P01.T04` | TASK | MANDATORY | `PASS` | 1 | `ab238d930369` `9b2c46d8aa79` | merge-tree --write-tree produces merge_tree_sha; conflict is BLOCKED |
| `P01.T05` | TASK | MANDATORY | `PASS` | 1 | `ab238d930369` `9b2c46d8aa79` | commit-tree synthetic merge with DETERMINISTIC metadata (fixed identity, T = max(base,head committer time)+1, +0000, fixed message, parents base-then-head) |
| `P01.T06` | TASK | MANDATORY | `PASS` | 1 | `ab238d930369` `9b2c46d8aa79` | worktree add --detach at merge_commit_sha |
| `P01.T07` | TASK | MANDATORY | `PASS` | 1 | `ab238d930369` `9b2c46d8aa79` | Emit snapshot.json with all four SHAs, mode, dirty flag, git version |
| `P01.T08` | TASK | MANDATORY | `PASS` | 1 | `ab238d930369` `9b2c46d8aa79` | Provenance API — the sole owner of SHA resolution; no gate calls git rev-parse directly |
| `P01.T09` | TASK | MANDATORY | `PASS` | 1 | `ab238d930369` `9b2c46d8aa79` | Add .ci-verify/, vitest-results.phase-*.json, local-proof-contract.json to .gitignore |
| `P01.TEST01` | POSITIVE_VALIDATION | MANDATORY | `PASS` | 1 | `058f5c60b32c` | Clean branch ahead of main yields four distinct SHAs and a worktree at the merge commit |
| `P01.TEST02` | POSITIVE_VALIDATION | MANDATORY | `PASS` | 1 | `058f5c60b32c` | Branch identical to main: merge_tree_sha equals base tree |
| `P01.TEST03` | POSITIVE_VALIDATION | MANDATORY | `PASS` | 1 | `058f5c60b32c` | snapshot.json validates against its schema |
| `P01.TEST04` | POSITIVE_VALIDATION | MANDATORY | `PASS` | 1 | `058f5c60b32c` | Determinism: same {head,base} yields identical merge_tree_sha AND merge_commit_sha across >=5 runs and two clocks |
| `P01.NEG01` | NEGATIVE_VALIDATION | MANDATORY | `PASS` | 1 | `058f5c60b32c` | Conflicting branch yields BLOCKED(MERGE_CONFLICT) naming the conflicting paths |
| `P01.NEG02` | NEGATIVE_VALIDATION | MANDATORY | `PASS` | 1 | `fc14a7941932` `058f5c60b32c` | Dirty tree in default mode yields BLOCKED(DIRTY_TREE) |
| `P01.NEG03` | NEGATIVE_VALIDATION | MANDATORY | `PASS` | 1 | `058f5c60b32c` | Simulated worktree-add failure yields INFRA-FAIL and leaves no orphan worktree |
| `P01.NEG04` | NEGATIVE_VALIDATION | MANDATORY | `PASS` | 1 | `058f5c60b32c` | A gate calling git rev-parse directly fails the provenance audit |
| `P01.NEG05` | NEGATIVE_VALIDATION | MANDATORY | `PASS` | 1 | `058f5c60b32c` | Unpinning any single commit-metadata field changes merge_commit_sha — proving the pin is load-bearing |
| `P01.REG01` | REGRESSION | MANDATORY | `PASS` | 1 | `da1208e20b82` | 20 consecutive runs leave the worktree count stable |
| `P01.CLN01` | CLEANUP | MANDATORY | `PASS` | 1 | `b6cf771462ab` `0c1f7618eafa` | SIGINT during snapshot removes the worktree |
| `P01.AUD01` | AUDIT | MANDATORY | `PASS` | 1 | `419990139fe0` `6fb07e5b0f9b` | Static proof that no module bypasses the P01.T08 provenance API |
| `P01.EV01` | EVIDENCE | MANDATORY | `PASS` | 1 | `9b2c46d8aa79` | Evidence: snapshot.json |
| `P01.EV02` | EVIDENCE | MANDATORY | `PASS` | 1 | `38c1a3597f0e` | Evidence: worktree residue log |
| `P01.GATE01` | ACCEPTANCE_GATE | MANDATORY | `PASS` | 1 | `0203cd21076b` `da1208e20b82` `b6cf771462ab` | P01.REG01 and P01.CLN01 PASS |
| `P01.CP01` | CHECKPOINT | MANDATORY | `PASS` | 1 | `51ccc53de3f1` `0203cd21076b` | P01 checkpoint recorded |

## P02 — Contract extraction, freeze, conformance

**State:** `ACCEPTED`

**Assurance property:** There is exactly one machine-readable definition of the merge contract, frozen and checksummed, and the runtime never parses YAML.

**Depends on:** `P01`

**Progress (MANDATORY):** 23 / 23

**Entry checklist**

- [ ] P01 ACCEPTED
- [ ] P00.T04 construct census available

**Exit checklist**

- [ ] P02.T01..P02.T08 closed
- [ ] P02.TEST01, TEST02 PASS
- [ ] P02.NEG01..NEG04 PASS
- [ ] P02.CONF01, P02.AUD01 PASS
- [ ] P02.EV01..EV03 hashed
- [ ] P02.GATE01 PASS
- [ ] P02.CP01 recorded

| ID | Kind | Class | Status | Attempts | Evidence | Title |
| --- | --- | --- | --- | --- | --- | --- |
| `P02.T01` | TASK | MANDATORY | `PASS` | 1 | `a7863a04df4e` `ae32cd8de4b8` | Census consumer — read the P00.T04 construct inventory as the parser allowlist |
| `P02.T02` | TASK | MANDATORY | `PASS` | 1 | `a7863a04df4e` `ae32cd8de4b8` | Canonicalizer — stable key order and expression normalization |
| `P02.T03` | TASK | MANDATORY | `PASS` | 1 | `a7863a04df4e` `ae32cd8de4b8` | Per-workflow sha256 hashing |
| `P02.T04` | TASK | MANDATORY | `PASS` | 1 | `a7863a04df4e` `ae32cd8de4b8` | Emitter with schema_version and parser_version |
| `P02.T05` | TASK | MANDATORY | `PASS` | 1 | `a7863a04df4e` `ae32cd8de4b8` | Allowlist enforcement — abort on any non-allowlisted construct, never partial output |
| `P02.T06` | TASK | MANDATORY | `PASS` | 1 | `a7863a04df4e` `ae32cd8de4b8` | Generate contract.sha256 |
| `P02.T07` | TASK | MANDATORY | `PASS` | 1 | `a7863a04df4e` `ae32cd8de4b8` | Conformance test — workflow change without regeneration fails |
| `P02.T08` | TASK | MANDATORY | `PASS` | 1 | `a7863a04df4e` `ae32cd8de4b8` | Render docs/verification/CONTRACT.md |
| `P02.TEST01` | POSITIVE_VALIDATION | MANDATORY | `PASS` | 1 | `7be688044165` | Regeneration is byte-stable across runs |
| `P02.TEST02` | POSITIVE_VALIDATION | MANDATORY | `PASS` | 1 | `7be688044165` | Every required status context maps to a check id |
| `P02.NEG01` | NEGATIVE_VALIDATION | MANDATORY | `PASS` | 1 | `7be688044165` | Non-allowlisted construct aborts generation with NO partial file written |
| `P02.NEG02` | NEGATIVE_VALIDATION | MANDATORY | `PASS` | 1 | `7be688044165` | Workflow mutated without regeneration yields CONTRACT-DRIFT |
| `P02.NEG03` | NEGATIVE_VALIDATION | MANDATORY | `PASS` | 1 | `7be688044165` | Hand-edited frozen contract yields sha256 mismatch |
| `P02.NEG04` | NEGATIVE_VALIDATION | MANDATORY | `PASS` | 1 | `7be688044165` | Required context with no local mapping fails, naming the context |
| `P02.REG01` | REGRESSION | MANDATORY | `PASS` | 1 | `7be688044165` | Pinned-parser regression: yaml@2.9.0 correctly handles every construct class actually present, and its YAML 1.2 semantics are intentional rather than accidental |
| `P02.CONF01` | CONFORMANCE | MANDATORY | `PASS` | 1 | `7be688044165` `ae32cd8de4b8` | Conformance: frozen contract matches the workflow tree |
| `P02.CONF02` | CONFORMANCE | MANDATORY | `PASS` | 1 | `7be688044165` `ae32cd8de4b8` | Rendered-document conformance: CONTRACT.md is byte-identical to a fresh render of contract.frozen.json |
| `P02.AUD01` | AUDIT | MANDATORY | `PASS` | 1 | `12d5fa4efd7e` `7be688044165` | Audit: zero YAML parsing in any runtime execution path |
| `P02.EV01` | EVIDENCE | MANDATORY | `PASS` | 1 | `ac630d2ea196` | Evidence: contract.frozen.json |
| `P02.EV02` | EVIDENCE | MANDATORY | `PASS` | 1 | `46efbe66e64b` `21ba3fa355a8` | Evidence: contract.sha256 |
| `P02.EV03` | EVIDENCE | MANDATORY | `PASS` | 1 | `207733e171d2` | Evidence: construct census as consumed |
| `P02.GATE01` | ACCEPTANCE_GATE | MANDATORY | `PASS` | 1 | `ae32cd8de4b8` `7be688044165` `46efbe66e64b` | P02.NEG01..NEG04 all PASS |
| `P02.CP01` | CHECKPOINT | MANDATORY | `PASS` | 1 | `1a36ea25a1e4` `ae32cd8de4b8` | P02 checkpoint recorded |

## P03 — Registries, taxonomy, reporter, ledger integration

**State:** `ACCEPTED`

**Assurance property:** Every gate result carries a class and a status from a closed vocabulary, and no class can be silently collapsed into one verdict.

**Depends on:** `P02`

**Progress (MANDATORY):** 24 / 24

**Entry checklist**

- [ ] P02 ACCEPTED
- [ ] Ledger operational from P-BOOT

**Exit checklist**

- [ ] P03.T01..P03.T08 closed
- [ ] P03.TEST01, TEST02 PASS
- [ ] P03.NEG01..NEG05 PASS
- [ ] P03.GATE01, P03.GATE02 PASS
- [ ] P03.CP01 recorded

| ID | Kind | Class | Status | Attempts | Evidence | Title |
| --- | --- | --- | --- | --- | --- | --- |
| `P03.T01` | TASK | MANDATORY | `PASS` | 1 | `d0410b15eb5d` `d578bb6b1ab4` | Implement the 12-status result model |
| `P03.T02` | TASK | MANDATORY | `PASS` | 1 | `d0410b15eb5d` `d578bb6b1ab4` | Class-to-terminal-state reduction |
| `P03.T03` | TASK | MANDATORY | `PASS` | 1 | `d0410b15eb5d` `d578bb6b1ab4` | PARITY registry loader — contract-derived and immutable |
| `P03.T04` | TASK | MANDATORY | `PASS` | 1 | `d0410b15eb5d` `d578bb6b1ab4` | HARDENING registry scaffold |
| `P03.T05` | TASK | MANDATORY | `PASS` | 1 | `d0410b15eb5d` `d578bb6b1ab4` | JSONL reporter |
| `P03.T06` | TASK | MANDATORY | `PASS` | 1 | `d0410b15eb5d` `d578bb6b1ab4` | Six-class summary renderer |
| `P03.T07` | TASK | MANDATORY | `PASS` | 1 | `d0410b15eb5d` `d578bb6b1ab4` | INTEGRATE the already-existing ledger from P-BOOT (bind taxonomy, wire reporter) — does not create the writer |
| `P03.T08` | TASK | MANDATORY | `PASS` | 1 | `d0410b15eb5d` `d578bb6b1ab4` | Ledger render plus render-conformance wiring |
| `P03.TEST01` | POSITIVE_VALIDATION | MANDATORY | `PASS` | 1 | `d61950688f8c` | Table-driven coverage of all 12 statuses across all 6 classes |
| `P03.TEST02` | POSITIVE_VALIDATION | MANDATORY | `PASS` | 1 | `d61950688f8c` | Summary renders every class, including empty ones |
| `P03.TEST03` | POSITIVE_VALIDATION | MANDATORY | `PASS` | 1 | `d61950688f8c` | False-green adversarial suite: no combination of results, omissions, duplicates, aggregation or rendering can manufacture a misleading green state |
| `P03.NEG01` | NEGATIVE_VALIDATION | MANDATORY | `PASS` | 1 | `d61950688f8c` | FLAKY must never reduce to PASS |
| `P03.NEG02` | NEGATIVE_VALIDATION | MANDATORY | `PASS` | 1 | `d61950688f8c` | Programmatic append to the PARITY registry throws |
| `P03.NEG03` | NEGATIVE_VALIDATION | MANDATORY | `PASS` | 1 | `d61950688f8c` | set PASS without verifiable evidence is refused |
| `P03.NEG04` | NEGATIVE_VALIDATION | MANDATORY | `PASS` | 1 | `d61950688f8c` `d578bb6b1ab4` | Hand-edited ledger yields LEDGER_TAMPERED |
| `P03.NEG05` | NEGATIVE_VALIDATION | MANDATORY | `PASS` | 1 | `d61950688f8c` `d578bb6b1ab4` | Rendered markdown diverging from JSON fails conformance |
| `P03.CONF01` | CONFORMANCE | MANDATORY | `PASS` | 1 | `d61950688f8c` | Ledger render conformance after P03 integration: CI-VERIFY-EXECUTION-LEDGER.md is byte-identical to a fresh render and cannot create a green state absent from canonical JSON |
| `P03.AUD01` | AUDIT | MANDATORY | `PASS` | 1 | `6c5102f18c12` `d61950688f8c` | Contract-to-registry fidelity audit: PARITY membership and every field are a faithful projection of the frozen contract, with DEF-017 and DEF-018 regression anchors |
| `P03.AUD02` | AUDIT | MANDATORY | `PASS` | 1 | `6c5102f18c12` `d61950688f8c` | Runtime YAML isolation: no P03 runtime module parses workflow YAML or reconstructs P02 semantics |
| `P03.EV01` | EVIDENCE | MANDATORY | `PASS` | 1 | `e2e2b2985d4a` | Evidence: PARITY registry snapshot derived from the frozen contract |
| `P03.EV02` | EVIDENCE | MANDATORY | `PASS` | 1 | `a28417ee1e7d` | Evidence: JSONL reporter stream and its six-class summary |
| `P03.GATE01` | ACCEPTANCE_GATE | MANDATORY | `PASS` | 1 | `d61950688f8c` `d578bb6b1ab4` | Full taxonomy coverage demonstrated |
| `P03.GATE02` | ACCEPTANCE_GATE | MANDATORY | `PASS` | 1 | `d578bb6b1ab4` `6c5102f18c12` | P03.NEG03 and P03.NEG04 PASS |
| `P03.CP01` | CHECKPOINT | MANDATORY | `PASS` | 1 | `1ccb5c006c3a` `d578bb6b1ab4` | P03 checkpoint recorded |

## P04 — Executor core

**State:** `ACCEPTED`

**Assurance property:** Gates execute under declared scheduling, hermeticity, timeout, and teardown guarantees, and no exit code is ever silently suppressed.

**Depends on:** `P03`

**Progress (MANDATORY):** 30 / 30

**Entry checklist**

- [ ] P03 ACCEPTED
- [ ] Container runtime available, or HERMETIC:UNENFORCED explicitly accepted

**Exit checklist**

- [ ] P04.T01..P04.T10 closed
- [ ] P04.TEST01..TEST03 PASS
- [ ] P04.NEG01..NEG06 PASS
- [ ] P04.FI01, P04.FI02, P04.CLN01 PASS
- [ ] P04.GATE01 PASS
- [ ] P04.CP01 recorded

| ID | Kind | Class | Status | Attempts | Evidence | Title |
| --- | --- | --- | --- | --- | --- | --- |
| `P04.T01` | TASK | MANDATORY | `PASS` | 1 | `e24278a9eab3` `487ff557025b` | DAG scheduler over declared requires |
| `P04.T02` | TASK | MANDATORY | `PASS` | 1 | `e24278a9eab3` `487ff557025b` | Concurrency and memory budget |
| `P04.T03` | TASK | MANDATORY | `PASS` | 1 | `e24278a9eab3` `487ff557025b` `a847e483b9af` | Serial DB lane |
| `P04.T04` | TASK | MANDATORY | `PASS` | 1 | `e24278a9eab3` `487ff557025b` | Hermetic env: TZ=UTC, LC_ALL=C.UTF-8, seed, reserved ports, isolated TMPDIR |
| `P04.T05` | TASK | MANDATORY | `PASS` | 1 | `e24278a9eab3` `487ff557025b` | Network policy plus ENFORCEMENT DETECTION (host runs report HERMETIC:UNENFORCED) |
| `P04.T06` | TASK | MANDATORY | `PASS` | 1 | `e24278a9eab3` `487ff557025b` | Timeout: SIGTERM, grace, SIGKILL |
| `P04.T07` | TASK | MANDATORY | `PASS` | 1 | `e24278a9eab3` `487ff557025b` `e6864db608b5` | Teardown registry across success, failure, SIGINT, SIGTERM, timeout, uncaught exception |
| `P04.T08` | TASK | MANDATORY | `PASS` | 1 | `e24278a9eab3` `a847e483b9af` `487ff557025b` | Attempts and flake recording |
| `P04.T09` | TASK | MANDATORY | `PASS` | 1 | `e24278a9eab3` `a847e483b9af` `487ff557025b` | Emit executor.jsonl |
| `P04.T10` | TASK | MANDATORY | `PASS` | 1 | `e24278a9eab3` `487ff557025b` `a847e483b9af` | Lane sentinel: named lane lock with entered_at/exited_at intervals, released on crash and timeout |
| `P04.TEST01` | POSITIVE_VALIDATION | MANDATORY | `PASS` | 1 | `487ff557025b` `258a5a137e3b` | Scheduler respects declared requires ordering |
| `P04.TEST02` | POSITIVE_VALIDATION | MANDATORY | `PASS` | 1 | `487ff557025b` `258a5a137e3b` | Serial lane exclusivity holds |
| `P04.TEST03` | POSITIVE_VALIDATION | MANDATORY | `PASS` | 1 | `487ff557025b` `258a5a137e3b` | Hermetic env is observed inside a child process |
| `P04.NEG01` | NEGATIVE_VALIDATION | MANDATORY | `PASS` | 1 | `487ff557025b` `258a5a137e3b` | Orphaned process is reaped and reported INFRA-FAIL |
| `P04.NEG02` | NEGATIVE_VALIDATION | MANDATORY | `PASS` | 1 | `487ff557025b` `258a5a137e3b` | Hanging gate yields TIMEOUT, not FAIL |
| `P04.NEG03` | NEGATIVE_VALIDATION | MANDATORY | `PASS` | 1 | `487ff557025b` `3988fab2e997` `e6864db608b5` | SIGINT yields clean teardown and a non-zero exit |
| `P04.NEG04` | NEGATIVE_VALIDATION | MANDATORY | `PASS` | 1 | `487ff557025b` `258a5a137e3b` | network: deny on host yields INCONCLUSIVE, never PASS |
| `P04.NEG05` | NEGATIVE_VALIDATION | MANDATORY | `PASS` | 1 | `487ff557025b` `258a5a137e3b` | Top-level exit-code suppression is detected by audit |
| `P04.NEG06` | NEGATIVE_VALIDATION | MANDATORY | `PASS` | 1 | `487ff557025b` `258a5a137e3b` | Direct concurrent invocation bypassing the scheduler trips LANE_VIOLATION deterministically |
| `P04.NEG07` | NEGATIVE_VALIDATION | MANDATORY | `PASS` | 1 | `487ff557025b` `258a5a137e3b` | Ownership boundary adversarial suite: teardown can never destroy a resource it cannot prove it owns |
| `P04.NEG08` | NEGATIVE_VALIDATION | MANDATORY | `PASS` | 1 | `487ff557025b` `258a5a137e3b` | Executor false-green adversarial suite: no loss, drift, interruption, or infrastructure failure converts to PASS |
| `P04.FI01` | FAILURE_INJECTION | MANDATORY | `PASS` | 1 | `487ff557025b` `258a5a137e3b` | Failure injection: kill the executor mid-gate |
| `P04.FI02` | FAILURE_INJECTION | MANDATORY | `PASS` | 1 | `487ff557025b` `258a5a137e3b` | Failure injection: exhaust the memory budget |
| `P04.CLN01` | CLEANUP | MANDATORY | `PASS` | 1 | `487ff557025b` `aa565d25f311` | SIGINT teardown: 10 of 10 runs leave zero residue |
| `P04.AUD01` | AUDIT | MANDATORY | `PASS` | 1 | `e64dbfa7f685` | Audit: every cleanup operation maps to proven ownership; zero broad destructive mechanisms |
| `P04.AUD02` | AUDIT | MANDATORY | `PASS` | 1 | `db4e1ad76f44` | Audit: spawn/exit-code fidelity on every execution path; the piped-exit-status false-PASS class is regression-anchored |
| `P04.AUD03` | AUDIT | MANDATORY | `PASS` | 1 | `b7bb3566b3af` | Audit: P04 emits results only through the P03 result/reporter model — no second taxonomy, summary, registry, YAML parser, or ledger |
| `P04.EV01` | EVIDENCE | MANDATORY | `PASS` | 1 | `a847e483b9af` `ba2d18f01f2d` `16f1672a996f` | Evidence: canonical executor.jsonl from a real mixed-outcome fixture run |
| `P04.GATE01` | ACCEPTANCE_GATE | MANDATORY | `PASS` | 1 | `487ff557025b` `258a5a137e3b` `aa565d25f311` | P04.CLN01, P04.NEG01, P04.NEG04 PASS |
| `P04.CP01` | CHECKPOINT | MANDATORY | `PASS` | 1 | `d710f47496b9` | P04 checkpoint recorded |

## P05 — ASSURANCE — the self-test framework

**State:** `ACCEPTED`

**Assurance property:** Every mandatory gate is proven capable of rejection, for its own declared reason, and proven to return to green after restoration.

**Depends on:** `P04`

**Progress (MANDATORY):** 27 / 27

**Entry checklist**

- [ ] P04 ACCEPTED
- [ ] Executor operational
- [ ] Disposable worktree supported
- [ ] Fixture-placement policy confirmed via P00.T05
- [ ] Target gates identified

**Exit checklist**

- [ ] P05.T01..P05.T07 closed
- [ ] P05.TEST01..TEST03 PASS
- [ ] P05.NEG01..NEG04 PASS
- [ ] P05.AUD01 PASS
- [ ] P05.EV01, P05.EV02 hashed
- [ ] P05.GATE01, P05.GATE02 PASS
- [ ] P05.CP01 recorded

| ID | Kind | Class | Status | Attempts | Evidence | Title |
| --- | --- | --- | --- | --- | --- | --- |
| `P05.T01` | TASK | MANDATORY | `PASS` | 1 | `4edb99e86f20` `919769ab9a5a` | Fixture format {poison.patch, expect.json} |
| `P05.T02` | TASK | MANDATORY | `PASS` | 1 | `4edb99e86f20` `919769ab9a5a` | Placement policy enforcement — fixtures are patches, never live files in scanned trees |
| `P05.T03` | TASK | MANDATORY | `PASS` | 1 | `4edb99e86f20` `919769ab9a5a` | Runner: worktree, apply, run target gate, assert, revert, control re-run |
| `P05.T04` | TASK | MANDATORY | `PASS` | 1 | `4edb99e86f20` `919769ab9a5a` | expected_gate enforcement |
| `P05.T05` | TASK | MANDATORY | `PASS` | 1 | `4edb99e86f20` `919769ab9a5a` | expected_reason signature matching |
| `P05.T06` | TASK | MANDATORY | `PASS` | 1 | `4edb99e86f20` `919769ab9a5a` | Coverage assertion — every mandatory gate has a fixture |
| `P05.T07` | TASK | MANDATORY | `PASS` | 1 | `4edb99e86f20` `919769ab9a5a` | Emit assurance.json plus its sha256 |
| `P05.TEST01` | POSITIVE_VALIDATION | MANDATORY | `PASS` | 1 | `919769ab9a5a` `72cf4564a506` | Real gate 1 reddens for its own declared reason; control returns green |
| `P05.TEST02` | POSITIVE_VALIDATION | MANDATORY | `PASS` | 1 | `919769ab9a5a` `72cf4564a506` | Real gate 2 reddens for its own declared reason; control returns green |
| `P05.TEST03` | POSITIVE_VALIDATION | MANDATORY | `PASS` | 1 | `919769ab9a5a` `72cf4564a506` | Real gate 3 reddens for its own declared reason; control returns green |
| `P05.TEST04` | POSITIVE_VALIDATION | MANDATORY | `PASS` | 1 | `919769ab9a5a` `72cf4564a506` | Repeated poison/control cycles produce identical logical proof semantics; a flaky fixture can never be PROVEN |
| `P05.NEG01` | NEGATIVE_VALIDATION | MANDATORY | `PASS` | 1 | `919769ab9a5a` `72cf4564a506` | Fixture reddening the wrong gate yields BROKEN-GATE(WRONG_TARGET) |
| `P05.NEG02` | NEGATIVE_VALIDATION | MANDATORY | `PASS` | 1 | `919769ab9a5a` `72cf4564a506` | Fixture whose control run stays red yields BROKEN-GATE(NON_RESTORING) |
| `P05.NEG03` | NEGATIVE_VALIDATION | MANDATORY | `PASS` | 1 | `919769ab9a5a` `72cf4564a506` | Mandatory gate without a fixture yields BROKEN-GATE(UNPROVEN) |
| `P05.NEG04` | NEGATIVE_VALIDATION | MANDATORY | `PASS` | 1 | `919769ab9a5a` `f1d5a4812916` | A live poison fixture inside a scanned path causes the build to refuse |
| `P05.NEG05` | NEGATIVE_VALIDATION | MANDATORY | `PASS` | 1 | `919769ab9a5a` `72cf4564a506` | Target gate failing for a reason other than the intended detector yields BROKEN-GATE(WRONG_REASON) |
| `P05.NEG06` | NEGATIVE_VALIDATION | MANDATORY | `PASS` | 1 | `919769ab9a5a` `72cf4564a506` | False-assurance adversarial suite: no-op/partial/wrong-file poison, non-detector statuses, missing or tampered evidence, duplicate or malformed fixtures, and path escapes all fail closed |
| `P05.NEG07` | NEGATIVE_VALIDATION | MANDATORY | `PASS` | 1 | `919769ab9a5a` `5bc8b0526d6c` | Interruption during a poison cycle discards the candidate, leaves zero poison and zero residue, and can never emit a proof |
| `P05.AUD01` | AUDIT | MANDATORY | `PASS` | 1 | `f1d5a4812916` `a543ab8077fe` | Audit: zero poison artifacts exist in the tracked tree |
| `P05.AUD02` | AUDIT | MANDATORY | `PASS` | 1 | `f1d5a4812916` `5eb33700ff0f` | Audit: P05 duplicates no P01-P04 control-plane mechanism (snapshots, YAML, contract, registry, results, execution, cleanup, ledger, acceptance) |
| `P05.EV01` | EVIDENCE | MANDATORY | `PASS` | 1 | `abf4c803c515` `d58ddd47aed8` | Evidence: assurance.json |
| `P05.EV02` | EVIDENCE | MANDATORY | `PASS` | 1 | `1ad955853895` | Evidence: assurance.json sha256 |
| `P05.GATE01` | ACCEPTANCE_GATE | MANDATORY | `PASS` | 1 | `abf4c803c515` `919769ab9a5a` `4edb99e86f20` | At least three real gates proven |
| `P05.GATE02` | ACCEPTANCE_GATE | MANDATORY | `PASS` | 1 | `919769ab9a5a` `e800975dcbe7` | Coverage assertion armed |
| `P05.CP01` | CHECKPOINT | MANDATORY | `PASS` | 1 | `1a5009ba0682` | P05 checkpoint recorded |
| `P05.CP02` | CHECKPOINT | MANDATORY | `PASS` | 1 | `bf3692d404df` | P05 re-checkpoint after DEF-023 remediation; supersedes CP01 for progression while CP01 is preserved byte-for-byte |
| `P05.CP05` | CHECKPOINT | MANDATORY | `PASS` | 1 | `ab45fd7b558b` | P05 re-checkpoint after integrating the exact current main; supersedes CP01-CP04 for progression while all remain byte-unchanged |

## P06 — PARITY — static, security, supply chain

**State:** `ACCEPTED`

**Assurance property:** Every locally reproducible static and supply-chain requirement of the merge contract is executed verbatim, with pinned tools.

**Depends on:** `P05`

**Progress (MANDATORY):** 29 / 29

**Entry checklist**

- [ ] P05 ACCEPTED
- [ ] Tool pins readable from the frozen contract

**Exit checklist**

- [ ] P06.T01..P06.T12 closed
- [ ] P06.TEST01, TEST02 PASS
- [ ] P06.NEG01..NEG12 PASS
- [ ] P06.AUD01 PASS
- [ ] P06.GATE01 PASS
- [ ] P06.CP01 recorded

| ID | Kind | Class | Status | Attempts | Evidence | Title |
| --- | --- | --- | --- | --- | --- | --- |
| `P06.T01` | TASK | MANDATORY | `PASS` | 1 | `1efbc1fb876d` `d09ed6edf0b2` | tools-sync: contract-read pins plus checksum verification — the ONLY network-permitted unit |
| `P06.T02` | TASK | MANDATORY | `PASS` | 1 | `f6276830197b` `d09ed6edf0b2` | Gate: typecheck |
| `P06.T03` | TASK | MANDATORY | `PASS` | 1 | `f6276830197b` `d09ed6edf0b2` | Gate: format |
| `P06.T04` | TASK | MANDATORY | `PASS` | 1 | `f6276830197b` `d09ed6edf0b2` | Gate: semgrep-blocking |
| `P06.T05` | TASK | MANDATORY | `PASS` | 1 | `f6276830197b` `d09ed6edf0b2` | Gate: zizmor |
| `P06.T06` | TASK | MANDATORY | `PASS` | 1 | `f6276830197b` `5bdc9e0c55ee` | Gate: gitleaks |
| `P06.T07` | TASK | MANDATORY | `PASS` | 1 | `f6276830197b` `d09ed6edf0b2` | Gate: osv-scanner plus check-osv-scan |
| `P06.T08` | TASK | MANDATORY | `PASS` | 1 | `f6276830197b` `807e44769298` | Gate: actions-security contract |
| `P06.T09` | TASK | MANDATORY | `PASS` | 1 | `f6276830197b` `d09ed6edf0b2` | Gate: federation docs |
| `P06.T10` | TASK | MANDATORY | `PASS` | 1 | `f6276830197b` `807e44769298` | Gate: migration hygiene trio |
| `P06.T11` | TASK | MANDATORY | `PASS` | 1 | `f6276830197b` `d09ed6edf0b2` | Gate: ai-eval set with env -u DATABASE_URL |
| `P06.T12` | TASK | MANDATORY | `PASS` | 1 | `bf67f9dcfd4f` | CI-ONLY registration with explicit reasons |
| `P06.TEST01` | POSITIVE_VALIDATION | MANDATORY | `PASS` | 1 | `f6276830197b` `d09ed6edf0b2` | All implemented gates green on a clean snapshot |
| `P06.TEST02` | POSITIVE_VALIDATION | MANDATORY | `PASS` | 1 | `5c33cb0f6c36` `d09ed6edf0b2` | Executed command is byte-for-byte identical to the frozen contract |
| `P06.NEG01` | NEGATIVE_VALIDATION | MANDATORY | `PASS` | 1 | `807e44769298` | Poison fixture reddens the typecheck gate for its own reason |
| `P06.NEG02` | NEGATIVE_VALIDATION | MANDATORY | `SKIPPED_DECLARED` | 1 | — | Poison fixture reddens the format gate for its own reason |
| `P06.NEG03` | NEGATIVE_VALIDATION | MANDATORY | `PASS` | 1 | `807e44769298` | Poison fixture reddens the semgrep gate for its own reason |
| `P06.NEG04` | NEGATIVE_VALIDATION | MANDATORY | `PASS` | 1 | `807e44769298` | Poison fixture reddens the zizmor gate for its own reason |
| `P06.NEG05` | NEGATIVE_VALIDATION | MANDATORY | `PASS` | 1 | `807e44769298` | Poison fixture reddens the gitleaks gate for its own reason |
| `P06.NEG06` | NEGATIVE_VALIDATION | MANDATORY | `SKIPPED_DECLARED` | 1 | — | Poison fixture reddens the osv gate for its own reason |
| `P06.NEG07` | NEGATIVE_VALIDATION | MANDATORY | `PASS` | 1 | `807e44769298` | Poison fixture reddens the actions-security gate for its own reason |
| `P06.NEG08` | NEGATIVE_VALIDATION | MANDATORY | `SKIPPED_DECLARED` | 1 | — | Poison fixture reddens the federation-docs gate for its own reason |
| `P06.NEG09` | NEGATIVE_VALIDATION | MANDATORY | `PASS` | 1 | `807e44769298` | Poison fixture reddens the migration-hygiene gate for its own reason |
| `P06.NEG10` | NEGATIVE_VALIDATION | MANDATORY | `PASS` | 1 | `807e44769298` | Poison fixture reddens the ai-eval gate for its own reason |
| `P06.NEG11` | NEGATIVE_VALIDATION | MANDATORY | `PASS` | 1 | `5c33cb0f6c36` `f6276830197b` | Missing tool yields BLOCKED, never green |
| `P06.NEG12` | NEGATIVE_VALIDATION | MANDATORY | `PASS` | 1 | `5c33cb0f6c36` `ebf314113563` | Tool version differing from the contract pin yields CONTRACT-DRIFT |
| `P06.AUD01` | AUDIT | MANDATORY | `PASS` | 1 | `bf67f9dcfd4f` `7cec2751f4db` | Audit: network is permitted only in P06.T01 |
| `P06.GATE01` | ACCEPTANCE_GATE | MANDATORY | `PASS` | 1 | `d09ed6edf0b2` `807e44769298` | Self-test coverage for this phase is 100 percent |
| `P06.CP01` | CHECKPOINT | MANDATORY | `PASS` | 1 | `71abf520c025` `d09ed6edf0b2` | P06 checkpoint recorded |

## P07 — PARITY — test and data

**State:** `ACCEPTED`

**Assurance property:** The full test contract runs with CI's partitioning, with no impact selection, and DB-lane exclusion is proven deterministically.

**Depends on:** `P05`

**Progress (MANDATORY):** 24 / 24

**Entry checklist**

- [ ] P05 ACCEPTED
- [ ] docker available
- [ ] mysql image digest pinned

**Exit checklist**

- [ ] P07.T01..P07.T10 closed
- [ ] P07.TEST01..TEST03 PASS
- [ ] P07.NEG01..NEG05 PASS
- [ ] P07.REG01 PASS
- [ ] P07.EV01..EV03 hashed
- [ ] P07.GATE01 PASS
- [ ] P07.CP01 recorded

| ID | Kind | Class | Status | Attempts | Evidence | Title |
| --- | --- | --- | --- | --- | --- | --- |
| `P07.T01` | TASK | MANDATORY | `PASS` | 1 | `e688f054502d` `f9a0bb53e8a9` | MySQL fixture pinned by image digest |
| `P07.T02` | TASK | MANDATORY | `PASS` | 1 | `e688f054502d` `d884ee630a6a` | Reconciled migration replay on the fresh database |
| `P07.T03` | TASK | MANDATORY | `PASS` | 1 | `f9a0bb53e8a9` `4ddb0099b9c1` | DB-suite discovery via the SKIP_DB_IN_CI marker |
| `P07.T04` | TASK | MANDATORY | `PASS` | 1 | `f9a0bb53e8a9` `4ddb0099b9c1` | Cross-check discovery against ci.yml's hardcoded suite list |
| `P07.T05` | TASK | MANDATORY | `PASS` | 1 | `f9a0bb53e8a9` `d884ee630a6a` | Non-DB parallel phase |
| `P07.T06` | TASK | MANDATORY | `PASS` | 1 | `e688f054502d` `f9a0bb53e8a9` | DB serial phase using the P04.T10 lane sentinel |
| `P07.T07` | TASK | MANDATORY | `PASS` | 1 | `cb3bab798c93` `4ddb0099b9c1` | Environment-failure gate integration |
| `P07.T08` | TASK | MANDATORY | `PASS` | 1 | `f9a0bb53e8a9` `4ddb0099b9c1` | Collection-collapse floor enforcement |
| `P07.T09` | TASK | MANDATORY | `PASS` | 1 | `f9a0bb53e8a9` `9d02e78f27a4` | Report merge into a single result document |
| `P07.T10` | TASK | MANDATORY | `PASS` | 1 | `9d23daccdf9b` `4ddb0099b9c1` | Diff-aware gates read the base SHA from snapshot.json |
| `P07.TEST01` | POSITIVE_VALIDATION | MANDATORY | `PASS` | 1 | `f9a0bb53e8a9` `d884ee630a6a` | Full suite green on a clean snapshot |
| `P07.TEST02` | POSITIVE_VALIDATION | MANDATORY | `PASS` | 1 | `e688f054502d` `d884ee630a6a` | DB phase ordering matches CI |
| `P07.TEST03` | POSITIVE_VALIDATION | MANDATORY | `PASS` | 1 | `d884ee630a6a` `e688f054502d` | Local results match a CI db-tests run on the same SHA |
| `P07.NEG01` | NEGATIVE_VALIDATION | MANDATORY | `PASS` | 1 | `4ddb0099b9c1` | Suite removed from ci.yml's list yields CONTRACT-DRIFT |
| `P07.NEG02` | NEGATIVE_VALIDATION | MANDATORY | `PASS` | 1 | `4ddb0099b9c1` | Forced collection error is never excusable and yields FAIL |
| `P07.NEG03` | NEGATIVE_VALIDATION | MANDATORY | `PASS` | 1 | `4ddb0099b9c1` `e688f054502d` | Two DB-partitioned gates in one run record disjoint lane intervals, zero sentinel violations, and are serialized rather than rejected |
| `P07.NEG04` | NEGATIVE_VALIDATION | MANDATORY | `PASS` | 1 | `4ddb0099b9c1` | Impact-based test selection attempted in PARITY is refused |
| `P07.NEG05` | NEGATIVE_VALIDATION | MANDATORY | `PASS` | 1 | `f1c9f176a046` `4ddb0099b9c1` | Dirty tree plus a diff-aware coverage gate yields BLOCKED |
| `P07.REG01` | REGRESSION | MANDATORY | `PASS` | 1 | `d884ee630a6a` `f9a0bb53e8a9` | Three consecutive runs produce identical results |
| `P07.AUD01` | AUDIT | ADVISORY | `NOT_STARTED` | 0 | — | ADVISORY: optional reproduction of the historical Incident 42 race — never an acceptance input |
| `P07.EV01` | EVIDENCE | MANDATORY | `PASS` | 1 | `f9a0bb53e8a9` `d884ee630a6a` | Evidence: merged vitest results |
| `P07.EV02` | EVIDENCE | MANDATORY | `PASS` | 1 | `cb3bab798c93` `d884ee630a6a` | Evidence: environment-failure gate report |
| `P07.EV03` | EVIDENCE | MANDATORY | `PASS` | 1 | `e688f054502d` `d884ee630a6a` | Evidence: DB test report |
| `P07.GATE01` | ACCEPTANCE_GATE | MANDATORY | `PASS` | 1 | `d884ee630a6a` | P07.TEST03 demonstrated |
| `P07.CP01` | CHECKPOINT | MANDATORY | `PASS` | 1 | `9d23daccdf9b` `d884ee630a6a` | P07 checkpoint recorded |

## P08 — CLEANROOM — image identity, container build, dual runtime proof

**State:** `ACCEPTED`

**Assurance property:** The repository's container build contract reproduces, and the built artifact is proven on both the failure path and the healthy path.

**Depends on:** `P06`, `P07`

**Progress (MANDATORY):** 23 / 23

**Entry checklist**

- [ ] P06 ACCEPTED
- [ ] P07 ACCEPTED
- [ ] docker available

**Exit checklist**

- [ ] P08.T01..P08.T08 closed
- [ ] P08.TEST01..TEST03 PASS
- [ ] P08.NEG01..NEG03 PASS
- [ ] P08.CLN01, P08.AUD01 PASS
- [ ] P08.EV01..EV05 hashed
- [ ] P08.GATE01 PASS
- [ ] P08.AUTH01 granted (DEC-001 recorded)
- [ ] P08.CP01 recorded

| ID | Kind | Class | Status | Attempts | Evidence | Title |
| --- | --- | --- | --- | --- | --- | --- |
| `P08.T01` | TASK | MANDATORY | `PASS` | 1 | `7894bbd0285d` `19b3743c5608` | images.pinned.json — verifier-controlled images pinned by digest |
| `P08.T02` | TASK | MANDATORY | `PASS` | 1 | `7894bbd0285d` | RECORD the Dockerfile base digest without editing FROM |
| `P08.T03` | TASK | MANDATORY | `PASS` | 1 | `399a6244b525` `19b3743c5608` | Container build reproducing the repository's build contract |
| `P08.T04` | TASK | MANDATORY | `PASS` | 1 | `fb70414f6d53` `19b3743c5608` | Trivy CRITICAL fixable-only blocking gate |
| `P08.T05` | TASK | MANDATORY | `PASS` | 1 | `19b3743c5608` | SBOM generation |
| `P08.T06` | TASK | MANDATORY | `PASS` | 1 | `7508825e92a9` `19b3743c5608` | Runtime profile A — dead DB: crash-guard, /health, structured 401, listen line |
| `P08.T07` | TASK | MANDATORY | `PASS` | 1 | `e8a6a082fdb5` `19b3743c5608` | Runtime profile B — healthy DB: commit identity, schema compatibility, auth-independent paths, background-job gating, graceful SIGTERM shutdown |
| `P08.T08` | TASK | MANDATORY | `PASS` | 1 | `19b3743c5608` | Build-variance recorder (AUDIT class, non-blocking) |
| `P08.TEST01` | POSITIVE_VALIDATION | MANDATORY | `PASS` | 1 | `7508825e92a9` `19b3743c5608` | Runtime profile A green |
| `P08.TEST02` | POSITIVE_VALIDATION | MANDATORY | `PASS` | 1 | `e8a6a082fdb5` `19b3743c5608` | Runtime profile B green including graceful shutdown |
| `P08.TEST03` | POSITIVE_VALIDATION | MANDATORY | `PASS` | 1 | `19b3743c5608` | SBOM is non-empty |
| `P08.NEG01` | NEGATIVE_VALIDATION | MANDATORY | `PASS` | 1 | `399a6244b525` `19b3743c5608` | Broken Dockerfile fails the build before any runtime gate executes |
| `P08.NEG02` | NEGATIVE_VALIDATION | MANDATORY | `PASS` | 1 | `399a6244b525` `19b3743c5608` | Wrong EXPECTED_COMMIT fails profile B on build identity |
| `P08.NEG03` | NEGATIVE_VALIDATION | MANDATORY | `PASS` | 1 | `399a6244b525` `19b3743c5608` | MySQL killed mid-run yields INFRA-FAIL, not FAIL |
| `P08.CLN01` | CLEANUP | MANDATORY | `PASS` | 1 | `399a6244b525` `b1804ebebe81` | Zero residual containers after every run |
| `P08.AUD01` | AUDIT | ADVISORY | `PASS` | 1 | `19b3743c5608` | ADVISORY: build variance recorded across clean rebuilds, never blocking |
| `P08.EV01` | EVIDENCE | MANDATORY | `PASS` | 1 | `7eeacfbbd309` | Evidence: image-id.txt |
| `P08.EV02` | EVIDENCE | MANDATORY | `PASS` | 1 | `fb70414f6d53` | Evidence: trivy.table |
| `P08.EV03` | EVIDENCE | MANDATORY | `PASS` | 1 | `19b3743c5608` | Evidence: sbom.spdx.json |
| `P08.EV04` | EVIDENCE | MANDATORY | `PASS` | 1 | `7508825e92a9` | Evidence: runtime profile A log |
| `P08.EV05` | EVIDENCE | MANDATORY | `PASS` | 1 | `e8a6a082fdb5` | Evidence: runtime profile B log |
| `P08.GATE01` | ACCEPTANCE_GATE | MANDATORY | `PASS` | 1 | `b1804ebebe81` `19b3743c5608` | Three consecutive clean runs of profiles A and B |
| `P08.AUTH01` | AUTHORIZATION | MANDATORY | `PASS` | 1 | `7d9785003538` `7894bbd0285d` | Owner decision DEC-001 RECORDED: PIN_BY_DIGEST or RECORD_ONLY — both satisfy this authorization |
| `P08.CP01` | CHECKPOINT | MANDATORY | `PASS` | 1 | `19b3743c5608` `7d9785003538` | P08 checkpoint recorded |

## P09 — HARDENING

**State:** `ACCEPTED`

**Assurance property:** Dime-specific standards that CI does not enforce are checked locally, and are reported separately from the PARITY verdict.

**Depends on:** `P08`

**Progress (MANDATORY):** 17 / 17

**Entry checklist**

- [ ] P08 ACCEPTED
- [ ] HARDENING registry writable

**Exit checklist**

- [ ] P09.T01..P09.T05 closed
- [ ] P09.TEST01..TEST04 PASS
- [ ] P09.NEG01..NEG04 PASS
- [ ] P09.AUD01 PASS
- [ ] P09.GATE01 PASS
- [ ] P09.AUTH01 granted (DEC-002 recorded)
- [ ] P09.CP01 recorded

| ID | Kind | Class | Status | Attempts | Evidence | Title |
| --- | --- | --- | --- | --- | --- | --- |
| `P09.T01` | TASK | MANDATORY | `PASS` | 1 | `7299cac149f1` | Populate the HARDENING registry |
| `P09.T02` | TASK | MANDATORY | `PASS` | 1 | `f4351a1cfa80` `0e36381a205f` | Deploy-order gate — new drizzle/*.sql requires db-push.yml first |
| `P09.T03` | TASK | MANDATORY | `PASS` | 1 | `f4351a1cfa80` `0e36381a205f` | Schema type-drift gate — drizzle column types versus migration SQL |
| `P09.T04` | TASK | MANDATORY | `PASS` | 1 | `404ba92bc9d2` `0e36381a205f` | knip — dead exports and dependencies |
| `P09.T05` | TASK | MANDATORY | `PASS` | 1 | `f05ff15929e6` `0e36381a205f` | Accessibility gate on the built client |
| `P09.TEST01` | POSITIVE_VALIDATION | MANDATORY | `PASS` | 1 | `0e36381a205f` | Deploy-order gate green on a clean snapshot |
| `P09.TEST02` | POSITIVE_VALIDATION | MANDATORY | `PASS` | 1 | `0e36381a205f` | Schema type-drift gate green on a clean snapshot |
| `P09.TEST03` | POSITIVE_VALIDATION | MANDATORY | `PASS` | 1 | `0e36381a205f` | knip green on a clean snapshot |
| `P09.TEST04` | POSITIVE_VALIDATION | MANDATORY | `PASS` | 1 | `0e36381a205f` | Accessibility gate green on a clean snapshot |
| `P09.NEG01` | NEGATIVE_VALIDATION | MANDATORY | `PASS` | 1 | `0e36381a205f` `71fe5005d868` | Synthetic drizzle/*.sql inside the worktree reddens the deploy-order gate |
| `P09.NEG02` | NEGATIVE_VALIDATION | MANDATORY | `PASS` | 1 | `0e36381a205f` `71fe5005d868` | Injected type mismatch reddens the schema type-drift gate |
| `P09.NEG03` | NEGATIVE_VALIDATION | MANDATORY | `PASS` | 1 | `0e36381a205f` `71fe5005d868` | knip fixture reddens the knip gate |
| `P09.NEG04` | NEGATIVE_VALIDATION | MANDATORY | `PASS` | 1 | `0e36381a205f` `71fe5005d868` | Accessibility fixture reddens the a11y gate |
| `P09.AUD01` | AUDIT | MANDATORY | `PASS` | 1 | `7299cac149f1` `71fe5005d868` | Audit: HARDENING results are never merged into the PARITY verdict |
| `P09.GATE01` | ACCEPTANCE_GATE | MANDATORY | `PASS` | 1 | `0e36381a205f` `71fe5005d868` | P09.T02 and P09.T03 green with their fixtures |
| `P09.AUTH01` | AUTHORIZATION | MANDATORY | `PASS` | 1 | `7299cac149f1` `71fe5005d868` | Owner decision DEC-002 RECORDED: BLOCKING or ADVISORY for the deploy-order gate — both satisfy this authorization |
| `P09.CP01` | CHECKPOINT | MANDATORY | `PASS` | 1 | `71fe5005d868` `7299cac149f1` | P09 checkpoint recorded |

## P10 — Certificate, REMOTE reconciliation, LOCAL_READY_FOR_PR

**State:** `ACCEPTED`

**Assurance property:** A certificate is issued only when the whole execution history is closed, and it is void the instant any bound input changes.

**Depends on:** `P09`

**Progress (MANDATORY):** 22 / 22

**Entry checklist**

- [ ] P00..P09 all ACCEPTED (10 of 10 preceding)
- [ ] Ledger sha256 valid

**Exit checklist**

- [ ] P10.T01..P10.T08 closed
- [ ] P10.TEST01..TEST03 PASS
- [ ] P10.NEG01..NEG08 PASS
- [ ] P10.GATE01 PASS (10/10 preceding phases ACCEPTED)
- [ ] Certificate issued and independently verified
- [ ] P10.AUTH01 granted
- [ ] P10.CP01 recorded, binding the certificate hash

| ID | Kind | Class | Status | Attempts | Evidence | Title |
| --- | --- | --- | --- | --- | --- | --- |
| `P10.T01` | TASK | MANDATORY | `PASS` | 1 | `39a826eb1fb3` `041f00f78261` | Certificate binding set: head, base, merge_tree, merge_commit, lockfile, contract, verifier, images, env profile, hermetic mode, assurance hash, results by class |
| `P10.T02` | TASK | MANDATORY | `PASS` | 1 | `39a826eb1fb3` `1723c8e40cb2` | verify/void logic — recompute every binding from disk |
| `P10.T03` | TASK | MANDATORY | `PASS` | 1 | `041f00f78261` | Execution-history binding: ledger state at issuance (P00-P09 ACCEPTED plus P10 units through GATE01) |
| `P10.T04` | TASK | MANDATORY | `PASS` | 1 | `03fc481ddef7` | REMOTE reconciliation against the live ruleset AND classic protection |
| `P10.T05` | TASK | MANDATORY | `PASS` | 1 | `03fc481ddef7` | CI proof reconciliation guarded by {head, base, merge_tree, contract_hash} — compares merge_tree_sha, never merge_commit_sha |
| `P10.T06` | TASK | MANDATORY | `PASS` | 1 | `39a826eb1fb3` `041f00f78261` | Issuance rule |
| `P10.T07` | TASK | MANDATORY | `PASS` | 1 | `39a826eb1fb3` `041f00f78261` | Opt-in pre-push hook |
| `P10.T08` | TASK | MANDATORY | `PASS` | 1 | `041f00f78261` | File evidence into the /eng-loop evidence record |
| `P10.TEST01` | POSITIVE_VALIDATION | MANDATORY | `PASS` | 1 | `041f00f78261` | A fully green run issues a certificate that verify accepts |
| `P10.TEST02` | POSITIVE_VALIDATION | MANDATORY | `PASS` | 1 | `03fc481ddef7` | One real PR reconciles field-for-field against CI's proof artifact |
| `P10.TEST03` | POSITIVE_VALIDATION | MANDATORY | `PASS` | 1 | `041f00f78261` | Independent verification: a SEPARATE process re-derives every binding from disk and accepts |
| `P10.NEG01` | NEGATIVE_VALIDATION | MANDATORY | `PASS` | 1 | `1723c8e40cb2` | Touching any tracked file yields VOID(head_sha) |
| `P10.NEG02` | NEGATIVE_VALIDATION | MANDATORY | `PASS` | 1 | `041f00f78261` | Advancing origin/main yields NOT-COMPARABLE(STALE_BASE), not a parity mismatch |
| `P10.NEG03` | NEGATIVE_VALIDATION | MANDATORY | `PASS` | 1 | `1723c8e40cb2` | Editing scripts/ci/** yields VOID(verifier_hash) |
| `P10.NEG04` | NEGATIVE_VALIDATION | MANDATORY | `PASS` | 1 | `041f00f78261` | Any FLAKY mandatory result refuses issuance |
| `P10.NEG05` | NEGATIVE_VALIDATION | MANDATORY | `PASS` | 1 | `041f00f78261` | An incomplete ledger refuses issuance |
| `P10.NEG06` | NEGATIVE_VALIDATION | MANDATORY | `PASS` | 1 | `041f00f78261` | Any phase not ACCEPTED refuses issuance |
| `P10.NEG07` | NEGATIVE_VALIDATION | MANDATORY | `PASS` | 1 | `041f00f78261` | A tampered ledger yields LEDGER_TAMPERED and refuses issuance |
| `P10.NEG08` | NEGATIVE_VALIDATION | MANDATORY | `PASS` | 1 | `041f00f78261` | Issuance attempted with a preceding phase not ACCEPTED is refused, naming that phase |
| `P10.GATE01` | ACCEPTANCE_GATE | MANDATORY | `PASS` | 1 | `041f00f78261` | Issuance closure list: 10 of 10 PRECEDING phases ACCEPTED (P00..P09), all mandatory units closed, all mandatory gates negatively proven, zero unresolved defects, zero unexplained skips, zero flaky mandatory gates, zero infrastructure uncertainty, zero contract drift, zero broken gates, zero stale evidence, zero dirty bound inputs, zero ledger tampering |
| `P10.AUTH01` | AUTHORIZATION | MANDATORY | `PASS` | 1 | `041f00f78261` | Owner authorization to enable the opt-in pre-push hook |
| `P10.CP01` | CHECKPOINT | MANDATORY | `PASS` | 1 | `7b9447f9eb9d` `041f00f78261` | P10 checkpoint recorded, binding the issued certificate hash |

## Gate results by class (P03)

**Result schema:** `1.0.0`

| Class | Results | Status breakdown |
| --- | --- | --- |
| `PARITY` | 0 | — |
| `HARDENING` | 0 | — |
| `CLEANROOM` | 0 | — |
| `ASSURANCE` | 0 | — |
| `REMOTE` | 0 | — |
| `AUDIT` | 0 | — |

## Owner decisions

| ID | Required by | Allowed values | Status | Value |
| --- | --- | --- | --- | --- |
| `DEC-001` | `P08.AUTH01` | PIN_BY_DIGEST \| RECORD_ONLY | `RECORDED` | `RECORD_ONLY` |
| `DEC-002` | `P09.AUTH01` | BLOCKING \| ADVISORY | `RECORDED` | `BLOCKING` |
| `DEC-003` | `DEF-002` | DOCUMENT_LIVE_STATE \| RESTORE_CLASSIC_PROTECTION | `RECORDED` | `DOCUMENT_LIVE_STATE` |
| `DEC-004` | `DEF-003` | PINNED_DEV_DEPENDENCY \| P06_CLASS_PINNED_TOOL \| DEPENDENCY_FREE_SCANNER | `RECORDED` | `PINNED_DEV_DEPENDENCY` |

## Defects (append-only)

| ID | Detected by | Severity | Status | Title |
| --- | --- | --- | --- | --- |
| `DEF-001` | `PB.T02` | LOW | `CLOSED` | Evidence pointing at live control-plane artifacts is structurally invalid |
| `DEF-002` | `P00.T02` | HIGH | `CLOSED` | Live branch protection disagrees with the checked-in authority (classic protection absent; 0 required approvals) |
| `DEF-003` | `P00.T04` | MEDIUM | `CLOSED` | No declared YAML parser available for the P02 contract extractor |
| `DEF-004` | `P00.CP01` | MEDIUM | `CLOSED` | progress().acceptance_met reports only unit closure, not the full ACCEPT(P) predicate — a misleading green |
| `DEF-005` | `P00.CP02` | MEDIUM | `CLOSED` | GEN-000 recorded git_head_at_bootstrap as the placeholder 'unknown' (boolean flag swallowed --head) |
| `DEF-006` | `P00.T02` | LOW | `CLOSED` | DEF-002 validator split context names on '(' and mangled 'Secret Scan (gitleaks)' |
| `DEF-007` | `P00.CP02` | MEDIUM | `CLOSED` | False PASS in DEF-003 evidence: exit code read through a pipe ($? captured tail, not pnpm) |
| `DEF-008` | `P00.CP02` | LOW | `CLOSED` | Self-reference negative proof exited 1 via ILLEGAL_TRANSITION, not EVIDENCE_SELF_REFERENCE |
| `DEF-009` | `P01.AUD01` | MEDIUM | `CLOSED` | Provenance audit raised a false violation on a prose string in a declaration-only module |
| `DEF-010` | `P01.TEST01` | HIGH | `CLOSED` | assertRepository compared unresolved paths; macOS /var vs /private/var symlink caused INFRA-FAIL(REPOSITORY_MISMATCH) |
| `DEF-011` | `P01.TEST02` | MEDIUM | `CLOSED` | Degenerate base==head case: git deduplicates identical parents, so declared parent_order misrepresented the object |
| `DEF-012` | `P01.NEG01` | HIGH | `CLOSED` | merge-tree conflict parser sliced FROM the blank separator, capturing informational messages instead of conflicting paths |
| `DEF-013` | `P01.NEG02` | MEDIUM | `CLOSED` | P01 evidence asserted absolute worktree/stash baselines instead of measured deltas |
| `DEF-014` | `P01.CLN01` | HIGH | `CLOSED` | Interrupted run had already emitted a snapshot certificate on stdout |
| `DEF-015` | `P01.GATE01` | LOW | `CLOSED` | False FAIL in P01 sweep: prettier --check given .gitignore, which has no parser |
| `DEF-016` | `P01.CP01` | LOW | `CLOSED` | CP01 evidence under-specified the unrelated-work verification (one external change, two visibility changes) |
| `DEF-017` | `P02.T04` | HIGH | `CLOSED` | Check runnability marked LOCAL gates as CI-ONLY because the job uploads an artifact |
| `DEF-018` | `P02.T04` | HIGH | `CLOSED` | Required external tools under-detected: TOOL_SIGNATURES matched JSON-escaped text |
| `DEF-019` | `P02.GATE01` | HIGH | `CLOSED` | AMD-002 recorded a reason that never took effect (blueprint edit failed; batch continued and wrote a vacuous amendment) |
| `DEF-020` | `P03.CP01` | MEDIUM | `CLOSED` | P03.CP01 evidence lost three backticked terms to unquoted-heredoc command substitution |
| `DEF-021` | `P04.NEG03` | HIGH | `CLOSED` | Interrupted executor run can still write a complete manifest: the async signal-teardown races the main flow, which keeps settling child exits and reaches the manifest write before process.exit(130) |
| `DEF-022` | `P05.T03` | LOW | `CLOSED` | Wrong-cwd ledger invocation: persistent shell cwd inside a kept spike worktree routed two phase-transition writes into the worktree's disposable ledger copy; the canonical amend was refused by EVIDENCE_MISSING before any write |
| `DEF-023` | `P05.T03` | HIGH | `CLOSED` | REQUIRED production check 05-workflow-security#zizmor cannot reject: 'zizmor --min-severity high --format sarif' exits 0 even with a High finding (plain format exits 14), so the gate is green regardless of workflow-security findings; its own inline comment asserts the opposite |
| `DEF-024` | `P05.AUD01` | MEDIUM | `CLOSED` | P05.AUD01 false positives: treated any poison signature under a sensitive root as a violation, flagging 22 legitimate pre-existing files (secrets.X in real workflows, DROP TABLE in historical migrations); the audit must ask whether P05 introduced live poison, not whether the repo contains those strings |
| `DEF-025` | `P05.AUD02` | MEDIUM | `CLOSED` | P05 tripped three prior-phase audits: p05-audit.mjs genuinely duplicated P01-owned ref resolution (git diff origin/main...HEAD), and P05.AUD02 missed it because it exempted the whole audit file instead of only its declaration rows; the remaining four flags are declaration-table false positives |
| `DEF-026` | `P05.NEG07` | LOW | `CLOSED` | An interrupted poison cycle leaves an orphaned run directory: P01 and P04 both wire SIGINT handlers and whichever exits first preempts the other's removal, stranding <run>/worktree/node_modules (gitignored, no poison, no worktree registration); P05.NEG07 asserted no poison and no artifact but never asserted zero run-dir residue |
| `DEF-027` | `P05.T03` | HIGH | `CLOSED` | Pre-existing HIGH workflow-security finding blocks DEF-023 closure: zizmor/bot-conditions in .github/workflows/auto-merge-dependabot.yml:27 (spoofable github.actor check) means the now-fail-closed 05-workflow-security gate fails on a CLEAN tree, so its control leg cannot pass and the gate cannot be PROVEN |
| `DEF-028` | `P05.EV01` | MEDIUM | `CLOSED` | Regenerating assurance.json in place invalidated evidence under three already-closed units (P05.EV01/EV02/GATE01); PASS is terminal by design so they cannot be re-pointed, and the run artifact was never a stable path to record as immutable unit evidence |
| `DEF-029` | `P05.T03` | HIGH | `CLOSED` | origin/main advanced mid-session (4d644cf4 -> 1c17c555, 5 commits touching 19 workflow files) and now conflicts with this branch in .gitignore; P01 reports BLOCKED(MERGE_CONFLICT) so no candidate can be constructed, and the existing proofs certify a merge GitHub will no longer evaluate |
| `DEF-030` | `P05.T03` | HIGH | `CLOSED` | Authorized main integration cannot land on the branch: four unrelated UNCOMMITTED developer paths (.gitignore, .claude/settings.json, CLAUDE.md, .claude/scripts/bootstrap-gstack.sh) collide with the incoming merge, and git refuses; resolving requires committing, stashing, or removing developer work, which section 1 forbids |
| `DEF-031` | `P06.T02` | MEDIUM | `CLOSED` | P06 gate runner executes contract provisioning steps that cannot run non-interactively, producing FAIL that is not a detector verdict: ci.yml#security-audit fails on 'sudo: a terminal is required' AFTER its actual checks passed, and full-osv fails on a curl write error |
| `DEF-032` | `P06.T02` | MEDIUM | `CLOSED` | P06 gate runner ignores contract working-directory: dime-llm-validation#validate fails with 'No pyproject.toml found' because it runs from the worktree root instead of its declared ml/dime-1.0 cwd |
| `DEF-033` | `P06.T02` | HIGH | `CLOSED` | Secret-bound gates are classified EXECUTABLE by P06 scope derivation: 01-pr-proof-contract#proof runs the full suite and reports FAIL from 80 credential/DB-dependent test failures (64 env-bound by the repo's own env-gate); these gates require GitHub Actions secrets and must be NOT_LOCALLY_EXECUTABLE, never FAIL |
| `DEF-034` | `P07.T01` | HIGH | `CLOSED` | P07 DB parity is blocked: ci.yml#db-tests requires a mysql:8 service container and the Docker daemon is unreachable, so no digest-pinned MySQL fixture, migration replay, or DB test execution is possible; faking it is forbidden |
| `DEF-035` | `P06.T03 execution` | MEDIUM | `CLOSED` | P06 runner let a stale /usr/local/bin/node v24.11.1 shadow the contract's node-22 pin, so tsx children ran the wrong runtime and ci.yml#typecheck's pi:audit step crashed |
| `DEF-036` | `P06.T03 execution` | MEDIUM | `CLOSED` | executor's gate-isolated TMPDIR path exceeded the 104-byte AF_UNIX sun_path limit, so tsx IPC socket creation failed with EINVAL inside ci.yml#typecheck |
| `DEF-037` | `P06.T03 execution` | HIGH | `CLOSED` | step driver ran undeclared-shell contract steps under pipefail, converting a SUCCESSFUL 'docker logs | grep -q' into exit 141 (SIGPIPE) and reporting a false detector FAIL for 09-artifact |
| `DEF-038` | `P06.T03 execution` | MEDIUM | `CLOSED` | bsdtar on the host rejected the proof contract's 'tar --sort=name', producing a false FAIL in 01-pr-proof-contract#proof's digest step |
| `DEF-039` | `P06.T03 execution` | MEDIUM | `CLOSED` | node_modules equivalence-by-upward-resolution was insufficient: contract-extract.mjs resolves node_modules/yaml/package.json as a literal path, so 10 contract.test.ts assertions failed inside the candidate |
| `DEF-040` | `P07.T02 execution` | MEDIUM | `CLOSED` | verifier-owned MySQL container left an anonymous volume behind: docker rm -f does not remove a container's own anonymous volumes, violating the zero-owned-residue law |
| `DEF-041` | `P06 ASSURANCE` | HIGH | `CLOSED` | ASSURANCE arm() trusted git apply: a mis-counted @@ hunk silently TRUNCATED the poison, yielding a weaker defect that tripped a different rule than the one under proof |
| `DEF-042` | `P06 ASSURANCE` | LOW | `CLOSED` | ASSURANCE cross-fixture contamination: one fixture's declared execution artifact (gitleaks' results.sarif) surfaced as the NEXT fixture's restore residue, producing a false NON_RESTORING |
| `DEF-043` | `P06 ASSURANCE` | MEDIUM | `CLOSED` | ASSURANCE poison was applied but left unstaged, so semgrep skipped it entirely — 'Scan was limited to files tracked by git' — and the blocking gate could not be proven |
| `DEF-044` | `P06 ASSURANCE` | MEDIUM | `CLOSED` | CANDIDATE FINDING: the blocking Semgrep rule dime-money-float-arithmetic-on-cents is structurally incapable of firing on its multiplication/division alternatives, so billing-math protection is vacuous |
| `DEF-045` | `P06.T03 execution` | LOW | `OPEN` | CANDIDATE FINDING: dime-llm-validation#validate fails on origin/main itself — 6 governed evidence-chain pytest failures — and the workflow's ml/** path filter means main has not re-run it since the drift landed |
| `DEF-046` | `P06.T03 execution` | LOW | `OPEN` | CANDIDATE FINDING: the nightly tier is red on main (full-osv-scan and full-container-scan), and the local verifier reproduces both failures — parity confirmed, not a verifier defect |
| `DEF-047` | `P06 ASSURANCE control leg` | HIGH | `CLOSED` | the mandatory #proof gate is INTERMITTENT on this host: its ASSURANCE control leg failed on a single test (scripts/os/observe-crons.test.ts) that passes 3/3 in isolation and passed in the immediately preceding full roster run |
| `DEF-048` | `P07.T02 execution` | LOW | `CLOSED` | the capability probe ran a frozen pnpm install in the DEVELOPER'S repository root, mutating node_modules outside the verifier's scope, and forcing --offline made provisioning depend on local store contents |
| `DEF-049` | `P06 resumption, host measurement` | HIGH | `CLOSED` | ROOT CAUSE OF DEF-047: eight orphaned synthetic CPU-load generators from a PRIOR Claude Code session had been saturating all 8 cores continuously for 2 days 23 hours, starving every full-suite #proof run |
| `DEF-050` | `P06/P07 resumption, P01 candidate construction` | HIGH | `CLOSED` | BLOCKER: no prospective candidate can be constructed — origin/main advanced to 29a4a97e and now conflicts with the branch on pnpm-lock.yaml, so P01 refuses with BLOCKED(MERGE_CONFLICT) and no P06/P07 gate can execute against a current base |
| `DEF-051` | `P06/P07 cross-phase regression` | MEDIUM | `CLOSED` | the P06/P07 modules added last turn violated two ALREADY-ACCEPTED phases' isolation audits: 56 P03 workflow-path violations and 8 P01 provenance violations, neither of which was run before the previous halt |
| `DEF-052` | `DEF-047 invariant analysis` | MEDIUM | `CLOSED` | CANDIDATE FINDING: the test named 'bcrypt cost=10 (OWASP-compliant)' hardcodes cost 10 in its own call, so it verifies nothing about the cost production actually uses; the genuine security invariant is untested |
| `DEF-053` | `P06 re-proof of DEF-044` | HIGH | `OPEN` | CANDIDATE FINDING, escalates DEF-044: TWO ERROR-severity Semgrep rules fail to PARSE, so semgrep-core silently drops them and the blocking gate still exits 0 — the gate reports success while carrying invalid detectors |
| `DEF-054` | `negative proof of my own DEF-052 remediation` | MEDIUM | `CLOSED` | the first version of my production-bcrypt-cost assertion was itself vacuous: the pathspec 'server/**/*.ts' silently excludes files directly under server/, so the poisoned site was never scanned and the test passed |
| `DEF-055` | `P06 full-regression surface (P05.AUD01)` | HIGH | `CLOSED` | the P06 fixtures were INVISIBLE to P05's poison-containment audit: its signature list knew only the p05 marker, so most P06 poison passed through unexamined rather than being proven inert |
| `DEF-056` | `P06/P07 fresh-base checks` | MEDIUM | `CLOSED` | STRUCTURAL: origin/main advances faster than a full P06+P07 verification cycle completes, so a strictly-current-base acceptance may never converge on an active day |
| `DEF-057` | `P06 roster at base 43a33c84` | MEDIUM | `CLOSED` | candidate materialization gap: P01 worktree candidates leave the new cloudflare-os gitlink EMPTY, so the tailered-os gate's detector failed on 'git -C cloudflare-os rev-parse HEAD' — a provisioning gap surfacing as a false detector FAIL (the DEF-031 class) |
| `DEF-058` | `P06 serial roster @43a33c84, tailered-os.yml#test step journal` | HIGH | `CLOSED` | VERIFIER FIDELITY: contract extractor drops workflow-level env: blocks (records job?.env only), so EXPECTED_CLOUDFLARE_OS_PIN never reaches the detector step — a correct candidate pin (b2a51b54) is reported as detector FAIL. Blast radius bounded to this one gate: 03-semgrep/05-workflow-security use their workflow-level vars in provisioning steps already satisfied by governed tools |
| `DEF-059` | `P06 serial rebind roster @ candidate 7e86ad23, gitleaks gate + ASSURANCE CONTROL_NOT_GREEN` | HIGH | `CLOSED` | CANDIDATE FINDING introduced by DEF-058 remediation: embedding workflow-level env in contract.frozen.json juxtaposes CLOUDFLARE keyword with the 40-hex submodule pin in quoted-JSON form, tripping gitleaks cloudflare-api-key. The value is the public immutable cloudflare-os commit SHA (present in .gitmodules and tailered-os.yml), not a credential |
| `DEF-060` | `P07 coverage gate @ e672bb11 (serial chain), single test failure under v8 instrumentation at host load 18/8-cores` | MEDIUM | `CLOSED` | CANDIDATE TEST-QUALITY (DEF-047 Cause-C class): strikeoutProps.test.ts loaded the entire app-router graph via await import inside the 15s testTimeout; under coverage instrumentation + load the bound measures CPU availability, not router existence. Same test PASSed ci#test in the same chain; coverage gate PASSed the two prior candidates; content delta was toml/docs only |
| `DEF-061` | `P06 roster @ 249bf314 candidate, proof gate step journal` | MEDIUM | `CLOSED` | CANDIDATE TEST-QUALITY (DEF-060 class): dime-authentication-closure.test.ts runs bundle-generation subprocesses with a declared 30s execFile budget inside the 15s default testTimeout — inner allowance exceeds outer bound, so the test times out under full-suite parallelism (now +305 TOS-009 tests) while passing isolated in 2.5s and green on main CI |
| `DEF-062` | `P06 roster @ 249bf314 candidate (second attempt), proof step journal` | MEDIUM | `CLOSED` | VERIFIER ENVIRONMENT (structural, terminates the DEF-060/061 class): vitest runs 8 workers on this 8-core host (no cap in vitest.config) while CI's ubuntu-latest exposes 4 vCPUs — per-worker CPU starvation local-only; three distinct subprocess-heavy tests tripped the 15s testTimeout across consecutive rosters while green in CI and isolated |
| `DEF-063` | `P08.T07 profile B (cleanroom runtime), first full-mode run` | HIGH | `CLOSED` | CANDIDATE FINDING: the production container has NO SIGTERM handler while node runs as PID 1 (CMD [node, dist/index.js]) — PID 1 ignores default signal dispositions, so every platform SIGTERM (each Railway deploy, docker stop) is silently ignored until SIGKILL: exit 137 observed on both cleanroom profiles, in-flight work dropped, DB connections severed on every deploy since inception |
| `DEF-064` | `P09.T05 a11y gate, first control run` | LOW | `OPEN` | CANDIDATE FINDING: .state-pill--pass on the landing page fails WCAG AA color contrast (serious, 1 node) — found by the vendored-axe gate against the BUILT client; baselined under the documented ratchet (recorded, never hidden), fix deferred to UI brand-law work |
| `DEF-065` | `P10.T04 remote reconciliation` | LOW | `OPEN` | REMOTE DRIFT: the live ruleset added 13-tos-notion-context as a 10th required context mid-program (TOS-009), while the program contract snapshot records 9. The added check is credential-bound (locally NOT_LOCALLY_EXECUTABLE, T13 nonlocal class — same as dependency-review), so local-parity verdicts are unaffected; PRs additionally need it green in CI. Snapshot refresh rides the next contract re-derivation |
| `DEF-066` | `ci:verify:pr rehearsal attempt 4, proof suite (P05.TEST04 + VER01)` | MEDIUM | `CLOSED` | TWO rehearsal findings: (a) self-test fixture cycles ran git fetch inside the parallel proof suite and collided on git's lock — INFRA-FAIL(BASE_FETCH_FAILED) surfacing as a test failure; (b) the round-2 fix commit modified run-p09.mjs/certificate.mjs/knip.json without reevidencing the P09/P10 units that cite them — VER01 (our own anchor) caught the stale hashes in the committed ledger |
| `DEF-067` | `closure-audit CI-VERIFY-AUDIT-20260812T131456Z (D9/M-benchmark Q5)` | LOW | `CLOSED` | report.json carries no identity binding: the verify-pr report cannot prove which commit it describes |
| `DEF-068` | `closure-audit scenario E2: tampered required_contexts + re-pin verified VALID pre-repair (live reproduction)` | HIGH | `CLOSED` | certificate verify compared only 7 hashes: stored display bindings (required_contexts, toolchain, cleanroom, execution_history, verifier_file_count, open_units_all_p10) were never compared |
| `DEF-069` | `closure-audit E0 preflight inventory` | LOW | `CLOSED` | stale run-dir residue: 7 .ci-verify/runs dirs with 9 registered git worktrees (9.5G) persisted while a zero-worktree-residue claim was reported |
| `DEF-070` | `closure-audit E13 attempt 2 (gate FAIL, reproduced 2x in isolation at 2.1s)` | LOW | `CLOSED` | ENVIRONMENT: Security Audit red repo-wide — GHSA-jmr9-qjv8-65gv (extract-zip <=2.0.1, HIGH) modified 2026-08-12T19:30:12Z with no patched release; via @puppeteer/browsers@2.13.0 (dev tooling); same class as DEF-045/046; blocks LOCAL_READY_FOR_PR until owner dispositions the advisory (osv-scanner.toml entry or dependency removal — outside audit authority) |
| `DEF-071` | `closure-audit scenario H2 (sandbox): 20 concurrent writers -> 1 survivor; duplicate-id guard TOCTOU race` | MEDIUM | `CLOSED` | canonical ledger writer loses concurrent updates: load-mutate-persist had no pre-write exclusion and no atomic settlement; corruption was detectable only AFTER the fact |
| `DEF-072` | `P7 rehearsal attempt 1 (first honest run): migration replay exited 1 with empty stdout` | LOW | `CLOSED` | deploy lib.run() inherited the pnpm-run corepack context: child pnpm failed the packageManager pin inside ci:verify:deploy:* (DEF-062 class recurrence in new code) |
| `DEF-073` | `P8 attempt 1: p06-roster gitleaks parity gate FAIL on the committed rehearsal evidence` | LOW | `CLOSED` | generic-api-key false positive: rehearsal evidence idempotency_key (derived sha256 of public identifiers) trips the entropy rule on every rehearsal record |
| `DEF-074` | `PR #512 CI attempt 1 (first-ever GitHub execution of the branch): 12+5 test failures across 01/07/Vitest + CodeQL new-alert check` | MEDIUM | `OPEN` | verifier self-tests and jobs assumed the dev host: shallow checkout without origin/main, missing pinned zizmor on suite runners, sudo that fails locally but succeeds on runners, macOS-only ps -E in teardown, predictable tmpdirs in new suites |

## Checkpoints

| Phase | Decision | Recorded at | Evidence |
| --- | --- | --- | --- |
| `PB` | **PROCEED TO P00** | 2026-08-10T08:20:39.490Z | `7b75b64faad4` |
| `P00` | **DO NOT PROCEED (blocking: DEF-002, DEF-003)** | 2026-08-10T08:32:07.069Z | `9a0d5373db77` |
| `P00` | **PROCEED TO P01 (supersedes CP01; DEF-002/003/004 closed)** | 2026-08-10T08:54:23.461Z | `56e2ba284da9` |
| `P01` | **PROCEED TO P02** | 2026-08-10T09:24:40.039Z | `51ccc53de3f1` |
| `P02` | **PROCEED TO P03** | 2026-08-10T09:51:10.828Z | `1a36ea25a1e4` |
| `P03` | **PROCEED TO P04** | 2026-08-10T10:22:27.089Z | `1ccb5c006c3a` |
| `P04` | **PROCEED TO P05** | 2026-08-10T11:11:17.814Z | `d710f47496b9` `258a5a137e3b` `0dd066e93e4c` |
| `P05` | **DO NOT PROCEED — Blocking IDs: DEF-023** | 2026-08-10T12:34:32.750Z | `1a5009ba0682` `72cf4564a506` `c47c1ae2f501` |
| `P05` | **DO NOT PROCEED — Blocking IDs: DEF-023, DEF-027** | 2026-08-10T12:55:08.983Z | `bf3692d404df` `a7e7af54c903` `0e420ebcdb5b` |
| `P05` | **DO NOT PROCEED — Blocking IDs: DEF-029** | 2026-08-10T13:15:11.937Z | `3272fd4ce86f` `c94494e91c9a` `8f98269979b8` |
| `P05` | **DO NOT PROCEED — Blocking IDs: DEF-029, DEF-030** | 2026-08-10T13:44:51.683Z | `84975bcad146` `b15f0425e1ce` |
| `P05` | **PROCEED TO P06/P07** | 2026-08-10T14:03:07.890Z | `ab45fd7b558b` `abf4c803c515` `27c38bf1eaa0` |
| `P06` | **DO NOT PROCEED — Blocking IDs: DEF-031, DEF-032, DEF-033** | 2026-08-10T14:22:28.227Z | `cc14465b43fa` `190c484a3703` `ae0d6be4ea27` |
| `P07` | **DO NOT PROCEED — Blocking IDs: DEF-034** | 2026-08-10T14:22:28.288Z | `f388f46ae9f9` `9f5ddae08867` |
| `P06` | **DO NOT PROCEED — Blocking IDs: DEF-031, DEF-032, DEF-033** | 2026-08-10T14:34:03.422Z | `0f8dca748667` `4dded656ac55` `abc590181a04` |
| `P07` | **DO NOT PROCEED — Blocking IDs: DEF-034** | 2026-08-10T14:34:03.488Z | `2b7514164ab6` `9f5ddae08867` |
| `P06` | **DO NOT PROCEED — blocking: DEF-047 (mandatory #proof gate intermittent on this host; ASSURANCE coverage 5/6, #proof UNPROVEN because a proof requires a green control leg)** | 2026-08-10T18:37:18.002Z | `2b5c209dd15e` `eb7ea91ec878` `4ed0818286bc` |
| `P07` | **DO NOT PROCEED — blocking: DEF-047 (shared test-surface instability prevents asserting zero_flaky_mandatory). DB parity itself PROVEN: digest-bound mysql 8.4.11, migration replay to 0134, 10 files/92 tests, zero residue; DEF-034 CLOSED** | 2026-08-10T18:37:18.174Z | `f01e7bf16e52` `e688f054502d` |
| `P06` | **DO NOT PROCEED — blocking: DEF-050 (no candidate: origin/main advanced to 29a4a97e and conflicts on pnpm-lock.yaml), DEF-047 (root cause established and remediated via DEF-049, but the 5-run determinism campaign requires the blocked candidate)** | 2026-08-10T19:28:40.157Z | `71abf520c025` |
| `P07` | **DO NOT PROCEED — blocking: DEF-050, DEF-047. DB parity evidence is real but now stale-based: it binds to 7fa4b3fe and origin/main has moved to 29a4a97e** | 2026-08-10T19:28:40.241Z | `9d23daccdf9b` |
| `P06` | **ACCEPT — seven-term predicate TRUE at base 249bf314, integration 61369e77, remediations 114052b3+77594d5a, contract b594ebd9 (byte-identical across the base move): 29/29 mandatory units closed; roster blocking 0 with #proof PASS; ASSURANCE 8/8 PROVEN coverage 6/6; regression green (negatives 56/56, scripts suite, prettier, ledger verify, conformance+3 audits, tsc); open defects all non-blocking advisories (DEF-045 LOW, DEF-046 LOW, DEF-053 non-attributed); freshness barrier PASS at the acceptance record (FINAL_MAIN_SHA == FROZEN_BASE_SHA == 249bf314)** | 2026-08-12T07:30:04.789Z | `569c4c0f76a6` `d09ed6edf0b2` `239f7adf2711` |
| `P07` | **ACCEPT — seven-term predicate TRUE at base 249bf314: 24/24 mandatory units closed; P07 3/3 PASS at this base (test 214.3s, coverage 163.7s, db-tests 26.8s = 10 files/92 tests, MySQL 8.4.11 digest-bound, zero residue); DB surface byte-identical from 43a33c84 through 249bf314 so the TEST03 same-SHA demonstration and REG01 three-run series remain valid and db-tests reproduced 10/92 again; zero open defects attributed to P07; freshness barrier PASS at the acceptance record** | 2026-08-12T07:30:04.832Z | `0b40d19bc23c` `d884ee630a6a` |
| `P08` | **ACCEPT — all 24 mandatory units closed at base 249bf314, candidate e35cd5841c9e (DEF-063 fix aboard): build+trivy+SBOM green; profiles A and B green including graceful shutdown and drained connections; NEG01-03 each demonstrably reject their exact defect; GATE01 3/3 consecutive clean rounds; CLN01 zero residue every run; DEF-063 (PID-1 SIGTERM ignored — every production deploy hard-killed the app) found by this phase, fixed, and retested; build-variance recorded honestly (image id is run-scoped; candidate commit is the binding identity); freshness barrier holds at the acceptance record** | 2026-08-12T09:10:19.901Z | `19b3743c5608` `7d9785003538` |
| `P09` | **ACCEPT — 17/17 mandatory units closed at base 249bf314, candidate 6aabf13c8fb7: all four HARDENING gates green in one final run AND all four negatives redden for their exact defect (deploy-order/#370 class BLOCKING per DEC-002; schema-type-drift/0134 class via drizzle-kit no-op oracle; knip ratchet over the verifier tree; a11y over the BUILT client with vendored sha256-pinned axe). Bring-up caught its own vacuous drift PASS (NEG02), the knip TS-7 peer break, and a REAL pre-existing WCAG miss (DEF-064, baselined recorded-never-hidden). HARDENING never merges into PARITY (AUD01). Barrier holds at the record** | 2026-08-12T09:28:55.465Z | `71fe5005d868` `7299cac149f1` |
| `P10` | **ACCEPT — certificate machine proven both directions: ISSUED baf628a2e256 at 3b493236e with independent fresh-process verify VALID (TEST03); 8/8 negatives produce their exact verdicts (VOID head_sha/verifier_hash, NOT_COMPARABLE(STALE_BASE) never a parity mismatch, REFUSED on flaky/incomplete/non-accepted-phase-with-name/tampered); TEST02 field-for-field vs real PR #510 (merge_tree e67d0af39842 exact match); T04 remote reconciliation caught genuine drift (DEF-065: 10th required context added mid-program, credential-bound, local parity unaffected); barrier holds** | 2026-08-12T09:40:30.634Z | `7b9447f9eb9d` `041f00f78261` |
