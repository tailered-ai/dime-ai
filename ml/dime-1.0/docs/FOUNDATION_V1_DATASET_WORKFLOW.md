# Foundation v1 dataset workflow

## Purpose

This workflow turns reviewable Dime SFT records into the exact five-file
private Hugging Face snapshot consumed by a later authorized training run. It
does not author private data, publish to Hugging Face, authorize full training,
start a GPU run, or activate serving.

Foundation v1 is deliberately limited to:

- Dime-owned human-authored gold examples; and
- fully synthetic scenarios and tool fixtures.

It excludes chats, Bet Tracker history, user-derived examples, provider
exports, licensed odds/splits feeds, and teacher-generated drafts. This
restriction resolves the current private-draft storage risk: every draft that
appears in a public GitHub branch must already be safe for public review. The
eventual approved frozen release will remain private on Hugging Face.

## Current state

This workflow is implemented as a fail-closed review framework, not as an
approved dataset or a release. `configs/curriculum_v1.yaml` remains
`proposed`; no Foundation v1 candidate has completed all review and audit
gates, no approved five-file Foundation snapshot exists, and no Foundation
dataset revision has been published.

Nothing in this workflow changes Hugging Face, authorizes a training run,
starts a GPU, promotes an adapter, changes serving, or activates the
application provider. Those are later, separately reviewed transitions.

## Authority and locations

GitHub owns code, schemas, templates, configuration, the trusted reviewer
registry, synthetic public fixtures, the rubric, tests, and sanitized evidence.
The private Hugging Face repository `taileredsports/dime-foundation-sft` owns
only approved frozen releases. RunPod is a rebuildable working area and must
never be the sole location of a candidate, review ledger, audit report, or
frozen snapshot.

The owner-selected private candidate workbench is
`taileredsports/dime-foundation-workbench`. Its state is
`selected_pending_provisioning`; it may not receive private data until private
visibility, least-privilege access, credential denial, individual human
identity, registered agent workload identity, and immutable review-receipt
controls have been implemented and verified. The workbench stores pre-freeze candidate and review material only.
It is not the approved Foundation release and cannot authorize training.

Foundation v1 admits substantive human-authored gold examples and fully
synthetic scenarios or fixtures only. Substantive AI drafting, retained
AI-supplied prose, and relabeling AI-authored prose as `synthetic` are
prohibited. Automated assistance may check spelling, formatting, critique, or
compliance without supplying retained substantive prose. A separately
registered AI-agent reviewer may approve the exact bytes under this contract;
review authority never grants authorship authority.

No current platform state authorizes publication or training.

## Trusted reviewer authority

`configs/foundation_reviewer_registry.json`, validated by
`schemas/foundation_reviewer_registry.schema.json`, is the only Git-controlled
source of reviewer status and roles. Its exact UTF-8 file bytes are the
hashable authority. Every authority change requires a reviewed pull request
and a new `registry_version`; IDs are stable opaque identifiers and must not be
reassigned to another human or AI-agent principal.

Every reviewer entry must also define an opaque `independence_group_id` and a
half-open authority period: `effective_start` is inclusive and
`effective_end_or_open_ended` is exclusive, or `null` for open-ended authority.
Quorums count distinct independence groups, not aliases or reviewer IDs.
Review, source-rights, external-audit, and dataset-approval timestamps must
fall inside the referenced reviewer's authority period.

The current v3 registry is `proposed` and contains two inactive AI-agent
reviewer assignments in distinct independence groups. Their proposed roles
collectively cover every elevated specialist, external audit, and
dataset-approval duty, but neither entry grants authority. A proposed or
retired registry cannot contain an active reviewer, so the current file cannot
authorize a dataset, training run, release, or serving change.

Registry activation requires every AI-agent profile to pin the exact model
provider, model ID and immutable revision, runtime version, system-instruction
hash, tool-contract hash, inference-policy hash, receipt-issuer key, approved
roles, independence group, effective period, conflicts/recusals, and revocation
state. Materially correlated model or policy lineages count as one
independence group. Every governed AI-agent decision must carry the SHA-256 of
an immutable identity-bound receipt. Shared service credentials cannot
establish reviewer identity or sign a decision. No placeholder reviewer or
movable model alias may satisfy this gate.

