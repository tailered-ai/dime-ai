# Dime AI Data Governance

## Default rules

- The sample files are synthetic fixtures only.
- This GitHub repository is public. A branch or draft pull request is already
  publication.
- “Approved for training” is not the same as approved for public publication.
- Only redistribution-cleared, synthetic or properly de-identified,
  identifier-free material with recorded provenance and rights may enter
  GitHub.
- Personalization is off until the user opts in.
- Reusing conversations or Bet Tracker history for training is a separate opt-in
  and is off by default.
- Private user history stays in user-scoped retrieval; it is not placed in model
  weights merely because it is available to the product.
- Every training item needs a stable ID, timestamp, provenance, rights basis,
  privacy state, partition keys, and governed review status.
- Reviewer status and roles come only from the Git-controlled trusted reviewer
  registry. A review ledger may reference stable reviewer IDs; it cannot create
  identities, activate reviewers, or grant roles.
- Public accessibility is not a training, caching, display, or redistribution
  license.
- Raw Bet Tracker exports, chats, private retrieval context, hidden
  evaluations, provider exports, and licensed odds/splits data without public
  redistribution rights never enter GitHub.
- Hashing raw personal identifiers is not de-identification.

## Current Foundation v1 state

`configs/curriculum_v1.yaml` remains `proposed`. No Foundation v1 dataset has
been approved, frozen for release, published to Hugging Face, or authorized for
training. The candidate, review, audit, approval, and freeze contracts are
governance infrastructure only; they do not change the `foundation_only`
platform state, serving, or provider activation.

GitHub holds only the public contracts, templates, synthetic fixtures, tests,
and sanitized evidence. The actual private candidate records, source registry,
review ledger, external reports, and approval record remain outside GitHub in
an authorized private review system. RunPod is a rebuildable processor and may
not be their sole authoritative location.

The trusted authority at `configs/foundation_reviewer_registry.json` uses the
v3 reviewer shape and is still `proposed`. It contains two inactive,
owner-confirmed AI-agent reviewer assignments in distinct independence groups,
with proposed roles covering the required specialist, audit, and dataset-
approval duties. It therefore grants no review, external-audit, specialist, or
dataset-approval authority. Every entry carries an opaque independence group,
a canonical UTC authority period, and an agent profile. An active agent profile
must pin the provider, exact model and revision, runtime, system instructions,
tool contract, inference policy, and receipt-issuer key. Null profile fields
are allowed only while the assignment remains inactive. Quorums count distinct
groups, and materially correlated model or policy lineages count as one group.

The owner has selected `taileredsports/dime-foundation-workbench` as the future
private candidate workbench, pending provisioning and live access
verification. No private record may enter it yet. Human access must use
individual MFA-protected identities. AI agents must use one workload identity
per registered principal. Generic workbench service credentials cannot
establish reviewer identity or sign a decision. Human activation requires a
restricted identity mapping; AI-agent activation requires a fully pinned
immutable profile. Every AI-agent review, audit, and approval must carry the
SHA-256 of its identity-bound decision receipt.

The owner has approved AI agents as an official reviewer principal type and
the two assignments above are the proposed official roster. They are not yet
active: the cryptographic receipt verifier is not implemented, so runtime
validation rejects every active AI-agent entry. Activation requires a later
focused change that implements and validates signature verification; a
64-character digest by itself is not proof of a decision.

Foundation v1 substantive prose is human-authored. Fully synthetic scenarios
and fixtures remain allowed, but `synthetic` cannot relabel AI-authored answers.
AI may assist with spelling, formatting, critique, or checklist validation only
when it contributes no retained substantive prose. A separately registered,
independent AI-agent reviewer may approve the exact candidate bytes; reviewer
authority does not grant authorship or permit AI-drafted training prose.

## Required dataset lineage

Every governed dataset release must record:

- dataset name and immutable version;
- source record IDs and snapshot timestamps;
- source owner and contractual rights;
- whether the record is human-authored, synthetic, or teacher-generated;
- consent basis and deletion obligations where user data is involved;
- deidentification method and direct-identifier scan result;
- event, source, and hashed-user partition keys;
- curriculum skill, interaction, difficulty, risk, and scenario-cluster labels;
- reviewer IDs, approval date, trusted reviewer-registry version, and the
  SHA-256 of the exact Git-controlled registry bytes;
- deduplication, contamination, and quality checks;
- SHA-256 hashes of the final split files;
- visibility and publication classification;
- train and validation record counts;
- provider-derived and user-data declarations;
- the curriculum, tool-catalog, and chat-template hashes;
- partition-leakage and future-data audit results; and
- a deletion-policy identifier plus limitations.

Unknown provenance, license, or required consent is a build failure.

The local admission scanner uses explicit, deterministic patterns for known
credential and direct-identifier forms, including common API-key prefixes and
assignments, private-key PEM blocks, and credential-bearing URIs. It is a
fail-closed first pass for recognized forms, not an exhaustive generic-entropy
secret scanner. Foundation approval additionally requires the independent
`privacy_and_identifiers` audit over the exact candidate bytes; that external
privacy/secret review and its authorized reviewer cannot be replaced by a
passing local pattern scan.

