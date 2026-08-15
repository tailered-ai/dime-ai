from __future__ import annotations

import hashlib
import importlib.util
import inspect
import json
import os
import sys
from copy import deepcopy
from dataclasses import replace
from datetime import UTC, datetime
from pathlib import Path
from types import ModuleType, SimpleNamespace
from typing import Any

import pytest

import dime_ai.foundation_dataset as foundation_dataset
from dime_ai.foundation_dataset import (
    EXTERNAL_AUDIT_FILES,
    EXTERNAL_AUDIT_REVIEWER_ROLES,
    FoundationAuditResult,
    FoundationDatasetError,
    _development_contamination,
    _load_external_audits,
    canonical_record_sha256,
    freeze_foundation_snapshot,
    validate_numeric_traceability,
    validate_review_ledger,
    validate_source_registry,
)
from dime_ai.hf_provenance import (
    DEVELOPMENT_EVAL_MANIFEST_PATH,
    DEVELOPMENT_EVAL_REPO_ID,
    RemoteDevelopmentEvalSnapshot,
    VerifiedDevelopmentEvaluation,
    case_inventory_sha256,
)
from dime_ai.market_math import american_to_implied_probability

HASH_A = "a" * 64
HASH_B = "b" * 64
REVISION = "1" * 40
LOCKED_REFERENCE = "locked-eval-suite:foundation-v1"
CUTOFF = datetime(2026, 1, 5, tzinfo=UTC)


def _load_audit_script() -> ModuleType:
    script_path = Path(__file__).resolve().parents[1] / "scripts/audit_foundation_candidates.py"
    spec = importlib.util.spec_from_file_location(
        "dime_audit_foundation_candidates_test",
        script_path,
    )
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


audit_script = _load_audit_script()


def _sha256(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def test_foundation_schema_errors_do_not_reflect_untrusted_content() -> None:
    marker = "UNTRUSTED_FOUNDATION_SCHEMA_MARKER"
    with pytest.raises(FoundationDatasetError) as captured:
        foundation_dataset._validate_schema(
            {"schema_version": marker},
            "foundation_candidate_audit.schema.json",
            "foundation candidate audit",
        )
    message = str(captured.value)
    assert marker not in message
    assert "foundation candidate audit" in message
    assert "validation" in message


def _write_json(path: Path, value: dict[str, Any]) -> None:
    path.write_text(
        json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True),
        encoding="utf-8",
    )


def test_foundation_timestamps_require_canonical_z_suffix() -> None:
    assert foundation_dataset._parse_utc(
        "2026-07-25T12:00:00Z",
        "timestamp",
    ) == datetime(2026, 7, 25, 12, 0, tzinfo=UTC)

    with pytest.raises(FoundationDatasetError, match="ending in Z"):
        foundation_dataset._parse_utc(
            "2026-07-25T12:00:00+00:00",
            "timestamp",
        )


def _source_fixture(tmp_path: Path) -> tuple[Path, dict[str, Any], dict[str, Any]]:
    artifact_root = tmp_path / "source-artifacts"
    artifact_root.mkdir()
    snapshot = artifact_root / "source.txt"
    snapshot.write_bytes(b"approved immutable source\n")
    registry = {
        "schema_version": "dime-foundation-source-registry-v1",
        "dataset_version": "dime-sft-foundation-v1",
        "generated_at_utc": "2026-01-04T00:00:00Z",
        "sources": [
            {
                "source_id": "source-approved-001",
                "source_class": "synthetic",
                "source_owner": "Dime",
                "snapshot_id": "snapshot-approved-001",
                "snapshot_sha256": _sha256(snapshot.read_bytes()),
                "snapshot_file": "source.txt",
                "snapshot_at_utc": "2026-01-02T00:00:00Z",
                "available_at_utc": "2026-01-01T00:00:00Z",
                "rights_record_id": "rights-approved-001",
                "ml_training_permitted": True,
                "derivative_use_permitted": True,
                "public_redistribution_permitted": False,
                "contains_user_data": False,
                "contains_provider_derived_data": False,
                "restrictions": "Private Foundation training only.",
                "expires_at_utc": "2026-01-06T00:00:00Z",
                "reviewer_ids": ["rights-reviewer-001"],
                "reviewed_at_utc": "2026-01-03T00:00:00Z",
            }
        ],
    }
    config = {"source_policy": {"allowed_source_classes": ["synthetic"]}}
    return artifact_root, registry, config


def test_source_registry_binds_snapshot_bytes_and_exact_inventory(tmp_path: Path) -> None:
    artifact_root, registry, config = _source_fixture(tmp_path)
    source_index, artifact_hash = validate_source_registry(
        registry,
        config,
        effective_at=CUTOFF,
        source_artifact_root=artifact_root,
    )

    assert set(source_index) == {"source-approved-001"}
    assert len(artifact_hash) == 64

    (artifact_root / "source.txt").write_bytes(b"mutated source\n")
    with pytest.raises(FoundationDatasetError, match="snapshot bytes"):
        validate_source_registry(
            registry,
            config,
            effective_at=CUTOFF,
            source_artifact_root=artifact_root,
        )


def test_source_registry_rejects_unregistered_artifacts(tmp_path: Path) -> None:
    artifact_root, registry, config = _source_fixture(tmp_path)
    (artifact_root / "unregistered.txt").write_text("not inventoried", encoding="utf-8")

    with pytest.raises(FoundationDatasetError, match="inventory mismatch"):
        validate_source_registry(
            registry,
            config,
            effective_at=CUTOFF,
            source_artifact_root=artifact_root,
        )


def test_source_registry_rejects_symlinks(tmp_path: Path) -> None:
    artifact_root, registry, config = _source_fixture(tmp_path)
    (artifact_root / "linked.txt").symlink_to(artifact_root / "source.txt")

    with pytest.raises(FoundationDatasetError, match="contains a symlink"):
        validate_source_registry(
            registry,
            config,
            effective_at=CUTOFF,
            source_artifact_root=artifact_root,
        )


@pytest.mark.parametrize(
    ("target", "field", "value", "message"),
    [
        ("source", "available_at_utc", "2026-01-03T00:00:00Z", "cannot follow"),
        ("source", "snapshot_at_utc", "2026-01-06T00:00:00Z", "after the audit cutoff"),
        ("source", "reviewed_at_utc", "2026-01-01T00:00:00Z", "predates"),
        ("source", "reviewed_at_utc", "2026-01-06T00:00:00Z", "after the audit cutoff"),
        ("registry", "generated_at_utc", "2026-01-02T00:00:00Z", "predates its rights review"),
        ("source", "expires_at_utc", "2026-01-05T00:00:00Z", "rights have expired"),
        ("source", "reviewed_at_utc", "not-a-date", "not a valid timestamp"),
    ],
)
def test_source_registry_rejects_invalid_time_order_and_format(
    tmp_path: Path,
    target: str,
    field: str,
    value: str,
    message: str,
) -> None:
    artifact_root, registry, config = _source_fixture(tmp_path)
    if target == "registry":
        registry[field] = value
    else:
        registry["sources"][0][field] = value

    with pytest.raises(FoundationDatasetError, match=message):
        validate_source_registry(
            registry,
            config,
            effective_at=CUTOFF,
            source_artifact_root=artifact_root,
        )


def test_development_contamination_compares_user_prompt_windows() -> None:
    prompt = "Analyze the exact market setup without inventing live odds."
    candidate = {
        "example_id": "candidate-001",
        "messages": [
            {"role": "user", "content": prompt},
            {"role": "assistant", "content": "A distinct answer."},
        ],
    }
    evaluation = {
        "case_id": "dev-case-001",
        "messages": [{"role": "user", "content": prompt}],
    }

    matches = _development_contamination(
        [candidate],
        [evaluation],
        shingle_size=3,
        threshold=0.8,
    )

    assert matches == [
        {
            "example_id": "candidate-001",
            "evaluation_case_id": "dev-case-001",
            "exact_prompt_copy": True,
            "similarity": 1.0,
        }
    ]

    candidate["messages"][0]["content"] = "A genuinely unrelated user request."
    candidate["messages"][1]["content"] = prompt
    assert (
        _development_contamination(
            [candidate],
            [evaluation],
            shingle_size=3,
            threshold=0.8,
        )
        == []
    )


def _numeric_config() -> dict[str, Any]:
    return {
        "record_policy": {
            "numeric_tolerance_maximums": {
                "probability": 1e-9,
                "roi": 1e-9,
                "decimal_odds": 1e-9,
                "units": 1e-6,
                "count": 0,
            }
        }
    }


def _numeric_record() -> dict[str, Any]:
    expected = american_to_implied_probability(-110)
    formatted = str(expected)
    claim = f"The implied probability is {formatted}."
    return {
        "example_id": "market-math-001",
        "task_type": "market_math",
        "messages": [
            {"role": "user", "content": "What is the implied probability at -110?"},
            {
                "role": "assistant",
                "content": "",
                "tool_calls": [
                    {
                        "id": "call-1",
                        "type": "function",
                        "function": {
                            "name": "calculate_market_math",
                            "arguments": {
                                "operation": "implied_probability",
                                "inputs": {"american_odds": -110},
                            },
                        },
                    }
                ],
            },
            {
                "role": "tool",
                "name": "calculate_market_math",
                "tool_call_id": "call-1",
                "content": json.dumps(
                    {
                        "status": "ok",
                        "data": {
                            "operation": "implied_probability",
                            "formula_version": "dime-market-math-v1",
                            "normalized_inputs": {"american_odds": -110},
                            "output": {"implied_probability": formatted},
                        },
                    },
                    separators=(",", ":"),
                ),
            },
            {"role": "assistant", "content": claim},
        ],
        "numeric_assertions": [
            {
                "source_path": "tool:call-1:data.output.implied_probability",
                "value": formatted,
                "unit": "probability",
                "comparator": "exact",
                "tolerance": 0,
                "assistant_message_index": 3,
                "claim_text": claim,
                "formatted_value": formatted,
            }
        ],
    }


def test_numeric_traceability_accepts_recomputed_and_bound_claim() -> None:
    validate_numeric_traceability(_numeric_record(), _numeric_config())


def test_numeric_traceability_rejects_extra_tool_result_keys() -> None:
    record = _numeric_record()
    result = json.loads(record["messages"][2]["content"])
    result["data"]["output"]["unreviewed_metric"] = "1"
    record["messages"][2]["content"] = json.dumps(result)

    with pytest.raises(FoundationDatasetError, match="key inventory mismatch"):
        validate_numeric_traceability(record, _numeric_config())


def test_numeric_traceability_rejects_unsupported_assertions() -> None:
    record = _numeric_record()
    extra = deepcopy(record["numeric_assertions"][0])
    extra["source_path"] = "tool:call-1:data.output.unreviewed_metric"
    record["numeric_assertions"].append(extra)

    with pytest.raises(FoundationDatasetError, match="unsupported paths"):
        validate_numeric_traceability(record, _numeric_config())


def test_numeric_traceability_enforces_tolerance_ceiling() -> None:
    record = _numeric_record()
    record["numeric_assertions"][0]["comparator"] = "approximate"
    record["numeric_assertions"][0]["tolerance"] = 1e-8

    with pytest.raises(FoundationDatasetError, match="exceeds the probability"):
        validate_numeric_traceability(record, _numeric_config())


