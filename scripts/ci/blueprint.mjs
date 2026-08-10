/**
 * blueprint.mjs — the NORMATIVE unit registry for the ci:verify control plane.
 *
 * This file is the single machine-readable declaration of every phase, task,
 * validation, negative validation, regression, conformance, failure-injection,
 * cleanup, audit, evidence artifact, acceptance gate, checkpoint, and
 * authorization requirement in the frozen blueprint (P-BOOT, P00 .. P10).
 *
 * Contract rules (from the frozen architecture, §0.1):
 *   - IDs are PERMANENT. They are never reused and never renumbered.
 *   - A retired unit becomes status RETIRED; it is never deleted from here.
 *   - `ledger.mjs` seeds one ledger record per declared ID. Initialization
 *     FAILS if this file contains a duplicate ID (PB.NEG01) or if the produced
 *     ledger is missing any declared ID (PB.NEG02).
 *
 * The SHA-256 of THIS FILE is recorded as `blueprint_sha256` in the genesis
 * record GEN-000, so any edit to the blueprint is detectable forever after.
 */

export const SCHEMA_VERSION = "1.0.0";
export const BLUEPRINT_VERSION = "1.0.0";

/** MANDATORY units gate phase acceptance; ADVISORY units never do. */
const M = "MANDATORY";
const A = "ADVISORY";

/**
 * Terse unit constructor. `extra` may carry expected_output, validation,
 * negative_validation, depends_on, exit_requirement.
 */
function u(id, cls, title, extra = {}) {
  return { id, class: cls, title, ...extra };
}

/** Unit kind is DERIVED from the ID suffix — never stored redundantly. */
export function unitKind(id) {
  const suffix = id.split(".").slice(1).join(".");
  if (/^T\d+$/.test(suffix)) return "TASK";
  if (/^T\d+\.S\d+$/.test(suffix)) return "SUBSTEP";
  if (/^TEST\d+$/.test(suffix)) return "POSITIVE_VALIDATION";
  if (/^NEG\d+$/.test(suffix)) return "NEGATIVE_VALIDATION";
  if (/^REG\d+$/.test(suffix)) return "REGRESSION";
  if (/^CONF\d+$/.test(suffix)) return "CONFORMANCE";
  if (/^FI\d+$/.test(suffix)) return "FAILURE_INJECTION";
  if (/^CLN\d+$/.test(suffix)) return "CLEANUP";
  if (/^AUD\d+$/.test(suffix)) return "AUDIT";
  if (/^EV\d+$/.test(suffix)) return "EVIDENCE";
  if (/^GATE\d+$/.test(suffix)) return "ACCEPTANCE_GATE";
  if (/^CP\d+$/.test(suffix)) return "CHECKPOINT";
  if (/^AUTH\d+$/.test(suffix)) return "AUTHORIZATION";
  throw new Error(`UNKNOWN_UNIT_KIND: ${id}`);
}