## Splitting

Split by event, source snapshot, conversation, scenario cluster, and user—not
by individual row. No related event, duplicated or near-duplicated passage,
scenario, conversation, or user's records may cross train, validation, locked,
or hidden partitions. Historical evaluations must enforce
`available_at <= as_of_utc`.

The v3 dataset manifest remains the contract for any newly approved public
train/validation files committed to GitHub. It binds the curriculum, tool
catalog, chat template, split hashes and counts, rights, consent, privacy,
partition leakage, future data, semantic deduplication, and evaluation
contamination.

The private Foundation v1 release uses
`schemas/dataset_manifest.v4.schema.json`, not the public v3 contract. Its
version directory has an exact closed-world inventory:

```text
train.jsonl
validation.jsonl
dataset_manifest.json
dataset_card.md
checksums.json
```

The v4 manifest binds the split bytes and the independently reviewed
Foundation evidence: `system_prompt_sha256`,
`foundation_build_config_sha256`, `source_registry_sha256`,
`source_artifacts_sha256`, `review_ledger_sha256`, `candidate_audit_sha256`,
`approval_record_sha256`, and report hashes for
`semantic_deduplication`, `privacy_and_identifiers`, `rights`,
`development_evaluation_contamination`,
`locked_evaluation_contamination`, and `numeric_traceability`. It also binds
the development-evaluation repository and full commit, its manifest and
identity hashes, plus the approved locked-evaluation reference.

The Foundation audit and freeze path binds that exact
`reviewer_registry_sha256` through the candidate audit, every external audit,
the Foundation approval, and the v4 manifest. All ledger and report reviewer
IDs must resolve to active entries with the required roles in that same
registry revision. The proposed registry deliberately cannot satisfy this
gate.

Future full training must bind the SHA-256 of that exact v4
`dataset_manifest.json`, the SHA-256 of `checksums.json`, and the same complete
`foundation_evidence_hashes` mapping into
`authorization.training_candidate`, including the independently reviewed
`reviewer_registry_sha256`. The authorization must also pin the foundation and
development datasets by full 40-character Hugging Face commit SHA and bind the
approved locked-evaluation full revision or structured opaque reference. The
trainer must recompute the snapshot, registry, and evidence bindings and fail
closed on any mismatch. A local path, tag, branch, dataset revision, manifest
hash, or passing audit by itself is not sufficient authorization.

The historical v2 schema remains tracked without semantic changes. It is not
sufficient for new public publication. `scripts/validate_data.py` rejects
non-sample public JSONL unless the exact approved train/validation paths are
bound to a valid v3 `approved-public` manifest.

Approved private foundation data belongs in
`taileredsports/dime-foundation-sft`; visible private development evaluations
belong in `taileredsports/dime-eval-development`; and locked or hidden
release-gate material belongs in the separately restricted
`taileredsports/dime-eval-locked`. None belongs in this public repository. The
training credential is denied access to the locked repository.

Foundation audit and freeze must remotely prove the visible development
evaluation with identity schema
`dime-foundation-development-eval-identity-v2`, an explicit nonempty
`HF_TOKEN`, and the exact private
`taileredsports/dime-eval-development` 40-character commit. The identity binds
`evaluation_manifest.json` and a strictly sorted exhaustive inventory of every
recursive `cases/**/*.jsonl` path, hash, and record count. The verifier
enumerates that live revision, downloads every bound file, and requires local
and remote byte equality. A local subset, tag, branch, cached evidence,
unavailable remote, or privacy/inventory/hash/count mismatch fails closed; no
local fallback is permitted.

Every numeric token in every Foundation assistant message, regardless of task
type, must be enclosed by a reviewed `numeric_assertion` whose `source_path`
resolves to a numeric leaf in a linked successful (`status: "ok"`) tool
result. Literal constants and user, metadata, failed-tool, stale-tool, or
unlinked sources are not admissible. When the source tool is
`calculate_market_math`, the complete returned key inventory and values are
also independently recomputed from the call arguments before the assertion
and displayed value are checked within the configured unit tolerance.

The complete candidate-to-freeze process is defined in
[Foundation v1 dataset workflow](FOUNDATION_V1_DATASET_WORKFLOW.md).

## Retention and deletion

Before production, Dime needs written retention schedules for raw conversations,
retrieval indexes, derived profiles, training candidates, released datasets,
logs, and backups. A deletion or withdrawn-consent workflow must remove the item
from future retrieval and future dataset builds and track which prior immutable
artifacts require retirement or documented exception handling.

## Data quality ladder

1. Synthetic fixtures validate plumbing.
2. Human-authored gold examples establish desired behavior.
3. Rights-cleared historical snapshots add domain coverage.
4. Deidentified, separately consented user examples may add coaching coverage.
5. Hard cases and failures enter a reviewed correction set.

Do not bulk-train raw chats, feed dumps, articles, or Bet Tracker tables.