def test_numeric_traceability_binds_every_assistant_numeric_token() -> None:
    record = _numeric_record()
    record["messages"][3]["content"] += " This is confidence tier 2."

    with pytest.raises(FoundationDatasetError, match="outside every reviewed numeric claim"):
        validate_numeric_traceability(record, _numeric_config())


def test_numeric_assertion_covers_only_its_formatted_numeric_token() -> None:
    record = _numeric_record()
    claim = f"{record['messages'][3]['content']} This used 2 verified books."
    record["messages"][3]["content"] = claim
    record["numeric_assertions"][0]["claim_text"] = claim

    with pytest.raises(
        FoundationDatasetError,
        match=r"numeric token is outside every reviewed numeric claim",
    ):
        validate_numeric_traceability(record, _numeric_config())


def test_numeric_assertion_requires_unambiguous_formatted_value() -> None:
    record = _numeric_record()
    formatted = record["numeric_assertions"][0]["formatted_value"]
    claim = f"The two reported values are {formatted} and {formatted}."
    record["messages"][3]["content"] = claim
    record["numeric_assertions"][0]["claim_text"] = claim

    with pytest.raises(
        FoundationDatasetError,
        match="formatted_value must occur exactly once",
    ):
        validate_numeric_traceability(record, _numeric_config())


def test_numeric_traceability_uses_strict_json_tool_results() -> None:
    record = _numeric_record()
    expected = str(american_to_implied_probability(-110))
    record["messages"][2]["content"] = (
        f'{{"status":"ok","status":"ok","data":{{"implied_probability":"{expected}"}}}}'
    )

    with pytest.raises(FoundationDatasetError):
        validate_numeric_traceability(record, _numeric_config())


def test_numeric_traceability_accepts_non_market_tool_numeric_evidence() -> None:
    claim = "The verified tracker sample contains 12 bets."
    record = {
        "example_id": "tracker-numeric-001",
        "task_type": "bet_tracker_coaching",
        "messages": [
            {"role": "user", "content": "How large is the verified sample?"},
            {
                "role": "assistant",
                "content": "",
                "tool_calls": [
                    {
                        "id": "call-history",
                        "type": "function",
                        "function": {
                            "name": "get_user_betting_history",
                            "arguments": {},
                        },
                    }
                ],
            },
            {
                "role": "tool",
                "name": "get_user_betting_history",
                "tool_call_id": "call-history",
                "content": '{"status":"ok","data":{"sample_size":12,"label":"verified"}}',
            },
            {"role": "assistant", "content": claim},
        ],
        "numeric_assertions": [
            {
                "source_path": "tool:call-history:data.sample_size",
                "value": 12,
                "unit": "count",
                "comparator": "exact",
                "tolerance": 0,
                "assistant_message_index": 3,
                "claim_text": claim,
                "formatted_value": "12",
            }
        ],
    }

    validate_numeric_traceability(record, _numeric_config())


def test_numeric_traceability_rejects_unbound_number_outside_market_math() -> None:
    record = {
        "example_id": "conversation-numeric-001",
        "task_type": "conversation",
        "messages": [
            {"role": "user", "content": "How confident are you?"},
            {"role": "assistant", "content": "I am 99% confident."},
        ],
        "numeric_assertions": [],
    }

    with pytest.raises(FoundationDatasetError, match="outside every reviewed numeric claim"):
        validate_numeric_traceability(record, _numeric_config())


def test_numeric_traceability_rejects_literal_not_grounded_in_tool_output() -> None:
    record = {
        "example_id": "literal-numeric-001",
        "task_type": "conversation",
        "messages": [
            {"role": "user", "content": "Give the answer."},
            {"role": "assistant", "content": "The answer is 12."},
        ],
        "numeric_assertions": [
            {
                "source_path": "literal:12",
                "value": 12,
                "unit": "count",
                "comparator": "exact",
                "tolerance": 0,
                "assistant_message_index": 1,
                "claim_text": "The answer is 12.",
                "formatted_value": "12",
            }
        ],
    }

    with pytest.raises(FoundationDatasetError, match="unsupported paths"):
        validate_numeric_traceability(record, _numeric_config())


def _review_fixture() -> tuple[
    dict[str, Any],
    dict[str, Any],
    dict[str, dict[str, Any]],
    dict[str, Any],
    str,
]:
    rubric_sha = "c" * 64
    record = {
        "example_id": "conversation-001",
        "task_type": "conversation",
        "messages": [
            {"role": "user", "content": "Give a careful general answer."},
            {"role": "assistant", "content": "Here is a careful answer."},
        ],
        "curriculum": {
            "risk_tier": "standard",
            "policy_action": "allow",
        },
        "metadata": {
            "author_id": "author-001",
            "available_at_utc": "2026-01-01T00:00:00Z",
        },
        "quality": {
            "reviewer_ids": ["domain-reviewer-001"],
            "reviewed_at_utc": "2026-01-03T00:00:00Z",
        },
    }
    ledger = {
        "schema_version": "dime-foundation-review-ledger-v1",
        "dataset_version": "dime-sft-foundation-v1",
        "rubric": {"rubric_id": "dime-answer-v1", "sha256": rubric_sha},
        "decisions": [
            {
                "example_id": record["example_id"],
                "record_sha256": canonical_record_sha256(record),
                "reviewer_id": "domain-reviewer-001",
                "decision": "approve",
                "reviewed_at_utc": "2026-01-03T00:00:00Z",
                "rubric_sha256": rubric_sha,
                "content_quality_passed": True,
                "grounding_passed": True,
                "numeric_trace_passed": True,
                "policy_behavior_passed": True,
                "privacy_passed": True,
                "rights_passed": True,
                "findings": [],
            }
        ],
    }
    config = {
        "review_policy": {
            "elevated_task_families": [],
            "elevated_policy_actions": [],
            "required_specialist_roles": {},
            "standard_reviewer_minimum": 1,
            "elevated_reviewer_minimum": 2,
        }
    }
    reviewer_index = {
        "domain-reviewer-001": {
            "reviewer_id": "domain-reviewer-001",
            "roles": ["domain"],
            "active": True,
            "independence_group_id": "dime-independence-group-domain-001",
            "effective_start": "2025-01-01T00:00:00Z",
            "effective_end_or_open_ended": None,
        }
    }
    return record, ledger, reviewer_index, config, rubric_sha


def _active_agent_profile(suffix: str) -> dict[str, Any]:
    return {
        "profile_id": f"dime-agent-profile-{suffix}",
        "status": "active",
        "model_provider": "provider-001",
        "model_id": "model-001",
        "model_revision": "model-snapshot-2026-07-27",
        "runtime_version": "review-runtime-1.0.0",
        "system_instruction_sha256": "1" * 64,
        "tool_contract_sha256": "2" * 64,
        "inference_policy_sha256": "3" * 64,
        "receipt_issuer_key_id": f"key-{hashlib.sha256(suffix.encode()).hexdigest()[:32]}",
    }


def test_review_ledger_binds_approval_to_exact_record_content() -> None:
    record, ledger, reviewer_index, config, rubric_sha = _review_fixture()
    validate_review_ledger(
        [record],
        ledger,
        reviewer_index,
        config,
        rubric_sha,
        effective_at=CUTOFF,
    )

    record["messages"][1]["content"] = "Content changed after review."
    with pytest.raises(FoundationDatasetError, match="unknown record hash"):
        validate_review_ledger(
            [record],
            ledger,
            reviewer_index,
            config,
            rubric_sha,
            effective_at=CUTOFF,
        )


def test_ai_agent_review_requires_identity_bound_receipt_digest() -> None:
    record, ledger, reviewer_index, config, rubric_sha = _review_fixture()
    reviewer_index["domain-reviewer-001"]["principal_type"] = "ai_agent"

    with pytest.raises(FoundationDatasetError, match="receipt IDs"):
        validate_review_ledger(
            [record],
            ledger,
            reviewer_index,
            config,
            rubric_sha,
            effective_at=CUTOFF,
        )

    ledger["decisions"][0]["agent_decision_receipt_sha256"] = "d" * 64
    validate_review_ledger(
        [record],
        ledger,
        reviewer_index,
        config,
        rubric_sha,
        effective_at=CUTOFF,
    )


def test_review_ledger_rejects_unknown_record_decision() -> None:
    record, ledger, reviewer_index, config, rubric_sha = _review_fixture()
    ledger["decisions"][0]["record_sha256"] = HASH_B

    with pytest.raises(FoundationDatasetError, match="unknown record hash"):
        validate_review_ledger(
            [record],
            ledger,
            reviewer_index,
            config,
            rubric_sha,
            effective_at=CUTOFF,
        )


def test_captured_jsonl_rejects_one_blank_shard_among_valid_shards(
    tmp_path: Path,
) -> None:
    valid = tmp_path / "valid.jsonl"
    blank = tmp_path / "blank.jsonl"
    valid.write_text('{"example_id":"valid-001"}\n', encoding="utf-8")
    blank.write_text("\n \n", encoding="utf-8")
    captured = foundation_dataset._capture_inputs([valid, blank], "test shard")

    with pytest.raises(FoundationDatasetError, match="blank.jsonl: file has no records"):
        foundation_dataset._captured_jsonl_records(
            captured,
            [valid, blank],
            "train",
        )


def test_review_ledger_rejects_review_before_source_availability() -> None:
    record, ledger, reviewer_index, config, rubric_sha = _review_fixture()
    ledger["decisions"][0]["reviewed_at_utc"] = "2025-12-31T00:00:00Z"
    record["quality"]["reviewed_at_utc"] = "2025-12-31T00:00:00Z"
    ledger["decisions"][0]["record_sha256"] = canonical_record_sha256(record)

    with pytest.raises(FoundationDatasetError, match="predates the record"):
        validate_review_ledger(
            [record],
            ledger,
            reviewer_index,
            config,
            rubric_sha,
            effective_at=CUTOFF,
        )


def test_review_ledger_rejects_decision_after_audit_cutoff() -> None:
    record, ledger, reviewer_index, config, rubric_sha = _review_fixture()
    ledger["decisions"][0]["reviewed_at_utc"] = "2026-01-06T00:00:00Z"

    with pytest.raises(FoundationDatasetError, match="after the audit cutoff"):
        validate_review_ledger(
            [record],
            ledger,
            reviewer_index,
            config,
            rubric_sha,
            effective_at=CUTOFF,
        )


def test_review_ledger_rejects_decision_before_reviewer_authority_start() -> None:
    record, ledger, reviewer_index, config, rubric_sha = _review_fixture()
    reviewer_index["domain-reviewer-001"]["effective_start"] = "2026-01-04T00:00:00Z"

    with pytest.raises(FoundationDatasetError, match="outside.*authority period"):
        validate_review_ledger(
            [record],
            ledger,
            reviewer_index,
            config,
            rubric_sha,
            effective_at=CUTOFF,
        )


