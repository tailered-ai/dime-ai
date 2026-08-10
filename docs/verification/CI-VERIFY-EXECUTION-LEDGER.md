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
| `P04` | Executor core | `NOT_STARTED` | 0 / 24 | 0 | 0 |
| `P05` | ASSURANCE — the self-test framework | `NOT_STARTED` | 0 / 20 | 0 | 0 |
| `P06` | PARITY — static, security, supply chain | `NOT_STARTED` | 0 / 29 | 0 | 0 |
| `P07` | PARITY — test and data | `NOT_STARTED` | 0 / 24 | 0 | 0 |
| `P08` | CLEANROOM — image identity, container build, dual runtime proof | `NOT_STARTED` | 0 / 23 | 0 | 0 |
| `P09` | HARDENING | `NOT_STARTED` | 0 / 17 | 0 | 0 |
| `P10` | Certificate, REMOTE reconciliation, LOCAL_READY_FOR_PR | `NOT_STARTED` | 0 / 22 | 0 | 0 |

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

**State:** `NOT_STARTED`

**Assurance property:** Gates execute under declared scheduling, hermeticity, timeout, and teardown guarantees, and no exit code is ever silently suppressed.

**Depends on:** `P03`

**Progress (MANDATORY):** 0 / 24

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
| `P04.T01` | TASK | MANDATORY | `NOT_STARTED` | 0 | — | DAG scheduler over declared requires |
| `P04.T02` | TASK | MANDATORY | `NOT_STARTED` | 0 | — | Concurrency and memory budget |
| `P04.T03` | TASK | MANDATORY | `NOT_STARTED` | 0 | — | Serial DB lane |
| `P04.T04` | TASK | MANDATORY | `NOT_STARTED` | 0 | — | Hermetic env: TZ=UTC, LC_ALL=C.UTF-8, seed, reserved ports, isolated TMPDIR |
| `P04.T05` | TASK | MANDATORY | `NOT_STARTED` | 0 | — | Network policy plus ENFORCEMENT DETECTION (host runs report HERMETIC:UNENFORCED) |
| `P04.T06` | TASK | MANDATORY | `NOT_STARTED` | 0 | — | Timeout: SIGTERM, grace, SIGKILL |
| `P04.T07` | TASK | MANDATORY | `NOT_STARTED` | 0 | — | Teardown registry across success, failure, SIGINT, SIGTERM, timeout, uncaught exception |
| `P04.T08` | TASK | MANDATORY | `NOT_STARTED` | 0 | — | Attempts and flake recording |
| `P04.T09` | TASK | MANDATORY | `NOT_STARTED` | 0 | — | Emit executor.jsonl |
| `P04.T10` | TASK | MANDATORY | `NOT_STARTED` | 0 | — | Lane sentinel: named lane lock with entered_at/exited_at intervals, released on crash and timeout |
| `P04.TEST01` | POSITIVE_VALIDATION | MANDATORY | `NOT_STARTED` | 0 | — | Scheduler respects declared requires ordering |
| `P04.TEST02` | POSITIVE_VALIDATION | MANDATORY | `NOT_STARTED` | 0 | — | Serial lane exclusivity holds |
| `P04.TEST03` | POSITIVE_VALIDATION | MANDATORY | `NOT_STARTED` | 0 | — | Hermetic env is observed inside a child process |
| `P04.NEG01` | NEGATIVE_VALIDATION | MANDATORY | `NOT_STARTED` | 0 | — | Orphaned process is reaped and reported INFRA-FAIL |
| `P04.NEG02` | NEGATIVE_VALIDATION | MANDATORY | `NOT_STARTED` | 0 | — | Hanging gate yields TIMEOUT, not FAIL |
| `P04.NEG03` | NEGATIVE_VALIDATION | MANDATORY | `NOT_STARTED` | 0 | — | SIGINT yields clean teardown and a non-zero exit |
| `P04.NEG04` | NEGATIVE_VALIDATION | MANDATORY | `NOT_STARTED` | 0 | — | network: deny on host yields INCONCLUSIVE, never PASS |
| `P04.NEG05` | NEGATIVE_VALIDATION | MANDATORY | `NOT_STARTED` | 0 | — | Top-level exit-code suppression is detected by audit |
| `P04.NEG06` | NEGATIVE_VALIDATION | MANDATORY | `NOT_STARTED` | 0 | — | Direct concurrent invocation bypassing the scheduler trips LANE_VIOLATION deterministically |
| `P04.FI01` | FAILURE_INJECTION | MANDATORY | `NOT_STARTED` | 0 | — | Failure injection: kill the executor mid-gate |
| `P04.FI02` | FAILURE_INJECTION | MANDATORY | `NOT_STARTED` | 0 | — | Failure injection: exhaust the memory budget |
| `P04.CLN01` | CLEANUP | MANDATORY | `NOT_STARTED` | 0 | — | SIGINT teardown: 10 of 10 runs leave zero residue |
| `P04.GATE01` | ACCEPTANCE_GATE | MANDATORY | `NOT_STARTED` | 0 | — | P04.CLN01, P04.NEG01, P04.NEG04 PASS |
| `P04.CP01` | CHECKPOINT | MANDATORY | `NOT_STARTED` | 0 | — | P04 checkpoint recorded |