AI agents are an owner-approved official reviewer principal type, and the two
checked-in assignments are the proposed official roster. They remain inactive.
The current runtime deliberately rejects active AI-agent entries because the
cryptographic receipt verifier is not yet implemented. Receipt SHA-256 fields
are content references, not signature verification and not activation
authority.

Review ledgers, external reports, and approval records may only reference a
stable `reviewer_id` that resolves to an active entry and the required role in
the exact trusted registry revision. They cannot create a reviewer, activate
one, or grant a role. The review ledger contains rubric-bound decisions; it
does not contain reviewer status or role definitions.

The candidate auditor and freezer require an `active` registry, resolve ledger,
source-rights, external-audit, and approval IDs from it, and enforce each
required role, authority period, and independence-group quorum. Dataset
approvers must also be distinct from candidate authors. The SHA-256 of the
exact registry file—therefore also its embedded `registry_version`—is bound as
`reviewer_registry_sha256` in the candidate audit and every external audit,
the Foundation approval, the v4 dataset manifest, and the candidate-specific
training evidence. All five evidence layers must bind the same digest.

## Record lifecycle

1. **Candidate**
   - Stable `example_id`, Foundation v1 dataset version, full lineage, grouped
     partition keys, and canonical record SHA-256.
   - Candidate validation may pass; it is not trainable.
2. **Reviewed**
   - Reviewer-owned decisions bind the exact record hash and rubric hash and
     reference a stable ID in the trusted registry.
   - Ledger-supplied status or roles have no authority.
   - A content change invalidates all earlier decisions.
3. **Approved**
   - Every required independent reviewer approved the exact hash.
   - Embedded record status alone has no authority.
4. **Rejected**
   - Terminal for that byte revision. Rework creates a new candidate hash.

## Dataset lifecycle

1. **Assembling** — select approved record hashes and group before splitting.
2. **Audited** — machine audit passes and external reports bind the exact
   train/validation hashes.
3. **Approved** — two dataset approvers approve the exact inputs and evidence.
4. **Frozen** — a new exact-inventory directory is written atomically.
5. **Published** — a separate owner-authorized publisher uploads and verifies
   the bytes at a full Hugging Face commit SHA.
6. **Retired** — the immutable revision remains recoverable but cannot
   authorize new training.

## Required private working inputs

```text
candidate-root/
├── train/
│   └── *.jsonl
├── validation/
│   └── *.jsonl
├── source-artifacts/
│   └── <exact files named by source_registry.json>
├── source_registry.json
├── review_ledger.json
├── development-evaluation/
│   ├── cases/
│   │   └── *.jsonl
│   ├── evaluation_manifest.json
│   └── development_eval_identity.json
├── dataset_card.md
├── candidate_audit.json
├── foundation_approval.json
└── external-audits/
    ├── semantic-deduplication.json
    ├── privacy-and-identifiers.json
    ├── rights.json
    ├── development-evaluation-contamination.json
    ├── locked-evaluation-contamination.json
    └── numeric-traceability.json
```

The locked contamination artifact is an opaque, non-reconstructable
attestation from the isolated evaluator. Locked prompts, answers, thresholds,
case IDs, and traces never enter this workspace.

This tree is a required logical contract, not a public GitHub storage path.
The real candidate records and all private source, review, audit, and approval
artifacts remain in an authorized private review system. Only public-safe
templates, schemas, deterministic code, and sanitized evidence may be tracked
in GitHub. A working copy may be staged on RunPod only when another
authoritative copy exists.

## Remote development-evaluation proof

Development-contamination review is bound to live Hugging Face evidence, not
to an operator-selected local subset. The candidate auditor and freezer accept
only identity schema `dime-foundation-development-eval-identity-v2`. Its
completed identity must contain:

- repository type `dataset` and repository ID
  `taileredsports/dime-eval-development`;
- the exact lowercase 40-character Hugging Face commit SHA, never a branch,
  tag, or other moving alias;
- `evaluation_manifest.json` and the SHA-256 of its exact bytes;
- `case_root` equal to `cases`;
- a strictly path-sorted and exhaustive `case_files` entry for every remote
  path below `cases/` ending in `.jsonl`, including each file's exact SHA-256
  and nonzero record count;
- `case_files_sha256`, computed from the canonical JSON serialization of that
  complete ordered array (UTF-8, keys sorted, no insignificant whitespace,
  one trailing newline); and
- `case_count`, equal to the sum of all per-file record counts.

