# Dime 1.0 Hugging Face registry

This registry defines the private Hugging Face repositories, immutable revision
rules, and least-privilege credentials for Dime 1.0.

The machine-readable authority is
[`configs/platform_contract.json`](../configs/platform_contract.json). This
document explains that contract for operators and reviewers.

## Current registry status

As of the 2026-07-26 infrastructure verification, all four Dime repositories
are private and contain governance cards only.

The current machine-readable platform contract remains `foundation_only` and
sets `authorization.adapter_publication` to `false`. No adapter publication is
authorized until a focused, owner-approved pull request changes that state and
binds the authorization to the exact release-review evidence. A completed
training run or locally edited attestation cannot override this gate.

| Role | Repository | Type | Observed governance head | Approved release |
|---|---|---|---|---|
| Foundation SFT | `taileredsports/dime-foundation-sft` | Dataset | `af9a45fb7835df01585c859c628e1dbc9e372356` | None |
| Development evaluation | `taileredsports/dime-eval-development` | Dataset | `5b75491b4fc3d3b22e270510f7cba767d01ec363` | None |
| Locked evaluation | `taileredsports/dime-eval-locked` | Dataset | `4ad747fd76d3f54b54ef7d3b5ebc36ccbe7fd8d1` | None |
| Promoted adapter | `taileredsports/Llama-3-Dime-1.0` | Model | `298c735fa2b32e3f63b19a1b18c4f4f901933e3e` | None |

These SHAs identify the verified governance-card state. They are not approved
training, evaluation, or serving revisions and must not be substituted for a
future release SHA.

The Foundation v1 curriculum remains `proposed`. The repository now defines a
candidate, independent-review, audit, approval, and freeze layer, but no
approved Foundation snapshot exists. Those local contracts do not upload,
tag, or otherwise mutate Hugging Face and do not authorize training or
serving.

The upstream dependency is:

```text
repository: meta-llama/Llama-3.1-8B
revision:   d04e592bb4f6aa9cfee91e2e20afa771667e1d4b
```

Meta base weights are downloaded from the upstream repository. They are never
copied into a Dime repository.

## Repository contracts

### Foundation SFT

`taileredsports/dime-foundation-sft` stores only approved, frozen foundation
training releases.

Target release layout:

```text
README.md
foundation-v1/
├── train.jsonl
├── validation.jsonl
├── dataset_manifest.json
├── dataset_card.md
└── checksums.json
```

The root `README.md` is the rendered Dataset Card. A version-specific
`dataset_card.md` supplements the root card; it does not replace it.
The five files under `foundation-v1/` are the exact, closed-world release
inventory; no source registry, review ledger, raw audit report, approval
record, candidate shard, cache, or unknown file is published in that
directory.

Before publication, the release must pass provenance, rights, privacy, consent,
de-identification, partition, future-data, semantic-deduplication,
contamination, schema, and checksum review.

Its v4 manifest binds the exact source-registry, aggregate source-artifact,
review-ledger, candidate-audit, approval-record, canonical-system-prompt, and
Foundation build-config SHA-256 values; the six independently reviewed
external audit report hashes; the development-evaluation repository, full
revision, manifest hash, and identity hash; and the approved locked-evaluation
reference. Actual private candidate and evidence artifacts remain outside
public GitHub in an authorized private review system. RunPod must never be
their sole copy.

Future training authorization must repeat those independently reviewed values
under `authorization.training_candidate.foundation_evidence_hashes`, pin the
Foundation and development-evaluation releases by their returned full
40-character commit SHAs, and bind the approved locked-evaluation full
revision or structured opaque reference. The registry commit alone is not
training authority.

See [Foundation v1 dataset workflow](FOUNDATION_V1_DATASET_WORKFLOW.md).

### Development evaluation

`taileredsports/dime-eval-development` stores visible, team-accessible
development and validation evaluations.

It may include:

- development and validation cases;
- rubrics used during iteration;
- expected tool behavior;
- numeric tolerances;
- evaluation manifests; and
- checksums.

Because developers can see this material, it may guide iteration but cannot
serve as the locked release gate.

Foundation candidate audit and freeze accept this repository only through
identity schema `dime-foundation-development-eval-identity-v2`. The identity
must name repository type `dataset`, exact repository
`taileredsports/dime-eval-development`, and an exact lowercase 40-character
commit SHA. It binds `evaluation_manifest.json` plus the strictly path-sorted,
exhaustive inventory of every remote path below `cases/` ending in `.jsonl`,
with per-file hashes and record counts, an aggregate canonical-inventory hash,
and the total case count.