## P05 — ASSURANCE — the self-test framework

**State:** `NOT_STARTED`

**Assurance property:** Every mandatory gate is proven capable of rejection, for its own declared reason, and proven to return to green after restoration.

**Depends on:** `P04`

**Progress (MANDATORY):** 0 / 20

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
| `P05.T01` | TASK | MANDATORY | `NOT_STARTED` | 0 | — | Fixture format {poison.patch, expect.json} |
| `P05.T02` | TASK | MANDATORY | `NOT_STARTED` | 0 | — | Placement policy enforcement — fixtures are patches, never live files in scanned trees |
| `P05.T03` | TASK | MANDATORY | `NOT_STARTED` | 0 | — | Runner: worktree, apply, run target gate, assert, revert, control re-run |
| `P05.T04` | TASK | MANDATORY | `NOT_STARTED` | 0 | — | expected_gate enforcement |
| `P05.T05` | TASK | MANDATORY | `NOT_STARTED` | 0 | — | expected_reason signature matching |
| `P05.T06` | TASK | MANDATORY | `NOT_STARTED` | 0 | — | Coverage assertion — every mandatory gate has a fixture |
| `P05.T07` | TASK | MANDATORY | `NOT_STARTED` | 0 | — | Emit assurance.json plus its sha256 |
| `P05.TEST01` | POSITIVE_VALIDATION | MANDATORY | `NOT_STARTED` | 0 | — | Real gate 1 reddens for its own declared reason; control returns green |
| `P05.TEST02` | POSITIVE_VALIDATION | MANDATORY | `NOT_STARTED` | 0 | — | Real gate 2 reddens for its own declared reason; control returns green |
| `P05.TEST03` | POSITIVE_VALIDATION | MANDATORY | `NOT_STARTED` | 0 | — | Real gate 3 reddens for its own declared reason; control returns green |
| `P05.NEG01` | NEGATIVE_VALIDATION | MANDATORY | `NOT_STARTED` | 0 | — | Fixture reddening the wrong gate yields BROKEN-GATE(WRONG_TARGET) |
| `P05.NEG02` | NEGATIVE_VALIDATION | MANDATORY | `NOT_STARTED` | 0 | — | Fixture whose control run stays red yields BROKEN-GATE(NON_RESTORING) |
| `P05.NEG03` | NEGATIVE_VALIDATION | MANDATORY | `NOT_STARTED` | 0 | — | Mandatory gate without a fixture yields BROKEN-GATE(UNPROVEN) |
| `P05.NEG04` | NEGATIVE_VALIDATION | MANDATORY | `NOT_STARTED` | 0 | — | A live poison fixture inside a scanned path causes the build to refuse |
| `P05.AUD01` | AUDIT | MANDATORY | `NOT_STARTED` | 0 | — | Audit: zero poison artifacts exist in the tracked tree |
| `P05.EV01` | EVIDENCE | MANDATORY | `NOT_STARTED` | 0 | — | Evidence: assurance.json |
| `P05.EV02` | EVIDENCE | MANDATORY | `NOT_STARTED` | 0 | — | Evidence: assurance.json sha256 |
| `P05.GATE01` | ACCEPTANCE_GATE | MANDATORY | `NOT_STARTED` | 0 | — | At least three real gates proven |
| `P05.GATE02` | ACCEPTANCE_GATE | MANDATORY | `NOT_STARTED` | 0 | — | Coverage assertion armed |
| `P05.CP01` | CHECKPOINT | MANDATORY | `NOT_STARTED` | 0 | — | P05 checkpoint recorded |

