# Dime 1.0 platform ownership contract

This contract defines which platform owns every material Dime 1.0 asset, how
an asset moves between platforms, and which boundaries must never be crossed.
It is release authority for the active project at `ml/dime-1.0/`.

The present state is foundation-only. Nothing in this document authorizes full
training, locked evaluation, model publication, serving, or provider
activation. The machine-readable contract currently sets
`authorization.adapter_publication` to `false`; publication remains blocked
until a focused, owner-approved pull request changes and binds that state to an
exact release candidate.

The Foundation v1 curriculum remains `proposed`. The tracked candidate,
review, audit, approval, and freeze layer has not produced an approved
Foundation dataset and does not change any Hugging Face repository, training
authorization, serving configuration, or provider state.

The trusted reviewer registry is also `proposed`. It contains two owner-
confirmed, independent AI-agent reviewer assignments, but both entries are
inactive and grant no reviewer or approver authority. Reviewer-backed
transitions remain blocked until each exact agent profile and receipt issuer is
pinned and a reviewed registry revision activates them. The audit, freeze, and
training paths bind its exact SHA-256 through every evidence layer.

## Foundation v1 owner decision

The repository owner has selected the private Hugging Face dataset repository
`taileredsports/dime-foundation-workbench` as the Foundation v1 candidate
workbench. The machine-readable decision is
`configs/platform_contract.json.foundation_v1_owner_decision`.

This is a storage and governance decision, not an external-state claim. The
workbench remains `selected_pending_provisioning`, and private-data admission
is false until the repository exists, private visibility is verified, the
fine-grained access boundary passes live positive and negative checks, and the
reviewer identity/receipt control below is operational.

The workbench is authoritative only for private candidate records, source
artifacts and registry, review ledger, raw external audits, and the Foundation
approval record before freeze. It is never the approved Foundation release,
training authority, an adapter release, or a serving source. RunPod may hold a
working copy but is never authoritative.

Foundation v1 is strictly limited to substantive human-authored gold examples
and fully synthetic scenarios or fixtures. Substantive AI drafting and retained
AI-supplied prose are prohibited. The `synthetic` source class cannot be used
to relabel AI-authored answers. AI assistance may be limited to spelling,
formatting, critique, and checklist validation when it supplies no retained
substantive prose. Registered AI-agent reviewers may approve exact candidate
bytes under the separation-of-duties contract; that authority does not permit
AI-authored training prose.

Human workbench access requires individual accounts and MFA. Registered AI
reviewers require a unique workload identity bound to one reviewer profile.
Shared human or AI-agent credentials are prohibited. The planned
`dime-foundation-workbench-read-v1` and
`dime-foundation-workbench-write-v1` service credentials are scoped only to
that workbench and cannot establish reviewer identity or sign a decision.
Training, serving, release-publisher, locked-evaluator, and locked-publisher
credentials are all denied access.

Reviewer activation remains deliberately blocked. The proposed v3 registry now
contains two inactive opaque AI-agent reviewer IDs in distinct independence
groups. One proposed assignment covers domain, numeric, simulation,
semantic-audit, and dataset-approver duties; the other covers coaching, safety,
privacy, rights, evaluation-audit, locked-evaluation, and dataset-approver
duties. Before either entry can become active, its profile must pin the exact
provider, model and revision, runtime, system instructions, tool contract,
inference policy, receipt issuer, approved roles, effective authority dates,
conflicts, recusals, and revocation state. Every agent review, audit, and
approval must carry an immutable identity-bound receipt digest. A shared
service token is never evidence that a particular principal made a decision.
No placeholder identity or movable model alias may be used.

This owner decision approves AI agents as an official reviewer principal type
and designates the two inactive assignments as the proposed official roster.
It does not activate them. The cryptographic receipt verifier is not
implemented, so the runtime rejects every active AI-agent registry entry. A
later focused change must implement signature verification before
`ai_agent_activation_authorized` can become true.