The operator must supply an explicit nonempty `HF_TOKEN` with read access to
that private repository. At the declared commit, the verifier:

1. resolves the exact repository ID and commit and proves the repository is
   private;
2. enumerates the live repository and requires root `README.md`,
   `evaluation_manifest.json`, and exact equality between the declared case
   paths and the complete recursive `cases/**/*.jsonl` inventory;
3. downloads the manifest and every declared case file;
4. verifies all manifest, inventory, file, and record-count hashes;
5. requires the local manifest and each local case file to equal the remote
   bytes; and
6. validates every remote case in production mode and rejects duplicate case
   IDs across files.

Identity v1, a missing or blank token, inaccessible remote state, a public
repository, wrong or unresolved commit, selective local files, missing or
extra remote case files, and any byte/hash/count mismatch all stop the audit.
Remote or transport failure never falls back to the local working copy or
previously recorded evidence.

## Operator command blueprint

Run the CPU-only candidate audit from `ml/dime-1.0` after replacing the
private-workspace paths. Repeat `--train`, `--validation`, or
`--development-eval` once per shard. Every local case named by the v2 identity
must be supplied; selecting only a convenient subset fails. Confirm the
fine-grained read-only token is injected without printing it:

```bash
test -n "${HF_TOKEN:-}" || {
  echo "HF_TOKEN is required" >&2
  exit 1
}
```

Then run:

```bash
python scripts/audit_foundation_candidates.py \
  --train /private-review/foundation-v1/train/part-000.jsonl \
  --validation /private-review/foundation-v1/validation/part-000.jsonl \
  --development-eval /private-review/development-eval/cases/development/part-000.jsonl \
  --development-eval-identity /private-review/development-eval/development_eval_identity.json \
  --development-eval-manifest /private-review/development-eval/evaluation_manifest.json \
  --source-artifact-root /private-review/foundation-v1/source-artifacts \
  --source-registry /private-review/foundation-v1/source_registry.json \
  --review-ledger /private-review/foundation-v1/review_ledger.json \
  --generated-at-utc 2026-01-01T00:00:00Z \
  --report /private-review/foundation-v1/candidate_audit.json
```

The audit requires every private candidate, source, ledger, and development
evaluation path—and the new report destination—to be outside the entire
enclosing public Git worktree. It rejects symlink aliases and fails closed
when the worktree root cannot be established. The report writer also refuses
to overwrite an existing path. A nonzero exit or `"pass": false` stops the
workflow.

After independent audits and owner approval bind those exact bytes, freeze to
a new path outside the entire public Git worktree:

```bash
python scripts/freeze_foundation_dataset.py \
  --train /private-review/foundation-v1/train/part-000.jsonl \
  --validation /private-review/foundation-v1/validation/part-000.jsonl \
  --development-eval /private-review/development-eval/cases/development/part-000.jsonl \
  --development-eval-identity /private-review/development-eval/development_eval_identity.json \
  --development-eval-manifest /private-review/development-eval/evaluation_manifest.json \
  --source-artifact-root /private-review/foundation-v1/source-artifacts \
  --source-registry /private-review/foundation-v1/source_registry.json \
  --review-ledger /private-review/foundation-v1/review_ledger.json \
  --candidate-audit /private-review/foundation-v1/candidate_audit.json \
  --approval /private-review/foundation-v1/foundation_approval.json \
  --dataset-card /private-review/foundation-v1/dataset_card.md \
  --external-audit-dir /private-review/foundation-v1/external-audits \
  --output /private-release/foundation-v1
```

The freezer re-runs the candidate audit. It does not trust a caller-supplied
pass result, overwrite an existing release directory, publish to Hugging Face,
or authorize training.

## Machine audit

`scripts/audit_foundation_candidates.py`:

- validates the complete curriculum against
  `schemas/curriculum_program.schema.json` and rejects missing, unknown, or
  internally inconsistent policy sections;
- rejects duplicate JSON keys, nonfinite JSON numbers, invalid UTF-8,
  symlinks, empty files, duplicate IDs, arbitrary system messages, malformed
  tools, future data, secrets, and direct identifiers;
- verifies every record source against the immutable source registry;
- hashes each registry-named source artifact from disk, rejects unknown files
  and symlinks, and enforces
  `available_at_utc <= snapshot_at_utc <= reviewed_at_utc <= audit cutoff`;