## P06 — PARITY — static, security, supply chain

**State:** `NOT_STARTED`

**Assurance property:** Every locally reproducible static and supply-chain requirement of the merge contract is executed verbatim, with pinned tools.

**Depends on:** `P05`

**Progress (MANDATORY):** 0 / 29

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
| `P06.T01` | TASK | MANDATORY | `NOT_STARTED` | 0 | — | tools-sync: contract-read pins plus checksum verification — the ONLY network-permitted unit |
| `P06.T02` | TASK | MANDATORY | `NOT_STARTED` | 0 | — | Gate: typecheck |
| `P06.T03` | TASK | MANDATORY | `NOT_STARTED` | 0 | — | Gate: format |
| `P06.T04` | TASK | MANDATORY | `NOT_STARTED` | 0 | — | Gate: semgrep-blocking |
| `P06.T05` | TASK | MANDATORY | `NOT_STARTED` | 0 | — | Gate: zizmor |
| `P06.T06` | TASK | MANDATORY | `NOT_STARTED` | 0 | — | Gate: gitleaks |
| `P06.T07` | TASK | MANDATORY | `NOT_STARTED` | 0 | — | Gate: osv-scanner plus check-osv-scan |
| `P06.T08` | TASK | MANDATORY | `NOT_STARTED` | 0 | — | Gate: actions-security contract |
| `P06.T09` | TASK | MANDATORY | `NOT_STARTED` | 0 | — | Gate: federation docs |
| `P06.T10` | TASK | MANDATORY | `NOT_STARTED` | 0 | — | Gate: migration hygiene trio |
| `P06.T11` | TASK | MANDATORY | `NOT_STARTED` | 0 | — | Gate: ai-eval set with env -u DATABASE_URL |
| `P06.T12` | TASK | MANDATORY | `NOT_STARTED` | 0 | — | CI-ONLY registration with explicit reasons |
| `P06.TEST01` | POSITIVE_VALIDATION | MANDATORY | `NOT_STARTED` | 0 | — | All implemented gates green on a clean snapshot |
| `P06.TEST02` | POSITIVE_VALIDATION | MANDATORY | `NOT_STARTED` | 0 | — | Executed command is byte-for-byte identical to the frozen contract |
| `P06.NEG01` | NEGATIVE_VALIDATION | MANDATORY | `NOT_STARTED` | 0 | — | Poison fixture reddens the typecheck gate for its own reason |
| `P06.NEG02` | NEGATIVE_VALIDATION | MANDATORY | `NOT_STARTED` | 0 | — | Poison fixture reddens the format gate for its own reason |
| `P06.NEG03` | NEGATIVE_VALIDATION | MANDATORY | `NOT_STARTED` | 0 | — | Poison fixture reddens the semgrep gate for its own reason |
| `P06.NEG04` | NEGATIVE_VALIDATION | MANDATORY | `NOT_STARTED` | 0 | — | Poison fixture reddens the zizmor gate for its own reason |
| `P06.NEG05` | NEGATIVE_VALIDATION | MANDATORY | `NOT_STARTED` | 0 | — | Poison fixture reddens the gitleaks gate for its own reason |
| `P06.NEG06` | NEGATIVE_VALIDATION | MANDATORY | `NOT_STARTED` | 0 | — | Poison fixture reddens the osv gate for its own reason |
| `P06.NEG07` | NEGATIVE_VALIDATION | MANDATORY | `NOT_STARTED` | 0 | — | Poison fixture reddens the actions-security gate for its own reason |
| `P06.NEG08` | NEGATIVE_VALIDATION | MANDATORY | `NOT_STARTED` | 0 | — | Poison fixture reddens the federation-docs gate for its own reason |
| `P06.NEG09` | NEGATIVE_VALIDATION | MANDATORY | `NOT_STARTED` | 0 | — | Poison fixture reddens the migration-hygiene gate for its own reason |
| `P06.NEG10` | NEGATIVE_VALIDATION | MANDATORY | `NOT_STARTED` | 0 | — | Poison fixture reddens the ai-eval gate for its own reason |
| `P06.NEG11` | NEGATIVE_VALIDATION | MANDATORY | `NOT_STARTED` | 0 | — | Missing tool yields BLOCKED, never green |
| `P06.NEG12` | NEGATIVE_VALIDATION | MANDATORY | `NOT_STARTED` | 0 | — | Tool version differing from the contract pin yields CONTRACT-DRIFT |
| `P06.AUD01` | AUDIT | MANDATORY | `NOT_STARTED` | 0 | — | Audit: network is permitted only in P06.T01 |
| `P06.GATE01` | ACCEPTANCE_GATE | MANDATORY | `NOT_STARTED` | 0 | — | Self-test coverage for this phase is 100 percent |
| `P06.CP01` | CHECKPOINT | MANDATORY | `NOT_STARTED` | 0 | — | P06 checkpoint recorded |