Verification requires an explicit nonempty `HF_TOKEN`. The verifier resolves
the declared commit, proves the repository is private, enumerates the live
inventory, requires root `README.md` and `evaluation_manifest.json`, downloads
the manifest and all declared case files, validates their hashes and records,
and requires byte equality with the local working copy. Authentication,
transport, privacy, revision, inventory, hash, count, schema, or byte failure
stops the workflow. It never substitutes local files, prior evidence, a branch,
or a tag for the remote proof.

### Locked evaluation

`taileredsports/dime-eval-locked` stores the hidden release-gate suite.

It may include:

- locked cases;
- private rubrics;
- expected tool behavior;
- numeric tolerances;
- an evaluation manifest; and
- checksums.

Raw locked content must never appear in:

- GitHub;
- the foundation or development repositories;
- the promoted-adapter repository;
- a training or serving Pod;
- the training network volume;
- a shared Hugging Face cache;
- a developer notebook; or
- a public or general release report.

Only an isolated evaluator can read it. Only non-reconstructable, approved
aggregate results may leave that environment.

The evaluator reads the promoted-adapter repository only to load an existing
champion comparison control. A new candidate is not uploaded there before
locked evaluation. It arrives as exact, hashed bytes through the reviewed
[candidate-to-locked-evaluator handoff](CANDIDATE_EVALUATION_HANDOFF.md).
This avoids both pre-publication leakage and a circular requirement for a
candidate Hugging Face commit that cannot yet exist.

`evaluation_summary.json` is therefore not the evaluator's full report. It is
the sanitized `dime-release-evaluation-summary-v1` export: aggregate counts,
an opaque evaluator run ID, the approved locked-suite reference, hashes that
bind the exact candidate and restricted full report, the evaluator
implementation Git commit and hash, and no case ID, result, rubric, threshold,
answer, prompt, or trace. The full report and human-review record remain in
restricted evaluator storage.

### Promoted adapter

`taileredsports/Llama-3-Dime-1.0` is the adapter-only model registry.

The default revision may contain only a promoted, serving-approved PEFT adapter
release. The executable allowlist is:

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

All files are root-level. Unknown files and nested directories fail closed.
The three tokenizer override files are omitted when the release uses the
pinned base tokenizer unchanged; if any is present, all three are required.
`added_tokens.json` is permitted only with that complete override set.
`adapter_config.json` and `training_manifest.json` must both pin the exact Meta
repository and revision. `checksums.sha256` must bind every other file in the
release.

The sole permitted remote-only metadata file is `.gitattributes`, which
Hugging Face uses for repository and large-file behavior. It is not release
payload, must not be supplied from the local adapter bundle, and is excluded
from `checksums.sha256`. The verified remote inventory at the published commit
must be exactly `.gitattributes` plus the approved payload files above. No
other pre-existing or stale remote file may survive promotion.

`bundle_payload_sha256` in the release attestation is the SHA-256 of the
canonical, sorted filename-to-SHA-256 mapping for all payload files except
`release_attestation.json` and `checksums.sha256`. This avoids a circular hash.
`checksums.sha256` then binds every other payload file, including the completed
attestation.

It must not contain Meta base-model weights, merged full-model weights,
quantized full-model weights, training checkpoints, optimizer state, raw
datasets, locked cases, caches, workspaces, or deployment bundles.

The rehearsal adapter remains:

`REHEARSAL — NOT APPROVED FOR SERVING`

It must not be uploaded to the default revision. A future decision to preserve
rehearsal weights outside RunPod requires a separate private rehearsal
repository or another explicitly non-serving archive with machine-readable
non-release status.

## Fine-grained credential matrix

Credential values are stored in the approved secret manager and injected only
into the environment that needs them. Names may be documented; values must
never be printed, logged, committed, or copied into a manifest.

| Credential | Foundation | Development eval | Locked eval | Adapter | Gated Meta | Write scope |
|---|---:|---:|---:|---:|---:|---|
| `dime-training-read-v1` | Read | Read | Denied | Read | Read | None |
| `dime-serving-read-v1` | Denied | Denied | Denied | Read | Read | None |
| `dime-release-publisher-v1` | Read/write | Read/write | Denied | Read/write | Denied | Foundation, development, adapter |
| `dime-locked-evaluator-read-v1` | Denied | Denied | Read | Read | Read | None |
| `dime-locked-publisher-v1` | Denied | Denied | Read/write | Denied | Denied | Locked only |