This owner decision does not create the repository, provision credentials,
admit private data, activate reviewers, approve a record or dataset, authorize
GPU execution or training, publish a release, change serving, or activate the
provider.

Authorization is never a reusable global switch. Full training additionally
requires `authorization.training_candidate` to match the exact experiment,
prior clean source commit, config hash, foundation dataset-manifest hash,
foundation checksum-manifest hash, complete independently reviewed
`foundation_evidence_hashes` including the trusted reviewer-registry SHA-256,
preflight run-manifest hash, full 40-character foundation and development
revisions, and the approved locked-evaluation full revision or structured
opaque reference. A separate authorization commit may change only the
canonical platform contract across the entire repository.
Publication additionally requires
`authorization.release_candidate` to match the exact candidate artifact
hashes, evaluation-summary hash, training-contract hash, canonical
bundle-payload hash, locked-suite manifest hash and expected-case count, and
immutable comparison-control kind/repository/revision/hash, comparison-report
hash, quality-slice-report hash, and destination parent commit. A prior
`promoted_adapter.approved_release_revision` must remain the champion and serve
as both comparison control and destination parent; only an inaugural release
may use the pinned Meta base control while that field is `null`.

## Non-negotiable invariants

1. GitHub `main` is the reviewed source for code and governance.
2. Approved private datasets are frozen in separate Hugging Face dataset
   repositories and loaded by full 40-character commit SHA.
3. Locked evaluations are isolated from training, development, and serving.
4. The production model repository contains promoted PEFT adapter releases
   only; Meta base weights and full merged models are prohibited.
5. Training compute receives read-only Hugging Face access. A training
   environment can never publish a release.
6. RunPod is replaceable compute and working storage, not the only permanent
   location for an important asset.
7. Application user data remains in authorized application data systems and is
   not training data by default.
8. Serving may load only an explicitly approved adapter commit and must never
   load `main`, `latest`, or a movable tag.
9. A training authorization cannot approve itself: source commit `S` owns all
   governed inputs, authorization commit `A` changes only the platform
   contract across the repository, and training verifies `S` is an ancestor of
   clean `A`.
10. Locked-evaluation authorization binds an approved suite reference,
    manifest SHA-256, expected case count, and isolated evaluator run ID;
    case-level content never crosses into the release bundle.
11. A new candidate reaches locked evaluation only through the reviewed,
    one-way, content-addressed handoff. It is not uploaded to the production
    model repository before it passes locked evaluation and release review.
12. Foundation candidate records, source and review evidence, raw audit
    reports, and approval material remain in an authorized private review
    system until freeze; GitHub holds only public-safe contracts and sanitized
    evidence.
13. The Git-controlled trusted reviewer registry is the sole authority for
    reviewer status and roles. Ledgers and reports reference its stable IDs;
    they cannot create identities, activate reviewers, or grant roles.

## End-to-end boundary

```text
GitHub reviewed source S ─────────────┐
GitHub authorization commit A ───────┤ exact two-commit chain
HF foundation dataset ───────────────┤ exact HF commit
HF development evaluation ──────────┤ exact HF commit
Meta Llama base ─────────────────────┤ exact HF commit
                                     ▼
                         RunPod training workspace
                         read-only training token
                                     │
                      candidate adapter + run evidence
                                     ▼
                 one-way candidate transfer control
                                     │ exact candidate hashes
                                     ▼
HF locked evaluation ───────► isolated evaluator
                                     │
                          sanitized aggregate only
                                     ▼
                         GitHub review and release gates
                                     │
                       separate release-publisher token
                                     ▼
                    HF promoted-adapter repository
                                     │ first approved candidate HF commit
                                     ▼
                              serving platform

Locked content never reaches training, development, release, or serving.
The evaluator input never mounts the shared training volume or cache.
```

## GitHub: canonical reviewed source