def test_review_ledger_treats_authority_end_as_exclusive() -> None:
    record, ledger, reviewer_index, config, rubric_sha = _review_fixture()
    reviewer_index["domain-reviewer-001"]["effective_end_or_open_ended"] = "2026-01-03T00:00:00Z"

    with pytest.raises(FoundationDatasetError, match="outside.*authority period"):
        validate_review_ledger(
            [record],
            ledger,
            reviewer_index,
            config,
            rubric_sha,
            effective_at=CUTOFF,
        )


def test_elevated_review_requires_distinct_independence_groups() -> None:
    record, ledger, reviewer_index, config, rubric_sha = _review_fixture()
    record["curriculum"]["risk_tier"] = "high"
    record["quality"]["reviewer_ids"] = ["domain-reviewer-001", "domain-reviewer-002"]
    record_hash = canonical_record_sha256(record)
    ledger["decisions"][0]["record_sha256"] = record_hash
    second = deepcopy(ledger["decisions"][0])
    second["reviewer_id"] = "domain-reviewer-002"
    ledger["decisions"].append(second)
    reviewer_index["domain-reviewer-002"] = {
        "reviewer_id": "domain-reviewer-002",
        "roles": ["domain"],
        "active": True,
        "independence_group_id": "dime-independence-group-domain-001",
        "effective_start": "2026-01-01T00:00:00Z",
        "effective_end_or_open_ended": None,
    }

    with pytest.raises(FoundationDatasetError, match="independence groups"):
        validate_review_ledger(
            [record],
            ledger,
            reviewer_index,
            config,
            rubric_sha,
            effective_at=CUTOFF,
        )


def test_trusted_reviewer_registry_rejects_nonpositive_authority_period() -> None:
    reviewer = {
        "reviewer_id": "dime-reviewer-domain-001",
        "principal_type": "human",
        "roles": ["domain"],
        "active": True,
        "independence_group_id": "dime-independence-group-domain-001",
        "effective_start": "2026-01-03T00:00:00Z",
        "effective_end_or_open_ended": "2026-01-03T00:00:00Z",
    }
    registry = {
        "schema_version": "dime-foundation-reviewer-registry-v3",
        "registry_version": "dime-foundation-reviewers-v0.4.0",
        "status": "active",
        "reviewers": [reviewer],
    }

    with pytest.raises(FoundationDatasetError, match="end must be later"):
        foundation_dataset.trusted_reviewer_index(registry)


def test_trusted_reviewer_registry_blocks_agent_activation_until_receipts_are_verified() -> None:
    reviewer = {
        "reviewer_id": "dime-reviewer-c794ca4d-001",
        "principal_type": "ai_agent",
        "active": True,
        "agent_profile": _active_agent_profile("agent-001"),
        "roles": ["domain"],
        "independence_group_id": "dime-independence-group-c794ca4d-001",
        "effective_start": "2026-01-01T00:00:00Z",
        "effective_end_or_open_ended": None,
    }
    registry = {
        "schema_version": "dime-foundation-reviewer-registry-v3",
        "registry_version": "dime-foundation-reviewers-v0.4.0",
        "status": "active",
        "reviewers": [reviewer],
    }

    with pytest.raises(FoundationDatasetError, match="cryptographic.*verifier"):
        foundation_dataset.trusted_reviewer_index(registry)


def test_dataset_approval_requires_distinct_groups_and_non_author_approvers() -> None:
    reviewers = {
        "dime-reviewer-approver-001": {
            "reviewer_id": "dime-reviewer-approver-001",
            "roles": ["dataset-approver"],
            "active": True,
            "independence_group_id": "dime-independence-group-approver-001",
            "effective_start": "2026-01-01T00:00:00Z",
            "effective_end_or_open_ended": None,
        },
        "dime-reviewer-approver-002": {
            "reviewer_id": "dime-reviewer-approver-002",
            "roles": ["dataset-approver"],
            "active": True,
            "independence_group_id": "dime-independence-group-approver-001",
            "effective_start": "2026-01-01T00:00:00Z",
            "effective_end_or_open_ended": None,
        },
    }
    approver_ids = list(reviewers)

    with pytest.raises(FoundationDatasetError, match="independence groups"):
        foundation_dataset._validate_dataset_approver_authority(
            approver_ids,
            reviewers,
            approval_time=datetime(2026, 1, 4, tzinfo=UTC),
            candidate_author_ids=set(),
        )

    reviewers["dime-reviewer-approver-002"]["independence_group_id"] = (
        "dime-independence-group-approver-002"
    )
    with pytest.raises(FoundationDatasetError, match="candidate author"):
        foundation_dataset._validate_dataset_approver_authority(
            approver_ids,
            reviewers,
            approval_time=datetime(2026, 1, 4, tzinfo=UTC),
            candidate_author_ids={"dime-reviewer-approver-001"},
        )


def test_ai_agent_dataset_approvers_require_exact_receipt_map() -> None:
    reviewers = {
        "dime-reviewer-approver-001": {
            "reviewer_id": "dime-reviewer-approver-001",
            "principal_type": "ai_agent",
            "roles": ["dataset-approver"],
            "active": True,
            "independence_group_id": "dime-independence-group-approver-001",
            "effective_start": "2026-01-01T00:00:00Z",
            "effective_end_or_open_ended": None,
        },
        "dime-reviewer-approver-002": {
            "reviewer_id": "dime-reviewer-approver-002",
            "principal_type": "ai_agent",
            "roles": ["dataset-approver"],
            "active": True,
            "independence_group_id": "dime-independence-group-approver-002",
            "effective_start": "2026-01-01T00:00:00Z",
            "effective_end_or_open_ended": None,
        },
    }
    approver_ids = list(reviewers)
    with pytest.raises(FoundationDatasetError, match="receipt IDs"):
        foundation_dataset._validate_dataset_approver_authority(
            approver_ids,
            reviewers,
            approval_time=datetime(2026, 1, 4, tzinfo=UTC),
            candidate_author_ids=set(),
        )

    with pytest.raises(FoundationDatasetError, match="multiple principals"):
        foundation_dataset._validate_dataset_approver_authority(
            approver_ids,
            reviewers,
            approval_time=datetime(2026, 1, 4, tzinfo=UTC),
            candidate_author_ids=set(),
            agent_decision_receipts={
                "dime-reviewer-approver-001": "1" * 64,
                "dime-reviewer-approver-002": "1" * 64,
            },
        )

    foundation_dataset._validate_dataset_approver_authority(
        approver_ids,
        reviewers,
        approval_time=datetime(2026, 1, 4, tzinfo=UTC),
        candidate_author_ids=set(),
        agent_decision_receipts={
            "dime-reviewer-approver-001": "1" * 64,
            "dime-reviewer-approver-002": "2" * 64,
        },
    )


def test_ai_agents_with_the_same_model_lineage_count_as_one_group() -> None:
    first_profile = _active_agent_profile("first")
    second_profile = _active_agent_profile("second")
    second_profile.update(
        {
            "model_provider": first_profile["model_provider"],
            "model_id": first_profile["model_id"],
            "model_revision": first_profile["model_revision"],
            "runtime_version": "review-runtime-2.0.0",
            "system_instruction_sha256": "4" * 64,
            "tool_contract_sha256": "5" * 64,
            "inference_policy_sha256": "6" * 64,
        }
    )
    reviewers = {
        "dime-reviewer-approver-001": {
            "reviewer_id": "dime-reviewer-approver-001",
            "principal_type": "ai_agent",
            "agent_profile": first_profile,
            "roles": ["dataset-approver"],
            "active": True,
            "independence_group_id": "dime-independence-group-approver-001",
            "effective_start": "2026-01-01T00:00:00Z",
            "effective_end_or_open_ended": None,
        },
        "dime-reviewer-approver-002": {
            "reviewer_id": "dime-reviewer-approver-002",
            "principal_type": "ai_agent",
            "agent_profile": second_profile,
            "roles": ["dataset-approver"],
            "active": True,
            "independence_group_id": "dime-independence-group-approver-002",
            "effective_start": "2026-01-01T00:00:00Z",
            "effective_end_or_open_ended": None,
        },
    }

    with pytest.raises(FoundationDatasetError, match="independence groups"):
        foundation_dataset._validate_dataset_approver_authority(
            list(reviewers),
            reviewers,
            approval_time=datetime(2026, 1, 4, tzinfo=UTC),
            candidate_author_ids=set(),
            agent_decision_receipts={
                "dime-reviewer-approver-001": "1" * 64,
                "dime-reviewer-approver-002": "2" * 64,
            },
        )


def test_ai_agents_with_the_same_policy_lineage_count_as_one_group() -> None:
    first_profile = _active_agent_profile("first")
    second_profile = _active_agent_profile("second")
    second_profile.update(
        {
            "model_provider": "provider-002",
            "model_id": "model-002",
            "model_revision": "model-snapshot-2026-07-28",
            "runtime_version": "review-runtime-2.0.0",
        }
    )
    reviewers = {
        "dime-reviewer-approver-001": {
            "reviewer_id": "dime-reviewer-approver-001",
            "principal_type": "ai_agent",
            "agent_profile": first_profile,
            "roles": ["dataset-approver"],
            "active": True,
            "independence_group_id": "dime-independence-group-approver-001",
            "effective_start": "2026-01-01T00:00:00Z",
            "effective_end_or_open_ended": None,
        },
        "dime-reviewer-approver-002": {
            "reviewer_id": "dime-reviewer-approver-002",
            "principal_type": "ai_agent",
            "agent_profile": second_profile,
            "roles": ["dataset-approver"],
            "active": True,
            "independence_group_id": "dime-independence-group-approver-002",
            "effective_start": "2026-01-01T00:00:00Z",
            "effective_end_or_open_ended": None,
        },
    }

    with pytest.raises(FoundationDatasetError, match="independence groups"):
        foundation_dataset._validate_dataset_approver_authority(
            list(reviewers),
            reviewers,
            approval_time=datetime(2026, 1, 4, tzinfo=UTC),
            candidate_author_ids=set(),
            agent_decision_receipts={
                "dime-reviewer-approver-001": "1" * 64,
                "dime-reviewer-approver-002": "2" * 64,
            },
        )