export const PHASES = [
  {
    id: "PB",
    title: "Control-plane bootstrap",
    assurance_property:
      "The execution ledger exists, is tool-written, evidence-enforcing, " +
      "tamper-evident, and covers every declared blueprint ID before any " +
      "verifier work begins.",
    depends_on: [],
    entry: [
      "Repository readable",
      "Node/pnpm/git versions captured in the execution baseline",
      "Branch feat/ci-verify-control-plane cut from origin/main",
    ],
    exit: [
      "PB.T01..PB.T05 closed",
      "PB.TEST01, PB.TEST02 PASS",
      "PB.NEG01, PB.NEG02 PASS",
      "PB.GATE01 PASS",
      "PB.CP01 recorded",
    ],
    units: [
      u(
        "PB.T01",
        M,
        "Create scripts/ci/ledger.mjs — the sole ledger writer, with §0.3 evidence enforcement",
        {
          expected_output: "scripts/ci/ledger.mjs",
          validation: "PB.TEST01",
          negative_validation: "PB.NEG01",
          exit_requirement:
            "File exists; set/init/render/verify subcommands implemented; PASS refused without verifiable evidence",
        }
      ),
      u(
        "PB.T02",
        M,
        "Initialize docs/verification/ci-verify-ledger.json seeded with every declared P00-P10 ID at NOT_STARTED",
        {
          expected_output: "docs/verification/ci-verify-ledger.json",
          validation: "PB.TEST01",
          negative_validation: "PB.NEG02",
          depends_on: ["PB.T01"],
          exit_requirement:
            "Every blueprint ID present exactly once at NOT_STARTED",
        }
      ),
      u(
        "PB.T03",
        M,
        "Create self-attesting genesis record GEN-000 {schema_version, ledger_impl_sha256, blueprint_sha256, git_head_at_bootstrap, created_at}",
        {
          expected_output: "GEN-000 inside ci-verify-ledger.json",
          validation: "PB.TEST01",
          depends_on: ["PB.T02"],
          exit_requirement:
            "All five genesis fields present and non-empty; ledger_impl_sha256 matches ledger.mjs on disk",
        }
      ),
      u("PB.T04", M, "Generate docs/verification/ci-verify-ledger.sha256", {
        expected_output: "docs/verification/ci-verify-ledger.sha256",
        validation: "PB.TEST02",
        depends_on: ["PB.T03"],
        exit_requirement:
          "Hash equals sha256 of the canonical ledger bytes on disk",
      }),
      u(
        "PB.T05",
        M,
        "Generate docs/verification/CI-VERIFY-EXECUTION-LEDGER.md exclusively from the JSON",
        {
          expected_output: "docs/verification/CI-VERIFY-EXECUTION-LEDGER.md",
          validation: "PB.TEST02",
          depends_on: ["PB.T04"],
          exit_requirement:
            "Rendered markdown is byte-identical to a fresh render of the JSON",
        }
      ),
      u(
        "PB.TEST01",
        M,
        "Every blueprint ID appears in the initialized ledger exactly once",
        {
          expected_output: "vitest result",
          exit_requirement: "Test passes against the real seeding code path",
        }
      ),
      u(
        "PB.TEST02",
        M,
        "Rendered markdown conforms exactly to the JSON (render is a pure function of state)",
        {
          expected_output: "vitest result",
          exit_requirement: "Re-render equals on-disk markdown byte-for-byte",
        }
      ),
      u("PB.NEG01", M, "Duplicate ID in the blueprint FAILS initialization", {
        expected_output: "vitest result",
        exit_requirement:
          "assertBlueprintUnique throws DUPLICATE_UNIT_ID; no ledger written",
      }),
      u(
        "PB.NEG02",
        M,
        "A declared blueprint ID missing from the seed FAILS initialization",
        {
          expected_output: "vitest result",
          exit_requirement:
            "assertSeedComplete throws SEED_INCOMPLETE; no ledger written",
        }
      ),
      u(
        "PB.GATE01",
        M,
        "Genesis record, ledger sha256, and rendered ledger all exist and verify",
        {
          expected_output: "ledger verify output",
          depends_on: [
            "PB.T01",
            "PB.T02",
            "PB.T03",
            "PB.T04",
            "PB.T05",
            "PB.TEST01",
            "PB.TEST02",
            "PB.NEG01",
            "PB.NEG02",
          ],
          exit_requirement:
            "ledger.mjs verify exits 0 with no drift and no tampering",
        }
      ),
      u(
        "PB.CP01",
        M,
        "P-BOOT checkpoint recorded with PROCEED / DO NOT PROCEED decision",
        {
          expected_output: "checkpoint record in ledger",
          depends_on: ["PB.GATE01"],
          exit_requirement:
            "Checkpoint written; phase state ACCEPTED before P00 may enter READY",
        }
      ),
      // --- Added during DEF-004 remediation. New permanent IDs; nothing
      // previously published was renumbered (blueprint contract §0.1).
      u(
        "PB.T06",
        M,
        "Append-only amendment + sync mechanism: authorized-implementation-hash amendments (AMD-*) and additive unit sync, so a post-bootstrap correction never rewrites genesis GEN-000",
        {
          expected_output: "scripts/ci/ledger.mjs amend / sync subcommands",
          validation: "PB.REG01",
          negative_validation: "PB.NEG03",
          depends_on: ["PB.T01"],
          exit_requirement:
            "GEN-000 byte-unchanged; verify compares against the latest AMD record; sync only ADDS newly declared units",
        }
      ),
      u(
        "PB.TEST03",
        M,
        "Full ACCEPT(P) predicate: table-driven proof that the complete conjunction returns true and every individual term is independently load-bearing",
        {
          expected_output: "vitest result",
          exit_requirement:
            "Each of the seven acceptance terms proven necessary in isolation",
        }
      ),
      u(
        "PB.NEG03",
        M,
        "Acceptance negatives: one OPEN MEDIUM defect, one missing evidence hash, one failed gate, one ungranted authorization, and one FLAKY mandatory unit each independently force acceptance false",
        {
          expected_output: "vitest result",
          exit_requirement:
            "Five negative cases pass; unit status, gate result taxonomy, and phase state remain distinct vocabularies",
        }
      ),
      u(
        "PB.REG01",
        M,
        "Regression: PB.TEST01/TEST02/NEG01/NEG02 and ledger verify still hold after the DEF-004 correction and the amendment mechanism",
        {
          expected_output: "vitest result + ledger verify output",
          exit_requirement:
            "Full PB suite green and verify exit 0 against the amended implementation",
        }
      ),
    ],
  },

  {
    id: "P00",
    title: "Pre-flight resolution",
    assurance_property:
      "Every blocking unknown that changes the shape of the contract is " +
      "answered from direct repository/GitHub evidence, never inference.",
    depends_on: ["PB"],
    entry: [
      "PB ACCEPTED",
      "Repository readable",
      "gh authenticated",
      "Ledger initialized",
    ],
    exit: [
      "P00.T01..P00.T05 PASS",
      "P00.EV01..P00.EV05 hashed",
      "P00.AUD01 PASS",
      "P00.GATE01 PASS",
      "P00.CP01 recorded",
    ],
    units: [
      u(
        "P00.T01",
        M,
        "Determine whether the merge queue is ENABLED, versus workflows merely carrying merge_group: triggers",
        {
          expected_output: "docs/verification/evidence/p00/T01-merge-queue.md",
          validation: "P00.EV01",
          exit_requirement:
            "Answer stated with exact command + raw output; BLOCKED/INCONCLUSIVE if not provable",
        }
      ),
      u(
        "P00.T02",
        M,
        "Enumerate exactly which required status contexts are enforced TODAY versus still graduating",
        {
          expected_output:
            "docs/verification/evidence/p00/T02-required-contexts.md",
          validation: "P00.EV02",
          exit_requirement:
            "Ruleset AND classic protection both read; each context attributed to a surface",
        }
      ),
      u(
        "P00.T03",
        M,
        "Determine whether scripts/** is inside patch-coverage measurement scope",
        {
          expected_output:
            "docs/verification/evidence/p00/T03-coverage-scope.md",
          validation: "P00.EV03",
          exit_requirement:
            "Answered from check-patch-coverage.mjs source + 07-coverage-patch.yml coverage.include flags",
        }
      ),
      u(
        "P00.T04",
        M,
        "Inventory GitHub Actions constructs across ALL workflows — the contract-parser construct census",
        {
          expected_output:
            "docs/verification/evidence/p00/T04-construct-census.md",
          validation: "P00.EV04",
          exit_requirement:
            "Every workflow file enumerated; every construct class counted; census is the P02 allowlist input",
        }
      ),
      u(
        "P00.T05",
        M,
        "Determine the exact filesystem scope inspected by check-github-actions-security.mjs",
        {
          expected_output:
            "docs/verification/evidence/p00/T05-actions-security-scope.md",
          validation: "P00.EV05",
          exit_requirement:
            "Scan roots identified from source; determines where P05 poison fixtures may legally live",
        }
      ),
      u(
        "P00.AUD01",
        M,
        "Audit: every answer carries an exact command and preserved output — zero inferences",
        {
          expected_output:
            "docs/verification/evidence/p00/AUD01-evidence-audit.md",
          depends_on: ["P00.T01", "P00.T02", "P00.T03", "P00.T04", "P00.T05"],
          exit_requirement:
            "Each of T01..T05 has command, raw output artifact, interpretation, sha256",
        }
      ),
      u("P00.EV01", M, "Evidence artifact for P00.T01", {
        expected_output: "docs/verification/evidence/p00/T01-merge-queue.md",
        exit_requirement: "Artifact exists, non-empty, hashed into the ledger",
      }),
      u("P00.EV02", M, "Evidence artifact for P00.T02", {
        expected_output:
          "docs/verification/evidence/p00/T02-required-contexts.md",
        exit_requirement: "Artifact exists, non-empty, hashed into the ledger",
      }),
      u("P00.EV03", M, "Evidence artifact for P00.T03", {
        expected_output: "docs/verification/evidence/p00/T03-coverage-scope.md",
        exit_requirement: "Artifact exists, non-empty, hashed into the ledger",
      }),
      u("P00.EV04", M, "Evidence artifact for P00.T04", {
        expected_output:
          "docs/verification/evidence/p00/T04-construct-census.md",
        exit_requirement: "Artifact exists, non-empty, hashed into the ledger",
      }),
      u("P00.EV05", M, "Evidence artifact for P00.T05", {
        expected_output:
          "docs/verification/evidence/p00/T05-actions-security-scope.md",
        exit_requirement: "Artifact exists, non-empty, hashed into the ledger",
      }),
      u(
        "P00.GATE01",
        M,
        "Five of five pre-flight unknowns answered with verifiable evidence",
        {
          depends_on: [
            "P00.T01",
            "P00.T02",
            "P00.T03",
            "P00.T04",
            "P00.T05",
            "P00.AUD01",
          ],
          expected_output: "gate evaluation in ledger",
          exit_requirement:
            "No unknown left NOT_STARTED, BLOCKED, or INCONCLUSIVE",
        }
      ),
      u(
        "P00.CP01",
        M,
        "P00 checkpoint report with binary PROCEED TO P01 / DO NOT PROCEED decision",
        {
          depends_on: ["P00.GATE01"],
          expected_output: "docs/verification/evidence/p00/CP01-checkpoint.md",
          exit_requirement:
            "Checkpoint written with all mandated fields and one binary decision",
        }
      ),
      // Added during DEF-002/003/004 remediation. P00.CP01 is SEALED and is
      // neither edited nor reinterpreted; CP02 supersedes it append-only.
      u(
        "P00.CP02",
        M,
        "P00 re-evaluation checkpoint after DEF-002/DEF-003/DEF-004 remediation, superseding P00.CP01 append-only",
        {
          depends_on: ["P00.CP01", "P00.GATE01"],
          expected_output: "docs/verification/evidence/p00/CP02-checkpoint.md",
          exit_requirement:
            "References the superseded checkpoint; evaluates ACCEPT(P00) term by term; carries one binary decision",
        }
      ),
    ],
  },

  {
    id: "P01",
    title: "Snapshot resolution and prospective-merge materialization",
    assurance_property:
      "Verification runs against the prospective merge of HEAD into " +
      "origin/main, with deterministic, single-owner SHA provenance.",
    depends_on: ["P00"],
    entry: [
      "P00 ACCEPTED",
      "Scratch directory writable",
      "git >= 2.38 (merge-tree --write-tree)",
    ],
    exit: [
      "P01.T01..P01.T09 closed",
      "P01.TEST01..TEST04 PASS",
      "P01.NEG01..NEG05 PASS",
      "P01.REG01, P01.CLN01, P01.AUD01 PASS",
      "P01.EV01, P01.EV02 hashed",
      "P01.GATE01 PASS",
      "P01.CP01 recorded",
    ],
    units: [
      u(
        "P01.T01",
        M,
        "Run layout under the scratch directory (.ci-verify/runs/<run_id>/)"
      ),
      u(
        "P01.T02",
        M,
        "Base fetch and resolve (git fetch origin main; base_sha)"
      ),
      u(
        "P01.T03",
        M,
        "Head resolve plus dirty-tree policy (--committed default, --stash-probe advisory)"
      ),
      u(
        "P01.T04",
        M,
        "merge-tree --write-tree produces merge_tree_sha; conflict is BLOCKED"
      ),
      u(
        "P01.T05",
        M,
        "commit-tree synthetic merge with DETERMINISTIC metadata (fixed identity, T = max(base,head committer time)+1, +0000, fixed message, parents base-then-head)",
        {
          depends_on: ["P01.T04"],
          validation: "P01.TEST04",
          negative_validation: "P01.NEG05",
          exit_requirement:
            "Identical {head,base} yields identical merge_commit_sha across runs and clocks",
        }
      ),
      u("P01.T06", M, "worktree add --detach at merge_commit_sha"),
      u(
        "P01.T07",
        M,
        "Emit snapshot.json with all four SHAs, mode, dirty flag, git version"
      ),
      u(
        "P01.T08",
        M,
        "Provenance API — the sole owner of SHA resolution; no gate calls git rev-parse directly",
        {
          negative_validation: "P01.NEG04",
        }
      ),
      u(
        "P01.T09",
        M,
        "Add .ci-verify/, vitest-results.phase-*.json, local-proof-contract.json to .gitignore"
      ),
      u(
        "P01.TEST01",
        M,
        "Clean branch ahead of main yields four distinct SHAs and a worktree at the merge commit"
      ),
      u(
        "P01.TEST02",
        M,
        "Branch identical to main: merge_tree_sha equals base tree"
      ),
      u("P01.TEST03", M, "snapshot.json validates against its schema"),
      u(
        "P01.TEST04",
        M,
        "Determinism: same {head,base} yields identical merge_tree_sha AND merge_commit_sha across >=5 runs and two clocks"
      ),
      u(
        "P01.NEG01",
        M,
        "Conflicting branch yields BLOCKED(MERGE_CONFLICT) naming the conflicting paths"
      ),
      u(
        "P01.NEG02",
        M,
        "Dirty tree in default mode yields BLOCKED(DIRTY_TREE)"
      ),
      u(
        "P01.NEG03",
        M,
        "Simulated worktree-add failure yields INFRA-FAIL and leaves no orphan worktree"
      ),
      u(
        "P01.NEG04",
        M,
        "A gate calling git rev-parse directly fails the provenance audit"
      ),
      u(
        "P01.NEG05",
        M,
        "Unpinning any single commit-metadata field changes merge_commit_sha — proving the pin is load-bearing"
      ),
      u("P01.REG01", M, "20 consecutive runs leave the worktree count stable"),
      u("P01.CLN01", M, "SIGINT during snapshot removes the worktree"),
      u(
        "P01.AUD01",
        M,
        "Static proof that no module bypasses the P01.T08 provenance API"
      ),
      u("P01.EV01", M, "Evidence: snapshot.json"),
      u("P01.EV02", M, "Evidence: worktree residue log"),
      u("P01.GATE01", M, "P01.REG01 and P01.CLN01 PASS", {
        depends_on: ["P01.REG01", "P01.CLN01"],
      }),
      u("P01.CP01", M, "P01 checkpoint recorded", {
        depends_on: ["P01.GATE01"],
      }),
    ],
  },

  {
    id: "P02",
    title: "Contract extraction, freeze, conformance",
    assurance_property:
      "There is exactly one machine-readable definition of the merge " +
      "contract, frozen and checksummed, and the runtime never parses YAML.",
    depends_on: ["P01"],
    entry: ["P01 ACCEPTED", "P00.T04 construct census available"],
    exit: [
      "P02.T01..P02.T08 closed",
      "P02.TEST01, TEST02 PASS",
      "P02.NEG01..NEG04 PASS",
      "P02.CONF01, P02.AUD01 PASS",
      "P02.EV01..EV03 hashed",
      "P02.GATE01 PASS",
      "P02.CP01 recorded",
    ],
    units: [
      u(
        "P02.T01",
        M,
        "Census consumer — read the P00.T04 construct inventory as the parser allowlist",
        {
          depends_on: ["P00.T04"],
        }
      ),
      u(
        "P02.T02",
        M,
        "Canonicalizer — stable key order and expression normalization"
      ),
      u("P02.T03", M, "Per-workflow sha256 hashing"),
      u("P02.T04", M, "Emitter with schema_version and parser_version"),
      u(
        "P02.T05",
        M,
        "Allowlist enforcement — abort on any non-allowlisted construct, never partial output"
      ),
      u("P02.T06", M, "Generate contract.sha256"),
      u(
        "P02.T07",
        M,
        "Conformance test — workflow change without regeneration fails"
      ),
      u("P02.T08", M, "Render docs/verification/CONTRACT.md"),
      u("P02.TEST01", M, "Regeneration is byte-stable across runs"),
      u("P02.TEST02", M, "Every required status context maps to a check id"),
      u(
        "P02.NEG01",
        M,
        "Non-allowlisted construct aborts generation with NO partial file written"
      ),
      u(
        "P02.NEG02",
        M,
        "Workflow mutated without regeneration yields CONTRACT-DRIFT"
      ),
      u("P02.NEG03", M, "Hand-edited frozen contract yields sha256 mismatch"),
      u(
        "P02.NEG04",
        M,
        "Required context with no local mapping fails, naming the context"
      ),
      u(
        "P02.CONF01",
        M,
        "Conformance: frozen contract matches the workflow tree"
      ),
      u(
        "P02.AUD01",
        M,
        "Audit: zero YAML parsing in any runtime execution path"
      ),
      u("P02.EV01", M, "Evidence: contract.frozen.json"),
      u("P02.EV02", M, "Evidence: contract.sha256"),
      u("P02.EV03", M, "Evidence: construct census as consumed"),
      u("P02.GATE01", M, "P02.NEG01..NEG04 all PASS", {
        depends_on: ["P02.NEG01", "P02.NEG02", "P02.NEG03", "P02.NEG04"],
      }),
      // Added during P02 implementation. New permanent IDs only; nothing
      // previously published was renumbered (blueprint contract 0.1).
      u(
        "P02.REG01",
        M,
        "Pinned-parser regression: yaml@2.9.0 correctly handles every construct class actually present, and its YAML 1.2 semantics are intentional rather than accidental",
        {
          expected_output: "vitest result",
          exit_requirement:
            "Every observed construct class exercised; YAML 1.1-vs-1.2 scalar behaviour asserted explicitly",
        }
      ),
      u(
        "P02.CONF02",
        M,
        "Rendered-document conformance: CONTRACT.md is byte-identical to a fresh render of contract.frozen.json",
        {
          expected_output: "vitest result + conformance doc exit code",
          depends_on: ["P02.T08"],
          exit_requirement:
            "Stale human documentation cannot silently disagree with the machine contract",
        }
      ),
      u("P02.CP01", M, "P02 checkpoint recorded", {
        depends_on: ["P02.GATE01"],
      }),
    ],
  },

  {
    id: "P03",
    title: "Registries, taxonomy, reporter, ledger integration",
    assurance_property:
      "Every gate result carries a class and a status from a closed " +
      "vocabulary, and no class can be silently collapsed into one verdict.",
    depends_on: ["P02"],
    entry: ["P02 ACCEPTED", "Ledger operational from P-BOOT"],
    exit: [
      "P03.T01..P03.T08 closed",
      "P03.TEST01, TEST02 PASS",
      "P03.NEG01..NEG05 PASS",
      "P03.GATE01, P03.GATE02 PASS",
      "P03.CP01 recorded",
    ],
    units: [
      u("P03.T01", M, "Implement the 12-status result model"),
      u("P03.T02", M, "Class-to-terminal-state reduction"),
      u(
        "P03.T03",
        M,
        "PARITY registry loader — contract-derived and immutable"
      ),
      u("P03.T04", M, "HARDENING registry scaffold"),
      u("P03.T05", M, "JSONL reporter"),
      u("P03.T06", M, "Six-class summary renderer"),
      u(
        "P03.T07",
        M,
        "INTEGRATE the already-existing ledger from P-BOOT (bind taxonomy, wire reporter) — does not create the writer",
        {
          depends_on: ["PB.T01"],
        }
      ),
      u("P03.T08", M, "Ledger render plus render-conformance wiring"),
      u(
        "P03.TEST01",
        M,
        "Table-driven coverage of all 12 statuses across all 6 classes"
      ),
      u("P03.TEST02", M, "Summary renders every class, including empty ones"),
      u("P03.NEG01", M, "FLAKY must never reduce to PASS"),
      u("P03.NEG02", M, "Programmatic append to the PARITY registry throws"),
      u("P03.NEG03", M, "set PASS without verifiable evidence is refused"),
      u("P03.NEG04", M, "Hand-edited ledger yields LEDGER_TAMPERED"),
      u(
        "P03.NEG05",
        M,
        "Rendered markdown diverging from JSON fails conformance"
      ),
      u("P03.GATE01", M, "Full taxonomy coverage demonstrated", {
        depends_on: ["P03.TEST01"],
      }),
      u("P03.GATE02", M, "P03.NEG03 and P03.NEG04 PASS", {
        depends_on: ["P03.NEG03", "P03.NEG04"],
      }),
      u("P03.CP01", M, "P03 checkpoint recorded", {
        depends_on: ["P03.GATE01", "P03.GATE02"],
      }),
    ],
  },

  {
    id: "P04",
    title: "Executor core",
    assurance_property:
      "Gates execute under declared scheduling, hermeticity, timeout, and " +
      "teardown guarantees, and no exit code is ever silently suppressed.",
    depends_on: ["P03"],
    entry: [
      "P03 ACCEPTED",
      "Container runtime available, or HERMETIC:UNENFORCED explicitly accepted",
    ],
    exit: [
      "P04.T01..P04.T10 closed",
      "P04.TEST01..TEST03 PASS",
      "P04.NEG01..NEG06 PASS",
      "P04.FI01, P04.FI02, P04.CLN01 PASS",
      "P04.GATE01 PASS",
      "P04.CP01 recorded",
    ],
    units: [
      u("P04.T01", M, "DAG scheduler over declared requires"),
      u("P04.T02", M, "Concurrency and memory budget"),
      u("P04.T03", M, "Serial DB lane"),
      u(
        "P04.T04",
        M,
        "Hermetic env: TZ=UTC, LC_ALL=C.UTF-8, seed, reserved ports, isolated TMPDIR"
      ),
      u(
        "P04.T05",
        M,
        "Network policy plus ENFORCEMENT DETECTION (host runs report HERMETIC:UNENFORCED)"
      ),
      u("P04.T06", M, "Timeout: SIGTERM, grace, SIGKILL"),
      u(
        "P04.T07",
        M,
        "Teardown registry across success, failure, SIGINT, SIGTERM, timeout, uncaught exception"
      ),
      u("P04.T08", M, "Attempts and flake recording"),
      u("P04.T09", M, "Emit executor.jsonl"),
      u(
        "P04.T10",
        M,
        "Lane sentinel: named lane lock with entered_at/exited_at intervals, released on crash and timeout",
        {
          depends_on: ["P04.T03"],
          negative_validation: "P04.NEG06",
        }
      ),
      u("P04.TEST01", M, "Scheduler respects declared requires ordering"),
      u("P04.TEST02", M, "Serial lane exclusivity holds"),
      u("P04.TEST03", M, "Hermetic env is observed inside a child process"),
      u("P04.NEG01", M, "Orphaned process is reaped and reported INFRA-FAIL"),
      u("P04.NEG02", M, "Hanging gate yields TIMEOUT, not FAIL"),
      u("P04.NEG03", M, "SIGINT yields clean teardown and a non-zero exit"),
      u(
        "P04.NEG04",
        M,
        "network: deny on host yields INCONCLUSIVE, never PASS"
      ),
      u("P04.NEG05", M, "Top-level exit-code suppression is detected by audit"),
      u(
        "P04.NEG06",
        M,
        "Direct concurrent invocation bypassing the scheduler trips LANE_VIOLATION deterministically"
      ),
      u("P04.FI01", M, "Failure injection: kill the executor mid-gate"),
      u("P04.FI02", M, "Failure injection: exhaust the memory budget"),
      u("P04.CLN01", M, "SIGINT teardown: 10 of 10 runs leave zero residue"),
      u("P04.GATE01", M, "P04.CLN01, P04.NEG01, P04.NEG04 PASS", {
        depends_on: ["P04.CLN01", "P04.NEG01", "P04.NEG04"],
      }),
      u("P04.CP01", M, "P04 checkpoint recorded", {
        depends_on: ["P04.GATE01"],
      }),
    ],
  },

  {
    id: "P05",
    title: "ASSURANCE — the self-test framework",
    assurance_property:
      "Every mandatory gate is proven capable of rejection, for its own " +
      "declared reason, and proven to return to green after restoration.",
    depends_on: ["P04"],
    entry: [
      "P04 ACCEPTED",
      "Executor operational",
      "Disposable worktree supported",
      "Fixture-placement policy confirmed via P00.T05",
      "Target gates identified",
    ],
    exit: [
      "P05.T01..P05.T07 closed",
      "P05.TEST01..TEST03 PASS",
      "P05.NEG01..NEG04 PASS",
      "P05.AUD01 PASS",
      "P05.EV01, P05.EV02 hashed",
      "P05.GATE01, P05.GATE02 PASS",
      "P05.CP01 recorded",
    ],
    units: [
      u("P05.T01", M, "Fixture format {poison.patch, expect.json}"),
      u(
        "P05.T02",
        M,
        "Placement policy enforcement — fixtures are patches, never live files in scanned trees",
        {
          depends_on: ["P00.T05"],
          negative_validation: "P05.NEG04",
        }
      ),
      u(
        "P05.T03",
        M,
        "Runner: worktree, apply, run target gate, assert, revert, control re-run"
      ),
      u("P05.T04", M, "expected_gate enforcement"),
      u("P05.T05", M, "expected_reason signature matching"),
      u(
        "P05.T06",
        M,
        "Coverage assertion — every mandatory gate has a fixture"
      ),
      u("P05.T07", M, "Emit assurance.json plus its sha256"),
      u(
        "P05.TEST01",
        M,
        "Real gate 1 reddens for its own declared reason; control returns green"
      ),
      u(
        "P05.TEST02",
        M,
        "Real gate 2 reddens for its own declared reason; control returns green"
      ),
      u(
        "P05.TEST03",
        M,
        "Real gate 3 reddens for its own declared reason; control returns green"
      ),
      u(
        "P05.NEG01",
        M,
        "Fixture reddening the wrong gate yields BROKEN-GATE(WRONG_TARGET)"
      ),
      u(
        "P05.NEG02",
        M,
        "Fixture whose control run stays red yields BROKEN-GATE(NON_RESTORING)"
      ),
      u(
        "P05.NEG03",
        M,
        "Mandatory gate without a fixture yields BROKEN-GATE(UNPROVEN)"
      ),
      u(
        "P05.NEG04",
        M,
        "A live poison fixture inside a scanned path causes the build to refuse"
      ),
      u(
        "P05.AUD01",
        M,
        "Audit: zero poison artifacts exist in the tracked tree"
      ),
      u("P05.EV01", M, "Evidence: assurance.json"),
      u("P05.EV02", M, "Evidence: assurance.json sha256"),
      u("P05.GATE01", M, "At least three real gates proven", {
        depends_on: ["P05.TEST01", "P05.TEST02", "P05.TEST03"],
      }),
      u("P05.GATE02", M, "Coverage assertion armed", {
        depends_on: ["P05.T06"],
      }),
      u("P05.CP01", M, "P05 checkpoint recorded", {
        depends_on: ["P05.GATE01", "P05.GATE02"],
      }),
    ],
  },

  {
    id: "P06",
    title: "PARITY — static, security, supply chain",
    assurance_property:
      "Every locally reproducible static and supply-chain requirement of " +
      "the merge contract is executed verbatim, with pinned tools.",
    depends_on: ["P05"],
    entry: ["P05 ACCEPTED", "Tool pins readable from the frozen contract"],
    exit: [
      "P06.T01..P06.T12 closed",
      "P06.TEST01, TEST02 PASS",
      "P06.NEG01..NEG12 PASS",
      "P06.AUD01 PASS",
      "P06.GATE01 PASS",
      "P06.CP01 recorded",
    ],
    units: [
      u(
        "P06.T01",
        M,
        "tools-sync: contract-read pins plus checksum verification — the ONLY network-permitted unit"
      ),
      u("P06.T02", M, "Gate: typecheck"),
      u("P06.T03", M, "Gate: format"),
      u("P06.T04", M, "Gate: semgrep-blocking"),
      u("P06.T05", M, "Gate: zizmor"),
      u("P06.T06", M, "Gate: gitleaks"),
      u("P06.T07", M, "Gate: osv-scanner plus check-osv-scan"),
      u("P06.T08", M, "Gate: actions-security contract"),
      u("P06.T09", M, "Gate: federation docs"),
      u("P06.T10", M, "Gate: migration hygiene trio"),
      u("P06.T11", M, "Gate: ai-eval set with env -u DATABASE_URL"),
      u("P06.T12", M, "CI-ONLY registration with explicit reasons"),
      u("P06.TEST01", M, "All implemented gates green on a clean snapshot"),
      u(
        "P06.TEST02",
        M,
        "Executed command is byte-for-byte identical to the frozen contract"
      ),
      u(
        "P06.NEG01",
        M,
        "Poison fixture reddens the typecheck gate for its own reason"
      ),
      u(
        "P06.NEG02",
        M,
        "Poison fixture reddens the format gate for its own reason"
      ),
      u(
        "P06.NEG03",
        M,
        "Poison fixture reddens the semgrep gate for its own reason"
      ),
      u(
        "P06.NEG04",
        M,
        "Poison fixture reddens the zizmor gate for its own reason"
      ),
      u(
        "P06.NEG05",
        M,
        "Poison fixture reddens the gitleaks gate for its own reason"
      ),
      u(
        "P06.NEG06",
        M,
        "Poison fixture reddens the osv gate for its own reason"
      ),
      u(
        "P06.NEG07",
        M,
        "Poison fixture reddens the actions-security gate for its own reason"
      ),
      u(
        "P06.NEG08",
        M,
        "Poison fixture reddens the federation-docs gate for its own reason"
      ),
      u(
        "P06.NEG09",
        M,
        "Poison fixture reddens the migration-hygiene gate for its own reason"
      ),
      u(
        "P06.NEG10",
        M,
        "Poison fixture reddens the ai-eval gate for its own reason"
      ),
      u("P06.NEG11", M, "Missing tool yields BLOCKED, never green"),
      u(
        "P06.NEG12",
        M,
        "Tool version differing from the contract pin yields CONTRACT-DRIFT"
      ),
      u("P06.AUD01", M, "Audit: network is permitted only in P06.T01"),
      u("P06.GATE01", M, "Self-test coverage for this phase is 100 percent", {
        depends_on: ["P05.GATE02"],
      }),
      u("P06.CP01", M, "P06 checkpoint recorded", {
        depends_on: ["P06.GATE01"],
      }),
    ],
  },

  {
    id: "P07",
    title: "PARITY — test and data",
    assurance_property:
      "The full test contract runs with CI's partitioning, with no impact " +
      "selection, and DB-lane exclusion is proven deterministically.",
    depends_on: ["P05"],
    entry: ["P05 ACCEPTED", "docker available", "mysql image digest pinned"],
    exit: [
      "P07.T01..P07.T10 closed",
      "P07.TEST01..TEST03 PASS",
      "P07.NEG01..NEG05 PASS",
      "P07.REG01 PASS",
      "P07.EV01..EV03 hashed",
      "P07.GATE01 PASS",
      "P07.CP01 recorded",
    ],
    units: [
      u("P07.T01", M, "MySQL fixture pinned by image digest"),
      u("P07.T02", M, "Reconciled migration replay on the fresh database", {
        depends_on: ["P07.T01"],
      }),
      u("P07.T03", M, "DB-suite discovery via the SKIP_DB_IN_CI marker", {
        depends_on: ["P07.T02"],
      }),
      u(
        "P07.T04",
        M,
        "Cross-check discovery against ci.yml's hardcoded suite list",
        {
          depends_on: ["P07.T03"],
        }
      ),
      u("P07.T05", M, "Non-DB parallel phase"),
      u("P07.T06", M, "DB serial phase using the P04.T10 lane sentinel", {
        depends_on: ["P07.T04", "P04.T10"],
      }),
      u("P07.T07", M, "Environment-failure gate integration", {
        depends_on: ["P07.T06"],
      }),
      u("P07.T08", M, "Collection-collapse floor enforcement"),
      u("P07.T09", M, "Report merge into a single result document", {
        depends_on: ["P07.T07"],
      }),
      u("P07.T10", M, "Diff-aware gates read the base SHA from snapshot.json", {
        depends_on: ["P01.T07"],
      }),
      u("P07.TEST01", M, "Full suite green on a clean snapshot"),
      u("P07.TEST02", M, "DB phase ordering matches CI"),
      u(
        "P07.TEST03",
        M,
        "Local results match a CI db-tests run on the same SHA"
      ),
      u(
        "P07.NEG01",
        M,
        "Suite removed from ci.yml's list yields CONTRACT-DRIFT"
      ),
      u(
        "P07.NEG02",
        M,
        "Forced collection error is never excusable and yields FAIL"
      ),
      u(
        "P07.NEG03",
        M,
        "Two DB-partitioned gates in one run record disjoint lane intervals, zero sentinel violations, and are serialized rather than rejected"
      ),
      u(
        "P07.NEG04",
        M,
        "Impact-based test selection attempted in PARITY is refused"
      ),
      u(
        "P07.NEG05",
        M,
        "Dirty tree plus a diff-aware coverage gate yields BLOCKED"
      ),
      u("P07.REG01", M, "Three consecutive runs produce identical results"),
      u(
        "P07.AUD01",
        A,
        "ADVISORY: optional reproduction of the historical Incident 42 race — never an acceptance input"
      ),
      u("P07.EV01", M, "Evidence: merged vitest results"),
      u("P07.EV02", M, "Evidence: environment-failure gate report"),
      u("P07.EV03", M, "Evidence: DB test report"),
      u("P07.GATE01", M, "P07.TEST03 demonstrated", {
        depends_on: ["P07.TEST03"],
      }),
      u("P07.CP01", M, "P07 checkpoint recorded", {
        depends_on: ["P07.GATE01"],
      }),
    ],
  },

  {
    id: "P08",
    title: "CLEANROOM — image identity, container build, dual runtime proof",
    assurance_property:
      "The repository's container build contract reproduces, and the built " +
      "artifact is proven on both the failure path and the healthy path.",
    depends_on: ["P06", "P07"],
    entry: ["P06 ACCEPTED", "P07 ACCEPTED", "docker available"],
    exit: [
      "P08.T01..P08.T08 closed",
      "P08.TEST01..TEST03 PASS",
      "P08.NEG01..NEG03 PASS",
      "P08.CLN01, P08.AUD01 PASS",
      "P08.EV01..EV05 hashed",
      "P08.GATE01 PASS",
      "P08.AUTH01 granted (DEC-001 recorded)",
      "P08.CP01 recorded",
    ],
    units: [
      u(
        "P08.T01",
        M,
        "images.pinned.json — verifier-controlled images pinned by digest"
      ),
      u("P08.T02", M, "RECORD the Dockerfile base digest without editing FROM"),
      u(
        "P08.T03",
        M,
        "Container build reproducing the repository's build contract"
      ),
      u("P08.T04", M, "Trivy CRITICAL fixable-only blocking gate"),
      u("P08.T05", M, "SBOM generation"),
      u(
        "P08.T06",
        M,
        "Runtime profile A — dead DB: crash-guard, /health, structured 401, listen line"
      ),
      u(
        "P08.T07",
        M,
        "Runtime profile B — healthy DB: commit identity, schema compatibility, auth-independent paths, background-job gating, graceful SIGTERM shutdown"
      ),
      u("P08.T08", M, "Build-variance recorder (AUDIT class, non-blocking)"),
      u("P08.TEST01", M, "Runtime profile A green"),
      u("P08.TEST02", M, "Runtime profile B green including graceful shutdown"),
      u("P08.TEST03", M, "SBOM is non-empty"),
      u(
        "P08.NEG01",
        M,
        "Broken Dockerfile fails the build before any runtime gate executes"
      ),
      u(
        "P08.NEG02",
        M,
        "Wrong EXPECTED_COMMIT fails profile B on build identity"
      ),
      u("P08.NEG03", M, "MySQL killed mid-run yields INFRA-FAIL, not FAIL"),
      u("P08.CLN01", M, "Zero residual containers after every run"),
      u(
        "P08.AUD01",
        A,
        "ADVISORY: build variance recorded across clean rebuilds, never blocking"
      ),
      u("P08.EV01", M, "Evidence: image-id.txt"),
      u("P08.EV02", M, "Evidence: trivy.table"),
      u("P08.EV03", M, "Evidence: sbom.spdx.json"),
      u("P08.EV04", M, "Evidence: runtime profile A log"),
      u("P08.EV05", M, "Evidence: runtime profile B log"),
      u("P08.GATE01", M, "Three consecutive clean runs of profiles A and B", {
        depends_on: ["P08.TEST01", "P08.TEST02"],
      }),
      u(
        "P08.AUTH01",
        M,
        "Owner decision DEC-001 RECORDED: PIN_BY_DIGEST or RECORD_ONLY — both satisfy this authorization",
        {
          exit_requirement:
            "DEC-001 exists with a value in {PIN_BY_DIGEST, RECORD_ONLY}; the verifier never edits the production Dockerfile on its own authority",
        }
      ),
      u("P08.CP01", M, "P08 checkpoint recorded", {
        depends_on: ["P08.GATE01", "P08.AUTH01"],
      }),
    ],
  },

  {
    id: "P09",
    title: "HARDENING",
    assurance_property:
      "Dime-specific standards that CI does not enforce are checked " +
      "locally, and are reported separately from the PARITY verdict.",
    depends_on: ["P08"],
    entry: ["P08 ACCEPTED", "HARDENING registry writable"],
    exit: [
      "P09.T01..P09.T05 closed",
      "P09.TEST01..TEST04 PASS",
      "P09.NEG01..NEG04 PASS",
      "P09.AUD01 PASS",
      "P09.GATE01 PASS",
      "P09.AUTH01 granted (DEC-002 recorded)",
      "P09.CP01 recorded",
    ],
    units: [
      u("P09.T01", M, "Populate the HARDENING registry"),
      u(
        "P09.T02",
        M,
        "Deploy-order gate — new drizzle/*.sql requires db-push.yml first"
      ),
      u(
        "P09.T03",
        M,
        "Schema type-drift gate — drizzle column types versus migration SQL"
      ),
      u("P09.T04", M, "knip — dead exports and dependencies"),
      u("P09.T05", M, "Accessibility gate on the built client"),
      u("P09.TEST01", M, "Deploy-order gate green on a clean snapshot"),
      u("P09.TEST02", M, "Schema type-drift gate green on a clean snapshot"),
      u("P09.TEST03", M, "knip green on a clean snapshot"),
      u("P09.TEST04", M, "Accessibility gate green on a clean snapshot"),
      u(
        "P09.NEG01",
        M,
        "Synthetic drizzle/*.sql inside the worktree reddens the deploy-order gate"
      ),
      u(
        "P09.NEG02",
        M,
        "Injected type mismatch reddens the schema type-drift gate"
      ),
      u("P09.NEG03", M, "knip fixture reddens the knip gate"),
      u("P09.NEG04", M, "Accessibility fixture reddens the a11y gate"),
      u(
        "P09.AUD01",
        M,
        "Audit: HARDENING results are never merged into the PARITY verdict"
      ),
      u("P09.GATE01", M, "P09.T02 and P09.T03 green with their fixtures", {
        depends_on: ["P09.TEST01", "P09.TEST02", "P09.NEG01", "P09.NEG02"],
      }),
      u(
        "P09.AUTH01",
        M,
        "Owner decision DEC-002 RECORDED: BLOCKING or ADVISORY for the deploy-order gate — both satisfy this authorization",
        {
          exit_requirement:
            "DEC-002 exists with a value in {BLOCKING, ADVISORY}",
        }
      ),
      u("P09.CP01", M, "P09 checkpoint recorded", {
        depends_on: ["P09.GATE01", "P09.AUTH01"],
      }),
    ],
  },

  {
    id: "P10",
    title: "Certificate, REMOTE reconciliation, LOCAL_READY_FOR_PR",
    assurance_property:
      "A certificate is issued only when the whole execution history is " +
      "closed, and it is void the instant any bound input changes.",
    depends_on: ["P09"],
    entry: [
      "P00..P09 all ACCEPTED (10 of 10 preceding)",
      "Ledger sha256 valid",
    ],
    exit: [
      "P10.T01..P10.T08 closed",
      "P10.TEST01..TEST03 PASS",
      "P10.NEG01..NEG08 PASS",
      "P10.GATE01 PASS (10/10 preceding phases ACCEPTED)",
      "Certificate issued and independently verified",
      "P10.AUTH01 granted",
      "P10.CP01 recorded, binding the certificate hash",
    ],
    units: [
      u(
        "P10.T01",
        M,
        "Certificate binding set: head, base, merge_tree, merge_commit, lockfile, contract, verifier, images, env profile, hermetic mode, assurance hash, results by class"
      ),
      u("P10.T02", M, "verify/void logic — recompute every binding from disk"),
      u(
        "P10.T03",
        M,
        "Execution-history binding: ledger state at issuance (P00-P09 ACCEPTED plus P10 units through GATE01)",
        {
          exit_requirement:
            "Hash scope EXCLUDES P10.CP01 and P10's own ACCEPTED transition, by construction — this is what removes the circularity",
        }
      ),
      u(
        "P10.T04",
        M,
        "REMOTE reconciliation against the live ruleset AND classic protection"
      ),
      u(
        "P10.T05",
        M,
        "CI proof reconciliation guarded by {head, base, merge_tree, contract_hash} — compares merge_tree_sha, never merge_commit_sha"
      ),
      u("P10.T06", M, "Issuance rule"),
      u("P10.T07", M, "Opt-in pre-push hook"),
      u("P10.T08", M, "File evidence into the /eng-loop evidence record"),
      u(
        "P10.TEST01",
        M,
        "A fully green run issues a certificate that verify accepts"
      ),
      u(
        "P10.TEST02",
        M,
        "One real PR reconciles field-for-field against CI's proof artifact"
      ),
      u(
        "P10.TEST03",
        M,
        "Independent verification: a SEPARATE process re-derives every binding from disk and accepts"
      ),
      u("P10.NEG01", M, "Touching any tracked file yields VOID(head_sha)"),
      u(
        "P10.NEG02",
        M,
        "Advancing origin/main yields NOT-COMPARABLE(STALE_BASE), not a parity mismatch"
      ),
      u("P10.NEG03", M, "Editing scripts/ci/** yields VOID(verifier_hash)"),
      u("P10.NEG04", M, "Any FLAKY mandatory result refuses issuance"),
      u("P10.NEG05", M, "An incomplete ledger refuses issuance"),
      u("P10.NEG06", M, "Any phase not ACCEPTED refuses issuance"),
      u(
        "P10.NEG07",
        M,
        "A tampered ledger yields LEDGER_TAMPERED and refuses issuance"
      ),
      u(
        "P10.NEG08",
        M,
        "Issuance attempted with a preceding phase not ACCEPTED is refused, naming that phase"
      ),
      u(
        "P10.GATE01",
        M,
        "Issuance closure list: 10 of 10 PRECEDING phases ACCEPTED (P00..P09), all mandatory units closed, all mandatory gates negatively proven, zero unresolved defects, zero unexplained skips, zero flaky mandatory gates, zero infrastructure uncertainty, zero contract drift, zero broken gates, zero stale evidence, zero dirty bound inputs, zero ledger tampering",
        {
          exit_requirement:
            "Evaluated BEFORE issuance; self-reference to P10 is prohibited",
        }
      ),
      u(
        "P10.AUTH01",
        M,
        "Owner authorization to enable the opt-in pre-push hook"
      ),
      u(
        "P10.CP01",
        M,
        "P10 checkpoint recorded, binding the issued certificate hash",
        {
          depends_on: ["P10.GATE01", "P10.AUTH01"],
        }
      ),
    ],
  },
];