Repository:
`aisportsbettingcontact/ai-sports-betting-dime-ai`

Canonical project path:
`ml/dime-1.0/`

GitHub `main` permanently owns:

- source code and deterministic validation logic;
- versioned prompts, chat templates, and tool contracts;
- dataset, evaluation, manifest, and tool-response schemas;
- synthetic or redistribution-cleared public fixtures;
- public development-evaluation examples;
- training, evaluation, and runtime configurations;
- the versioned trusted reviewer registry and its closed schema;
- documentation, architecture, runbooks, and release gates;
- tests and CPU-safe validation workflows;
- approved dataset manifests and SHA-256 hashes that are safe to publish;
- experiment configurations and sanitized run fingerprints;
- sanitized aggregate reports, score summaries, and infrastructure evidence;
- model-card and release-attestation templates; and
- pull-request review history and promotion decisions.

Branches and pull requests are public draft work. Private data must never be
committed, even temporarily. Only reviewed, rights-cleared material may merge
into `main`.

`configs/foundation_reviewer_registry.json` is the sole reviewer authority.
Every change requires review and a new registry version. Its exact bytes are
hashed as `reviewer_registry_sha256`. The current `proposed` registry contains
two inactive AI-agent assignments, so it cannot authorize a decision, audit,
approval, dataset, or training run. Every v3 reviewer entry defines its
principal type, opaque independence group, and half-open effective period; AI
entries additionally carry an immutable activation profile. Runtime validation counts
distinct groups and requires record reviews, source-rights reviews, external
audits, and dataset approvals to occur during the referenced reviewer's
authority. A ledger may reference only a stable registry ID. Any ledger-
carried status, role, group, or authority date is non-authoritative and cannot
override the registry.

GitHub must not contain:

- Hugging Face, RunPod, GitHub, provider, database, or serving credentials;
- private foundation records or licensed data without redistribution rights;
- raw user betting histories, chats, account data, or private retrieval
  context;
- locked cases, answers, private rubrics, or case-level locked results;
- model or adapter weights;
- optimizer state, checkpoints, caches, or virtual environments; or
- raw Pod, volume, endpoint, or infrastructure identifiers in public evidence.

## Hugging Face: approved foundation training data

Private dataset repository:
`taileredsports/dime-foundation-sft`

This repository owns only approved, frozen foundation SFT releases. A release
contains a root Dataset Card plus this exact version-directory inventory:

```text
README.md
foundation-v1/
├── train.jsonl
├── validation.jsonl
├── dataset_manifest.json
├── dataset_card.md
└── checksums.json
```

The five files under `foundation-v1/` are a closed-world inventory. Candidate
shards, source registries, review ledgers, raw audit reports, approval records,
temporary files, and unknown files do not enter that directory. The root
`README.md` is repository metadata and does not become a sixth file inside the
version directory.

The v4 manifest binds the canonical system prompt, Foundation build config,
source registry, aggregate source-artifact bytes, review ledger, candidate
audit, approval record, and the six independently reviewed external audit
report hashes: semantic deduplication, privacy and identifiers, rights,
development-evaluation contamination, locked-evaluation contamination, and
numeric traceability. It also binds the development-evaluation repository and
full revision, its manifest and identity hashes, plus the approved
locked-evaluation reference. The candidate audit, every external audit,
approval, v4 manifest, and training evidence bind the same
`reviewer_registry_sha256`; the implementation enforces those bindings.

Draft and unreviewed records remain in a reviewed GitHub pull-request workflow
only when they are safe for public review. Private drafts remain in an
authorized private review system; they do not go on RunPod as the sole copy.

Training loads an approved release with `dime-training-read-v1` and its exact
Hugging Face commit SHA. A later candidate-specific authorization must also
bind the exact v4 manifest and checksums hashes, the complete
`foundation_evidence_hashes` mapping, the development-evaluation full commit,
and the locked-evaluation full revision or structured opaque reference. The
training environment cannot write to this repository.