- enforces the Foundation v1 no-user/no-provider source policy;
- binds each review decision to the canonical record and rubric hashes;
- enforces author/reviewer separation, independent reviewer counts, and
  specialist roles;
- requires every numeric token in every assistant message, across every task
  type, to be covered by a structured assertion sourced from a numeric leaf in
  a linked successful (`status: "ok"`) tool result;
- independently recomputes every `calculate_market_math` result from the call
  arguments, verifies its complete result-key inventory, and checks the
  structured and displayed values within the unit-specific tolerance;
- validates every development-evaluation case in production mode and remotely
  proves the private repository, exact 40-character revision, exhaustive
  recursive case inventory, manifest and per-file hashes/counts, and local/
  remote byte equality against `development_eval_identity.json`;
- checks exact normalized duplicates, grouped partition leakage, interaction
  coherence, quotas, distribution caps, answer-length mix, math subskills,
  responsible-gaming minimums, and matched controls; and
- emits only hashes, counts, metrics, gates, and issues—not source content.

A passing local near-duplicate screen is deterministic triage. It does not
replace the independently reviewed semantic-deduplication or evaluation-
contamination reports required for approval.

The built-in sensitive-material scanner is likewise a deterministic,
named-pattern admission control. It rejects recognized Hugging Face, GitHub,
AWS, bearer, OpenAI, Anthropic, Google, RunPod, odds-provider, and Stripe
credential forms, private-key PEM blocks, credential-bearing URIs, and named
direct-identifier patterns. It is not an exhaustive secret detector and does
not claim generic entropy detection. A passing local scan never replaces the
required independent `privacy_and_identifiers` report, whose privacy and
secret-review scope is bound to the exact candidate hashes and reviewed by an
authorized privacy auditor.

The auditor resolves every ledger reviewer ID and specialist role against the
trusted registry. The registry gate fails when the registry is not `active`,
an ID is unknown or inactive, or the required role is absent.

## Governed reviewer and external approval

The approval record binds:

- train and validation hashes;
- source registry and review ledger hashes;
- the aggregate hash of the exact source snapshot bytes;
- candidate-audit and Dataset Card hashes;
- curriculum, system prompt, chat template, tool catalog, and build-config
  hashes;
- the development-evaluation repository, full revision, manifest hash, and
  identity hash;
- six external audit report hashes, tools, versions, completion times, and
  reviewer identities, each bound to the candidate-audit hash and exact
  governed input map;
- an exact reviewer-to-receipt-digest mapping for every AI-agent decision;
- the approved locked-evaluation full revision or structured opaque reference;
  and
- two dataset approvers, deletion policy, and limitations.

Approval is invalid if any referenced byte changes, any report failed, an
approver is missing, or an approval/report timestamp precedes the record
reviews and audit.

No approval is authoritative under the current `proposed` reviewer registry.
The approval and audit contracts bind the same `reviewer_registry_sha256` used
to resolve every record reviewer, specialist, external auditor, and dataset
approver.

Each external report also has an exact independent scope:

| Audit | Required tool | Scope reference | Reviewer role |
|---|---|---|---|
| Semantic deduplication | `dime-semantic-audit@1.0.0` | Candidate-audit SHA-256 | `semantic-audit` |
| Privacy and identifiers | `dime-privacy-audit@1.0.0` | Direct-identifier scanner version | `privacy` |
| Rights | `dime-rights-audit@1.0.0` | Source-registry SHA-256 | `rights` |
| Development contamination | `dime-development-contamination-audit@1.0.0` | Development-evaluation full revision | `evaluation-audit` |
| Locked contamination | `dime-locked-contamination-audit@1.0.0` | Approved locked-evaluation reference | `locked-evaluation` |
| Numeric traceability | `dime-numeric-audit@1.0.0` | Tool-catalog SHA-256 | `numeric` |

All six reports bind the exact train and validation hashes, candidate-audit
hash, and complete governed input-evidence mapping. The locked report uses
only the fixed non-reconstructable summary allowed by its schema.

## Freeze

`scripts/freeze_foundation_dataset.py` performs a new audit, validates the
approval, revalidates source rights as of approval time, and creates:

```text
foundation-v1/
├── train.jsonl
├── validation.jsonl
├── dataset_manifest.json
├── dataset_card.md
└── checksums.json
```