## P07 — PARITY — test and data

**State:** `NOT_STARTED`

**Assurance property:** The full test contract runs with CI's partitioning, with no impact selection, and DB-lane exclusion is proven deterministically.

**Depends on:** `P05`

**Progress (MANDATORY):** 0 / 24

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
| `P07.T01` | TASK | MANDATORY | `NOT_STARTED` | 0 | — | MySQL fixture pinned by image digest |
| `P07.T02` | TASK | MANDATORY | `NOT_STARTED` | 0 | — | Reconciled migration replay on the fresh database |
| `P07.T03` | TASK | MANDATORY | `NOT_STARTED` | 0 | — | DB-suite discovery via the SKIP_DB_IN_CI marker |
| `P07.T04` | TASK | MANDATORY | `NOT_STARTED` | 0 | — | Cross-check discovery against ci.yml's hardcoded suite list |
| `P07.T05` | TASK | MANDATORY | `NOT_STARTED` | 0 | — | Non-DB parallel phase |
| `P07.T06` | TASK | MANDATORY | `NOT_STARTED` | 0 | — | DB serial phase using the P04.T10 lane sentinel |
| `P07.T07` | TASK | MANDATORY | `NOT_STARTED` | 0 | — | Environment-failure gate integration |
| `P07.T08` | TASK | MANDATORY | `NOT_STARTED` | 0 | — | Collection-collapse floor enforcement |
| `P07.T09` | TASK | MANDATORY | `NOT_STARTED` | 0 | — | Report merge into a single result document |
| `P07.T10` | TASK | MANDATORY | `NOT_STARTED` | 0 | — | Diff-aware gates read the base SHA from snapshot.json |
| `P07.TEST01` | POSITIVE_VALIDATION | MANDATORY | `NOT_STARTED` | 0 | — | Full suite green on a clean snapshot |
| `P07.TEST02` | POSITIVE_VALIDATION | MANDATORY | `NOT_STARTED` | 0 | — | DB phase ordering matches CI |
| `P07.TEST03` | POSITIVE_VALIDATION | MANDATORY | `NOT_STARTED` | 0 | — | Local results match a CI db-tests run on the same SHA |
| `P07.NEG01` | NEGATIVE_VALIDATION | MANDATORY | `NOT_STARTED` | 0 | — | Suite removed from ci.yml's list yields CONTRACT-DRIFT |
| `P07.NEG02` | NEGATIVE_VALIDATION | MANDATORY | `NOT_STARTED` | 0 | — | Forced collection error is never excusable and yields FAIL |
| `P07.NEG03` | NEGATIVE_VALIDATION | MANDATORY | `NOT_STARTED` | 0 | — | Two DB-partitioned gates in one run record disjoint lane intervals, zero sentinel violations, and are serialized rather than rejected |
| `P07.NEG04` | NEGATIVE_VALIDATION | MANDATORY | `NOT_STARTED` | 0 | — | Impact-based test selection attempted in PARITY is refused |
| `P07.NEG05` | NEGATIVE_VALIDATION | MANDATORY | `NOT_STARTED` | 0 | — | Dirty tree plus a diff-aware coverage gate yields BLOCKED |
| `P07.REG01` | REGRESSION | MANDATORY | `NOT_STARTED` | 0 | — | Three consecutive runs produce identical results |
| `P07.AUD01` | AUDIT | ADVISORY | `NOT_STARTED` | 0 | — | ADVISORY: optional reproduction of the historical Incident 42 race — never an acceptance input |
| `P07.EV01` | EVIDENCE | MANDATORY | `NOT_STARTED` | 0 | — | Evidence: merged vitest results |
| `P07.EV02` | EVIDENCE | MANDATORY | `NOT_STARTED` | 0 | — | Evidence: environment-failure gate report |
| `P07.EV03` | EVIDENCE | MANDATORY | `NOT_STARTED` | 0 | — | Evidence: DB test report |
| `P07.GATE01` | ACCEPTANCE_GATE | MANDATORY | `NOT_STARTED` | 0 | — | P07.TEST03 demonstrated |
| `P07.CP01` | CHECKPOINT | MANDATORY | `NOT_STARTED` | 0 | — | P07 checkpoint recorded |