Closed-world access is intentional:

- training cannot see locked data and cannot publish;
- serving cannot see any dataset and cannot publish;
- the general publisher cannot see locked data or the gated base model;
- the locked evaluator cannot see foundation or development data; and
- the locked publisher cannot see other datasets, models, or the gated base.

Using `dime-serving-read-v1` for the one pinned post-upload verification does
not grant the publisher additional access. It is injected separately, used
only by the verification client after the write returns a commit SHA, and then
removed. It must never be stored in the release bundle, receipt, training
template, or persistent workspace.

A broad account token is not a substitute for these credentials in automation.
Owner OAuth access is administrative and must not be embedded in a Pod,
serving process, workflow, or script.

## Foundation candidate workbench decision

The owner-selected candidate workbench is the future private dataset
repository `taileredsports/dime-foundation-workbench`. It is intentionally not
part of the approved-release repository matrix yet: its lifecycle state is
`selected_pending_provisioning`, and repository creation, credential
provisioning, live access verification, and private-data admission remain
false.

The planned workbench-only service identities are:

| Credential | Read | Write | Gated public models |
|---|---|---|---|
| `dime-foundation-workbench-read-v1` | Workbench only | None | No |
| `dime-foundation-workbench-write-v1` | Workbench only | Workbench only | No |

These service identities support repository operations only. They cannot
represent a human or AI-agent reviewer, sign a review/audit/approval, access the approved
Foundation or evaluation repositories, read the Meta base, publish an adapter,
or enter training, serving, release, or locked-evaluation environments.

Human authors and reviewers use individual identities with MFA; shared human
credentials are prohibited. Registered AI-agent reviewers use a unique
workload identity bound to one immutable registry profile; shared agent
credentials are prohibited. Before any private data enters the workbench, live
tests must prove both intended workbench access and denial for every training,
serving, general-publisher, locked-evaluator, and locked-publisher credential.
Human identity mappings, pinned AI-agent profiles, and immutable
identity-bound decision receipts must exist before the reviewer registry can
become active.

AI agents are approved as an official reviewer principal type, but the two
proposed assignments remain inactive. The machine-readable contract records
`agent_receipt_verifier_status: not_implemented`; runtime validation rejects
active AI-agent reviewers until a later focused change implements
cryptographic receipt-signature verification.

Before a full run, the training client calls the Hub identity endpoint with
the explicit runtime token and requires access-token name
`dime-training-read-v1` with role `fineGrained`. It then behaviorally proves
the required Foundation, development, and pinned base-model reads plus locked
evaluation denial. The name/role check and effective-access matrix are both
required; neither alone authorizes training.

## Credential placement

| Environment | Permitted credential | Explicitly prohibited |
|---|---|---|
| Training Pod/template | `dime-training-read-v1` | Serving, publisher, locked roles |
| Serving | `dime-serving-read-v1` | Dataset and publisher roles |
| General release workspace | `dime-release-publisher-v1`; `dime-serving-read-v1` only as the transient post-upload verifier | Training and locked roles; serving token after verification |
| Locked evaluator | `dime-locked-evaluator-read-v1` | Training, serving, publisher roles |
| Locked publication workspace | `dime-locked-publisher-v1` | All other roles |

No environment should retain a credential after its purpose ends. A secret is
referenced through the platform secret mechanism rather than entered as a
plain environment-variable value in a template.

## Immutable revision policy

Every approved release is identified by its full lowercase 40-character commit
SHA.

Valid:

```text
repository: taileredsports/dime-foundation-sft
revision:   <full-40-character-hugging-face-commit-sha>
```

Invalid as release authority:

```text
revision: main
revision: latest
revision: foundation-v1.0.0
revision: 12ab34c
```

A tag such as `foundation-v1.0.0`, `eval-v1.0.0`, or `adapter-v1.0.0` is a
human-readable alias only. Tags must never be moved or reused after approval.
Training, evaluation, serving, rollback, and evidence manifests record the
full commit SHA even when they also record a tag.

Corrections create a new commit, new version, new checksums, and new approval.
An approved revision is never silently overwritten.