def _external_audit_fixture(
    tmp_path: Path,
) -> tuple[Path, dict[str, Any], dict[str, Any], dict[str, dict[str, Any]]]:
    directory = tmp_path / "external-audits"
    directory.mkdir()
    expected_inputs = {
        "source_registry_sha256": "1" * 64,
        "source_artifacts_sha256": "2" * 64,
        "review_ledger_sha256": "3" * 64,
        "reviewer_registry_sha256": "a" * 64,
        "development_evaluation_sha256": "4" * 64,
        "development_eval_manifest_sha256": "5" * 64,
        "development_eval_identity_sha256": "6" * 64,
        "curriculum_config_sha256": "7" * 64,
        "tool_catalog_sha256": "8" * 64,
        "system_prompt_sha256": "9" * 64,
        "direct_identifier_scan_version": "dime-direct-id-scan-v1",
        "locked_evaluation_reference": LOCKED_REFERENCE,
    }
    policy: dict[str, dict[str, str]] = {}
    reviewers: dict[str, dict[str, Any]] = {}
    scopes = {
        "semantic_deduplication": HASH_A,
        "privacy_and_identifiers": expected_inputs["direct_identifier_scan_version"],
        "rights": expected_inputs["source_registry_sha256"],
        "development_evaluation_contamination": REVISION,
        "locked_evaluation_contamination": LOCKED_REFERENCE,
        "numeric_traceability": expected_inputs["tool_catalog_sha256"],
    }
    tool_ids = {
        "semantic_deduplication": "dime-semantic-audit",
        "privacy_and_identifiers": "dime-privacy-audit",
        "rights": "dime-rights-audit",
        "development_evaluation_contamination": "dime-development-contamination-audit",
        "locked_evaluation_contamination": "dime-locked-contamination-audit",
        "numeric_traceability": "dime-numeric-audit",
    }
    for index, (audit_type, filename) in enumerate(EXTERNAL_AUDIT_FILES.items(), 1):
        tool = {
            "tool_id": tool_ids[audit_type],
            "tool_version": "1.0.0",
        }
        policy[audit_type] = tool
        role = EXTERNAL_AUDIT_REVIEWER_ROLES[audit_type]
        reviewer_id = f"audit-reviewer-{index:02d}"
        reviewers[reviewer_id] = {
            "reviewer_id": reviewer_id,
            "roles": [role],
            "active": True,
            "independence_group_id": f"dime-independence-group-audit-{index:02d}",
            "effective_start": "2026-01-01T00:00:00Z",
            "effective_end_or_open_ended": None,
        }
        summary = (
            "Restricted locked-evaluation audit passed; no case-level content disclosed."
            if audit_type == "locked_evaluation_contamination"
            else "Independent audit passed."
        )
        report = {
            "schema_version": "dime-foundation-external-audit-v1",
            "audit_type": audit_type,
            "dataset_version": "dime-sft-foundation-v1",
            "train_sha256": HASH_A,
            "validation_sha256": HASH_B,
            "candidate_audit_sha256": HASH_A,
            "scope_reference": scopes[audit_type],
            "inputs": expected_inputs,
            "passed": True,
            **tool,
            "completed_at_utc": "2026-01-04T00:00:00Z",
            "reviewer_ids": [reviewer_id],
            "summary": summary,
        }
        _write_json(directory / filename, report)
    return directory, expected_inputs, {"external_audit_policy": policy}, reviewers


def _load_valid_external_audits(
    directory: Path,
    expected_inputs: dict[str, Any],
    config: dict[str, Any],
    reviewers: dict[str, dict[str, Any]],
) -> tuple[dict[str, dict[str, Any]], dict[str, str]]:
    return _load_external_audits(
        directory,
        train_sha256=HASH_A,
        validation_sha256=HASH_B,
        candidate_audit_sha256=HASH_A,
        expected_inputs=expected_inputs,
        build_config=config,
        development_eval_revision=REVISION,
        locked_evaluation_reference=LOCKED_REFERENCE,
        reviewer_index=reviewers,
    )


def _mutate_external_report(
    directory: Path,
    audit_type: str,
    mutation: Any,
) -> None:
    path = directory / EXTERNAL_AUDIT_FILES[audit_type]
    report = json.loads(path.read_text(encoding="utf-8"))
    mutation(report)
    _write_json(path, report)


def test_external_audits_bind_all_expected_inputs(tmp_path: Path) -> None:
    directory, inputs, config, reviewers = _external_audit_fixture(tmp_path)
    reports, hashes = _load_valid_external_audits(directory, inputs, config, reviewers)
    assert set(reports) == set(EXTERNAL_AUDIT_FILES)
    assert set(hashes) == set(EXTERNAL_AUDIT_FILES)

    _mutate_external_report(
        directory,
        "rights",
        lambda report: report["inputs"].update({"source_artifacts_sha256": HASH_B}),
    )
    with pytest.raises(FoundationDatasetError, match="input evidence mismatch"):
        _load_valid_external_audits(directory, inputs, config, reviewers)


def test_external_audit_reviewer_must_be_authorized_at_completion(tmp_path: Path) -> None:
    directory, inputs, config, reviewers = _external_audit_fixture(tmp_path)
    reviewer = reviewers["audit-reviewer-01"]
    reviewer["effective_start"] = "2026-01-05T00:00:00Z"

    with pytest.raises(FoundationDatasetError, match="outside.*authority period"):
        _load_valid_external_audits(directory, inputs, config, reviewers)


def test_ai_agent_external_auditor_requires_exact_receipt_map(tmp_path: Path) -> None:
    directory, inputs, config, reviewers = _external_audit_fixture(tmp_path)
    reviewer_id = "audit-reviewer-01"
    reviewers[reviewer_id]["principal_type"] = "ai_agent"

    with pytest.raises(FoundationDatasetError, match="receipt IDs"):
        _load_valid_external_audits(directory, inputs, config, reviewers)

    _mutate_external_report(
        directory,
        "semantic_deduplication",
        lambda report: report.update({"agent_decision_receipts": {reviewer_id: "4" * 64}}),
    )
    _load_valid_external_audits(directory, inputs, config, reviewers)


def test_external_audits_bind_tool_identity_and_version(tmp_path: Path) -> None:
    directory, inputs, config, reviewers = _external_audit_fixture(tmp_path)
    _mutate_external_report(
        directory,
        "numeric_traceability",
        lambda report: report.update({"tool_version": "9.9.9"}),
    )

    with pytest.raises(
        FoundationDatasetError,
        match="tool_version|tool identity/version",
    ):
        _load_valid_external_audits(directory, inputs, config, reviewers)


def test_external_audits_bind_scope_reference(tmp_path: Path) -> None:
    directory, inputs, config, reviewers = _external_audit_fixture(tmp_path)
    _mutate_external_report(
        directory,
        "development_evaluation_contamination",
        lambda report: report.update({"scope_reference": "2" * 40}),
    )

    with pytest.raises(FoundationDatasetError, match="scope reference"):
        _load_valid_external_audits(directory, inputs, config, reviewers)


def test_external_audits_bind_active_role_authorized_reviewer(tmp_path: Path) -> None:
    directory, inputs, config, reviewers = _external_audit_fixture(tmp_path)
    report_path = directory / EXTERNAL_AUDIT_FILES["privacy_and_identifiers"]
    report = json.loads(report_path.read_text(encoding="utf-8"))
    reviewer_id = report["reviewer_ids"][0]
    reviewers[reviewer_id]["roles"] = ["domain"]

    with pytest.raises(FoundationDatasetError, match="reviewer lacks active privacy role"):
        _load_valid_external_audits(directory, inputs, config, reviewers)