## P08 — CLEANROOM — image identity, container build, dual runtime proof

**State:** `NOT_STARTED`

**Assurance property:** The repository's container build contract reproduces, and the built artifact is proven on both the failure path and the healthy path.

**Depends on:** `P06`, `P07`

**Progress (MANDATORY):** 0 / 23

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
| `P08.T01` | TASK | MANDATORY | `NOT_STARTED` | 0 | — | images.pinned.json — verifier-controlled images pinned by digest |
| `P08.T02` | TASK | MANDATORY | `NOT_STARTED` | 0 | — | RECORD the Dockerfile base digest without editing FROM |
| `P08.T03` | TASK | MANDATORY | `NOT_STARTED` | 0 | — | Container build reproducing the repository's build contract |
| `P08.T04` | TASK | MANDATORY | `NOT_STARTED` | 0 | — | Trivy CRITICAL fixable-only blocking gate |
| `P08.T05` | TASK | MANDATORY | `NOT_STARTED` | 0 | — | SBOM generation |
| `P08.T06` | TASK | MANDATORY | `NOT_STARTED` | 0 | — | Runtime profile A — dead DB: crash-guard, /health, structured 401, listen line |
| `P08.T07` | TASK | MANDATORY | `NOT_STARTED` | 0 | — | Runtime profile B — healthy DB: commit identity, schema compatibility, auth-independent paths, background-job gating, graceful SIGTERM shutdown |
| `P08.T08` | TASK | MANDATORY | `NOT_STARTED` | 0 | — | Build-variance recorder (AUDIT class, non-blocking) |
| `P08.TEST01` | POSITIVE_VALIDATION | MANDATORY | `NOT_STARTED` | 0 | — | Runtime profile A green |
| `P08.TEST02` | POSITIVE_VALIDATION | MANDATORY | `NOT_STARTED` | 0 | — | Runtime profile B green including graceful shutdown |
| `P08.TEST03` | POSITIVE_VALIDATION | MANDATORY | `NOT_STARTED` | 0 | — | SBOM is non-empty |
| `P08.NEG01` | NEGATIVE_VALIDATION | MANDATORY | `NOT_STARTED` | 0 | — | Broken Dockerfile fails the build before any runtime gate executes |
| `P08.NEG02` | NEGATIVE_VALIDATION | MANDATORY | `NOT_STARTED` | 0 | — | Wrong EXPECTED_COMMIT fails profile B on build identity |
| `P08.NEG03` | NEGATIVE_VALIDATION | MANDATORY | `NOT_STARTED` | 0 | — | MySQL killed mid-run yields INFRA-FAIL, not FAIL |
| `P08.CLN01` | CLEANUP | MANDATORY | `NOT_STARTED` | 0 | — | Zero residual containers after every run |
| `P08.AUD01` | AUDIT | ADVISORY | `NOT_STARTED` | 0 | — | ADVISORY: build variance recorded across clean rebuilds, never blocking |
| `P08.EV01` | EVIDENCE | MANDATORY | `NOT_STARTED` | 0 | — | Evidence: image-id.txt |
| `P08.EV02` | EVIDENCE | MANDATORY | `NOT_STARTED` | 0 | — | Evidence: trivy.table |
| `P08.EV03` | EVIDENCE | MANDATORY | `NOT_STARTED` | 0 | — | Evidence: sbom.spdx.json |
| `P08.EV04` | EVIDENCE | MANDATORY | `NOT_STARTED` | 0 | — | Evidence: runtime profile A log |
| `P08.EV05` | EVIDENCE | MANDATORY | `NOT_STARTED` | 0 | — | Evidence: runtime profile B log |
| `P08.GATE01` | ACCEPTANCE_GATE | MANDATORY | `NOT_STARTED` | 0 | — | Three consecutive clean runs of profiles A and B |
| `P08.AUTH01` | AUTHORIZATION | MANDATORY | `NOT_STARTED` | 0 | — | Owner decision DEC-001 RECORDED: PIN_BY_DIGEST or RECORD_ONLY — both satisfy this authorization |
| `P08.CP01` | CHECKPOINT | MANDATORY | `NOT_STARTED` | 0 | — | P08 checkpoint recorded |