The destination must not exist. Every private input, private evidence
directory, Dataset Card working file, and output path must remain outside the
full public Git worktree. Inputs must be regular non-symlink files or
directories; output paths may not traverse a symlink alias. The freezer fails
closed when it cannot establish the worktree boundary, writes a sibling
temporary directory, fsyncs files, atomically renames it, and refuses unknown
output files. The v4 manifest binds the canonical system prompt,
source-artifact aggregate, development-evaluation identity, locked-evaluation
reference, and all review/audit evidence hashes. Any correction requires a
new dataset version and approval.

The five listed files are the complete version-directory payload. The Hugging
Face repository also requires its root `README.md` Dataset Card, but that
repository-level card is not a sixth file inside `foundation-v1/`.

## Canonical system prompt

Production records may not provide system messages. The full trainer injects
exactly one copy of `prompts/dime_system_v1.md`, followed by the frozen tool
catalog. This prevents record-level prompt weakening while retaining
assistant-only supervision.

## Future training authorization

Freezing and publishing a dataset do not authorize training. A later,
candidate-specific pull request must change the platform state to
`training_authorized` and bind `authorization.training_candidate` to the exact
experiment, source commit, training configuration, preflight run manifest, and
immutable dataset identities.

That authorization must contain `foundation_evidence_hashes` whose lowercase
SHA-256 values exactly match the independently reviewed v4 manifest:

- `system_prompt_sha256`;
- `foundation_build_config_sha256`;
- `source_registry_sha256`;
- `source_artifacts_sha256`;
- `reviewer_registry_sha256`;
- `review_ledger_sha256`;
- `candidate_audit_sha256`;
- `approval_record_sha256`; and
- an `audit_reports` mapping containing exactly
  `semantic_deduplication`, `privacy_and_identifiers`, `rights`,
  `development_evaluation_contamination`,
  `locked_evaluation_contamination`, and `numeric_traceability`.

It must also bind:

- the Foundation repository revision as a full 40-character Hugging Face
  commit SHA, plus `dataset_manifest.json` and `checksums.json` SHA-256 values;
- the development-evaluation repository revision as a full 40-character
  Hugging Face commit SHA; and
- the approved locked-evaluation full revision or structured opaque reference.

The training entrypoint recomputes these bindings and rejects a missing,
additional, or mismatched field. The proposed registry cannot produce an
approved snapshot, so it cannot authorize the current trainer. Tags, branches,
paths, mutable aliases, passing local audits, and an approved dataset revision
without the reviewed evidence mapping are insufficient.

## Stop conditions

Candidate validation loads the complete
[tool and canonical market contract bundle](TOOL_AND_MARKET_CONTRACTS.md).
Each tool call must use the exact request schema and canonical market key, and
each linked result must pass both the common envelope and its tool-specific
data schema. The Foundation build contract binds the aggregate bundle
SHA-256 across all 13 governed files, including both governing schemas,
preventing later evidence from retaining one request-catalog hash while
silently changing response or market contracts. Validation retains original
call arguments and binds every nonempty result to them. It also executes
registry scope/freshness classes, selection-keyed split totals and disclosure,
Decimal numeric domains, internal timestamp consistency, and recursive
server-owned argument exclusion. Item-level odds sources must be declared by
their envelope, returned temporal coverage must stay inside explicit request
filters, known split samples must be positive, warnings are bound to exact
tool/status/quote semantics, successful deterministic math is independently
recomputed for SFT and development-evaluation records, and schema failures
expose only governed schema paths and static categories.

Stop before freeze when:

- the 2,160/240 grouped split or any curriculum quota is incomplete;
- the 48-case Foundation Screen is not independently prepared for the later
  candidate decision;
- source, rights, reviewer, privacy, numeric, partition, deduplication, or
  contamination evidence is missing;
- an external audit is only a Boolean without a report hash and tool version;
- a record contains user/provider data or an arbitrary system message; or
- the platform contract remains `foundation_only` and anyone proposes full
  training, publication, or serving.

## Later publication

Dataset publication is a separate external mutation. It requires an
owner-authorized workflow, `dime-release-publisher-v1`, private visibility,
expected-parent concurrency, returned full commit SHA, independent read-only
download verification, a durable receipt, and a non-moving tag. None of those
steps are performed by the audit or freeze commands.

After publication, every training, evaluation, evidence, and rollback
reference must use the returned full 40-character Hugging Face commit SHA.
The tag is only a human-readable alias.