/** Owner decision records referenced by AUTHORIZATION units. */
export const DECISIONS = [
  {
    id: "DEC-001",
    title: "Dockerfile base image: pin by digest, or record only",
    required_by: "P08.AUTH01",
    allowed_values: ["PIN_BY_DIGEST", "RECORD_ONLY"],
    status: "PENDING",
    value: null,
  },
  {
    id: "DEC-002",
    title: "Deploy-order gate blocking semantics",
    required_by: "P09.AUTH01",
    allowed_values: ["BLOCKING", "ADVISORY"],
    status: "PENDING",
    value: null,
  },
  {
    id: "DEC-003",
    title:
      "DEF-002 resolution: reconcile RULESETS.md to live state, or restore classic protection",
    required_by: "DEF-002",
    allowed_values: ["DOCUMENT_LIVE_STATE", "RESTORE_CLASSIC_PROTECTION"],
    status: "PENDING",
    value: null,
  },
  {
    id: "DEC-004",
    title:
      "DEF-003 resolution: YAML parser architecture for the future P02 extractor",
    required_by: "DEF-003",
    allowed_values: [
      "PINNED_DEV_DEPENDENCY",
      "P06_CLASS_PINNED_TOOL",
      "DEPENDENCY_FREE_SCANNER",
    ],
    status: "PENDING",
    value: null,
  },
];