## P09 — HARDENING

**State:** `NOT_STARTED`

**Assurance property:** Dime-specific standards that CI does not enforce are checked locally, and are reported separately from the PARITY verdict.

**Depends on:** `P08`

**Progress (MANDATORY):** 0 / 17

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
| `P09.T01` | TASK | MANDATORY | `NOT_STARTED` | 0 | — | Populate the HARDENING registry |
| `P09.T02` | TASK | MANDATORY | `NOT_STARTED` | 0 | — | Deploy-order gate — new drizzle/*.sql requires db-push.yml first |
| `P09.T03` | TASK | MANDATORY | `NOT_STARTED` | 0 | — | Schema type-drift gate — drizzle column types versus migration SQL |
| `P09.T04` | TASK | MANDATORY | `NOT_STARTED` | 0 | — | knip — dead exports and dependencies |
| `P09.T05` | TASK | MANDATORY | `NOT_STARTED` | 0 | — | Accessibility gate on the built client |
| `P09.TEST01` | POSITIVE_VALIDATION | MANDATORY | `NOT_STARTED` | 0 | — | Deploy-order gate green on a clean snapshot |
| `P09.TEST02` | POSITIVE_VALIDATION | MANDATORY | `NOT_STARTED` | 0 | — | Schema type-drift gate green on a clean snapshot |
| `P09.TEST03` | POSITIVE_VALIDATION | MANDATORY | `NOT_STARTED` | 0 | — | knip green on a clean snapshot |
| `P09.TEST04` | POSITIVE_VALIDATION | MANDATORY | `NOT_STARTED` | 0 | — | Accessibility gate green on a clean snapshot |
| `P09.NEG01` | NEGATIVE_VALIDATION | MANDATORY | `NOT_STARTED` | 0 | — | Synthetic drizzle/*.sql inside the worktree reddens the deploy-order gate |
| `P09.NEG02` | NEGATIVE_VALIDATION | MANDATORY | `NOT_STARTED` | 0 | — | Injected type mismatch reddens the schema type-drift gate |
| `P09.NEG03` | NEGATIVE_VALIDATION | MANDATORY | `NOT_STARTED` | 0 | — | knip fixture reddens the knip gate |
| `P09.NEG04` | NEGATIVE_VALIDATION | MANDATORY | `NOT_STARTED` | 0 | — | Accessibility fixture reddens the a11y gate |
| `P09.AUD01` | AUDIT | MANDATORY | `NOT_STARTED` | 0 | — | Audit: HARDENING results are never merged into the PARITY verdict |
| `P09.GATE01` | ACCEPTANCE_GATE | MANDATORY | `NOT_STARTED` | 0 | — | P09.T02 and P09.T03 green with their fixtures |
| `P09.AUTH01` | AUTHORIZATION | MANDATORY | `NOT_STARTED` | 0 | — | Owner decision DEC-002 RECORDED: BLOCKING or ADVISORY for the deploy-order gate — both satisfy this authorization |
| `P09.CP01` | CHECKPOINT | MANDATORY | `NOT_STARTED` | 0 | — | P09 checkpoint recorded |

## P10 — Certificate, REMOTE reconciliation, LOCAL_READY_FOR_PR

**State:** `NOT_STARTED`

**Assurance property:** A certificate is issued only when the whole execution history is closed, and it is void the instant any bound input changes.

**Depends on:** `P09`

**Progress (MANDATORY):** 0 / 22

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
| `P10.T01` | TASK | MANDATORY | `NOT_STARTED` | 0 | — | Certificate binding set: head, base, merge_tree, merge_commit, lockfile, contract, verifier, images, env profile, hermetic mode, assurance hash, results by class |
| `P10.T02` | TASK | MANDATORY | `NOT_STARTED` | 0 | — | verify/void logic — recompute every binding from disk |
| `P10.T03` | TASK | MANDATORY | `NOT_STARTED` | 0 | — | Execution-history binding: ledger state at issuance (P00-P09 ACCEPTED plus P10 units through GATE01) |
| `P10.T04` | TASK | MANDATORY | `NOT_STARTED` | 0 | — | REMOTE reconciliation against the live ruleset AND classic protection |
| `P10.T05` | TASK | MANDATORY | `NOT_STARTED` | 0 | — | CI proof reconciliation guarded by {head, base, merge_tree, contract_hash} — compares merge_tree_sha, never merge_commit_sha |
| `P10.T06` | TASK | MANDATORY | `NOT_STARTED` | 0 | — | Issuance rule |
| `P10.T07` | TASK | MANDATORY | `NOT_STARTED` | 0 | — | Opt-in pre-push hook |
| `P10.T08` | TASK | MANDATORY | `NOT_STARTED` | 0 | — | File evidence into the /eng-loop evidence record |
| `P10.TEST01` | POSITIVE_VALIDATION | MANDATORY | `NOT_STARTED` | 0 | — | A fully green run issues a certificate that verify accepts |
| `P10.TEST02` | POSITIVE_VALIDATION | MANDATORY | `NOT_STARTED` | 0 | — | One real PR reconciles field-for-field against CI's proof artifact |
| `P10.TEST03` | POSITIVE_VALIDATION | MANDATORY | `NOT_STARTED` | 0 | — | Independent verification: a SEPARATE process re-derives every binding from disk and accepts |
| `P10.NEG01` | NEGATIVE_VALIDATION | MANDATORY | `NOT_STARTED` | 0 | — | Touching any tracked file yields VOID(head_sha) |
| `P10.NEG02` | NEGATIVE_VALIDATION | MANDATORY | `NOT_STARTED` | 0 | — | Advancing origin/main yields NOT-COMPARABLE(STALE_BASE), not a parity mismatch |
| `P10.NEG03` | NEGATIVE_VALIDATION | MANDATORY | `NOT_STARTED` | 0 | — | Editing scripts/ci/** yields VOID(verifier_hash) |
| `P10.NEG04` | NEGATIVE_VALIDATION | MANDATORY | `NOT_STARTED` | 0 | — | Any FLAKY mandatory result refuses issuance |
| `P10.NEG05` | NEGATIVE_VALIDATION | MANDATORY | `NOT_STARTED` | 0 | — | An incomplete ledger refuses issuance |
| `P10.NEG06` | NEGATIVE_VALIDATION | MANDATORY | `NOT_STARTED` | 0 | — | Any phase not ACCEPTED refuses issuance |
| `P10.NEG07` | NEGATIVE_VALIDATION | MANDATORY | `NOT_STARTED` | 0 | — | A tampered ledger yields LEDGER_TAMPERED and refuses issuance |
| `P10.NEG08` | NEGATIVE_VALIDATION | MANDATORY | `NOT_STARTED` | 0 | — | Issuance attempted with a preceding phase not ACCEPTED is refused, naming that phase |
| `P10.GATE01` | ACCEPTANCE_GATE | MANDATORY | `NOT_STARTED` | 0 | — | Issuance closure list: 10 of 10 PRECEDING phases ACCEPTED (P00..P09), all mandatory units closed, all mandatory gates negatively proven, zero unresolved defects, zero unexplained skips, zero flaky mandatory gates, zero infrastructure uncertainty, zero contract drift, zero broken gates, zero stale evidence, zero dirty bound inputs, zero ledger tampering |
| `P10.AUTH01` | AUTHORIZATION | MANDATORY | `NOT_STARTED` | 0 | — | Owner authorization to enable the opt-in pre-push hook |
| `P10.CP01` | CHECKPOINT | MANDATORY | `NOT_STARTED` | 0 | — | P10 checkpoint recorded, binding the issued certificate hash |

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
| `DEC-001` | `P08.AUTH01` | PIN_BY_DIGEST \| RECORD_ONLY | `PENDING` | — |
| `DEC-002` | `P09.AUTH01` | BLOCKING \| ADVISORY | `PENDING` | — |
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

## Checkpoints

| Phase | Decision | Recorded at | Evidence |
| --- | --- | --- | --- |
| `PB` | **PROCEED TO P00** | 2026-08-10T08:20:39.490Z | `7b75b64faad4` |
| `P00` | **DO NOT PROCEED (blocking: DEF-002, DEF-003)** | 2026-08-10T08:32:07.069Z | `9a0d5373db77` |
| `P00` | **PROCEED TO P01 (supersedes CP01; DEF-002/003/004 closed)** | 2026-08-10T08:54:23.461Z | `56e2ba284da9` |
| `P01` | **PROCEED TO P02** | 2026-08-10T09:24:40.039Z | `51ccc53de3f1` |
| `P02` | **PROCEED TO P03** | 2026-08-10T09:51:10.828Z | `1a36ea25a1e4` |
| `P03` | **PROCEED TO P04** | 2026-08-10T10:22:27.089Z | `1ccb5c006c3a` |