## Publication workflow

### Foundation or development release

1. Confirm the curriculum and release remain proposals until explicit human
   approval; a successful audit or freeze is not approval.
2. Review the proposed data, manifest, Dataset Card, and checksums. For
   Foundation v1, require the exact five-file version-directory inventory.
3. Verify schema, provenance, rights, privacy, consent, partition,
   deduplication, future-data, and contamination gates. For Foundation v1,
   verify every v4 evidence hash against the independently reviewed source,
   review, audit, approval, development-evaluation, and locked-evaluation
   references.
4. Confirm the destination repository and private visibility.
5. Publish with `dime-release-publisher-v1` from a dedicated release workspace.
6. Capture the returned full 40-character Hugging Face commit SHA.
7. Download and verify the exact inventory and bytes by that SHA using a
   read-only credential.
8. Add a human-readable tag without moving an existing tag.
9. Record the full SHA, counts, hashes, review decision, and durable
   publication receipt in GitHub without copying private records or raw
   private audit material.

The candidate audit and freeze utilities stop before step 5. Publication is a
separate owner-authorized external mutation. Until that mutation succeeds and
its returned SHA is independently verified, the registry continues to show no
approved Foundation release.

### Locked release

Follow the same immutable process in a restricted workspace using
`dime-locked-publisher-v1`. Do not expose case content or private scoring
details in GitHub, pull requests, logs, screenshots, or general manifests.
Verify the result with `dime-locked-evaluator-read-v1`.

### Adapter release

1. Complete every release gate in `RELEASE_GATES.md`.
2. Confirm the immutable training manifest is `completed_unreviewed` and the
   separate, reviewer-owned experiment decision is
   `approved_for_release_review`.
3. Change `authorization.adapter_publication` from `false` to `true` only in a
   focused, owner-approved platform-contract pull request. Populate
   `authorization.release_candidate` with the exact experiment, training
   source and training-authorization commits, training-contract hash,
   adapter/config/manifest/evaluation hashes, canonical bundle-payload hash,
   locked-suite manifest hash and expected-case count, immutable
   comparison-control kind, repository, revision, and artifact hash,
   comparison-report hash, quality-slice-report hash, and expected Hugging Face
   parent SHA. A global Boolean is insufficient.
4. Preserve
   `hugging_face.repositories.promoted_adapter.approved_release_revision`
   during authorization. It is `null` only before the inaugural adapter
   release. When it is `null`, evaluation must use the pinned Meta base
   control. After a champion exists, the field remains that champion's full
   Hugging Face commit SHA, the evaluation control must be that exact promoted
   adapter revision, and `expected_parent_commit` must equal it. A later
   candidate may never reset the field to `null` to compare against the easier
   base control. The publisher runs from the exact authorization commit,
   requires that commit's whole-repository diff against its first parent to be
   exactly one modification to `ml/dime-1.0/configs/platform_contract.json`,
   loads the parent contract from Git, and rejects any change to the recorded
   champion revision.
5. Bind the adapter to the exact Git source, foundation dataset revision plus
   dataset/checksum manifests, development evaluation, locked evaluation
   reference plus suite manifest and expected-case count, Meta revision,
   experiment and evaluator run IDs, prompt, template, tool contract, schemas,
   config, decoding, runtime, bundle, model, and evaluation hashes.
6. Complete the Model Card, aggregate evaluation summary, and release
   attestation. The attestation must set `release_review_status` to
   `approved_for_release_review`,
   `private_registry_publication_approved` to `true`, and
   `approved_for_serving` to `true`. Private registry approval never
   authorizes changing repository visibility.
7. Verify the local adapter-only allowlist, checksums, and absence of base or
   full-model weights.
8. Read the destination immediately before publication and record its full
   40-character commit SHA as `expected_parent_commit`.
9. Preflight the exact publication-receipt path with an exclusive durable
   create, sync, remove, and directory sync before any Hugging Face mutation.
10. Publish with `dime-release-publisher-v1` from a dedicated release workspace,
   never from the training Pod, using the expected parent SHA as an optimistic
   concurrency guard. Any parent mismatch aborts publication.
11. Capture the full 40-character commit SHA returned by Hugging Face. Do not
   infer it from a tag, branch, URL, or local content.