See [Foundation v1 dataset workflow](FOUNDATION_V1_DATASET_WORKFLOW.md).

## Hugging Face: development evaluation

Private dataset repository:
`taileredsports/dime-eval-development`

This repository owns visible development and validation cases, public-to-the-
team rubrics, expected tool behavior, numeric tolerances, evaluation manifests,
and checksums. Its contents may guide model development, so its scores cannot
substitute for the locked release gate.

The training environment may read an approved development-evaluation revision
by full commit SHA. Foundation candidate audit and freeze require an explicit
`HF_TOKEN` and identity schema
`dime-foundation-development-eval-identity-v2`. At that exact revision, they
prove the repository is private, enumerate the complete recursive
`cases/**/*.jsonl` inventory, require root `README.md` and
`evaluation_manifest.json`, and byte-compare the manifest and every case with
the identity-bound local working copy. A partial inventory or unavailable,
moving, public, mismatched, or unauthenticated remote fails closed; local-only
evidence is never a fallback. The training environment cannot modify the
repository.

## Hugging Face: locked evaluation

Restricted private dataset repository:
`taileredsports/dime-eval-locked`

This repository owns hidden release cases, private scoring material, expected
tool behavior, numeric tolerances, integrity manifests, and checksums. Raw
locked content may be accessed only by an isolated evaluator using
`dime-locked-evaluator-read-v1`. Publication uses the separate
`dime-locked-publisher-v1` credential.

The following credentials are denied access:

- `dime-training-read-v1`;
- `dime-serving-read-v1`; and
- `dime-release-publisher-v1`.

Locked content must not enter the training network volume, a developer
notebook, a model-development cache, GitHub, the adapter repository, serving,
or a general release workspace. Only approved, non-reconstructable aggregate
evidence may leave the evaluator.

The locked evaluator receives a new, unpromoted candidate through the
[candidate handoff](CANDIDATE_EVALUATION_HANDOFF.md), not through the
production adapter repository. Its access to the promoted repository exists
only to load the current champion comparison control.

## Hugging Face: promoted adapter releases

Private model repository:
`taileredsports/Llama-3-Dime-1.0`

The default revision owns only serving-approved, adapter-only releases for:

```text
base model: meta-llama/Llama-3.1-8B
revision:   d04e592bb4f6aa9cfee91e2e20afa771667e1d4b
```

An approved release includes the PEFT adapter, its configuration, a root Model
Card, exact training and evaluation provenance, release attestation,
checksums, and only the tokenizer/chat/generation artifacts required by the
allowlisted release contract.

The exact local payload is:

```text
README.md
LICENSE
NOTICE
adapter_model.safetensors
adapter_config.json
training_manifest.json
evaluation_summary.json
release_attestation.json
checksums.sha256
chat_template.jinja
generation_config.json
tokenizer.json                 # optional override set
tokenizer_config.json          # optional override set
special_tokens_map.json        # optional override set
added_tokens.json              # optional; requires override set
```

Tokenizer overrides are omitted when the pinned base tokenizer is unchanged.
If an override is required, all three core tokenizer files travel together;
`added_tokens.json` is permitted only with that complete set.

The root `.gitattributes` is permitted only as Hugging Face-managed remote
metadata. It is not local release payload and is excluded from the payload
checksum manifest. The published remote inventory must contain exactly that
metadata file plus the approved payload, with no stale artifact from an
earlier commit.

The repository must not contain:

- Meta base-model weight shards;
- merged or quantized full-model weights;
- `model.safetensors`, `model-*-of-*.safetensors`, or
  `pytorch_model*.bin`;
- training checkpoints, optimizer state, scheduler state, or trainer logs;
- rehearsal adapters on the default revision;
- raw foundation, development, or locked datasets;
- raw user data; or
- a workspace, cache, virtual environment, or deployment bundle.

The existing rehearsal adapter is classified:

`REHEARSAL — NOT APPROVED FOR SERVING`

It remains in governed archive/evidence storage and must not be uploaded to the
production root. Publication, when separately authorized, uses
`dime-release-publisher-v1`. Serving uses `dime-serving-read-v1` and loads only
the approved full commit SHA.

Publication records the destination's full expected parent commit, enforces it
as a concurrency guard, captures the full commit returned by Hugging Face,
verifies the exact remote inventory and hashes at that revision with a
read-only credential, and preserves a publication receipt. No tag or serving
promotion may precede that receipt.

For that single post-upload verification, `dime-serving-read-v1` is injected
as a separate transient verifier token because it can read the adapter
repository but cannot write or read any Dime dataset. It is removed after the
receipt is written and is never installed in training.

## RunPod: temporary compute and active workspace

RunPod owns no irreplaceable source artifact. It provides:

- GPU compute;
- the rebuildable environment at `/opt/dime-venv`;
- a persistent network volume mounted at `/workspace`;
- pinned source and dataset working copies;
- active experiment checkpoints, adapters, logs, and reports;
- Hugging Face and package caches; and
- recovery checkpoints retained for an active run.

The governed layout is:

```text
/workspace/
├── repos/
│   └── ai-sports-betting-dime-ai/
├── datasets/
│   ├── foundation-sft/
│   │   └── <full-hf-commit-sha>/
│   └── eval-development/
│       └── <full-hf-commit-sha>/
├── runs/
│   └── <experiment-id>/
│       ├── checkpoints/
│       ├── adapters/
│       │   └── final/          # trainer-created atomic artifact
│       ├── logs/
│       ├── reports/
│       └── run_manifest.json
├── archive/
└── .cache/
    ├── huggingface/
    └── pip/
```

Every run records an exact Git commit, exact Hugging Face dataset commits,
exact Meta base revision, unique experiment ID, configuration hashes, prompt
and schema versions, tool contract, decoding settings, runtime identity, and
output hashes. A future full-training run also records the Foundation v4
manifest and checksums hashes, the independently reviewed Foundation evidence
hash mapping, the development-evaluation full commit, and the approved
locked-evaluation reference.

For Foundation data admission, every numeric token in every assistant message
must resolve through a reviewed assertion to a numeric leaf in a successful
tool result. `calculate_market_math` outputs additionally require independent
recomputation from the recorded arguments. This applies across task families,
not only to records labeled `market_math`.

The training template receives only `dime-training-read-v1`. Publisher and
locked-evaluator credentials are prohibited. After a run, approved small
evidence moves to GitHub, an approved adapter moves through the separate
publisher workflow, necessary recovery checkpoints are retained, and GPU
compute is stopped. The network volume remains persistent and must not be
deleted as part of normal Pod cleanup.

See [RunPod workspace and runbook](RUNPOD_WORKSPACE_RUNBOOK.md).

## Restricted evaluator compute

Locked evaluation executes outside the training workspace with a separate
cache, filesystem, credential, and run identity. It loads:

- the unpromoted candidate from a fresh, read-only evaluator input whose exact
  three-file inventory, byte lengths, and SHA-256 values match the approved
  one-way transfer authorization and receiver receipt;
- the Meta base model by the pinned revision;
- the locked dataset by full Hugging Face commit SHA;
- the evaluator implementation by full Git commit SHA; and
- the current promoted adapter by full Hugging Face commit SHA only when a
  champion exists and is the approved comparison control.

It exports only `dime-release-evaluation-summary-v1`: approved aggregate
counts, opaque evaluator/locked-suite references, and hashes binding the exact
candidate and restricted evidence. Raw cases, answers, thresholds, rubrics,
case IDs, and case-level traces remain restricted.