/** Flat list of every declared unit, with its phase attached. */
export function allUnits(phases = PHASES) {
  const out = [];
  for (const phase of phases) {
    for (const unit of phase.units) {
      out.push({ ...unit, phase: phase.id, kind: unitKind(unit.id) });
    }
  }
  return out;
}

/** Every declared unit ID, in declaration order. */
export function blueprintIds(phases = PHASES) {
  return allUnits(phases).map(unit => unit.id);
}

/**
 * PB.NEG01 — duplicate IDs must fail initialization.
 * Throws DUPLICATE_UNIT_ID naming every offending id.
 */
export function assertBlueprintUnique(phases = PHASES) {
  const seen = new Map();
  const duplicates = [];
  for (const phase of phases) {
    for (const unit of phase.units) {
      if (seen.has(unit.id)) duplicates.push(unit.id);
      else seen.set(unit.id, phase.id);
    }
  }
  const phaseIds = phases.map(phase => phase.id);
  const duplicatePhases = phaseIds.filter(
    (id, index) => phaseIds.indexOf(id) !== index
  );
  if (duplicates.length || duplicatePhases.length) {
    throw new Error(
      `DUPLICATE_UNIT_ID: units=[${[...new Set(duplicates)].join(", ")}] ` +
        `phases=[${[...new Set(duplicatePhases)].join(", ")}]`
    );
  }
  return true;
}

/**
 * PB.NEG02 — a declared blueprint ID missing from the seeded ledger must fail
 * initialization. Throws SEED_INCOMPLETE naming every missing id.
 */
export function assertSeedComplete(phases, ledger) {
  const declared = blueprintIds(phases);
  const seeded = new Set(Object.keys(ledger?.units ?? {}));
  const missing = declared.filter(id => !seeded.has(id));
  const extra = [...seeded].filter(id => !declared.includes(id));
  if (missing.length || extra.length) {
    throw new Error(
      `SEED_INCOMPLETE: missing=[${missing.join(", ")}] extra=[${extra.join(", ")}]`
    );
  }
  return true;
}