12. Using a separate read-only credential, inspect that exact returned
   revision, require the exact remote inventory, download the payload, and
   verify every post-upload hash against `checksums.sha256`.
13. Atomically write and sync the publication receipt, record it in governed
    evidence, and only then add a human-readable tag without moving an
    existing tag. If receipt persistence unexpectedly fails after upload, use
    the returned SHA for explicit recovery review and do not republish.
14. Record the approved SHA, receipt hash, and rollback SHA in the serving
    promotion pull request.

The executable publisher requires two separately injected secrets:

- `HF_TOKEN`: `dime-release-publisher-v1`, used only for the guarded write; and
- `HF_VERIFY_TOKEN`: `dime-serving-read-v1`, used only for the pinned,
  post-upload read verification.

They must be distinct values, must not be printed, and must be removed from the
release workspace after verification. With an owner-authorized platform
contract and a fully reviewed bundle, the command shape is below. The script
always loads `configs/platform_contract.json` from its own reviewed, clean Git
checkout; callers cannot supply a replacement contract path.

```bash
python scripts/publish_adapter.py \
  --adapter-dir "/workspace/runs/<experiment-id>/release-bundle" \
  --repo-id taileredsports/Llama-3-Dime-1.0 \
  --confirm-repo taileredsports/Llama-3-Dime-1.0 \
  --expected-parent-commit "<FULL_40_CHARACTER_CURRENT_MAIN_SHA>" \
  --evaluation-report "/workspace/runs/<experiment-id>/release-bundle/evaluation_summary.json" \
  --release-attestation "/workspace/runs/<experiment-id>/release-bundle/release_attestation.json" \
  --receipt "/workspace/runs/<experiment-id>/reports/hf-publication-receipt.json" \
  --private
```

The current `foundation_only` contract deliberately rejects this command
before any API mutation. Do not change that state merely to test the publisher;
the authorization change belongs in a candidate-specific, owner-approved pull
request after training and evaluation.

### Adapter publication receipt

The receipt is created after upload and is not part of the commit it verifies.
It must contain:

- schema version and publication timestamp;
- canonical repository ID and private visibility;
- full expected parent commit SHA;
- full returned commit SHA;
- publisher workflow or tool version;
- exact remote file inventory, with `.gitattributes` classified as permitted
  remote metadata rather than payload;
- verified post-upload SHA-256 for every payload file;
- SHA-256 of the downloaded `checksums.sha256`;
- release-attestation SHA-256;
- confirmation that the verifier value differed from the publisher value,
  with scope identity explicitly recorded as not introspected by the client;
- verification result; and
- tag and rollback commit, if assigned.

The client cannot prove the Hugging Face token's fine-grained token name or
scope. The separately preserved token-isolation audit establishes that
`HF_VERIFY_TOKEN` is provisioned from `dime-serving-read-v1`; the receipt does
not make an unverified credential-role claim.

The receipt must contain no credential value, raw locked case, private rubric,
or case-level evaluation result. A failed inventory, hash, parent, visibility,
or revision check blocks tagging and serving.

## Verification policy

The live least-privilege checks performed during initial setup established the
matrix above:

- training could read foundation, development, adapter, and gated Meta, and was
  denied locked evaluation;
- serving could read adapter and gated Meta, and was denied all datasets;
- the general publisher could access foundation, development, and adapter, and
  was denied locked evaluation and gated Meta;
- the locked evaluator could read locked evaluation, adapter, and gated Meta,
  and was denied foundation and development; its adapter access is for the
  current promoted champion control, not candidate transport; and
- the locked publisher could access locked evaluation and was denied all other
  Dime repositories and gated Meta.

These checks prove the observed setup at that point in time. Repository-local
tests validate the declared policy without making network calls; they cannot
prove current external permissions. Re-run live access checks after any token,
repository, visibility, organization, or ownership change.

An access denial from a private Hugging Face repository may appear as `401`,
`403`, or privacy-preserving `404`/“Repository not found.” A denial is expected
only when the same command succeeds under the authorized credential and the
repository's existence is independently known.

## Registry change procedure

Changing a repository ID, type, visibility, token scope, release file contract,
or observed governance head requires:

1. an owner-authorized external change;
2. live positive and negative permission tests;
3. an update to `configs/platform_contract.json`;
4. an update to this registry and affected runbooks;
5. repository contract tests;
6. secret rotation when scope changed; and
7. a focused GitHub pull request with no secret values.