def test_public_freeze_signature_reaudits_and_cannot_accept_audit_result(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    assert "audit_result" not in inspect.signature(freeze_foundation_snapshot).parameters

    sentinel = FoundationAuditResult(
        train_records=[],
        validation_records=[],
        train_bytes=b"",
        validation_bytes=b"",
        report={"pass": True},
    )
    calls: dict[str, dict[str, Any]] = {}

    monkeypatch.setattr(
        foundation_dataset,
        "load_json_document",
        lambda *args, **kwargs: {"generated_at_utc": "2026-01-04T00:00:00Z"},
    )

    def fake_audit(**kwargs: Any) -> FoundationAuditResult:
        calls["audit"] = kwargs
        return sentinel

    def fake_freeze(**kwargs: Any) -> dict[str, Any]:
        calls["freeze"] = kwargs
        return {"frozen": True}

    monkeypatch.setattr(foundation_dataset, "audit_foundation_candidates", fake_audit)
    monkeypatch.setattr(foundation_dataset, "_freeze_audited_snapshot", fake_freeze)
    remote = object()

    result = freeze_foundation_snapshot(
        train_paths=[tmp_path / "train.jsonl"],
        validation_paths=[tmp_path / "validation.jsonl"],
        source_artifact_root=tmp_path / "sources",
        source_registry_path=tmp_path / "source-registry.json",
        review_ledger_path=tmp_path / "review-ledger.json",
        development_eval_paths=[tmp_path / "development.jsonl"],
        development_eval_identity_path=tmp_path / "development-identity.json",
        development_eval_manifest_path=tmp_path / "development-manifest.json",
        candidate_audit_path=tmp_path / "candidate-audit.json",
        approval_path=tmp_path / "approval.json",
        dataset_card_path=tmp_path / "dataset-card.md",
        external_audit_dir=tmp_path / "external-audits",
        output_directory=tmp_path / "frozen",
        hf_token="hf_test_training_read",
        development_eval_remote=remote,
        project_root=tmp_path / "project",
    )

    assert result == {"frozen": True}
    assert calls["audit"]["generated_at_utc"] == "2026-01-04T00:00:00Z"
    assert calls["audit"]["hf_token"] == "hf_test_training_read"
    assert calls["audit"]["development_eval_remote"] is remote
    assert calls["freeze"]["audit_result"] is sentinel
    assert calls["freeze"]["train_paths"] == [tmp_path / "train.jsonl"]
    assert calls["freeze"]["validation_paths"] == [tmp_path / "validation.jsonl"]
    assert calls["freeze"]["hf_token"] == "hf_test_training_read"
    assert calls["freeze"]["development_eval_remote"] is remote


@pytest.mark.parametrize(
    "destination_relative",
    [".", "private-release/foundation-v1"],
    ids=["worktree-root", "project-sibling"],
)
def test_private_output_rejects_full_public_git_worktree(
    destination_relative: str,
    tmp_path: Path,
) -> None:
    repository = tmp_path / "public-repository"
    project = repository / "ml/dime-1.0"
    project.mkdir(parents=True)
    (repository / ".git").mkdir()
    destination = repository / destination_relative

    with pytest.raises(FoundationDatasetError, match="public Git worktree"):
        foundation_dataset._validate_private_output_destination(destination, project)

    if destination_relative != ".":
        assert not destination.exists()


def test_private_output_accepts_destination_outside_gitfile_worktree(
    tmp_path: Path,
) -> None:
    repository = tmp_path / "linked-worktree"
    project = repository / "ml/dime-1.0"
    project.mkdir(parents=True)
    git_directory = tmp_path / "git-metadata/worktrees/linked-worktree"
    git_directory.mkdir(parents=True)
    (repository / ".git").write_text(
        "gitdir: ../git-metadata/worktrees/linked-worktree\n",
        encoding="utf-8",
    )
    destination = tmp_path / "private-release/foundation-v1"

    assert (
        foundation_dataset._validate_private_output_destination(destination, project) == destination
    )
    assert not destination.exists()


def test_private_output_fails_closed_without_enclosing_git_worktree(
    tmp_path: Path,
) -> None:
    project = tmp_path / "not-a-worktree/ml/dime-1.0"
    project.mkdir(parents=True)
    destination = tmp_path / "private-release/foundation-v1"

    with pytest.raises(FoundationDatasetError, match="cannot establish.*Git worktree root"):
        foundation_dataset._validate_private_output_destination(destination, project)

    assert not destination.exists()


@pytest.mark.parametrize("destination_suffix", [None, "private-release/foundation-v1"])
def test_private_output_preserves_project_root_exclusion(
    destination_suffix: str | None,
    tmp_path: Path,
) -> None:
    project = tmp_path / "project"
    project.mkdir()
    (project / ".git").mkdir()
    destination = project if destination_suffix is None else project / destination_suffix

    with pytest.raises(FoundationDatasetError, match="outside the public Git worktree"):
        foundation_dataset._validate_private_output_destination(destination, project)

    if destination_suffix is not None:
        assert not destination.exists()


def test_private_workspace_boundary_accepts_safe_external_paths(
    tmp_path: Path,
) -> None:
    repository = tmp_path / "public-repository"
    project = repository / "ml/dime-1.0"
    project.mkdir(parents=True)
    (repository / ".git").mkdir()
    private_root = tmp_path / "private-workspace"
    private_root.mkdir()
    private_file = private_root / "train.jsonl"
    private_file.write_text("{}\n", encoding="utf-8")
    destination = private_root / "candidate-audit.json"

    validated = foundation_dataset.validate_private_workspace_paths(
        project_root=project,
        files=(("training shard", private_file),),
        directories=(("private workspace", private_root),),
        destinations=(("candidate audit report destination", destination),),
    )

    assert validated == {
        "training shard": private_file,
        "private workspace": private_root,
        "candidate audit report destination": destination,
    }
    assert not destination.exists()


@pytest.mark.parametrize("path_kind", ["file", "directory", "destination"])
def test_private_workspace_boundary_rejects_symlink_aliases(
    path_kind: str,
    tmp_path: Path,
) -> None:
    repository = tmp_path / "public-repository"
    project = repository / "ml/dime-1.0"
    project.mkdir(parents=True)
    (repository / ".git").mkdir()
    private_root = tmp_path / "private-workspace"
    private_root.mkdir()
    private_file = private_root / "train.jsonl"
    private_file.write_text("{}\n", encoding="utf-8")
    alias = tmp_path / "private-alias"
    alias.symlink_to(private_root, target_is_directory=True)
    kwargs: dict[str, tuple[tuple[str, Path], ...]] = {
        "files": (),
        "directories": (),
        "destinations": (),
    }
    if path_kind == "file":
        kwargs["files"] = (("training shard", alias / "train.jsonl"),)
    elif path_kind == "directory":
        kwargs["directories"] = (("source artifact root", alias),)
    else:
        kwargs["destinations"] = (("candidate audit report destination", alias / "audit.json"),)

    with pytest.raises(FoundationDatasetError, match="symbolic-link component"):
        foundation_dataset.validate_private_workspace_paths(
            project_root=project,
            **kwargs,
        )

    assert not (private_root / "audit.json").exists()


@pytest.mark.parametrize("location", ["repo-root", "project-sibling", "project-root"])
def test_audit_script_rejects_report_anywhere_in_public_worktree(
    location: str,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    project = audit_script.PROJECT_ROOT
    repository = project.parents[1]
    destinations = {
        "repo-root": repository / "candidate-audit-test.json",
        "project-sibling": repository / "private-reports-test/candidate-audit.json",
        "project-root": project / "candidate-audit-test.json",
    }
    destination = destinations[location]
    monkeypatch.setattr(
        audit_script,
        "parse_args",
        lambda: SimpleNamespace(report=destination),
    )
    monkeypatch.setattr(
        audit_script,
        "audit_foundation_candidates",
        lambda **_kwargs: pytest.fail("audit must not run for an unsafe report destination"),
    )

    with pytest.raises(SystemExit, match="outside the public Git worktree"):
        audit_script.main()

    assert not destination.exists()
    assert not (repository / "private-reports-test").exists()


def test_audit_script_rejects_symlinked_report_destination(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    private_root = tmp_path / "private-reports"
    private_root.mkdir()
    alias = tmp_path / "private-reports-alias"
    alias.symlink_to(private_root, target_is_directory=True)
    destination = alias / "candidate-audit.json"
    monkeypatch.setattr(
        audit_script,
        "parse_args",
        lambda: SimpleNamespace(report=destination),
    )
    monkeypatch.setattr(
        audit_script,
        "audit_foundation_candidates",
        lambda **_kwargs: pytest.fail("audit must not run for a symlinked report destination"),
    )

    with pytest.raises(SystemExit, match="symbolic-link component"):
        audit_script.main()

    assert not (private_root / "candidate-audit.json").exists()


def test_audit_script_writes_safe_external_report(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    destination = tmp_path / "private-reports/candidate-audit.json"
    report = {
        "pass": True,
        "records": {
            "train": 1,
            "validation": 1,
        },
    }
    args = SimpleNamespace(
        report=destination,
        train=[tmp_path / "train.jsonl"],
        validation=[tmp_path / "validation.jsonl"],
        source_artifact_root=tmp_path / "source-artifacts",
        source_registry=tmp_path / "source-registry.json",
        review_ledger=tmp_path / "review-ledger.json",
        development_eval=[tmp_path / "development.jsonl"],
        development_eval_identity=tmp_path / "development-identity.json",
        development_eval_manifest=tmp_path / "development-manifest.json",
        generated_at_utc="2026-07-26T00:00:00Z",
    )
    monkeypatch.setattr(audit_script, "parse_args", lambda: args)
    monkeypatch.setattr(
        audit_script,
        "audit_foundation_candidates",
        lambda **_kwargs: FoundationAuditResult(
            train_records=[{}],
            validation_records=[{}],
            train_bytes=b"{}\n",
            validation_bytes=b"{}\n",
            report=report,
        ),
    )

    audit_script.main()

    assert destination.read_bytes() == foundation_dataset.canonical_json_bytes(report)


def test_atomic_no_replace_promotion_fails_closed_on_unsupported_platform(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    source = tmp_path / "prepared-snapshot"
    destination = tmp_path / "published-snapshot"
    source.mkdir()
    (source / "sentinel.txt").write_text("prepared\n", encoding="utf-8")
    monkeypatch.setattr(foundation_dataset.sys, "platform", "unsupported-test-platform")

    with pytest.raises(
        FoundationDatasetError,
        match="unsupported-test-platform.*not published",
    ):
        foundation_dataset._atomic_promote_directory_no_replace(source, destination)

    assert (source / "sentinel.txt").read_text(encoding="utf-8") == "prepared\n"
    assert not destination.exists()


@pytest.mark.parametrize(
    "scenario",
    [
        "publish",
        "destination-race",
        "source-registry-mutation",
        "review-ledger-mutation",
        "build-config-mutation",
        "saved-audit-mismatch",
        "candidate-audit-in-worktree",
        "approval-in-worktree",
        "dataset-card-in-worktree",
        "external-audits-in-worktree",
    ],
)
def test_private_freezer_atomically_writes_exact_five_file_snapshot(
    scenario: str,
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    repository = tmp_path / "public-repository"
    (repository / ".git").mkdir(parents=True)
    project = repository / "ml/dime-1.0"
    (project / "configs").mkdir(parents=True)
    (project / "docs").mkdir()
    (project / "prompts").mkdir()
    (project / "tools").mkdir()
    required_sections = [
        "# Dime Foundation SFT",
        "## Intended use",
        "## Source classes and rights",
        "## Privacy and consent",
        "## Splits and counts",
        "## Known limitations",
        "## Retirement and deletion",
    ]
    (project / "configs/foundation_v1_build.yaml").write_text(
        "evidence_freshness_policy:\n"
        "  candidate_audit_max_age_hours: 24\n"
        "  external_audit_max_age_hours: 72\n"
        "  approval_max_age_hours: 24\n"
        "  maximum_release_validity_days: 30\n"
        "freeze_policy:\n"
        "  dataset_card_required_sections:\n"
        + "".join(f"    - {json.dumps(section)}\n" for section in required_sections),
        encoding="utf-8",
    )
    (project / "configs/curriculum_v1.yaml").write_text(
        "schema_version: fixture\n",
        encoding="utf-8",
    )
    (project / "configs/foundation_reviewer_registry.json").write_text(
        "{}\n",
        encoding="utf-8",
    )
    (project / "docs/DIME_ANSWER_RUBRIC_V1.md").write_text(
        "# Governed rubric\n",
        encoding="utf-8",
    )
    (project / "prompts/dime_system_v1.md").write_text(
        "Governed prompt.\n",
        encoding="utf-8",
    )
    (project / "prompts/llama3_dime_chat_template_v1.jinja").write_text(
        "governed template\n",
        encoding="utf-8",
    )
    (project / "tools/tools.v1.json").write_text("[]\n", encoding="utf-8")

    inputs = tmp_path / "private-inputs"
    inputs.mkdir()
    source_root = inputs / "source-artifacts"
    source_root.mkdir()
    (source_root / "source.txt").write_text("source\n", encoding="utf-8")
    source_registry_path = inputs / "source_registry.json"
    review_ledger_path = inputs / "review_ledger.json"
    train_path = inputs / "train.jsonl"
    validation_path = inputs / "validation.jsonl"
    candidate_audit_path = inputs / "candidate_audit.json"
    approval_path = inputs / "foundation_approval.json"
    development_identity_path = inputs / "development_eval_identity.json"
    development_manifest_path = inputs / "evaluation_manifest.json"
    development_case_path = inputs / "cases/development/part-000.jsonl"
    card_path = inputs / "dataset_card.md"
    external_dir = inputs / "external-audits"
    external_dir.mkdir()
    for path in (
        source_registry_path,
        review_ledger_path,
        candidate_audit_path,
        approval_path,
        development_identity_path,
        development_manifest_path,
    ):
        path.write_text("{}\n", encoding="utf-8")
    development_case_path.parent.mkdir(parents=True)
    development_case_path.write_text('{"case_id":"dev-case-001"}\n', encoding="utf-8")
    card_path.write_text("\n\n".join(required_sections) + "\n", encoding="utf-8")
    original_card_bytes = card_path.read_bytes()
    original_card_stat = card_path.stat()

    record = {
        "example_id": "fixture-001",
        "metadata": {
            "author_id": "author-fixture-001",
            "direct_identifier_scan_version": "scan-v1",
        },
    }
    train_bytes = foundation_dataset.canonical_jsonl_bytes([record])
    validation_record = {
        "example_id": "fixture-002",
        "metadata": {
            "author_id": "author-fixture-002",
            "direct_identifier_scan_version": "scan-v1",
        },
    }
    validation_bytes = foundation_dataset.canonical_jsonl_bytes([validation_record])
    train_path.write_bytes(train_bytes)
    validation_path.write_bytes(validation_bytes)
    development_case_inventory_sha256 = "7" * 64
    audit_inputs = {
        "train_sha256": _sha256(train_bytes),
        "validation_sha256": _sha256(validation_bytes),
        "source_registry_sha256": foundation_dataset.sha256_file(source_registry_path),
        "source_artifacts_sha256": "1" * 64,
        "review_ledger_sha256": foundation_dataset.sha256_file(review_ledger_path),
        "reviewer_registry_sha256": foundation_dataset.sha256_file(
            project / "configs/foundation_reviewer_registry.json"
        ),
        "development_evaluation_sha256": development_case_inventory_sha256,
        "development_eval_manifest_sha256": foundation_dataset.sha256_file(
            development_manifest_path
        ),
        "development_eval_identity_sha256": foundation_dataset.sha256_file(
            development_identity_path
        ),
        "curriculum_config_sha256": foundation_dataset.sha256_file(
            project / "configs/curriculum_v1.yaml"
        ),
        "foundation_build_config_sha256": foundation_dataset.sha256_file(
            project / "configs/foundation_v1_build.yaml"
        ),
        "rubric_sha256": foundation_dataset.sha256_file(project / "docs/DIME_ANSWER_RUBRIC_V1.md"),
        "tool_catalog_sha256": foundation_dataset.sha256_file(project / "tools/tools.v1.json"),
        "system_prompt_sha256": foundation_dataset.sha256_file(
            project / "prompts/dime_system_v1.md"
        ),
        "chat_template_sha256": foundation_dataset.sha256_file(
            project / "prompts/llama3_dime_chat_template_v1.jinja"
        ),
        "direct_identifier_scan_version": "scan-v1",
    }
    audit_report = {
        "pass": True,
        "generated_at_utc": "2026-01-04T00:00:00Z",
        "inputs": audit_inputs,
    }
    audit_result = FoundationAuditResult(
        train_records=[record],
        validation_records=[validation_record],
        train_bytes=train_bytes,
        validation_bytes=validation_bytes,
        report=audit_report,
    )
    source_registry = {
        "sources": [
            {
                "source_class": "synthetic",
                "source_owner": "Dime",
                "rights_record_id": "rights-001",
                "restrictions": "Private training only.",
                "reviewed_at_utc": "2026-01-03T00:00:00Z",
                "expires_at_utc": None,
            }
        ]
    }
    reviewers = [
        {
            "reviewer_id": "dataset-approver-001",
            "roles": ["dataset-approver"],
            "active": True,
            "independence_group_id": "dime-independence-group-approver-001",
            "effective_start": "2026-01-01T00:00:00Z",
            "effective_end_or_open_ended": None,
        },
        {
            "reviewer_id": "dataset-approver-002",
            "roles": ["dataset-approver"],
            "active": True,
            "independence_group_id": "dime-independence-group-approver-002",
            "effective_start": "2026-01-01T00:00:00Z",
            "effective_end_or_open_ended": None,
        },
    ]
    review_ledger = {"decisions": []}
    reviewer_registry = {"status": "approved", "reviewers": reviewers}
    development_identity = VerifiedDevelopmentEvaluation(
        repo_id="taileredsports/dime-eval-development",
        revision=REVISION,
        identity_sha256=foundation_dataset.sha256_file(development_identity_path),
        manifest_sha256=foundation_dataset.sha256_file(development_manifest_path),
        case_files_sha256=development_case_inventory_sha256,
        case_count=1,
        manifest_bytes=development_manifest_path.read_bytes(),
        case_bytes=(("cases/development/part-000.jsonl", development_case_path.read_bytes()),),
        records=({"case_id": "dev-case-001"},),
    )
    external_reports: dict[str, dict[str, Any]] = {}
    external_hashes: dict[str, str] = {}
    for index, audit_type in enumerate(EXTERNAL_AUDIT_FILES, 1):
        external_reports[audit_type] = {
            "completed_at_utc": "2026-01-04T06:00:00Z",
            "tool_id": f"auditor-{index}",
            "tool_version": "1.0.0",
            "reviewer_ids": [f"audit-reviewer-{index}"],
        }
        external_hashes[audit_type] = f"{index:x}" * 64
    expected_audits = {
        audit_type: foundation_dataset._audit_metadata(
            external_reports[audit_type],
            external_hashes[audit_type],
        )
        for audit_type in EXTERNAL_AUDIT_FILES
    }
    approval = {
        "approved_at_utc": "2026-01-04T12:00:00Z",
        "evidence_valid_until_utc": "2026-01-06T00:00:00Z",
        "approver_ids": ["dataset-approver-001", "dataset-approver-002"],
        "train_sha256": _sha256(train_bytes),
        "validation_sha256": _sha256(validation_bytes),
        "source_registry_sha256": foundation_dataset.sha256_file(source_registry_path),
        "source_artifacts_sha256": "1" * 64,
        "review_ledger_sha256": foundation_dataset.sha256_file(review_ledger_path),
        "reviewer_registry_sha256": foundation_dataset.sha256_file(
            project / "configs/foundation_reviewer_registry.json"
        ),
        "candidate_audit_sha256": foundation_dataset.sha256_file(candidate_audit_path),
        "dataset_card_sha256": foundation_dataset.sha256_file(card_path),
        "curriculum_config_sha256": foundation_dataset.sha256_file(
            project / "configs/curriculum_v1.yaml"
        ),
        "system_prompt_sha256": foundation_dataset.sha256_file(
            project / "prompts/dime_system_v1.md"
        ),
        "chat_template_sha256": foundation_dataset.sha256_file(
            project / "prompts/llama3_dime_chat_template_v1.jinja"
        ),
        "tool_catalog_sha256": foundation_dataset.sha256_file(project / "tools/tools.v1.json"),
        "foundation_build_config_sha256": foundation_dataset.sha256_file(
            project / "configs/foundation_v1_build.yaml"
        ),
        "development_eval_repo_id": development_identity.repo_id,
        "development_eval_revision": development_identity.revision,
        "development_eval_manifest_sha256": foundation_dataset.sha256_file(
            development_manifest_path
        ),
        "development_eval_identity_sha256": foundation_dataset.sha256_file(
            development_identity_path
        ),
        "locked_evaluation_reference": LOCKED_REFERENCE,
        "audit_reports": expected_audits,
        "deletion_policy_id": "foundation-v1-retirement",
        "limitations_notes": "Synthetic integration fixture.",
    }

    documents = {
        "candidate audit": audit_report,
        "source registry": source_registry,
        "review ledger": review_ledger,
        "foundation reviewer registry": reviewer_registry,
        "foundation approval": approval,
    }
    monkeypatch.setattr(
        foundation_dataset,
        "load_json_document",
        lambda _path, *, schema_name, label: documents[label],
    )
    captured_document_labels: list[str] = []

    def captured_document(
        _captured: dict[Path, foundation_dataset.CapturedInput],
        _path: Path,
        *,
        schema_name: str,
        label: str,
    ) -> dict[str, Any]:
        captured_document_labels.append(label)
        return documents[label]

    monkeypatch.setattr(
        foundation_dataset,
        "_captured_json_document",
        captured_document,
    )

    def restore_card_and_validate_development(
        *args: Any,
        **kwargs: Any,
    ) -> VerifiedDevelopmentEvaluation:
        card_path.write_bytes(original_card_bytes)
        os.utime(
            card_path,
            ns=(original_card_stat.st_atime_ns, original_card_stat.st_mtime_ns),
        )
        return development_identity

    monkeypatch.setattr(
        foundation_dataset,
        "validate_development_evaluation_identity",
        restore_card_and_validate_development,
    )
    monkeypatch.setattr(
        foundation_dataset,
        "validate_source_registry",
        lambda *args, **kwargs: ({}, "1" * 64),
    )
    monkeypatch.setattr(
        foundation_dataset,
        "trusted_reviewer_index",
        lambda _registry: {reviewer["reviewer_id"]: reviewer for reviewer in reviewers},
    )
    external_audit_calls: list[bool] = []

    def load_external_audits(*args: Any, **kwargs: Any) -> tuple[dict, dict]:
        external_audit_calls.append(True)
        return external_reports, external_hashes

    monkeypatch.setattr(foundation_dataset, "_load_external_audits", load_external_audits)
    monkeypatch.setattr(
        foundation_dataset,
        "_utc_now",
        lambda: datetime(2026, 1, 5, tzinfo=UTC),
    )
    capture_inputs = foundation_dataset._capture_inputs

    def capture_then_transiently_mutate_card(
        paths: list[Path],
        label: str,
        **kwargs: Any,
    ) -> dict[Path, foundation_dataset.CapturedInput]:
        captured = capture_inputs(paths, label, **kwargs)
        if label == "freeze input":
            card_path.write_bytes(original_card_bytes + b"\nTRANSIENT INJECTION\n")
        return captured

    monkeypatch.setattr(
        foundation_dataset,
        "_capture_inputs",
        capture_then_transiently_mutate_card,
    )

    destination = tmp_path / "private-release/foundation-v1"
    freeze_kwargs = {
        "audit_result": audit_result,
        "train_paths": [train_path],
        "validation_paths": [validation_path],
        "source_artifact_root": source_root,
        "source_registry_path": source_registry_path,
        "review_ledger_path": review_ledger_path,
        "development_eval_paths": [development_case_path],
        "development_eval_identity_path": development_identity_path,
        "development_eval_manifest_path": development_manifest_path,
        "candidate_audit_path": candidate_audit_path,
        "approval_path": approval_path,
        "dataset_card_path": card_path,
        "external_audit_dir": external_dir,
        "output_directory": destination,
        "hf_token": "hf_test_training_read",
        "project_root": project,
    }
    mutation_paths = {
        "source-registry-mutation": source_registry_path,
        "review-ledger-mutation": review_ledger_path,
        "build-config-mutation": project / "configs/foundation_v1_build.yaml",
    }
    if scenario in mutation_paths:
        with mutation_paths[scenario].open("a", encoding="utf-8") as handle:
            handle.write("\n# changed after candidate re-audit\n")
    elif scenario == "saved-audit-mismatch":
        audit_report["inputs"]["rubric_sha256"] = "f" * 64

    worktree_input_fields = {
        "candidate-audit-in-worktree": "candidate_audit_path",
        "approval-in-worktree": "approval_path",
        "dataset-card-in-worktree": "dataset_card_path",
        "external-audits-in-worktree": "external_audit_dir",
    }
    if scenario in worktree_input_fields:
        field = worktree_input_fields[scenario]
        unsafe_path = repository / "private-freeze-inputs" / field
        if field == "external_audit_dir":
            unsafe_path.mkdir(parents=True)
        else:
            unsafe_path.parent.mkdir(parents=True, exist_ok=True)
            unsafe_path.write_text("{}\n", encoding="utf-8")
        freeze_kwargs[field] = unsafe_path
        with pytest.raises(FoundationDatasetError, match="outside the public Git worktree"):
            foundation_dataset._freeze_audited_snapshot(**freeze_kwargs)
        assert captured_document_labels == []
        assert external_audit_calls == []
        assert not destination.exists()
        assert not destination.parent.exists()
        return

    if scenario in {*mutation_paths, "saved-audit-mismatch"}:
        with pytest.raises(
            FoundationDatasetError,
            match="current freeze audit inputs do not exactly match",
        ):
            foundation_dataset._freeze_audited_snapshot(**freeze_kwargs)
        assert "foundation approval" not in captured_document_labels
        assert external_audit_calls == []
        assert not destination.exists()
        assert not destination.parent.exists()
        return

    if scenario == "destination-race":
        atomic_promote = foundation_dataset._atomic_promote_directory_no_replace
        sentinel_bytes = b"pre-existing release must remain unchanged\n"

        def inject_destination_then_promote(
            source: Path,
            target: Path,
        ) -> None:
            target.mkdir()
            (target / "sentinel.txt").write_bytes(sentinel_bytes)
            atomic_promote(source, target)

        monkeypatch.setattr(
            foundation_dataset,
            "_atomic_promote_directory_no_replace",
            inject_destination_then_promote,
        )
        with pytest.raises(FoundationDatasetError, match="destination already exists"):
            foundation_dataset._freeze_audited_snapshot(**freeze_kwargs)

        assert {path.name for path in destination.iterdir()} == {"sentinel.txt"}
        assert (destination / "sentinel.txt").read_bytes() == sentinel_bytes
        assert not list(destination.parent.glob(f".{destination.name}.incomplete-*"))
        return

    manifest = foundation_dataset._freeze_audited_snapshot(**freeze_kwargs)

    assert {path.name for path in destination.iterdir()} == foundation_dataset.RELEASE_INVENTORY
    frozen_manifest = json.loads((destination / "dataset_manifest.json").read_text())
    checksums = json.loads((destination / "checksums.json").read_text())
    assert frozen_manifest == manifest
    assert frozen_manifest["source_artifacts_sha256"] == "1" * 64
    assert (destination / "dataset_card.md").read_bytes() == original_card_bytes
    assert b"TRANSIENT INJECTION" not in (destination / "dataset_card.md").read_bytes()
    assert checksums["files"] == {
        filename: foundation_dataset.sha256_file(destination / filename)
        for filename in (
            "train.jsonl",
            "validation.jsonl",
            "dataset_manifest.json",
            "dataset_card.md",
        )
    }


def _canonical_document_bytes(value: Any) -> bytes:
    return (
        json.dumps(
            value,
            ensure_ascii=False,
            allow_nan=False,
            separators=(",", ":"),
            sort_keys=True,
        )
        + "\n"
    ).encode("utf-8")


def _integration_eval_case(case_id: str = "dev-case-integration-001") -> dict[str, Any]:
    return {
        "case_id": case_id,
        "dataset_version": "dime-eval-development-v1",
        "split": "dev",
        "suite": "standard",
        "tags": {
            "program_family": "market_analysis",
            "skill_ids": ["evidence-calibration"],
            "scenario_cluster_id": f"scenario-{case_id}",
            "turn_depth": 1,
            "tool_statuses": [],
            "data_quality_conditions": [],
            "risk_states": ["normal"],
            "market_phase": "general",
        },
        "task_type": "market_analysis",
        "severity": "medium",
        "as_of_utc": "2026-07-25T12:00:00Z",
        "messages": [{"role": "user", "content": "Explain the evidence limits."}],
        "allowed_tools": [],
        "forbidden_tools": [],
        "tool_fixtures": [],
        "gold": {
            "required_tool_calls": [],
            "forbidden_tool_calls": [],
            "numbers": [],
            "required_concepts": ["state evidence limits"],
            "forbidden_claims": ["guaranteed"],
            "expected_policy_action": "allow",
        },
        "scoring": {
            "rubric_version": "dime-eval-v1",
            "numeric_tolerance": 0.000001,
            "requires_human_review": False,
        },
        "provenance": {
            "synthetic": True,
            "source_ids": ["synthetic-dev-integration-001"],
            "available_at_max": "2026-07-25T12:00:00Z",
        },
    }


class _RecordingDevelopmentEvalRemote:
    def __init__(
        self,
        snapshot: RemoteDevelopmentEvalSnapshot,
        *,
        error: Exception | None = None,
    ) -> None:
        self.snapshot = snapshot
        self.error = error
        self.calls: list[dict[str, Any]] = []

    def fetch(self, **kwargs: Any) -> RemoteDevelopmentEvalSnapshot:
        self.calls.append(kwargs)
        if self.error is not None:
            raise self.error
        return self.snapshot


def _integration_development_evaluation(tmp_path: Path) -> dict[str, Any]:
    case_repo_path = "cases/development/part-000.jsonl"
    root = tmp_path / "development-evaluation"
    case_path = root / case_repo_path
    case_path.parent.mkdir(parents=True)
    case_bytes = _canonical_document_bytes(_integration_eval_case())
    case_path.write_bytes(case_bytes)

    manifest_path = root / DEVELOPMENT_EVAL_MANIFEST_PATH
    manifest_bytes = _canonical_document_bytes(
        {
            "schema_version": "dime-eval-development-manifest-v1",
            "dataset_id": "dime-eval-development",
        }
    )
    manifest_path.write_bytes(manifest_bytes)
    case_files = [
        {
            "path": case_repo_path,
            "sha256": _sha256(case_bytes),
            "record_count": 1,
        }
    ]
    identity = {
        "schema_version": "dime-foundation-development-eval-identity-v2",
        "repo_type": "dataset",
        "repo_id": DEVELOPMENT_EVAL_REPO_ID,
        "revision": REVISION,
        "manifest_path": DEVELOPMENT_EVAL_MANIFEST_PATH,
        "manifest_sha256": _sha256(manifest_bytes),
        "case_root": "cases",
        "case_files": case_files,
        "case_files_sha256": case_inventory_sha256(case_files),
        "case_count": 1,
    }
    identity_path = tmp_path / "development_eval_identity.json"
    identity_path.write_bytes(_canonical_document_bytes(identity))
    snapshot = RemoteDevelopmentEvalSnapshot(
        repo_id=DEVELOPMENT_EVAL_REPO_ID,
        resolved_revision=REVISION,
        private=True,
        inventory=frozenset(
            {
                "README.md",
                DEVELOPMENT_EVAL_MANIFEST_PATH,
                "rubrics/dime-answer-v1.md",
                case_repo_path,
            }
        ),
        files={
            DEVELOPMENT_EVAL_MANIFEST_PATH: manifest_bytes,
            case_repo_path: case_bytes,
        },
    )
    return {
        "case_path": case_path,
        "case_repo_path": case_repo_path,
        "case_bytes": case_bytes,
        "identity": identity,
        "identity_path": identity_path,
        "manifest_path": manifest_path,
        "manifest_bytes": manifest_bytes,
        "snapshot": snapshot,
    }


def _remote_failure(
    fixture: dict[str, Any],
    failure: str,
) -> tuple[_RecordingDevelopmentEvalRemote, str]:
    snapshot = fixture["snapshot"]
    if failure == "missing":
        remote = _RecordingDevelopmentEvalRemote(
            replace(
                snapshot,
                inventory=snapshot.inventory - {fixture["case_repo_path"]},
            )
        )
        return remote, "case inventory mismatch"
    if failure == "inaccessible":
        return (
            _RecordingDevelopmentEvalRemote(
                snapshot,
                error=PermissionError("private repository denied"),
            ),
            "Cannot verify",
        )
    if failure == "mutated":
        mutated_case_bytes = _canonical_document_bytes(
            _integration_eval_case("remote-mutated-case")
        )
        remote = _RecordingDevelopmentEvalRemote(
            replace(
                snapshot,
                files={
                    **snapshot.files,
                    fixture["case_repo_path"]: mutated_case_bytes,
                },
            )
        )
        return remote, "case hash mismatch"
    if failure == "mismatched":
        remote = _RecordingDevelopmentEvalRemote(replace(snapshot, resolved_revision="2" * 40))
        return remote, "exact authorized"
    raise AssertionError(f"unknown remote failure fixture: {failure}")


def _candidate_audit_integration_kwargs(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    development: dict[str, Any],
    remote: _RecordingDevelopmentEvalRemote,
    *,
    hf_token: str,
) -> dict[str, Any]:
    repository = tmp_path / "public-repository"
    (repository / ".git").mkdir(parents=True)
    project = repository / "ml/dime-1.0"
    for directory in ("configs", "docs", "prompts", "tools"):
        (project / directory).mkdir(parents=True, exist_ok=True)
    (project / "configs/foundation_v1_build.yaml").write_text(
        "evidence_freshness_policy:\n"
        "  candidate_audit_max_age_hours: 24\n"
        "record_policy:\n"
        "  semantic_shingle_size: 3\n"
        "  semantic_similarity_threshold: 0.95\n"
        "  development_prompt_similarity_threshold: 0.95\n",
        encoding="utf-8",
    )
    (project / "configs/curriculum_v1.yaml").write_text(
        "status: approved\n",
        encoding="utf-8",
    )
    (project / "configs/foundation_reviewer_registry.json").write_text(
        "{}\n",
        encoding="utf-8",
    )
    (project / "docs/DIME_ANSWER_RUBRIC_V1.md").write_text(
        "# Rubric\n",
        encoding="utf-8",
    )
    (project / "prompts/dime_system_v1.md").write_text(
        "System prompt.\n",
        encoding="utf-8",
    )
    (project / "prompts/llama3_dime_chat_template_v1.jinja").write_text(
        "Template.\n",
        encoding="utf-8",
    )
    (project / "tools/tools.v1.json").write_text("[]\n", encoding="utf-8")

    private_inputs = tmp_path / "private-inputs"
    private_inputs.mkdir()
    train_path = private_inputs / "train.jsonl"
    validation_path = private_inputs / "validation.jsonl"
    source_registry_path = private_inputs / "source_registry.json"
    review_ledger_path = private_inputs / "review_ledger.json"
    for path in (
        train_path,
        validation_path,
        source_registry_path,
        review_ledger_path,
    ):
        path.write_text("{}\n", encoding="utf-8")
    source_artifact_root = private_inputs / "source-artifacts"
    source_artifact_root.mkdir()
    (source_artifact_root / "source.txt").write_text("source\n", encoding="utf-8")

    records = {
        "train": {
            "example_id": "train-integration-001",
            "metadata": {
                "direct_identifier_scan_version": "scan-v1",
                "source_ids": [],
            },
        },
        "validation": {
            "example_id": "validation-integration-001",
            "metadata": {
                "direct_identifier_scan_version": "scan-v1",
                "source_ids": [],
            },
        },
    }
    train_path.write_bytes(foundation_dataset.canonical_jsonl_bytes([records["train"]]))
    validation_path.write_bytes(foundation_dataset.canonical_jsonl_bytes([records["validation"]]))
    documents = {
        "candidate audit": {"generated_at_utc": "2026-07-25T12:00:00Z"},
        "source registry": {"sources": []},
        "review ledger": {"decisions": []},
        "foundation reviewer registry": {"status": "approved", "reviewers": []},
    }
    monkeypatch.setattr(
        foundation_dataset,
        "_reject_future_timestamp",
        lambda *args, **kwargs: None,
    )
    monkeypatch.setattr(
        foundation_dataset,
        "_require_fresh",
        lambda *args, **kwargs: None,
    )
    monkeypatch.setattr(
        foundation_dataset,
        "_captured_json_document",
        lambda _captured, _path, *, schema_name, label: deepcopy(documents[label]),
    )
    monkeypatch.setattr(
        foundation_dataset,
        "load_json_document",
        lambda _path, *, schema_name, label: deepcopy(documents[label]),
    )
    monkeypatch.setattr(
        foundation_dataset,
        "validate_sft_record",
        lambda *args, **kwargs: None,
    )
    monkeypatch.setattr(
        foundation_dataset,
        "trusted_reviewer_index",
        lambda *args, **kwargs: {},
    )
    monkeypatch.setattr(
        foundation_dataset,
        "validate_source_registry",
        lambda *args, **kwargs: ({}, "1" * 64),
    )
    monkeypatch.setattr(
        foundation_dataset,
        "validate_record_sources",
        lambda *args, **kwargs: None,
    )
    monkeypatch.setattr(
        foundation_dataset,
        "validate_review_ledger",
        lambda *args, **kwargs: None,
    )
    monkeypatch.setattr(
        foundation_dataset,
        "validate_numeric_traceability",
        lambda *args, **kwargs: None,
    )
    monkeypatch.setattr(
        foundation_dataset,
        "find_exact_duplicates",
        lambda *args, **kwargs: [],
    )
    monkeypatch.setattr(
        foundation_dataset,
        "find_semantic_neighbors",
        lambda *args, **kwargs: [],
    )
    monkeypatch.setattr(
        foundation_dataset,
        "_development_contamination",
        lambda *args, **kwargs: [],
    )
    monkeypatch.setattr(
        foundation_dataset,
        "partition_keys",
        lambda record: {record["example_id"]},
    )
    monkeypatch.setattr(
        foundation_dataset,
        "audit_curriculum",
        lambda *args, **kwargs: {"pass": True, "issues": []},
    )

    return {
        "train_paths": [train_path],
        "validation_paths": [validation_path],
        "source_artifact_root": source_artifact_root,
        "source_registry_path": source_registry_path,
        "review_ledger_path": review_ledger_path,
        "development_eval_paths": [development["case_path"]],
        "development_eval_identity_path": development["identity_path"],
        "development_eval_manifest_path": development["manifest_path"],
        "generated_at_utc": "2026-07-25T12:00:00Z",
        "hf_token": hf_token,
        "development_eval_remote": remote,
        "project_root": project,
    }


@pytest.mark.parametrize(
    "private_input",
    [
        "train_paths",
        "validation_paths",
        "source_artifact_root",
        "source_registry_path",
        "review_ledger_path",
        "development_eval_paths",
        "development_eval_identity_path",
        "development_eval_manifest_path",
    ],
)
def test_candidate_audit_rejects_every_private_input_inside_public_worktree(
    private_input: str,
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    development = _integration_development_evaluation(tmp_path)
    remote = _RecordingDevelopmentEvalRemote(development["snapshot"])
    kwargs = _candidate_audit_integration_kwargs(
        monkeypatch,
        tmp_path,
        development,
        remote,
        hf_token="hf_explicit_training_read",
    )
    repository = kwargs["project_root"].parents[1]
    unsafe_root = repository / "private-candidate-inputs"
    if private_input == "source_artifact_root":
        unsafe_value = unsafe_root / "source-artifacts"
        unsafe_value.mkdir(parents=True)
    else:
        original = kwargs[private_input]
        original_path = original[0] if isinstance(original, list) else original
        unsafe_value = unsafe_root / f"{private_input}.jsonl"
        unsafe_value.parent.mkdir(parents=True, exist_ok=True)
        unsafe_value.write_bytes(original_path.read_bytes())
        if isinstance(original, list):
            unsafe_value = [unsafe_value]
    kwargs[private_input] = unsafe_value

    with pytest.raises(FoundationDatasetError, match="outside the public Git worktree"):
        foundation_dataset.audit_foundation_candidates(**kwargs)

    assert remote.calls == []


def test_candidate_audit_rejects_symlinked_private_input_before_remote_access(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    development = _integration_development_evaluation(tmp_path)
    remote = _RecordingDevelopmentEvalRemote(development["snapshot"])
    kwargs = _candidate_audit_integration_kwargs(
        monkeypatch,
        tmp_path,
        development,
        remote,
        hf_token="hf_explicit_training_read",
    )
    train_alias = tmp_path / "private-train-alias.jsonl"
    train_alias.symlink_to(kwargs["train_paths"][0])
    kwargs["train_paths"] = [train_alias]

    with pytest.raises(FoundationDatasetError, match="symbolic-link component"):
        foundation_dataset.audit_foundation_candidates(**kwargs)

    assert remote.calls == []


def test_candidate_audit_forwards_explicit_token_and_remote_adapter(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    development = _integration_development_evaluation(tmp_path)
    remote = _RecordingDevelopmentEvalRemote(development["snapshot"])
    kwargs = _candidate_audit_integration_kwargs(
        monkeypatch,
        tmp_path,
        development,
        remote,
        hf_token="hf_explicit_training_read",
    )

    result = foundation_dataset.audit_foundation_candidates(**kwargs)

    assert result.report["pass"] is True
    assert result.report["gates"]["development_evaluation_remote_provenance"] is True
    assert (
        result.report["inputs"]["development_evaluation_sha256"]
        == (development["identity"]["case_files_sha256"])
    )
    assert result.development_evaluation is not None
    assert remote.calls == [
        {
            "repo_id": DEVELOPMENT_EVAL_REPO_ID,
            "repo_type": "dataset",
            "revision": REVISION,
            "requested_paths": frozenset(
                {
                    DEVELOPMENT_EVAL_MANIFEST_PATH,
                    development["case_repo_path"],
                }
            ),
            "token": "hf_explicit_training_read",
        }
    ]


def test_candidate_audit_evidence_is_byte_deterministic(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    development = _integration_development_evaluation(tmp_path)
    remote = _RecordingDevelopmentEvalRemote(development["snapshot"])
    kwargs = _candidate_audit_integration_kwargs(
        monkeypatch,
        tmp_path,
        development,
        remote,
        hf_token="hf_explicit_training_read",
    )

    first = foundation_dataset.audit_foundation_candidates(**kwargs)
    second = foundation_dataset.audit_foundation_candidates(**kwargs)

    first_bytes = foundation_dataset.canonical_json_bytes(first.report)
    second_bytes = foundation_dataset.canonical_json_bytes(second.report)
    assert first_bytes == second_bytes
    assert _sha256(first_bytes) == _sha256(second_bytes)


def test_candidate_audit_consumes_entry_snapshot_during_mutate_restore_race(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    development = _integration_development_evaluation(tmp_path)
    remote = _RecordingDevelopmentEvalRemote(development["snapshot"])
    kwargs = _candidate_audit_integration_kwargs(
        monkeypatch,
        tmp_path,
        development,
        remote,
        hf_token="hf_explicit_training_read",
    )
    train_path = kwargs["train_paths"][0]
    original_train_bytes = train_path.read_bytes()
    original_train_stat = train_path.stat()
    malicious = {
        "example_id": "transient-unapproved-record",
        "metadata": {
            "direct_identifier_scan_version": "scan-v1",
            "source_ids": [],
        },
    }
    capture_inputs = foundation_dataset._capture_inputs

    def capture_then_mutate_train(
        paths: list[Path],
        label: str,
        **kwargs: Any,
    ) -> dict[Path, foundation_dataset.CapturedInput]:
        captured = capture_inputs(paths, label, **kwargs)
        if label == "candidate audit input":
            train_path.write_bytes(foundation_dataset.canonical_jsonl_bytes([malicious]))
        return captured

    restored = False

    def restore_during_validation(*args: Any, **kwargs: Any) -> None:
        nonlocal restored
        if not restored:
            train_path.write_bytes(original_train_bytes)
            os.utime(
                train_path,
                ns=(original_train_stat.st_atime_ns, original_train_stat.st_mtime_ns),
            )
            restored = True

    monkeypatch.setattr(
        foundation_dataset,
        "_capture_inputs",
        capture_then_mutate_train,
    )
    monkeypatch.setattr(
        foundation_dataset,
        "validate_sft_record",
        restore_during_validation,
    )

    result = foundation_dataset.audit_foundation_candidates(**kwargs)

    assert result.report["pass"] is True
    assert result.train_records[0]["example_id"] == "train-integration-001"
    assert b"transient-unapproved-record" not in result.train_bytes
    assert train_path.read_bytes() == original_train_bytes


@pytest.mark.parametrize(
    "failure",
    ["missing", "inaccessible", "mutated", "mismatched"],
)
def test_candidate_audit_fails_closed_when_remote_development_eval_is_unproven(
    failure: str,
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    development = _integration_development_evaluation(tmp_path)
    remote, expected_issue = _remote_failure(development, failure)
    kwargs = _candidate_audit_integration_kwargs(
        monkeypatch,
        tmp_path,
        development,
        remote,
        hf_token="hf_explicit_training_read",
    )

    result = foundation_dataset.audit_foundation_candidates(**kwargs)

    assert result.report["pass"] is False
    assert result.report["gates"]["development_evaluation_remote_provenance"] is False
    assert result.report["gates"]["development_evaluation_contracts"] is False
    assert result.report["gates"]["development_evaluation_identity"] is False
    assert result.report["inputs"]["development_evaluation_sha256"] == "0" * 64
    assert result.development_evaluation is None
    assert any(expected_issue in issue for issue in result.report["issues"])
    assert remote.calls[0]["token"] == "hf_explicit_training_read"


def test_candidate_audit_fails_closed_without_explicit_hf_token(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    development = _integration_development_evaluation(tmp_path)
    remote = _RecordingDevelopmentEvalRemote(development["snapshot"])
    kwargs = _candidate_audit_integration_kwargs(
        monkeypatch,
        tmp_path,
        development,
        remote,
        hf_token="",
    )

    result = foundation_dataset.audit_foundation_candidates(**kwargs)

    assert result.report["pass"] is False
    assert result.report["gates"]["development_evaluation_remote_provenance"] is False
    assert any("explicit Hugging Face token" in issue for issue in result.report["issues"])
    assert remote.calls == []


@pytest.mark.parametrize(
    "failure",
    ["missing-token", "missing", "inaccessible", "mutated", "mismatched"],
)
def test_freeze_fails_closed_before_writing_when_remote_eval_is_unproven(
    failure: str,
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    development = _integration_development_evaluation(tmp_path)
    if failure == "missing-token":
        remote = _RecordingDevelopmentEvalRemote(development["snapshot"])
        hf_token = ""
    else:
        remote, _ = _remote_failure(development, failure)
        hf_token = "hf_explicit_training_read"
    audit_kwargs = _candidate_audit_integration_kwargs(
        monkeypatch,
        tmp_path,
        development,
        remote,
        hf_token=hf_token,
    )
    output_directory = tmp_path / "foundation-v1"
    external_audit_dir = tmp_path / "external-audits"
    external_audit_dir.mkdir()
    candidate_audit_path = tmp_path / "candidate-audit.json"
    approval_path = tmp_path / "approval.json"
    dataset_card_path = tmp_path / "dataset-card.md"
    candidate_audit_path.write_text("{}\n", encoding="utf-8")
    approval_path.write_text("{}\n", encoding="utf-8")
    dataset_card_path.write_text("# Fixture\n", encoding="utf-8")

    with pytest.raises(FoundationDatasetError, match="candidate audit did not pass"):
        freeze_foundation_snapshot(
            **{key: value for key, value in audit_kwargs.items() if key != "generated_at_utc"},
            candidate_audit_path=candidate_audit_path,
            approval_path=approval_path,
            dataset_card_path=dataset_card_path,
            external_audit_dir=external_audit_dir,
            output_directory=output_directory,
        )

    assert not output_directory.exists()
    if failure == "missing-token":
        assert remote.calls == []
    else:
        assert len(remote.calls) == 1
        assert remote.calls[0]["token"] == "hf_explicit_training_read"