No production Hugging Face commit exists for the candidate at this stage.
Publication happens only after the locked aggregate, human review, release
authorization, and all other gates pass. The full handoff, receipt,
closed-world inventory, cleanup, and failure rules are defined in
[Candidate-to-locked-evaluator handoff](CANDIDATE_EVALUATION_HANDOFF.md).

## Application data systems

Bet Tracker histories, chat histories, user identifiers, raw account data,
private conversations, consent state, and deletion state remain in the
application's authorized databases and object stores.

They are not training data by default. They must not enter GitHub, Hugging
Face, RunPod training, model weights, or evaluation suites until purpose,
consent, rights, retention, deletion, de-identification, tenant isolation,
partitioning, and privacy controls are formally approved.

Runtime personalization should use authorized, user-scoped retrieval rather
than silently placing private history into model weights.

## Serving platform

Serving owns the approved runtime image, endpoint configuration, operational
monitoring, and a local copy or cache of one approved adapter revision. It uses
`dime-serving-read-v1`, which can read only the promoted-adapter repository and
the gated Meta base model.

Serving cannot read foundation, development, or locked datasets. It cannot
write to Hugging Face. It must verify the release attestation and artifact
hashes before accepting a revision.

The application provider remains `frozen` until a separate owner-authorized
promotion pull request proves every release gate and explicitly changes the
provider constant.

## Asset transfer and approval matrix

| Transfer | Required identity | Approval | Destination |
|---|---|---|---|
| GitHub source to RunPod | Full Git commit SHA | Reviewed `main` commit | Pinned full checkout |
| Private Foundation candidates to review | Record hashes, source registry, rubric hash, stable reviewer IDs, and trusted reviewer-registry SHA-256 | Active registry roles plus independent record review | Authorized private review system |
| Approved Foundation inputs to freeze | Split, evidence, and trusted reviewer-registry SHA-256 values | Machine audit, external reports, and two registry-authorized dataset approvers | New exact five-file snapshot |
| Frozen Foundation snapshot to HF | Exact five-file hashes and expected parent | Separate owner-authorized publication | Private dataset commit with returned full SHA |
| Foundation data to RunPod | Full HF commit SHA | Approved dataset release | Revision-specific directory |
| Development eval to RunPod | Full HF commit SHA | Approved eval release | Revision-specific directory |
| Candidate outputs to review | Experiment ID and hashes | Experiment review | Sanitized GitHub evidence |
| Locked data to evaluator | Full HF commit SHA | Locked-suite approval | Isolated evaluator only |
| Candidate to locked evaluator | Transfer ID, experiment ID, and exact three-file hashes | Human-reviewed one-way transfer authorization | Fresh isolated, read-only evaluator input |
| Locked aggregate to release review | Evaluator run ID, candidate hashes, and restricted-evidence hashes | Locked-evaluation approval | Sanitized release evidence only |
| Candidate adapter to model repo | Full source/data/model provenance and hashes | Release attestation | Adapter-only HF commit |
| Adapter to serving | Full approved HF commit SHA | Serving approval | Pinned runtime revision |

Tags may aid discovery, but they are never the authoritative identity. Tags
must not be moved or reused after approval.

## Prompt and runtime authority

- `prompts/dime_system_v1.md` is the versioned training behavior contract.
- `prompts/llama3_dime_chat_template_v1.jinja` is the versioned chat-template
  contract.
- `tools/tools.v1.json` is the versioned tool catalog.
- `server/_core/dime1Model.ts` is a frozen runtime integration scaffold.

The runtime and training prompts are not asserted to be identical. A later,
owner-authorized promotion pull request must reconcile and hash the approved
runtime prompt against the canonical training prompt before activation.

## Change control

Changing a repository ID, credential boundary, workspace root, base-model
revision, release file contract, or platform owner requires:

1. a focused pull request;
2. an explicit migration and rollback plan;
3. updated contract tests and documentation;
4. verification that no secret or protected data crossed the old boundary;
5. revalidation of affected fine-grained token permissions; and
6. owner approval before any external mutation.
