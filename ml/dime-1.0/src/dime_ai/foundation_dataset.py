"""CPU-only audit and freeze controls for the private Foundation v1 dataset."""

from __future__ import annotations

import ctypes
import errno
import hashlib
import json
import os
import re
import shutil
import stat
import sys
import tempfile
from collections import defaultdict
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from functools import cache
from pathlib import Path
from typing import Any

import yaml
from jsonschema import Draft202012Validator, FormatChecker

from dime_ai.data_validation import (
    DataValidationError,
    partition_keys,
    read_jsonl,
    strict_json_loads,
    validate_eval_case,
    validate_sft_record,
    validate_unique_ids,
)
from dime_ai.foundation_contracts import _safe_schema_error_message
from dime_ai.hf_provenance import (
    DevelopmentEvalProvenanceError,
    DevelopmentEvalRemote,
    VerifiedDevelopmentEvaluation,
    verify_development_evaluation_provenance,
)
from dime_ai.market_math import (
    american_to_decimal,
    american_to_implied_probability,
    expected_profit_per_unit,
    market_hold,
    probability_clv,
    remove_vig_from_american,
    roi,
    settled_profit,
)
from dime_ai.program_audit import audit_curriculum

PROJECT_ROOT = Path(__file__).resolve().parents[2]
SCHEMA_ROOT = PROJECT_ROOT / "schemas"
AUDITOR_ID = "dime-foundation-auditor"
AUDITOR_VERSION = "1.0.0"
DATASET_VERSION = "dime-sft-foundation-v1"
RELEASE_INVENTORY = {
    "train.jsonl",
    "validation.jsonl",
    "dataset_manifest.json",
    "dataset_card.md",
    "checksums.json",
}
EXTERNAL_AUDIT_FILES = {
    "semantic_deduplication": "semantic-deduplication.json",
    "privacy_and_identifiers": "privacy-and-identifiers.json",
    "rights": "rights.json",
    "development_evaluation_contamination": "development-evaluation-contamination.json",
    "locked_evaluation_contamination": "locked-evaluation-contamination.json",
    "numeric_traceability": "numeric-traceability.json",
}
SHA256_PATTERN = re.compile(r"^[0-9a-f]{64}$")
TOKEN_PATTERN = re.compile(r"[a-z0-9]+")
NUMERIC_TOKEN_PATTERN = re.compile(
    r"(?<![A-Za-z0-9_])[-+]?(?:\d{1,3}(?:,\d{3})+|\d+|\.\d+)(?:\.\d+)?%?"
    r"(?![A-Za-z0-9_])"
)
REVIEW_PASS_FIELDS = {
    "content_quality_passed",
    "grounding_passed",
    "numeric_trace_passed",
    "policy_behavior_passed",
    "privacy_passed",
    "rights_passed",
}
PLACEHOLDER_IDENTITIES = {
    "",
    "replace_me",
    "reviewer-a",
    "reviewer-b",
    "tbd",
    "unknown",
}
EXTERNAL_AUDIT_REVIEWER_ROLES = {
    "semantic_deduplication": "semantic-audit",
    "privacy_and_identifiers": "privacy",
    "rights": "rights",
    "development_evaluation_contamination": "evaluation-audit",
    "locked_evaluation_contamination": "locked-evaluation",
    "numeric_traceability": "numeric",
}


class FoundationDatasetError(ValueError):
    """Raised when a Foundation v1 candidate cannot advance."""


@dataclass(frozen=True)
class FoundationAuditResult:
    """Validated candidate bytes and their sanitized audit report."""

    train_records: list[dict[str, Any]]
    validation_records: list[dict[str, Any]]
    train_bytes: bytes
    validation_bytes: bytes
    report: dict[str, Any]
    development_evaluation: VerifiedDevelopmentEvaluation | None = None


@dataclass(frozen=True)
class CapturedInput:
    """A stable identity for one governed input during audit or freeze."""

    path: Path
    data: bytes | None
    sha256: str
    identity: tuple[int, int, int, int]


@cache
def _validator(schema_name: str) -> Draft202012Validator:
    schema = json.loads((SCHEMA_ROOT / schema_name).read_text(encoding="utf-8"))
    Draft202012Validator.check_schema(schema)
    return Draft202012Validator(schema, format_checker=FormatChecker())


def _validate_schema(value: dict[str, Any], schema_name: str, label: str) -> None:
    errors = sorted(
        _validator(schema_name).iter_errors(value),
        key=lambda error: (
            tuple(str(item) for item in error.absolute_schema_path),
            str(error.validator),
        ),
    )
    if errors:
        raise FoundationDatasetError(_safe_schema_error_message(errors[0], label=label))


def _regular_file(path: str | Path, label: str) -> Path:
    absolute = Path(path).absolute()
    try:
        resolved = absolute.resolve(strict=True)
    except OSError as exc:
        raise FoundationDatasetError(f"{label} must be a regular file: {absolute}") from exc
    if resolved != absolute or not resolved.is_file():
        raise FoundationDatasetError(
            f"{label} and every ancestor must be regular and non-symlinked: {absolute}"
        )
    return absolute


def _regular_directory(path: str | Path, label: str) -> Path:
    absolute = Path(path).absolute()
    try:
        resolved = absolute.resolve(strict=True)
    except OSError as exc:
        raise FoundationDatasetError(f"{label} must be a directory: {absolute}") from exc
    if resolved != absolute or not resolved.is_dir():
        raise FoundationDatasetError(
            f"{label} and every ancestor must be a non-symlink directory: {absolute}"
        )
    return absolute


def _safe_artifact_path(root: Path, relative_path: str, label: str) -> Path:
    relative = Path(relative_path)
    if relative.is_absolute() or ".." in relative.parts:
        raise FoundationDatasetError(f"{label} must be a safe relative path")
    current = root
    for part in relative.parts:
        current = current / part
        if current.is_symlink():
            raise FoundationDatasetError(f"{label} contains a symlink: {current}")
    resolved_root = root.resolve()
    resolved = current.resolve()
    if not resolved.is_relative_to(resolved_root):
        raise FoundationDatasetError(f"{label} escapes the source artifact root")
    return _regular_file(resolved, label)


def load_json_document(
    path: str | Path,
    *,
    schema_name: str | None = None,
    label: str | None = None,
) -> dict[str, Any]:
    source = _regular_file(path, label or "JSON document")
    try:
        text = source.read_text(encoding="utf-8")
    except UnicodeDecodeError as exc:
        raise FoundationDatasetError(f"{source}: invalid UTF-8") from exc
    try:
        value = strict_json_loads(text, str(source))
    except (DataValidationError, json.JSONDecodeError) as exc:
        raise FoundationDatasetError(str(exc)) from exc
    if not isinstance(value, dict):
        raise FoundationDatasetError(f"{source}: expected a JSON object")
    if schema_name is not None:
        _validate_schema(value, schema_name, label or str(source))
    return value


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def sha256_file(path: str | Path) -> str:
    source = _regular_file(path, "hash input")
    digest = hashlib.sha256()
    with source.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _capture_input(
    path: str | Path,
    label: str,
    *,
    retain_data: bool = True,
) -> CapturedInput:
    source = _regular_file(path, label)
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
    descriptor = os.open(source, flags)
    try:
        before = os.fstat(descriptor)
        if not stat.S_ISREG(before.st_mode):
            raise FoundationDatasetError(f"{label} must be a regular file: {source}")
        digest = hashlib.sha256()
        chunks: list[bytes] = []
        bytes_read = 0
        while True:
            chunk = os.read(descriptor, 1024 * 1024)
            if not chunk:
                break
            digest.update(chunk)
            if retain_data:
                chunks.append(chunk)
            bytes_read += len(chunk)
        after = os.fstat(descriptor)
    finally:
        os.close(descriptor)
    before_identity = (
        before.st_dev,
        before.st_ino,
        before.st_size,
        before.st_mtime_ns,
    )
    after_identity = (
        after.st_dev,
        after.st_ino,
        after.st_size,
        after.st_mtime_ns,
    )
    if before_identity != after_identity or bytes_read != after.st_size:
        raise FoundationDatasetError(f"{label} changed while it was being captured")
    return CapturedInput(
        path=source,
        data=b"".join(chunks) if retain_data else None,
        sha256=digest.hexdigest(),
        identity=after_identity,
    )


def _capture_inputs(
    paths: list[Path],
    label: str,
    *,
    retain_data_paths: set[Path] | None = None,
) -> dict[Path, CapturedInput]:
    captured: dict[Path, CapturedInput] = {}
    retained = (
        {path.absolute() for path in retain_data_paths} if retain_data_paths is not None else None
    )
    for path in paths:
        item = _capture_input(
            path,
            label,
            retain_data=retained is None or path.absolute() in retained,
        )
        if item.path in captured:
            continue
        captured[item.path] = item
    return captured


def _assert_inputs_unchanged(
    captured: dict[Path, CapturedInput],
    label: str,
) -> None:
    for expected in captured.values():
        current = _capture_input(expected.path, label, retain_data=False)
        if current.identity != expected.identity or current.sha256 != expected.sha256:
            raise FoundationDatasetError(f"{label} changed after validation: {expected.path}")


def _captured_input(
    captured: dict[Path, CapturedInput],
    path: str | Path,
    label: str,
) -> CapturedInput:
    source = Path(path).absolute()
    try:
        return captured[source]
    except KeyError as exc:
        raise FoundationDatasetError(f"{label} was not captured: {source}") from exc


def _captured_text(
    captured: dict[Path, CapturedInput],
    path: str | Path,
    label: str,
) -> str:
    data = _captured_input(captured, path, label).data
    if data is None:
        raise FoundationDatasetError(f"{label} bytes were not retained")
    try:
        return data.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise FoundationDatasetError(f"{label} is invalid UTF-8") from exc


def _captured_json_document(
    captured: dict[Path, CapturedInput],
    path: str | Path,
    *,
    schema_name: str | None = None,
    label: str,
) -> dict[str, Any]:
    text = _captured_text(captured, path, label)
    try:
        value = strict_json_loads(text, label)
    except (DataValidationError, json.JSONDecodeError) as exc:
        raise FoundationDatasetError(str(exc)) from exc
    if not isinstance(value, dict):
        raise FoundationDatasetError(f"{label}: expected a JSON object")
    if schema_name is not None:
        _validate_schema(value, schema_name, label)
    return value


def _captured_jsonl_records(
    captured: dict[Path, CapturedInput],
    paths: list[Path],
    label: str,
) -> list[dict[str, Any]]:
    if not paths:
        raise FoundationDatasetError(f"{label} requires at least one JSONL shard")
    records: list[dict[str, Any]] = []
    for path in paths:
        text = _captured_text(captured, path, f"{label} shard")
        shard_records: list[dict[str, Any]] = []
        for line_number, line in enumerate(text.splitlines(), 1):
            if not line.strip():
                continue
            try:
                record = strict_json_loads(line, f"{path}:{line_number}")
            except (DataValidationError, json.JSONDecodeError) as exc:
                raise FoundationDatasetError(str(exc)) from exc
            if not isinstance(record, dict):
                raise FoundationDatasetError(f"{path}:{line_number}: each line must be an object")
            shard_records.append(record)
        if not shard_records:
            raise FoundationDatasetError(f"{path}: file has no records")
        records.extend(shard_records)
    return records


def _captured_sha256(
    captured: dict[Path, CapturedInput],
    path: str | Path,
    label: str,
) -> str:
    return _captured_input(captured, path, label).sha256


def _captured_tree(
    captured: dict[Path, CapturedInput],
    root: Path,
) -> dict[Path, CapturedInput]:
    absolute_root = root.absolute()
    return {path: item for path, item in captured.items() if path.is_relative_to(absolute_root)}


def _assert_tree_inventory_unchanged(
    root: Path,
    captured: dict[Path, CapturedInput],
    label: str,
) -> None:
    expected = set(_captured_tree(captured, root))
    actual = set(_regular_tree_files(root, label))
    if actual != expected:
        raise FoundationDatasetError(f"{label} inventory changed after validation")


def _regular_tree_files(root: Path, label: str) -> list[Path]:
    directory = _regular_directory(root, label)
    files: list[Path] = []
    for path in sorted(directory.rglob("*"), key=lambda item: str(item)):
        if path.is_symlink():
            raise FoundationDatasetError(f"{label} contains a symlink: {path}")
        if path.is_file():
            files.append(_regular_file(path, label))
        elif not path.is_dir():
            raise FoundationDatasetError(f"{label} contains a non-regular entry: {path}")
    return files


def canonical_json_bytes(value: Any) -> bytes:
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


def canonical_record_sha256(record: dict[str, Any]) -> str:
    return sha256_bytes(canonical_json_bytes(record))


def canonical_jsonl_bytes(records: list[dict[str, Any]]) -> bytes:
    ordered = sorted(records, key=lambda record: str(record.get("example_id", "")))
    return b"".join(canonical_json_bytes(record) for record in ordered)


def _parse_utc(value: Any, label: str) -> datetime:
    if not isinstance(value, str):
        raise FoundationDatasetError(f"{label} must be a canonical ISO-8601 UTC string ending in Z")
    if not value.endswith("Z"):
        try:
            datetime.fromisoformat(value)
        except ValueError as exc:
            raise FoundationDatasetError(f"{label} is not a valid timestamp") from exc
        raise FoundationDatasetError(f"{label} must be a canonical ISO-8601 UTC string ending in Z")
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise FoundationDatasetError(f"{label} is not a valid timestamp") from exc
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise FoundationDatasetError(f"{label} must include a UTC offset")
    if parsed.utcoffset().total_seconds() != 0:
        raise FoundationDatasetError(f"{label} must be normalized to UTC")
    return parsed.astimezone(UTC)


def _utc_now() -> datetime:
    return datetime.now(UTC)


def _reject_future_timestamp(
    value: datetime,
    label: str,
    *,
    now: datetime | None = None,
) -> None:
    if value > (now or _utc_now()) + timedelta(minutes=5):
        raise FoundationDatasetError(f"{label} cannot be in the future")


def _require_fresh(
    value: datetime,
    *,
    label: str,
    maximum_age: timedelta,
    now: datetime | None = None,
) -> None:
    reference = now or _utc_now()
    _reject_future_timestamp(value, label, now=reference)
    if reference - value > maximum_age:
        raise FoundationDatasetError(f"{label} is stale")


def _valid_identity(value: Any) -> bool:
    return (
        isinstance(value, str)
        and value.strip().lower() not in PLACEHOLDER_IDENTITIES
        and "replace" not in value.strip().lower()
    )


def trusted_reviewer_index(registry: dict[str, Any]) -> dict[str, dict[str, Any]]:
    """Resolve reviewer authority only from the Git-controlled registry."""

    _validate_schema(
        registry,
        "foundation_reviewer_registry.schema.json",
        "foundation reviewer registry",
    )
    if registry["status"] != "active":
        raise FoundationDatasetError(
            "foundation reviewer registry must be independently reviewed and active"
        )
    reviewers: dict[str, dict[str, Any]] = {}
    agent_profile_ids: set[str] = set()
    receipt_issuer_key_ids: set[str] = set()
    active_agent_ids: list[str] = []
    for reviewer in registry["reviewers"]:
        reviewer_id = reviewer["reviewer_id"]
        if reviewer_id in reviewers:
            raise FoundationDatasetError(f"duplicate trusted reviewer_id: {reviewer_id}")
        if not _valid_identity(reviewer_id):
            raise FoundationDatasetError(
                "trusted reviewer registry contains a placeholder identity"
            )
        _reviewer_authority_period(
            reviewer,
            label=f"trusted reviewer {reviewer_id}",
        )
        if reviewer["principal_type"] == "ai_agent":
            profile = reviewer["agent_profile"]
            profile_id = profile["profile_id"]
            if profile_id in agent_profile_ids:
                raise FoundationDatasetError(f"duplicate trusted AI-agent profile_id: {profile_id}")
            agent_profile_ids.add(profile_id)
            key_id = profile["receipt_issuer_key_id"]
            if key_id is not None and key_id in receipt_issuer_key_ids:
                raise FoundationDatasetError(
                    f"duplicate trusted AI-agent receipt issuer key: {key_id}"
                )
            if key_id is not None:
                receipt_issuer_key_ids.add(key_id)
            if reviewer["active"]:
                active_agent_ids.append(reviewer_id)
        reviewers[reviewer_id] = reviewer
    if not reviewers:
        raise FoundationDatasetError("active reviewer registry cannot be empty")
    if active_agent_ids:
        raise FoundationDatasetError(
            "AI-agent reviewer activation requires a cryptographic "
            "decision-receipt verifier; activation remains blocked"
        )
    return reviewers


def _reviewer_authority_period(
    reviewer: dict[str, Any],
    *,
    label: str,
) -> tuple[datetime, datetime | None]:
    start = _parse_utc(reviewer.get("effective_start"), f"{label}.effective_start")
    raw_end = reviewer.get("effective_end_or_open_ended")
    end = None if raw_end is None else _parse_utc(raw_end, f"{label}.effective_end_or_open_ended")
    if end is not None and end <= start:
        raise FoundationDatasetError(
            f"{label}: effective authority end must be later than its start"
        )
    return start, end


def _require_reviewer_authority(
    reviewer_index: dict[str, dict[str, Any]],
    reviewer_id: str,
    *,
    event_at: datetime,
    label: str,
    required_role: str | None = None,
) -> dict[str, Any]:
    reviewer = reviewer_index.get(reviewer_id)
    if reviewer is None or not reviewer["active"]:
        if required_role is None:
            raise FoundationDatasetError(f"inactive or unknown reviewer: {reviewer_id}")
        raise FoundationDatasetError(f"{label}: reviewer lacks active {required_role} role")
    if required_role is not None and required_role not in reviewer["roles"]:
        raise FoundationDatasetError(f"{label}: reviewer lacks active {required_role} role")
    start, end = _reviewer_authority_period(
        reviewer,
        label=f"{label} reviewer {reviewer_id}",
    )
    if event_at < start or (end is not None and event_at >= end):
        raise FoundationDatasetError(
            f"{label}: reviewer {reviewer_id} is outside their authority period"
        )
    return reviewer


def _require_independent_reviewer_groups(
    reviewer_ids: set[str],
    reviewer_index: dict[str, dict[str, Any]],
    *,
    minimum: int,
    label: str,
) -> None:
    groups = {reviewer_index[reviewer_id]["independence_group_id"] for reviewer_id in reviewer_ids}
    model_lineages = {
        _reviewer_lineage_keys(reviewer_index[reviewer_id])[0] for reviewer_id in reviewer_ids
    }
    policy_lineages = {
        _reviewer_lineage_keys(reviewer_index[reviewer_id])[1] for reviewer_id in reviewer_ids
    }
    if min(len(groups), len(model_lineages), len(policy_lineages)) < minimum:
        raise FoundationDatasetError(
            f"{label}: requires at least {minimum} distinct reviewer independence groups"
        )


def _reviewer_lineage_keys(reviewer: dict[str, Any]) -> tuple[str, str]:
    if reviewer.get("principal_type", "human") != "ai_agent":
        key = f"human:{reviewer['reviewer_id']}"
        return key, key
    profile = reviewer.get("agent_profile")
    if not isinstance(profile, dict):
        key = f"ai_agent:{reviewer['reviewer_id']}"
        return key, key
    model_lineage = {
        field: profile.get(field)
        for field in (
            "model_provider",
            "model_id",
            "model_revision",
        )
    }
    policy_lineage = {
        field: profile.get(field)
        for field in (
            "system_instruction_sha256",
            "tool_contract_sha256",
            "inference_policy_sha256",
        )
    }
    return (
        f"ai_model:{sha256_bytes(canonical_json_bytes(model_lineage))}",
        f"ai_policy:{sha256_bytes(canonical_json_bytes(policy_lineage))}",
    )


def _require_agent_decision_receipts(
    reviewer_ids: set[str],
    reviewer_index: dict[str, dict[str, Any]],
    receipts: dict[str, str] | None,
    *,
    label: str,
) -> None:
    required_ids = {
        reviewer_id
        for reviewer_id in reviewer_ids
        if reviewer_index[reviewer_id].get("principal_type", "human") == "ai_agent"
    }
    supplied = receipts or {}
    if set(supplied) != required_ids:
        raise FoundationDatasetError(
            f"{label}: AI-agent receipt IDs must exactly match AI-agent reviewer IDs"
        )
    if any(not SHA256_PATTERN.fullmatch(value) for value in supplied.values()):
        raise FoundationDatasetError(
            f"{label}: AI-agent decision receipts must be lowercase SHA-256 digests"
        )
    if len(set(supplied.values())) != len(supplied):
        raise FoundationDatasetError(
            f"{label}: one AI-agent decision receipt cannot represent multiple principals"
        )


def _validate_dataset_approver_authority(
    approver_ids: list[str],
    reviewer_index: dict[str, dict[str, Any]],
    *,
    approval_time: datetime,
    candidate_author_ids: set[str],
    agent_decision_receipts: dict[str, str] | None = None,
) -> None:
    approver_set = set(approver_ids)
    for approver_id in approver_ids:
        _require_reviewer_authority(
            reviewer_index,
            approver_id,
            event_at=approval_time,
            label="dataset approval",
            required_role="dataset-approver",
        )
    _require_independent_reviewer_groups(
        approver_set,
        reviewer_index,
        minimum=2,
        label="dataset approval",
    )
    _require_agent_decision_receipts(
        approver_set,
        reviewer_index,
        agent_decision_receipts,
        label="dataset approval",
    )
    overlapping_authors = sorted(approver_set & candidate_author_ids)
    if overlapping_authors:
        raise FoundationDatasetError("dataset approval cannot be granted by a candidate author")


def _load_shards(paths: list[Path], label: str) -> list[dict[str, Any]]:
    if not paths:
        raise FoundationDatasetError(f"{label} requires at least one JSONL shard")
    records: list[dict[str, Any]] = []
    for path in paths:
        records.extend(read_jsonl(_regular_file(path, f"{label} shard")))
    return records


def _normalized_text(value: str) -> str:
    return " ".join(TOKEN_PATTERN.findall(value.casefold()))


def _normalized_tool_result(value: str) -> Any:
    try:
        parsed = strict_json_loads(value, "tool result")
    except (DataValidationError, json.JSONDecodeError):
        return _normalized_text(value)
    if not isinstance(parsed, dict):
        return parsed
    sanitized = {
        key: item for key, item in parsed.items() if key not in {"as_of_utc", "source_ids"}
    }
    return sanitized


def normalized_message_signature(record: dict[str, Any]) -> str:
    """Normalize content while discarding linkage IDs and volatile source timestamps."""

    rendered: list[dict[str, Any]] = []
    for message in record.get("messages", []):
        item: dict[str, Any] = {
            "role": message.get("role"),
            "content": _normalized_text(str(message.get("content", ""))),
        }
        calls = message.get("tool_calls", [])
        if calls:
            item["tool_calls"] = [
                {
                    "name": call.get("function", {}).get("name"),
                    "arguments": call.get("function", {}).get("arguments"),
                }
                for call in calls
            ]
        if message.get("role") == "tool":
            item["name"] = message.get("name")
            item["result"] = _normalized_tool_result(str(message.get("content", "")))
        rendered.append(item)
    return json.dumps(rendered, ensure_ascii=False, separators=(",", ":"), sort_keys=True)


def _shingles(signature: str, size: int) -> frozenset[tuple[str, ...]]:
    tokens = TOKEN_PATTERN.findall(signature.casefold())
    if not tokens:
        return frozenset()
    if len(tokens) < size:
        return frozenset({tuple(tokens)})
    return frozenset(tuple(tokens[index : index + size]) for index in range(len(tokens) - size + 1))


def find_exact_duplicates(records: list[dict[str, Any]]) -> list[list[str]]:
    groups: dict[str, list[str]] = defaultdict(list)
    for record in records:
        groups[normalized_message_signature(record)].append(str(record["example_id"]))
    return [sorted(ids) for ids in groups.values() if len(ids) > 1]


def find_semantic_neighbors(
    records: list[dict[str, Any]],
    *,
    shingle_size: int,
    threshold: float,
    maximum_results: int = 100,
) -> list[dict[str, Any]]:
    """Deterministic near-duplicate triage; independent semantic review is still required."""

    postings: dict[tuple[str, ...], set[int]] = defaultdict(set)
    sets: list[frozenset[tuple[str, ...]]] = []
    results: list[dict[str, Any]] = []
    for right, record in enumerate(records):
        current = _shingles(normalized_message_signature(record), shingle_size)
        candidates: set[int] = set()
        for shingle in current:
            candidates.update(postings[shingle])
        for left in sorted(candidates):
            prior = sets[left]
            union = current | prior
            similarity = len(current & prior) / len(union) if union else 1.0
            if similarity >= threshold:
                results.append(
                    {
                        "left": str(records[left]["example_id"]),
                        "right": str(record["example_id"]),
                        "similarity": round(similarity, 8),
                    }
                )
                if len(results) >= maximum_results:
                    return results
        sets.append(current)
        for shingle in current:
            postings[shingle].add(right)
    return results


def _development_contamination(
    records: list[dict[str, Any]],
    evaluation_records: list[dict[str, Any]],
    *,
    shingle_size: int,
    threshold: float,
) -> list[dict[str, Any]]:
    if not evaluation_records:
        return [{"error": "no development evaluation records supplied"}]

    def prompt_windows(record: dict[str, Any]) -> list[str]:
        windows = [
            _normalized_text(str(message.get("content", "")))
            for message in record.get("messages", [])
            if message.get("role") == "user"
        ]
        return [window for window in windows if window]

    evaluation_windows = [
        (index, window)
        for index, record in enumerate(evaluation_records)
        for window in prompt_windows(record)
    ]
    if not evaluation_windows:
        return [{"error": "development evaluation has no user prompt windows"}]
    matches: list[dict[str, Any]] = []
    for record in records:
        for candidate_window in prompt_windows(record):
            candidate = _shingles(candidate_window, shingle_size)
            for index, reference_window in evaluation_windows:
                reference = _shingles(reference_window, shingle_size)
                exact = candidate_window == reference_window
                union = candidate | reference
                similarity = len(candidate & reference) / len(union) if union else 1.0
                if exact or similarity >= threshold:
                    matches.append(
                        {
                            "example_id": str(record["example_id"]),
                            "evaluation_case_id": str(
                                evaluation_records[index].get("case_id", f"case-{index}")
                            ),
                            "exact_prompt_copy": exact,
                            "similarity": round(similarity, 8),
                        }
                    )
                    if len(matches) >= 100:
                        return matches
    return matches


def validate_source_registry(
    registry: dict[str, Any],
    build_config: dict[str, Any],
    *,
    effective_at: datetime,
    source_artifact_root: Path,
    captured_inputs: dict[Path, CapturedInput] | None = None,
) -> tuple[dict[str, dict[str, Any]], str]:
    _validate_schema(
        registry,
        "foundation_source_registry.schema.json",
        "foundation source registry",
    )
    registry_generated_at = _parse_utc(
        registry["generated_at_utc"],
        "source_registry.generated_at_utc",
    )
    if registry_generated_at > effective_at:
        raise FoundationDatasetError("source registry was generated after the audit cutoff")
    artifact_root = _regular_directory(source_artifact_root, "source artifact root")
    allowed = set(build_config["source_policy"]["allowed_source_classes"])
    source_index: dict[str, dict[str, Any]] = {}
    snapshot_ids: set[str] = set()
    artifact_hashes: dict[str, str] = {}
    for source in registry["sources"]:
        source_id = source["source_id"]
        if source_id in source_index:
            raise FoundationDatasetError(f"duplicate source_id: {source_id}")
        if source["snapshot_id"] in snapshot_ids:
            raise FoundationDatasetError(f"duplicate snapshot_id: {source['snapshot_id']}")
        snapshot_ids.add(source["snapshot_id"])
        if source["source_class"] not in allowed:
            raise FoundationDatasetError(
                f"{source_id}: source class {source['source_class']} is not allowed"
            )
        if source["contains_user_data"] or source["contains_provider_derived_data"]:
            raise FoundationDatasetError(
                f"{source_id}: Foundation v1 excludes user and provider-derived data"
            )
        if not source["ml_training_permitted"] or not source["derivative_use_permitted"]:
            raise FoundationDatasetError(f"{source_id}: training/derivative rights are incomplete")
        expires = source.get("expires_at_utc")
        if (
            expires is not None
            and _parse_utc(expires, f"{source_id}.expires_at_utc") <= effective_at
        ):
            raise FoundationDatasetError(f"{source_id}: source rights have expired")
        available = _parse_utc(source["available_at_utc"], f"{source_id}.available_at_utc")
        snapshot = _parse_utc(source["snapshot_at_utc"], f"{source_id}.snapshot_at_utc")
        reviewed = _parse_utc(source["reviewed_at_utc"], f"{source_id}.reviewed_at_utc")
        if available > snapshot:
            raise FoundationDatasetError(
                f"{source_id}: available_at_utc cannot follow snapshot_at_utc"
            )
        if snapshot > effective_at:
            raise FoundationDatasetError(f"{source_id}: snapshot_at_utc is after the audit cutoff")
        if reviewed < snapshot:
            raise FoundationDatasetError(
                f"{source_id}: rights review predates the immutable source snapshot"
            )
        if reviewed > effective_at:
            raise FoundationDatasetError(f"{source_id}: rights review is after the audit cutoff")
        if reviewed > registry_generated_at:
            raise FoundationDatasetError(f"{source_id}: source registry predates its rights review")
        if any(not _valid_identity(value) for value in source["reviewer_ids"]):
            raise FoundationDatasetError(f"{source_id}: source reviewers contain placeholders")
        snapshot_file = source["snapshot_file"]
        if snapshot_file in artifact_hashes:
            raise FoundationDatasetError(
                f"{source_id}: duplicate source snapshot_file {snapshot_file}"
            )
        artifact = _safe_artifact_path(
            artifact_root,
            snapshot_file,
            f"{source_id}.snapshot_file",
        )
        artifact_hash = (
            _captured_sha256(
                captured_inputs,
                artifact,
                f"{source_id}.snapshot_file",
            )
            if captured_inputs is not None
            else sha256_file(artifact)
        )
        if artifact_hash != source["snapshot_sha256"]:
            raise FoundationDatasetError(
                f"{source_id}: source snapshot bytes do not match snapshot_sha256"
            )
        artifact_hashes[snapshot_file] = artifact_hash
        source_index[source_id] = source

    if captured_inputs is not None:
        actual_files = {
            path.relative_to(artifact_root).as_posix()
            for path in _captured_tree(captured_inputs, artifact_root)
        }
    else:
        actual_files = set()
        for path in artifact_root.rglob("*"):
            if path.is_symlink():
                raise FoundationDatasetError(f"source artifact root contains a symlink: {path}")
            if path.is_file():
                actual_files.add(path.relative_to(artifact_root).as_posix())
            elif not path.is_dir():
                raise FoundationDatasetError(
                    f"source artifact root contains a non-regular entry: {path}"
                )
    expected_files = set(artifact_hashes)
    if actual_files != expected_files:
        raise FoundationDatasetError(
            "source artifact inventory mismatch: "
            f"expected {sorted(expected_files)}, got {sorted(actual_files)}"
        )
    return source_index, sha256_bytes(canonical_json_bytes(artifact_hashes))


def validate_record_sources(
    record: dict[str, Any],
    source_index: dict[str, dict[str, Any]],
    *,
    effective_at: datetime,
) -> None:
    record_id = str(record["example_id"])
    metadata = record["metadata"]
    sources = []
    for source_id in metadata["source_ids"]:
        source = source_index.get(source_id)
        if source is None:
            raise FoundationDatasetError(f"{record_id}: unknown source_id {source_id}")
        sources.append(source)
    if not sources:
        raise FoundationDatasetError(f"{record_id}: at least one source is required")
    owners = {source["source_owner"] for source in sources}
    rights = {source["rights_record_id"] for source in sources}
    classes = {source["source_class"] for source in sources}
    if len(owners) != 1 or metadata.get("source_owner") not in owners:
        raise FoundationDatasetError(f"{record_id}: source_owner does not match the registry")
    if len(rights) != 1 or metadata.get("rights_basis") not in rights:
        raise FoundationDatasetError(f"{record_id}: rights_basis must name the registry record")
    if len(classes) != 1 or metadata.get("generation_method") not in classes:
        raise FoundationDatasetError(f"{record_id}: generation_method does not match source class")
    expected_available = max(
        _parse_utc(source["available_at_utc"], f"{record_id}.source.available_at_utc")
        for source in sources
    )
    record_available = _parse_utc(
        metadata["available_at_utc"],
        f"{record_id}.metadata.available_at_utc",
    )
    if record_available != expected_available:
        raise FoundationDatasetError(
            f"{record_id}: available_at_utc must equal the latest source availability"
        )
    snapshots = {source["snapshot_id"] for source in sources}
    if metadata.get("source_snapshot_partition_key") not in snapshots:
        raise FoundationDatasetError(
            f"{record_id}: source_snapshot_partition_key must resolve to a source snapshot"
        )
    if classes == {"synthetic"} and metadata["synthetic_or_deidentified"] != "synthetic":
        raise FoundationDatasetError(f"{record_id}: synthetic source has the wrong privacy label")
    if metadata["contains_user_data"]:
        raise FoundationDatasetError(f"{record_id}: Foundation v1 cannot contain user data")
    as_of = _parse_utc(metadata["as_of_utc"], f"{record_id}.metadata.as_of_utc")
    if as_of > effective_at:
        raise FoundationDatasetError(f"{record_id}: as_of_utc is after the audit cutoff")


def _flatten_decimal_values(
    value: Any,
    prefix: tuple[str, ...] = (),
) -> dict[tuple[str, ...], Decimal]:
    flattened: dict[tuple[str, ...], Decimal] = {}
    if isinstance(value, dict):
        for key, item in value.items():
            flattened.update(_flatten_decimal_values(item, (*prefix, str(key))))
    else:
        try:
            number = Decimal(str(value))
        except Exception as exc:  # noqa: BLE001 - normalized as a validation failure
            raise FoundationDatasetError(
                f"non-numeric market-math output at {'.'.join(prefix)}"
            ) from exc
        if not number.is_finite():
            raise FoundationDatasetError(f"non-finite market-math output at {'.'.join(prefix)}")
        flattened[prefix] = number
    return flattened


def _flatten_numeric_leaves(
    value: Any,
    prefix: tuple[str, ...] = (),
) -> dict[tuple[str, ...], Decimal]:
    """Return numeric JSON leaves while ignoring nonnumeric evidence fields."""

    flattened: dict[tuple[str, ...], Decimal] = {}
    if isinstance(value, dict):
        for key, item in value.items():
            flattened.update(_flatten_numeric_leaves(item, (*prefix, str(key))))
        return flattened
    if isinstance(value, list):
        for index, item in enumerate(value):
            flattened.update(_flatten_numeric_leaves(item, (*prefix, str(index))))
        return flattened
    if isinstance(value, bool) or value is None:
        return flattened
    try:
        number = Decimal(str(value))
    except Exception:  # noqa: BLE001 - a nonnumeric leaf is valid tool evidence
        return flattened
    if number.is_finite():
        flattened[prefix] = number
    return flattened


def _expected_market_math(call: dict[str, Any]) -> tuple[dict[str, Any], dict[str, str]]:
    arguments = call["function"]["arguments"]
    operation = arguments["operation"]
    inputs = arguments["inputs"]
    units: dict[str, str] = {}
    if operation == "implied_probability":
        probability = american_to_implied_probability(inputs["american_odds"])
        expected = {"implied_probability": probability}
        units["implied_probability"] = "probability"
    elif operation in {"remove_vig", "market_hold"}:
        odds = inputs["american_odds"]
        raw = {key: american_to_implied_probability(value) for key, value in odds.items()}
        expected = {
            "raw_probabilities": raw,
            "hold": market_hold(raw),
        }
        units["hold"] = "probability"
        units.update({f"raw_probabilities.{key}": "probability" for key in raw})
        if operation == "remove_vig":
            no_vig = remove_vig_from_american(odds)
            expected["no_vig_probabilities"] = no_vig
            units.update({f"no_vig_probabilities.{key}": "probability" for key in no_vig})
    elif operation == "expected_value":
        decimal_odds = american_to_decimal(inputs["american_odds"])
        value = expected_profit_per_unit(inputs["probability"], decimal_odds)
        expected = {
            "decimal_odds": decimal_odds,
            "expected_profit_per_unit": value,
            "expected_roi": value,
        }
        units.update(
            {
                "decimal_odds": "decimal_odds",
                "expected_profit_per_unit": "units",
                "expected_roi": "roi",
            }
        )
    elif operation == "settled_profit":
        decimal_odds = american_to_decimal(inputs["american_odds"])
        expected = {
            "decimal_odds": decimal_odds,
            "settled_profit": settled_profit(
                inputs["stake"],
                decimal_odds,
                inputs["result"],
            ),
        }
        units.update({"decimal_odds": "decimal_odds", "settled_profit": "units"})
    elif operation == "roi":
        expected = {"roi": roi(inputs["profits"], inputs["stakes"])}
        units["roi"] = "roi"
    elif operation == "probability_clv":
        entry = remove_vig_from_american(inputs["entry_market_odds"])
        close = remove_vig_from_american(inputs["closing_market_odds"])
        selection = inputs["backed_selection"]
        expected = {
            "entry_no_vig_probability": entry[selection],
            "closing_no_vig_probability": close[selection],
            "probability_clv": probability_clv(
                inputs["entry_market_odds"],
                inputs["closing_market_odds"],
                selection,
            ),
        }
        units.update(
            {
                "entry_no_vig_probability": "probability",
                "closing_no_vig_probability": "probability",
                "probability_clv": "probability",
            }
        )
    else:
        raise FoundationDatasetError(f"unsupported market-math operation: {operation}")
    return expected, units


def _decimal_close(actual: Any, expected: Decimal, tolerance: Decimal) -> bool:
    try:
        value = Decimal(str(actual))
    except Exception:  # noqa: BLE001 - normalized below as a validation failure
        return False
    return value.is_finite() and abs(value - expected) <= tolerance


def _formatted_numeric_value(
    formatted_value: str,
    *,
    unit: str,
    record_id: str,
    source_path: str,
) -> Decimal:
    tokens = list(NUMERIC_TOKEN_PATTERN.finditer(formatted_value))
    if len(tokens) != 1:
        raise FoundationDatasetError(
            f"{record_id}: numeric assertion {source_path} formatted_value "
            "must contain exactly one numeric token"
        )
    token = tokens[0].group(0)
    percentage = token.endswith("%")
    normalized = token.removesuffix("%").replace(",", "")
    try:
        value = Decimal(normalized)
    except Exception as exc:  # noqa: BLE001 - normalized as a validation failure
        raise FoundationDatasetError(
            f"{record_id}: numeric assertion {source_path} has invalid formatted_value"
        ) from exc
    if percentage:
        if unit not in {"probability", "roi"}:
            raise FoundationDatasetError(
                f"{record_id}: numeric assertion {source_path} cannot format {unit} as a percent"
            )
        value /= Decimal(100)
    return value


def validate_numeric_traceability(
    record: dict[str, Any],
    build_config: dict[str, Any],
) -> None:
    record_id = str(record["example_id"])
    calls: dict[str, dict[str, Any]] = {}
    results: dict[str, dict[str, Any]] = {}
    for message in record["messages"]:
        for call in message.get("tool_calls", []):
            if call["id"] in calls:
                raise FoundationDatasetError(f"{record_id}: duplicate tool call ID")
            calls[call["id"]] = call
        if message.get("role") == "tool":
            call_id = message["tool_call_id"]
            if call_id in results:
                raise FoundationDatasetError(f"{record_id}: duplicate tool result for {call_id}")
            try:
                content = strict_json_loads(
                    message["content"],
                    f"{record_id}.tool_result",
                )
            except (DataValidationError, json.JSONDecodeError) as exc:
                raise FoundationDatasetError(str(exc)) from exc
            if not isinstance(content, dict):
                raise FoundationDatasetError(f"{record_id}: tool result must be a JSON object")
            results[message["tool_call_id"]] = content

    traceable_assertions: dict[str, tuple[Decimal, str | None]] = {}
    required_assertion_paths: set[str] = set()
    for call_id, call in calls.items():
        result = results.get(call_id)
        if result is None or result.get("status") != "ok":
            continue
        if not isinstance(result.get("data"), dict):
            raise FoundationDatasetError(
                f"{record_id}: successful tool result requires object data for {call_id}"
            )
        for path, value in _flatten_numeric_leaves(result["data"]).items():
            dotted = ".".join(path)
            traceable_assertions[f"tool:{call_id}:data.{dotted}"] = (value, None)

        if call["function"]["name"] != "calculate_market_math":
            continue
        expected, units = _expected_market_math(call)
        expected_values = _flatten_decimal_values(expected)
        output = result["data"].get("output")
        if not isinstance(output, dict):
            raise FoundationDatasetError(
                f"{record_id}: market-math result requires operation-specific output"
            )
        result_values = _flatten_decimal_values(output)
        if set(result_values) != set(expected_values):
            expected_paths = sorted(".".join(path) for path in expected_values)
            actual_paths = sorted(".".join(path) for path in result_values)
            raise FoundationDatasetError(
                f"{record_id}: market-math result key inventory mismatch; "
                f"expected {expected_paths}, got {actual_paths}"
            )
        for path, expected_value in expected_values.items():
            dotted = ".".join(path)
            if not _decimal_close(
                result_values[path],
                expected_value,
                Decimal("1e-9"),
            ):
                raise FoundationDatasetError(
                    f"{record_id}: market-math result mismatch at data.{dotted}"
                )
            assertion_path = f"tool:{call_id}:data.output.{dotted}"
            traceable_assertions[assertion_path] = (expected_value, units[dotted])
            required_assertion_paths.add(assertion_path)

    if record["task_type"] == "market_math" and not required_assertion_paths:
        raise FoundationDatasetError(
            f"{record_id}: market_math requires a successful calculate_market_math result"
        )
    assertions = {
        assertion["source_path"]: assertion for assertion in record.get("numeric_assertions", [])
    }
    assertion_paths = [
        assertion["source_path"] for assertion in record.get("numeric_assertions", [])
    ]
    if len(assertion_paths) != len(set(assertion_paths)):
        raise FoundationDatasetError(f"{record_id}: duplicate numeric assertion source path")
    missing = sorted(required_assertion_paths - set(assertions))
    if missing:
        raise FoundationDatasetError(
            f"{record_id}: numeric assertions do not cover recomputed outputs: {missing}"
        )
    unexpected = sorted(set(assertions) - set(traceable_assertions))
    if unexpected:
        raise FoundationDatasetError(
            f"{record_id}: numeric assertions contain unsupported paths: {unexpected}"
        )
    covered_claim_ranges: dict[int, list[tuple[int, int]]] = defaultdict(list)
    tolerance_maximums = build_config["record_policy"]["numeric_tolerance_maximums"]
    for path, assertion in assertions.items():
        expected, governed_unit = traceable_assertions[path]
        expected_unit = governed_unit or assertion["unit"]
        assertion = assertions[path]
        if governed_unit is not None and assertion["unit"] != governed_unit:
            raise FoundationDatasetError(
                f"{record_id}: numeric assertion {path} uses the wrong unit"
            )
        tolerance = Decimal(str(assertion["tolerance"]))
        maximum_tolerance = Decimal(str(tolerance_maximums[expected_unit]))
        if tolerance > maximum_tolerance:
            raise FoundationDatasetError(
                f"{record_id}: numeric assertion {path} exceeds the {expected_unit} "
                "tolerance maximum"
            )
        if assertion["comparator"] == "exact" and tolerance != 0:
            raise FoundationDatasetError(
                f"{record_id}: exact numeric assertion {path} must have zero tolerance"
            )
        if not _decimal_close(assertion["value"], expected, tolerance):
            raise FoundationDatasetError(
                f"{record_id}: numeric assertion {path} does not match recomputation"
            )
        message_index = assertion["assistant_message_index"]
        if message_index >= len(record["messages"]):
            raise FoundationDatasetError(
                f"{record_id}: numeric assertion {path} references a missing message"
            )
        message = record["messages"][message_index]
        if message["role"] != "assistant":
            raise FoundationDatasetError(
                f"{record_id}: numeric assertion {path} must reference an assistant message"
            )
        claim_text = assertion["claim_text"]
        if message["content"].count(claim_text) != 1:
            raise FoundationDatasetError(
                f"{record_id}: numeric assertion {path} claim_text must occur "
                "exactly once in the referenced assistant message"
            )
        formatted_value = assertion["formatted_value"]
        if claim_text.count(formatted_value) != 1:
            raise FoundationDatasetError(
                f"{record_id}: numeric assertion {path} formatted_value must occur "
                "exactly once in claim_text"
            )
        formatted_numeric = _formatted_numeric_value(
            formatted_value,
            unit=expected_unit,
            record_id=record_id,
            source_path=path,
        )
        if not _decimal_close(formatted_numeric, expected, tolerance):
            raise FoundationDatasetError(
                f"{record_id}: numeric assertion {path} formatted_value "
                "does not match recomputation"
            )
        claim_start = message["content"].index(claim_text)
        formatted_start = claim_text.index(formatted_value)
        formatted_token = next(NUMERIC_TOKEN_PATTERN.finditer(formatted_value))
        numeric_start = claim_start + formatted_start + formatted_token.start()
        covered_claim_ranges[message_index].append(
            (numeric_start, numeric_start + len(formatted_token.group(0)))
        )

    for message_index, message in enumerate(record["messages"]):
        if message["role"] != "assistant":
            continue
        ranges = covered_claim_ranges.get(message_index, [])
        for token in NUMERIC_TOKEN_PATTERN.finditer(message["content"]):
            if not any(start <= token.start() and token.end() <= end for start, end in ranges):
                raise FoundationDatasetError(
                    f"{record_id}: assistant numeric token is outside every reviewed numeric claim"
                )


def validate_review_ledger(
    records: list[dict[str, Any]],
    ledger: dict[str, Any],
    reviewer_index: dict[str, dict[str, Any]],
    build_config: dict[str, Any],
    rubric_sha256: str,
    *,
    effective_at: datetime,
) -> None:
    _validate_schema(
        ledger,
        "foundation_review_ledger.schema.json",
        "foundation review ledger",
    )
    if ledger["rubric"]["sha256"] != rubric_sha256:
        raise FoundationDatasetError("review ledger rubric hash does not match the frozen rubric")
    decisions: dict[str, list[dict[str, Any]]] = defaultdict(list)
    decision_keys: set[tuple[str, str]] = set()
    seen_agent_receipts: set[str] = set()
    for decision in ledger["decisions"]:
        reviewer_id = decision["reviewer_id"]
        reviewed_at = _parse_utc(
            decision["reviewed_at_utc"],
            f"{decision['example_id']}.reviewed_at_utc",
        )
        if reviewed_at > effective_at:
            raise FoundationDatasetError(
                f"{decision['example_id']}: review decision is after the audit cutoff"
            )
        _require_reviewer_authority(
            reviewer_index,
            reviewer_id,
            event_at=reviewed_at,
            label=f"{decision['example_id']} review",
        )
        receipt = decision.get("agent_decision_receipt_sha256")
        _require_agent_decision_receipts(
            {reviewer_id},
            reviewer_index,
            {} if receipt is None else {reviewer_id: receipt},
            label=f"{decision['example_id']} review",
        )
        if receipt is not None:
            if receipt in seen_agent_receipts:
                raise FoundationDatasetError(
                    "AI-agent decision receipt cannot be reused across review decisions"
                )
            seen_agent_receipts.add(receipt)
        key = (decision["record_sha256"], reviewer_id)
        if key in decision_keys:
            raise FoundationDatasetError(
                f"duplicate reviewer decision for record hash {decision['record_sha256']}"
            )
        decision_keys.add(key)
        decisions[decision["record_sha256"]].append(decision)

    elevated_tasks = set(build_config["review_policy"]["elevated_task_families"])
    elevated_actions = set(build_config["review_policy"]["elevated_policy_actions"])
    specialists = build_config["review_policy"]["required_specialist_roles"]
    record_hashes = {
        canonical_record_sha256(record): str(record["example_id"]) for record in records
    }
    for decision in ledger["decisions"]:
        expected_id = record_hashes.get(decision["record_sha256"])
        if expected_id is None:
            raise FoundationDatasetError(
                "review ledger contains a decision for an unknown record hash"
            )
        if decision["example_id"] != expected_id:
            raise FoundationDatasetError(
                f"{decision['example_id']}: review ledger example/hash mismatch"
            )
    for record in records:
        record_id = str(record["example_id"])
        record_hash = canonical_record_sha256(record)
        record_decisions = decisions.get(record_hash, [])
        if any(decision["example_id"] != record_id for decision in record_decisions):
            raise FoundationDatasetError(f"{record_id}: review ledger example/hash mismatch")
        approvals = [
            decision
            for decision in record_decisions
            if decision["decision"] == "approve"
            and all(decision[field] is True for field in REVIEW_PASS_FIELDS)
            and decision["rubric_sha256"] == rubric_sha256
        ]
        if len(approvals) != len(record_decisions):
            raise FoundationDatasetError(
                f"{record_id}: unresolved, rejected, or incomplete decision targets this hash"
            )
        curriculum = record["curriculum"]
        elevated = (
            record["task_type"] in elevated_tasks
            or curriculum["risk_tier"] in {"high", "critical"}
            or curriculum["policy_action"] in elevated_actions
        )
        minimum = int(
            build_config["review_policy"][
                "elevated_reviewer_minimum" if elevated else "standard_reviewer_minimum"
            ]
        )
        approval_ids = {decision["reviewer_id"] for decision in approvals}
        if len(approval_ids) < minimum:
            raise FoundationDatasetError(
                f"{record_id}: requires at least {minimum} independent approvals"
            )
        _require_independent_reviewer_groups(
            approval_ids,
            reviewer_index,
            minimum=minimum,
            label=record_id,
        )
        if record["metadata"]["author_id"] in approval_ids:
            raise FoundationDatasetError(f"{record_id}: author cannot review their own record")
        embedded = set(record["quality"]["reviewer_ids"])
        if embedded != approval_ids:
            raise FoundationDatasetError(
                f"{record_id}: embedded reviewer IDs do not match the review ledger"
            )
        decision_times = [
            _parse_utc(decision["reviewed_at_utc"], f"{record_id}.reviewed_at_utc")
            for decision in approvals
        ]
        embedded_time = _parse_utc(
            record["quality"]["reviewed_at_utc"],
            f"{record_id}.quality.reviewed_at_utc",
        )
        if embedded_time != max(decision_times):
            raise FoundationDatasetError(
                f"{record_id}: embedded review timestamp must equal the latest approval"
            )
        available_at = _parse_utc(
            record["metadata"]["available_at_utc"],
            f"{record_id}.metadata.available_at_utc",
        )
        if any(reviewed_at < available_at for reviewed_at in decision_times):
            raise FoundationDatasetError(
                f"{record_id}: review decision predates the record's source availability"
            )
        specialist = specialists.get(record["task_type"])
        if specialist and not any(
            specialist in reviewer_index[reviewer_id]["roles"] for reviewer_id in approval_ids
        ):
            raise FoundationDatasetError(
                f"{record_id}: approval set lacks required {specialist} reviewer"
            )


def _aggregate_file_hash(paths: list[Path]) -> str:
    digest = hashlib.sha256()
    for path in sorted(paths, key=lambda item: str(item)):
        digest.update(str(path.name).encode("utf-8"))
        digest.update(bytes.fromhex(sha256_file(path)))
    return digest.hexdigest()


def _single_identifier_scan_version(records: list[dict[str, Any]]) -> str:
    versions = {
        record.get("metadata", {}).get("direct_identifier_scan_version") for record in records
    }
    if len(versions) != 1 or not all(isinstance(version, str) and version for version in versions):
        raise FoundationDatasetError(
            "all Foundation v1 records must use one non-empty identifier-scanner version"
        )
    return next(iter(versions))


def validate_development_evaluation_identity(
    evaluation_paths: list[Path],
    identity_path: Path,
    manifest_path: Path,
    *,
    token: str,
    remote: DevelopmentEvalRemote | None = None,
) -> VerifiedDevelopmentEvaluation:
    """Require local eval bytes to equal one exact private Hugging Face revision."""

    try:
        return verify_development_evaluation_provenance(
            evaluation_paths,
            identity_path,
            manifest_path,
            token=token,
            remote=remote,
        )
    except DevelopmentEvalProvenanceError as exc:
        raise FoundationDatasetError(str(exc)) from exc


def _bind_verified_development_evaluation_to_capture(
    verified: VerifiedDevelopmentEvaluation,
    *,
    evaluation_paths: list[Path],
    identity_path: Path,
    manifest_path: Path,
    captured_inputs: dict[Path, CapturedInput],
) -> None:
    if (
        _captured_sha256(
            captured_inputs,
            identity_path,
            "development evaluation identity",
        )
        != verified.identity_sha256
    ):
        raise FoundationDatasetError(
            "verified development evaluation identity differs from the entry snapshot"
        )
    if (
        _captured_sha256(
            captured_inputs,
            manifest_path,
            "development evaluation manifest",
        )
        != verified.manifest_sha256
    ):
        raise FoundationDatasetError(
            "verified development evaluation manifest differs from the entry snapshot"
        )
    manifest_root = manifest_path.absolute().parent
    captured_case_hashes: dict[str, str] = {}
    for path in evaluation_paths:
        absolute = path.absolute()
        try:
            repo_path = absolute.relative_to(manifest_root).as_posix()
        except ValueError as exc:
            raise FoundationDatasetError(
                f"development evaluation case escapes the manifest root: {absolute}"
            ) from exc
        captured_case_hashes[repo_path] = _captured_sha256(
            captured_inputs,
            absolute,
            f"development evaluation case {repo_path}",
        )
    verified_case_hashes = {repo_path: sha256_bytes(raw) for repo_path, raw in verified.case_bytes}
    if captured_case_hashes != verified_case_hashes:
        raise FoundationDatasetError(
            "verified development evaluation cases differ from the entry snapshot"
        )


def _candidate_audit_inputs_from_capture(
    *,
    captured_inputs: dict[Path, CapturedInput],
    train_sha256: str,
    validation_sha256: str,
    source_registry_path: Path,
    source_artifacts_sha256: str,
    review_ledger_path: Path,
    reviewer_registry_path: Path,
    development_evaluation_sha256: str,
    development_eval_manifest_path: Path,
    development_eval_identity_path: Path,
    direct_identifier_scan_version: str,
    curriculum_path: Path,
    build_config_path: Path,
    rubric_path: Path,
    prompt_path: Path,
    template_path: Path,
    tools_path: Path,
) -> dict[str, Any]:
    """Build the one canonical identity map for every candidate-audit input."""

    return {
        "train_sha256": train_sha256,
        "validation_sha256": validation_sha256,
        "source_registry_sha256": _captured_sha256(
            captured_inputs,
            source_registry_path,
            "source registry",
        ),
        "source_artifacts_sha256": source_artifacts_sha256,
        "review_ledger_sha256": _captured_sha256(
            captured_inputs,
            review_ledger_path,
            "review ledger",
        ),
        "reviewer_registry_sha256": _captured_sha256(
            captured_inputs,
            reviewer_registry_path,
            "foundation reviewer registry",
        ),
        "development_evaluation_sha256": development_evaluation_sha256,
        "development_eval_manifest_sha256": _captured_sha256(
            captured_inputs,
            development_eval_manifest_path,
            "development evaluation manifest",
        ),
        "development_eval_identity_sha256": _captured_sha256(
            captured_inputs,
            development_eval_identity_path,
            "development evaluation identity",
        ),
        "direct_identifier_scan_version": direct_identifier_scan_version,
        "curriculum_config_sha256": _captured_sha256(
            captured_inputs,
            curriculum_path,
            "curriculum",
        ),
        "foundation_build_config_sha256": _captured_sha256(
            captured_inputs,
            build_config_path,
            "build config",
        ),
        "rubric_sha256": _captured_sha256(
            captured_inputs,
            rubric_path,
            "rubric",
        ),
        "system_prompt_sha256": _captured_sha256(
            captured_inputs,
            prompt_path,
            "system prompt",
        ),
        "chat_template_sha256": _captured_sha256(
            captured_inputs,
            template_path,
            "chat template",
        ),
        "tool_catalog_sha256": _captured_sha256(
            captured_inputs,
            tools_path,
            "tool catalog",
        ),
    }


def audit_foundation_candidates(
    *,
    train_paths: list[Path],
    validation_paths: list[Path],
    source_artifact_root: Path,
    source_registry_path: Path,
    review_ledger_path: Path,
    development_eval_paths: list[Path],
    development_eval_identity_path: Path,
    development_eval_manifest_path: Path,
    generated_at_utc: str,
    hf_token: str,
    development_eval_remote: DevelopmentEvalRemote | None = None,
    project_root: Path = PROJECT_ROOT,
) -> FoundationAuditResult:
    """Run the complete CPU audit and return canonical candidate bytes."""

    validate_private_workspace_paths(
        project_root=project_root,
        files=(
            *((f"training shard {index}", path) for index, path in enumerate(train_paths, 1)),
            *(
                (f"validation shard {index}", path)
                for index, path in enumerate(validation_paths, 1)
            ),
            *(
                (f"development evaluation case {index}", path)
                for index, path in enumerate(development_eval_paths, 1)
            ),
            ("source registry", source_registry_path),
            ("review ledger", review_ledger_path),
            ("development evaluation identity", development_eval_identity_path),
            ("development evaluation manifest", development_eval_manifest_path),
        ),
        directories=(("source artifact root", source_artifact_root),),
    )
    generated_at = _parse_utc(generated_at_utc, "generated_at_utc")
    _reject_future_timestamp(generated_at, "generated_at_utc")
    config_path = project_root / "configs/foundation_v1_build.yaml"
    curriculum_path = project_root / "configs/curriculum_v1.yaml"
    reviewer_registry_path = project_root / "configs/foundation_reviewer_registry.json"
    rubric_path = project_root / "docs/DIME_ANSWER_RUBRIC_V1.md"
    prompt_path = project_root / "prompts/dime_system_v1.md"
    template_path = project_root / "prompts/llama3_dime_chat_template_v1.jinja"
    tools_path = project_root / "tools/tools.v1.json"
    source_artifact_paths = _regular_tree_files(
        source_artifact_root,
        "source artifact root",
    )
    audit_input_paths = [
        *train_paths,
        *validation_paths,
        *development_eval_paths,
        source_registry_path,
        review_ledger_path,
        development_eval_identity_path,
        development_eval_manifest_path,
        config_path,
        curriculum_path,
        reviewer_registry_path,
        rubric_path,
        prompt_path,
        template_path,
        tools_path,
        *source_artifact_paths,
    ]
    audit_input_fence = _capture_inputs(
        audit_input_paths,
        "candidate audit input",
        retain_data_paths={
            *train_paths,
            *validation_paths,
            source_registry_path,
            review_ledger_path,
            config_path,
            curriculum_path,
            reviewer_registry_path,
        },
    )
    build_config = yaml.safe_load(_captured_text(audit_input_fence, config_path, "build config"))
    curriculum = yaml.safe_load(_captured_text(audit_input_fence, curriculum_path, "curriculum"))
    _require_fresh(
        generated_at,
        label="generated_at_utc",
        maximum_age=timedelta(
            hours=int(build_config["evidence_freshness_policy"]["candidate_audit_max_age_hours"])
        ),
    )
    train = _captured_jsonl_records(audit_input_fence, train_paths, "train")
    validation = _captured_jsonl_records(
        audit_input_fence,
        validation_paths,
        "validation",
    )
    evaluations: list[dict[str, Any]] = []
    verified_development_evaluation: VerifiedDevelopmentEvaluation | None = None
    all_records = [*train, *validation]
    train_bytes = canonical_jsonl_bytes(train)
    validation_bytes = canonical_jsonl_bytes(validation)
    train_sha256 = sha256_bytes(train_bytes)
    validation_sha256 = sha256_bytes(validation_bytes)

    source_registry = _captured_json_document(
        audit_input_fence,
        source_registry_path,
        schema_name="foundation_source_registry.schema.json",
        label="source registry",
    )
    review_ledger = _captured_json_document(
        audit_input_fence,
        review_ledger_path,
        schema_name="foundation_review_ledger.schema.json",
        label="review ledger",
    )
    reviewer_registry = _captured_json_document(
        audit_input_fence,
        reviewer_registry_path,
        schema_name="foundation_reviewer_registry.schema.json",
        label="foundation reviewer registry",
    )
    development_evaluation_sha256 = "0" * 64
    development_eval_manifest_sha256 = "0" * 64
    development_eval_identity_sha256 = "0" * 64
    rubric_sha256 = _captured_sha256(audit_input_fence, rubric_path, "rubric")
    gates: dict[str, bool] = {}
    issues: list[str] = []
    reviewer_index: dict[str, dict[str, Any]] = {}

    def gate(name: str, operation: Any) -> None:
        try:
            operation()
        except (
            DataValidationError,
            FoundationDatasetError,
            IndexError,
            KeyError,
            OSError,
            TypeError,
            ValueError,
        ) as exc:
            gates[name] = False
            issues.append(f"{name}: {exc}")
        else:
            gates[name] = True

    gate(
        "record_contracts",
        lambda: [validate_sft_record(record, production=True) for record in all_records],
    )
    gate("unique_ids", lambda: validate_unique_ids(all_records, "example_id"))
    gate(
        "identifier_scanner_consistency",
        lambda: _single_identifier_scan_version(all_records),
    )

    def development_remote_gate() -> None:
        nonlocal development_eval_identity_sha256
        nonlocal development_eval_manifest_sha256
        nonlocal development_evaluation_sha256
        nonlocal evaluations
        nonlocal verified_development_evaluation
        verified_development_evaluation = validate_development_evaluation_identity(
            development_eval_paths,
            development_eval_identity_path,
            development_eval_manifest_path,
            token=hf_token,
            remote=development_eval_remote,
        )
        _bind_verified_development_evaluation_to_capture(
            verified_development_evaluation,
            evaluation_paths=development_eval_paths,
            identity_path=development_eval_identity_path,
            manifest_path=development_eval_manifest_path,
            captured_inputs=audit_input_fence,
        )
        evaluations = list(verified_development_evaluation.records)
        development_evaluation_sha256 = verified_development_evaluation.case_files_sha256
        development_eval_manifest_sha256 = verified_development_evaluation.manifest_sha256
        development_eval_identity_sha256 = verified_development_evaluation.identity_sha256

    gate("development_evaluation_remote_provenance", development_remote_gate)

    def development_contract_gate() -> None:
        if verified_development_evaluation is None:
            raise FoundationDatasetError(
                "development evaluation remote provenance was not verified"
            )
        for record in evaluations:
            validate_eval_case(record, production=True)
        validate_unique_ids(evaluations, "case_id")

    gate("development_evaluation_contracts", development_contract_gate)

    def development_identity_gate() -> None:
        if verified_development_evaluation is None:
            raise FoundationDatasetError(
                "development evaluation remote provenance was not verified"
            )

    gate("development_evaluation_identity", development_identity_gate)

    def reviewer_authority_gate() -> None:
        nonlocal reviewer_index
        reviewer_index = trusted_reviewer_index(reviewer_registry)

    gate("reviewer_authority", reviewer_authority_gate)

    source_index: dict[str, dict[str, Any]] = {}
    source_artifacts_sha256 = ""

    def source_gate() -> None:
        nonlocal source_artifacts_sha256, source_index
        source_index, source_artifacts_sha256 = validate_source_registry(
            source_registry,
            build_config,
            effective_at=generated_at,
            source_artifact_root=source_artifact_root,
            captured_inputs=audit_input_fence,
        )
        for record in all_records:
            validate_record_sources(
                record,
                source_index,
                effective_at=generated_at,
            )
        referenced_sources = {
            source_id for record in all_records for source_id in record["metadata"]["source_ids"]
        }
        if referenced_sources != set(source_index):
            raise FoundationDatasetError(
                "source registry must contain exactly the sources used by this candidate"
            )
        for source in source_registry["sources"]:
            reviewed_at = _parse_utc(
                source["reviewed_at_utc"],
                f"{source['source_id']}.reviewed_at_utc",
            )
            for reviewer_id in source["reviewer_ids"]:
                _require_reviewer_authority(
                    reviewer_index,
                    reviewer_id,
                    event_at=reviewed_at,
                    label=f"{source['source_id']} source",
                    required_role="rights",
                )

    gate("source_registry", source_gate)
    gate(
        "review_ledger",
        lambda: validate_review_ledger(
            all_records,
            review_ledger,
            reviewer_index,
            build_config,
            rubric_sha256,
            effective_at=generated_at,
        ),
    )
    gate(
        "numeric_traceability",
        lambda: [validate_numeric_traceability(record, build_config) for record in all_records],
    )

    exact_duplicates = find_exact_duplicates(all_records)
    gates["exact_deduplication"] = not exact_duplicates
    if exact_duplicates:
        issues.append(f"exact_deduplication: duplicate groups {exact_duplicates[:20]}")

    semantic_candidates = find_semantic_neighbors(
        all_records,
        shingle_size=int(build_config["record_policy"]["semantic_shingle_size"]),
        threshold=float(build_config["record_policy"]["semantic_similarity_threshold"]),
    )
    records_by_id = {str(record["example_id"]): record for record in all_records}
    semantic_neighbors = []
    for neighbor in semantic_candidates:
        left_pair = records_by_id[neighbor["left"]].get("curriculum", {}).get("control_pair_id")
        right_pair = records_by_id[neighbor["right"]].get("curriculum", {}).get("control_pair_id")
        if not (isinstance(left_pair, str) and left_pair and left_pair == right_pair):
            semantic_neighbors.append(neighbor)
    gates["semantic_duplicate_screen"] = not semantic_neighbors
    if semantic_neighbors:
        issues.append(
            f"semantic_duplicate_screen: {len(semantic_neighbors)} candidate neighbor pairs"
        )

    development_matches = _development_contamination(
        all_records,
        evaluations,
        shingle_size=int(build_config["record_policy"]["semantic_shingle_size"]),
        threshold=float(build_config["record_policy"]["development_prompt_similarity_threshold"]),
    )
    gates["development_contamination_screen"] = not development_matches
    if development_matches:
        issues.append(
            "development_contamination_screen: "
            f"{len(development_matches)} candidate/evaluation matches"
        )

    train_keys = set().union(*(partition_keys(record) for record in train))
    validation_keys = set().union(*(partition_keys(record) for record in validation))
    partition_leakage = sorted(train_keys & validation_keys)
    gates["grouped_partitions"] = not partition_leakage
    if partition_leakage:
        issues.append(f"grouped_partitions: cross-split keys {partition_leakage[:20]}")

    curriculum_report = audit_curriculum(train, validation, curriculum)
    curriculum_approved = curriculum.get("status") == "approved"
    gates["curriculum"] = bool(curriculum_report["pass"]) and curriculum_approved
    if not curriculum_approved:
        issues.append(
            "curriculum: configs/curriculum_v1.yaml must be independently reviewed "
            "and marked approved before Foundation v1 can pass"
        )
    if not curriculum_report["pass"]:
        issues.extend(f"curriculum: {issue}" for issue in curriculum_report["issues"][:50])

    record_index = {
        str(record["example_id"]): canonical_record_sha256(record)
        for record in sorted(all_records, key=lambda item: str(item["example_id"]))
    }
    report = {
        "schema_version": "dime-foundation-candidate-audit-v1",
        "dataset_version": DATASET_VERSION,
        "generated_at_utc": generated_at_utc,
        "audit_tool": {
            "id": AUDITOR_ID,
            "version": AUDITOR_VERSION,
        },
        "pass": bool(gates) and all(gates.values()),
        "inputs": _candidate_audit_inputs_from_capture(
            captured_inputs=audit_input_fence,
            train_sha256=train_sha256,
            validation_sha256=validation_sha256,
            source_registry_path=source_registry_path,
            source_artifacts_sha256=source_artifacts_sha256
            if gates["source_registry"]
            else "0" * 64,
            review_ledger_path=review_ledger_path,
            reviewer_registry_path=reviewer_registry_path,
            development_evaluation_sha256=development_evaluation_sha256,
            development_eval_manifest_path=development_eval_manifest_path,
            development_eval_identity_path=development_eval_identity_path,
            direct_identifier_scan_version=(
                _single_identifier_scan_version(all_records)
                if gates["identifier_scanner_consistency"]
                else "invalid"
            ),
            curriculum_path=curriculum_path,
            build_config_path=config_path,
            rubric_path=rubric_path,
            prompt_path=prompt_path,
            template_path=template_path,
            tools_path=tools_path,
        ),
        "records": {
            "train": len(train),
            "validation": len(validation),
            "total": len(all_records),
            "record_index_sha256": sha256_bytes(canonical_json_bytes(record_index)),
        },
        "gates": dict(sorted(gates.items())),
        "curriculum": curriculum_report,
        "issues": issues,
    }
    _validate_schema(
        report,
        "foundation_candidate_audit.schema.json",
        "candidate audit",
    )
    _assert_inputs_unchanged(audit_input_fence, "candidate audit input")
    _assert_tree_inventory_unchanged(
        source_artifact_root,
        audit_input_fence,
        "source artifact root",
    )
    return FoundationAuditResult(
        train_records=train,
        validation_records=validation,
        train_bytes=train_bytes,
        validation_bytes=validation_bytes,
        report=report,
        development_evaluation=verified_development_evaluation,
    )


def _load_external_audits(
    directory: Path,
    *,
    train_sha256: str,
    validation_sha256: str,
    candidate_audit_sha256: str,
    expected_inputs: dict[str, Any],
    build_config: dict[str, Any],
    development_eval_revision: str,
    locked_evaluation_reference: str,
    reviewer_index: dict[str, dict[str, Any]],
    captured_inputs: dict[Path, CapturedInput] | None = None,
) -> tuple[dict[str, dict[str, Any]], dict[str, str]]:
    _regular_directory(directory, "external audit directory")
    actual = (
        {
            path.relative_to(directory.absolute()).as_posix()
            for path in _captured_tree(captured_inputs, directory)
        }
        if captured_inputs is not None
        else {path.name for path in directory.iterdir()}
    )
    expected = set(EXTERNAL_AUDIT_FILES.values())
    if actual != expected:
        raise FoundationDatasetError(
            f"external audit inventory mismatch: expected {sorted(expected)}, got {sorted(actual)}"
        )
    reports: dict[str, dict[str, Any]] = {}
    hashes: dict[str, str] = {}
    for audit_type, filename in EXTERNAL_AUDIT_FILES.items():
        path = directory / filename
        report = (
            _captured_json_document(
                captured_inputs,
                path,
                schema_name="foundation_external_audit.schema.json",
                label=audit_type,
            )
            if captured_inputs is not None
            else load_json_document(
                path,
                schema_name="foundation_external_audit.schema.json",
                label=audit_type,
            )
        )
        if report["audit_type"] != audit_type:
            raise FoundationDatasetError(f"{filename}: audit_type mismatch")
        if report["train_sha256"] != train_sha256:
            raise FoundationDatasetError(f"{filename}: train hash mismatch")
        if report["validation_sha256"] != validation_sha256:
            raise FoundationDatasetError(f"{filename}: validation hash mismatch")
        if report["candidate_audit_sha256"] != candidate_audit_sha256:
            raise FoundationDatasetError(f"{filename}: candidate-audit hash mismatch")
        if report["inputs"] != expected_inputs:
            raise FoundationDatasetError(f"{filename}: audited input evidence mismatch")
        expected_tool = build_config["external_audit_policy"][audit_type]
        if (
            report["tool_id"] != expected_tool["tool_id"]
            or report["tool_version"] != expected_tool["tool_version"]
        ):
            raise FoundationDatasetError(f"{filename}: audit tool identity/version mismatch")
        expected_scope = {
            "semantic_deduplication": candidate_audit_sha256,
            "privacy_and_identifiers": expected_inputs["direct_identifier_scan_version"],
            "rights": expected_inputs["source_registry_sha256"],
            "development_evaluation_contamination": development_eval_revision,
            "locked_evaluation_contamination": locked_evaluation_reference,
            "numeric_traceability": expected_inputs["tool_catalog_sha256"],
        }[audit_type]
        if report["scope_reference"] != expected_scope:
            raise FoundationDatasetError(f"{filename}: audit scope reference mismatch")
        required_role = EXTERNAL_AUDIT_REVIEWER_ROLES[audit_type]
        completed_at = _parse_utc(
            report["completed_at_utc"],
            f"{filename}.completed_at_utc",
        )
        for reviewer_id in report["reviewer_ids"]:
            if not _valid_identity(reviewer_id):
                raise FoundationDatasetError(
                    f"{filename}: audit reviewer contains a placeholder identity"
                )
            _require_reviewer_authority(
                reviewer_index,
                reviewer_id,
                event_at=completed_at,
                label=filename,
                required_role=required_role,
            )
        _require_agent_decision_receipts(
            set(report["reviewer_ids"]),
            reviewer_index,
            report.get("agent_decision_receipts"),
            label=filename,
        )
        reports[audit_type] = report
        hashes[audit_type] = (
            _captured_sha256(captured_inputs, path, audit_type)
            if captured_inputs is not None
            else sha256_file(path)
        )
    return reports, hashes


def _audit_metadata(report: dict[str, Any], report_sha256: str) -> dict[str, Any]:
    metadata = {
        "passed": True,
        "report_sha256": report_sha256,
        "tool_id": report["tool_id"],
        "tool_version": report["tool_version"],
        "completed_at_utc": report["completed_at_utc"],
        "reviewer_ids": report["reviewer_ids"],
    }
    if "agent_decision_receipts" in report:
        metadata["agent_decision_receipts"] = report["agent_decision_receipts"]
    return metadata


def _verify_dataset_card(
    card_path: Path,
    build_config: dict[str, Any],
    *,
    captured_inputs: dict[Path, CapturedInput] | None = None,
) -> str:
    card = (
        _captured_text(captured_inputs, card_path, "dataset card")
        if captured_inputs is not None
        else _regular_file(card_path, "dataset card").read_text(encoding="utf-8")
    )
    missing = [
        section
        for section in build_config["freeze_policy"]["dataset_card_required_sections"]
        if section not in card
    ]
    if missing:
        raise FoundationDatasetError(f"dataset card is missing sections: {missing}")
    if "DRAFT — NOT APPROVED FOR TRAINING" in card:
        raise FoundationDatasetError("dataset card still carries the draft status")
    return card


def _fsync_file(path: Path) -> None:
    with path.open("rb") as handle:
        os.fsync(handle.fileno())


def _fsync_directory(path: Path) -> None:
    descriptor = os.open(path, os.O_RDONLY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def _atomic_promote_directory_no_replace(source: Path, destination: Path) -> None:
    """Atomically rename a directory while refusing to replace any destination."""

    libc = ctypes.CDLL(None, use_errno=True)
    source_bytes = os.fsencode(source)
    destination_bytes = os.fsencode(destination)

    if sys.platform.startswith("linux"):
        rename = getattr(libc, "renameat2", None)
        if rename is None:
            raise FoundationDatasetError(
                "atomic no-replace freeze promotion is unavailable: libc does not expose renameat2"
            )
        rename.argtypes = [
            ctypes.c_int,
            ctypes.c_char_p,
            ctypes.c_int,
            ctypes.c_char_p,
            ctypes.c_uint,
        ]
        rename.restype = ctypes.c_int
        result = rename(
            -100,  # AT_FDCWD
            source_bytes,
            -100,  # AT_FDCWD
            destination_bytes,
            1,  # RENAME_NOREPLACE
        )
    elif sys.platform == "darwin":
        rename = getattr(libc, "renamex_np", None)
        if rename is None:
            raise FoundationDatasetError(
                "atomic no-replace freeze promotion is unavailable: libc does not expose renamex_np"
            )
        rename.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_uint]
        rename.restype = ctypes.c_int
        result = rename(
            source_bytes,
            destination_bytes,
            0x00000004,  # RENAME_EXCL
        )
    else:
        raise FoundationDatasetError(
            "atomic no-replace freeze promotion is unsupported on "
            f"{sys.platform!r}; the incomplete snapshot was not published"
        )

    if result == 0:
        return

    error_number = ctypes.get_errno()
    if error_number in {errno.EEXIST, errno.ENOTEMPTY}:
        raise FoundationDatasetError(f"freeze destination already exists: {destination}")
    if error_number in {
        errno.EINVAL,
        errno.ENOSYS,
        errno.ENOTSUP,
        errno.EOPNOTSUPP,
    }:
        raise FoundationDatasetError(
            "atomic no-replace freeze promotion is unsupported by the "
            f"host filesystem: {destination.parent}"
        )
    raise FoundationDatasetError(
        "atomic no-replace freeze promotion failed: "
        f"[Errno {error_number}] {os.strerror(error_number)}"
    )


def _enclosing_git_worktree_root(project_root: Path) -> Path:
    """Establish the enclosing Git worktree from a trusted, non-symlink marker."""

    project = _regular_directory(project_root, "project root")
    for candidate in (project, *project.parents):
        marker = candidate / ".git"
        if marker.is_symlink():
            raise FoundationDatasetError(f"Git worktree marker must not be a symlink: {marker}")
        if not marker.exists():
            continue
        if marker.is_dir():
            _regular_directory(marker, "Git worktree metadata directory")
            return candidate
        if not marker.is_file():
            raise FoundationDatasetError(
                f"Git worktree marker is not a regular file or directory: {marker}"
            )
        marker_file = _regular_file(marker, "Git worktree marker")
        try:
            marker_lines = marker_file.read_text(encoding="utf-8").splitlines()
        except UnicodeDecodeError as exc:
            raise FoundationDatasetError(
                f"Git worktree marker is not valid UTF-8: {marker}"
            ) from exc
        if len(marker_lines) != 1 or not marker_lines[0].startswith("gitdir: "):
            raise FoundationDatasetError(f"Git worktree marker is malformed: {marker}")
        git_directory_value = marker_lines[0].removeprefix("gitdir: ").strip()
        if not git_directory_value:
            raise FoundationDatasetError(f"Git worktree marker is malformed: {marker}")
        git_directory = Path(git_directory_value)
        if not git_directory.is_absolute():
            git_directory = candidate / git_directory
        git_directory = Path(os.path.normpath(os.fspath(git_directory)))
        _regular_directory(git_directory, "Git worktree metadata directory")
        return candidate
    raise FoundationDatasetError(
        f"cannot establish the enclosing Git worktree root for project: {project}"
    )


def _non_symlink_absolute_path(
    path: Path,
    label: str,
    *,
    expected_type: str | None,
) -> Path:
    """Normalize a path and reject symbolic links in every existing component."""

    absolute = Path(os.path.abspath(os.fspath(path)))
    current = Path(absolute.anchor)
    missing_component = False
    for part in absolute.parts[1:] if absolute.anchor else absolute.parts:
        current /= part
        if missing_component:
            continue
        try:
            metadata = current.lstat()
        except FileNotFoundError:
            missing_component = True
            continue
        if stat.S_ISLNK(metadata.st_mode):
            raise FoundationDatasetError(f"{label} contains a symbolic-link component: {current}")
    if expected_type == "file":
        return _regular_file(absolute, label)
    if expected_type == "directory":
        return _regular_directory(absolute, label)
    if expected_type is not None:
        raise FoundationDatasetError(f"unsupported private path type: {expected_type}")
    return absolute


def validate_private_workspace_paths(
    *,
    project_root: Path,
    files: tuple[tuple[str, Path], ...] = (),
    directories: tuple[tuple[str, Path], ...] = (),
    destinations: tuple[tuple[str, Path], ...] = (),
) -> dict[str, Path]:
    """Bind private paths outside the full public worktree or fail closed."""

    worktree_root = _enclosing_git_worktree_root(project_root)
    validated: dict[str, Path] = {}
    specifications = (
        *((label, path, "file") for label, path in files),
        *((label, path, "directory") for label, path in directories),
        *((label, path, None) for label, path in destinations),
    )
    for label, path, expected_type in specifications:
        if label in validated:
            raise FoundationDatasetError(f"duplicate private workspace path label: {label}")
        absolute = _non_symlink_absolute_path(
            path,
            label,
            expected_type=expected_type,
        )
        if absolute == worktree_root or absolute.is_relative_to(worktree_root):
            raise FoundationDatasetError(
                f"{label} must be outside the public Git worktree: {worktree_root}"
            )
        validated[label] = absolute
    return validated


def _validate_private_output_destination(
    output_directory: Path,
    project_root: Path,
) -> Path:
    """Reject any private release destination inside the public Git worktree."""

    label = "private frozen snapshot destination"
    return validate_private_workspace_paths(
        project_root=project_root,
        destinations=((label, output_directory),),
    )[label]


def _freeze_audited_snapshot(
    *,
    audit_result: FoundationAuditResult,
    train_paths: list[Path],
    validation_paths: list[Path],
    source_artifact_root: Path,
    source_registry_path: Path,
    review_ledger_path: Path,
    development_eval_paths: list[Path],
    development_eval_identity_path: Path,
    development_eval_manifest_path: Path,
    candidate_audit_path: Path,
    approval_path: Path,
    dataset_card_path: Path,
    external_audit_dir: Path,
    output_directory: Path,
    hf_token: str,
    development_eval_remote: DevelopmentEvalRemote | None = None,
    project_root: Path = PROJECT_ROOT,
) -> dict[str, Any]:
    """Write an already re-audited snapshot. Kept private to prevent audit injection."""

    build_config_path = project_root / "configs/foundation_v1_build.yaml"
    curriculum_path = project_root / "configs/curriculum_v1.yaml"
    reviewer_registry_path = project_root / "configs/foundation_reviewer_registry.json"
    rubric_path = project_root / "docs/DIME_ANSWER_RUBRIC_V1.md"
    prompt_path = project_root / "prompts/dime_system_v1.md"
    template_path = project_root / "prompts/llama3_dime_chat_template_v1.jinja"
    tools_path = project_root / "tools/tools.v1.json"
    private_paths = validate_private_workspace_paths(
        project_root=project_root,
        files=(
            *((f"training shard {index}", path) for index, path in enumerate(train_paths, 1)),
            *(
                (f"validation shard {index}", path)
                for index, path in enumerate(validation_paths, 1)
            ),
            *(
                (f"development evaluation case {index}", path)
                for index, path in enumerate(development_eval_paths, 1)
            ),
            ("source registry", source_registry_path),
            ("review ledger", review_ledger_path),
            ("development evaluation identity", development_eval_identity_path),
            ("development evaluation manifest", development_eval_manifest_path),
            ("candidate audit", candidate_audit_path),
            ("foundation approval", approval_path),
            ("private dataset card working file", dataset_card_path),
        ),
        directories=(
            ("source artifact root", source_artifact_root),
            ("external audit directory", external_audit_dir),
        ),
        destinations=(("private frozen snapshot destination", output_directory),),
    )
    destination = private_paths["private frozen snapshot destination"]
    source_artifact_paths = _regular_tree_files(
        source_artifact_root,
        "source artifact root",
    )
    external_audit_paths = _regular_tree_files(
        external_audit_dir,
        "external audit directory",
    )
    freeze_input_paths = [
        *train_paths,
        *validation_paths,
        *development_eval_paths,
        source_registry_path,
        review_ledger_path,
        development_eval_identity_path,
        development_eval_manifest_path,
        candidate_audit_path,
        approval_path,
        dataset_card_path,
        build_config_path,
        curriculum_path,
        reviewer_registry_path,
        rubric_path,
        prompt_path,
        template_path,
        tools_path,
        *source_artifact_paths,
        *external_audit_paths,
    ]
    freeze_input_fence = _capture_inputs(
        freeze_input_paths,
        "freeze input",
        retain_data_paths={
            *train_paths,
            *validation_paths,
            source_registry_path,
            review_ledger_path,
            candidate_audit_path,
            approval_path,
            dataset_card_path,
            build_config_path,
            reviewer_registry_path,
            *external_audit_paths,
        },
    )
    if not audit_result.report["pass"]:
        raise FoundationDatasetError("candidate audit did not pass")
    saved_audit = _captured_json_document(
        freeze_input_fence,
        candidate_audit_path,
        schema_name="foundation_candidate_audit.schema.json",
        label="candidate audit",
    )
    if saved_audit != audit_result.report:
        raise FoundationDatasetError(
            "saved candidate audit does not exactly match the current deterministic audit"
        )
    build_config = yaml.safe_load(
        _captured_text(freeze_input_fence, build_config_path, "build config")
    )
    freshness = build_config["evidence_freshness_policy"]
    now = _utc_now()
    candidate_audit_time = _parse_utc(
        saved_audit["generated_at_utc"],
        "candidate_audit.generated_at_utc",
    )
    _require_fresh(
        candidate_audit_time,
        label="candidate_audit.generated_at_utc",
        maximum_age=timedelta(hours=int(freshness["candidate_audit_max_age_hours"])),
        now=now,
    )
    card = _verify_dataset_card(
        dataset_card_path,
        build_config,
        captured_inputs=freeze_input_fence,
    )
    current_train_records = _captured_jsonl_records(
        freeze_input_fence,
        train_paths,
        "training split",
    )
    current_validation_records = _captured_jsonl_records(
        freeze_input_fence,
        validation_paths,
        "validation split",
    )
    current_train_bytes = canonical_jsonl_bytes(current_train_records)
    current_validation_bytes = canonical_jsonl_bytes(current_validation_records)
    if (
        current_train_records != audit_result.train_records
        or current_validation_records != audit_result.validation_records
        or current_train_bytes != audit_result.train_bytes
        or current_validation_bytes != audit_result.validation_bytes
    ):
        raise FoundationDatasetError(
            "current freeze split records do not exactly match the deterministic candidate audit"
        )
    train_sha256 = sha256_bytes(current_train_bytes)
    validation_sha256 = sha256_bytes(current_validation_bytes)
    registry = _captured_json_document(
        freeze_input_fence,
        source_registry_path,
        schema_name="foundation_source_registry.schema.json",
        label="source registry",
    )
    ledger = _captured_json_document(
        freeze_input_fence,
        review_ledger_path,
        schema_name="foundation_review_ledger.schema.json",
        label="review ledger",
    )
    reviewer_registry = _captured_json_document(
        freeze_input_fence,
        reviewer_registry_path,
        schema_name="foundation_reviewer_registry.schema.json",
        label="foundation reviewer registry",
    )
    reviewer_index = trusted_reviewer_index(reviewer_registry)
    development_identity = validate_development_evaluation_identity(
        development_eval_paths,
        development_eval_identity_path,
        development_eval_manifest_path,
        token=hf_token,
        remote=development_eval_remote,
    )
    _bind_verified_development_evaluation_to_capture(
        development_identity,
        evaluation_paths=development_eval_paths,
        identity_path=development_eval_identity_path,
        manifest_path=development_eval_manifest_path,
        captured_inputs=freeze_input_fence,
    )
    _, source_artifacts_sha256 = validate_source_registry(
        registry,
        build_config,
        effective_at=now,
        source_artifact_root=source_artifact_root,
        captured_inputs=freeze_input_fence,
    )
    current_audit_inputs = _candidate_audit_inputs_from_capture(
        captured_inputs=freeze_input_fence,
        train_sha256=train_sha256,
        validation_sha256=validation_sha256,
        source_registry_path=source_registry_path,
        source_artifacts_sha256=source_artifacts_sha256,
        review_ledger_path=review_ledger_path,
        reviewer_registry_path=reviewer_registry_path,
        development_evaluation_sha256=development_identity.case_files_sha256,
        development_eval_manifest_path=development_eval_manifest_path,
        development_eval_identity_path=development_eval_identity_path,
        direct_identifier_scan_version=_single_identifier_scan_version(
            [*current_train_records, *current_validation_records]
        ),
        curriculum_path=curriculum_path,
        build_config_path=build_config_path,
        rubric_path=rubric_path,
        prompt_path=prompt_path,
        template_path=template_path,
        tools_path=tools_path,
    )
    if current_audit_inputs != saved_audit.get("inputs"):
        raise FoundationDatasetError(
            "current freeze audit inputs do not exactly match saved candidate audit inputs"
        )
    approval = _captured_json_document(
        freeze_input_fence,
        approval_path,
        schema_name="foundation_approval.schema.json",
        label="foundation approval",
    )
    approval_time = _parse_utc(
        approval["approved_at_utc"],
        "approval.approved_at_utc",
    )
    _require_fresh(
        approval_time,
        label="approval.approved_at_utc",
        maximum_age=timedelta(hours=int(freshness["approval_max_age_hours"])),
        now=now,
    )
    evidence_valid_until = _parse_utc(
        approval["evidence_valid_until_utc"],
        "approval.evidence_valid_until_utc",
    )
    if evidence_valid_until <= now:
        raise FoundationDatasetError("foundation approval evidence has expired")
    maximum_valid_until = approval_time + timedelta(
        days=int(freshness["maximum_release_validity_days"])
    )
    if evidence_valid_until > maximum_valid_until:
        raise FoundationDatasetError(
            "foundation approval evidence validity exceeds the configured maximum"
        )
    source_expiries = [
        _parse_utc(source["expires_at_utc"], f"{source['source_id']}.expires_at_utc")
        for source in registry["sources"]
        if source["expires_at_utc"] is not None
    ]
    if source_expiries and evidence_valid_until > min(source_expiries):
        raise FoundationDatasetError(
            "foundation approval evidence validity exceeds source rights expiry"
        )
    expected_hashes = {
        "train_sha256": train_sha256,
        "validation_sha256": validation_sha256,
        "source_registry_sha256": _captured_sha256(
            freeze_input_fence,
            source_registry_path,
            "source registry",
        ),
        "source_artifacts_sha256": source_artifacts_sha256,
        "review_ledger_sha256": _captured_sha256(
            freeze_input_fence,
            review_ledger_path,
            "review ledger",
        ),
        "reviewer_registry_sha256": _captured_sha256(
            freeze_input_fence,
            reviewer_registry_path,
            "foundation reviewer registry",
        ),
        "candidate_audit_sha256": _captured_sha256(
            freeze_input_fence,
            candidate_audit_path,
            "candidate audit",
        ),
        "dataset_card_sha256": _captured_sha256(
            freeze_input_fence,
            dataset_card_path,
            "dataset card",
        ),
        "curriculum_config_sha256": _captured_sha256(
            freeze_input_fence,
            curriculum_path,
            "curriculum",
        ),
        "system_prompt_sha256": _captured_sha256(
            freeze_input_fence,
            prompt_path,
            "system prompt",
        ),
        "chat_template_sha256": _captured_sha256(
            freeze_input_fence,
            template_path,
            "chat template",
        ),
        "tool_catalog_sha256": _captured_sha256(
            freeze_input_fence,
            tools_path,
            "tool catalog",
        ),
        "foundation_build_config_sha256": _captured_sha256(
            freeze_input_fence,
            build_config_path,
            "build config",
        ),
        "development_eval_manifest_sha256": _captured_sha256(
            freeze_input_fence,
            development_eval_manifest_path,
            "development evaluation manifest",
        ),
        "development_eval_identity_sha256": _captured_sha256(
            freeze_input_fence,
            development_eval_identity_path,
            "development evaluation identity",
        ),
    }
    for field, expected in expected_hashes.items():
        if approval[field] != expected:
            raise FoundationDatasetError(f"foundation approval {field} mismatch")
    if (
        development_identity.manifest_sha256 != expected_hashes["development_eval_manifest_sha256"]
        or development_identity.identity_sha256
        != expected_hashes["development_eval_identity_sha256"]
    ):
        raise FoundationDatasetError(
            "live development evaluation proof does not match the approval inputs"
        )
    if approval["development_eval_repo_id"] != development_identity.repo_id:
        raise FoundationDatasetError(
            "foundation approval development evaluation repository mismatch"
        )
    if approval["development_eval_revision"] != development_identity.revision:
        raise FoundationDatasetError("foundation approval development evaluation revision mismatch")

    audit_inputs = current_audit_inputs
    if (
        audit_inputs["development_evaluation_sha256"] != development_identity.case_files_sha256
        or audit_inputs["development_eval_manifest_sha256"] != development_identity.manifest_sha256
        or audit_inputs["development_eval_identity_sha256"] != development_identity.identity_sha256
    ):
        raise FoundationDatasetError(
            "live development evaluation proof does not match the candidate audit"
        )
    external_expected_inputs = {
        "source_registry_sha256": audit_inputs["source_registry_sha256"],
        "source_artifacts_sha256": audit_inputs["source_artifacts_sha256"],
        "review_ledger_sha256": audit_inputs["review_ledger_sha256"],
        "reviewer_registry_sha256": audit_inputs["reviewer_registry_sha256"],
        "development_evaluation_sha256": audit_inputs["development_evaluation_sha256"],
        "development_eval_manifest_sha256": audit_inputs["development_eval_manifest_sha256"],
        "development_eval_identity_sha256": audit_inputs["development_eval_identity_sha256"],
        "curriculum_config_sha256": audit_inputs["curriculum_config_sha256"],
        "tool_catalog_sha256": audit_inputs["tool_catalog_sha256"],
        "system_prompt_sha256": audit_inputs["system_prompt_sha256"],
        "direct_identifier_scan_version": audit_inputs["direct_identifier_scan_version"],
        "locked_evaluation_reference": approval["locked_evaluation_reference"],
    }
    external_reports, external_hashes = _load_external_audits(
        external_audit_dir,
        train_sha256=train_sha256,
        validation_sha256=validation_sha256,
        candidate_audit_sha256=expected_hashes["candidate_audit_sha256"],
        expected_inputs=external_expected_inputs,
        build_config=build_config,
        development_eval_revision=development_identity.revision,
        locked_evaluation_reference=approval["locked_evaluation_reference"],
        reviewer_index=reviewer_index,
        captured_inputs=freeze_input_fence,
    )
    agent_receipt_digests = [
        *[
            decision["agent_decision_receipt_sha256"]
            for decision in ledger["decisions"]
            if decision.get("agent_decision_receipt_sha256") is not None
        ],
        *[
            digest
            for report in external_reports.values()
            for digest in report.get("agent_decision_receipts", {}).values()
        ],
        *approval.get("agent_decision_receipts", {}).values(),
    ]
    if len(agent_receipt_digests) != len(set(agent_receipt_digests)):
        raise FoundationDatasetError(
            "AI-agent decision receipts must be unique across reviews, audits, and approval"
        )
    expected_audits = {
        audit_type: _audit_metadata(
            external_reports[audit_type],
            external_hashes[audit_type],
        )
        for audit_type in EXTERNAL_AUDIT_FILES
    }
    if approval["audit_reports"] != expected_audits:
        raise FoundationDatasetError("foundation approval external audit evidence mismatch")
    for audit_type, report in external_reports.items():
        _require_fresh(
            _parse_utc(
                report["completed_at_utc"],
                f"{audit_type}.completed_at_utc",
            ),
            label=f"{audit_type}.completed_at_utc",
            maximum_age=timedelta(hours=int(freshness["external_audit_max_age_hours"])),
            now=now,
        )
    _validate_dataset_approver_authority(
        approval["approver_ids"],
        reviewer_index,
        approval_time=approval_time,
        candidate_author_ids={
            str(record["metadata"]["author_id"])
            for record in [
                *audit_result.train_records,
                *audit_result.validation_records,
            ]
        },
        agent_decision_receipts=approval.get("agent_decision_receipts"),
    )
    prerequisite_times = [
        _parse_utc(saved_audit["generated_at_utc"], "candidate_audit.generated_at_utc"),
        *[
            _parse_utc(report["completed_at_utc"], f"{name}.completed_at_utc")
            for name, report in external_reports.items()
        ],
        *[
            _parse_utc(decision["reviewed_at_utc"], "review_decision.reviewed_at_utc")
            for decision in ledger["decisions"]
        ],
        *[
            _parse_utc(source["reviewed_at_utc"], "source.reviewed_at_utc")
            for source in registry["sources"]
        ],
    ]
    if approval_time < max(prerequisite_times):
        raise FoundationDatasetError("dataset approval predates a required review or audit")

    source_classes = {source["source_class"] for source in registry["sources"]}
    provenance_class = next(iter(source_classes)) if len(source_classes) == 1 else "mixed"
    owners = sorted({source["source_owner"] for source in registry["sources"]})
    rights = sorted({source["rights_record_id"] for source in registry["sources"]})
    restrictions = sorted({source["restrictions"] for source in registry["sources"]})
    scan_version = _single_identifier_scan_version(
        [*audit_result.train_records, *audit_result.validation_records]
    )
    manifest = {
        "schema_version": "dime-dataset-manifest-v4",
        "dataset_version": DATASET_VERSION,
        "visibility": "private",
        "publication_classification": "private-only",
        "provenance_source_class": provenance_class,
        "source_owner": "; ".join(owners),
        "rights_basis": "; ".join(rights),
        "license_or_usage_restrictions": "; ".join(restrictions),
        "synthetic_status": "fully-synthetic" if source_classes == {"synthetic"} else "mixed",
        "contains_user_data": False,
        "contains_provider_derived_data": False,
        "approval_status": "approved",
        "approved": True,
        "approved_at_utc": approval["approved_at_utc"],
        "evidence_valid_until_utc": approval["evidence_valid_until_utc"],
        "reviewer_ids": approval["approver_ids"],
        "train_record_count": len(audit_result.train_records),
        "validation_record_count": len(audit_result.validation_records),
        "train_sha256": train_sha256,
        "validation_sha256": validation_sha256,
        "curriculum_config_sha256": expected_hashes["curriculum_config_sha256"],
        "system_prompt_sha256": expected_hashes["system_prompt_sha256"],
        "tool_catalog_sha256": expected_hashes["tool_catalog_sha256"],
        "chat_template_sha256": expected_hashes["chat_template_sha256"],
        "foundation_build_config_sha256": expected_hashes["foundation_build_config_sha256"],
        "source_registry_sha256": expected_hashes["source_registry_sha256"],
        "source_artifacts_sha256": expected_hashes["source_artifacts_sha256"],
        "review_ledger_sha256": expected_hashes["review_ledger_sha256"],
        "reviewer_registry_sha256": expected_hashes["reviewer_registry_sha256"],
        "candidate_audit_sha256": expected_hashes["candidate_audit_sha256"],
        "approval_record_sha256": _captured_sha256(
            freeze_input_fence,
            approval_path,
            "foundation approval",
        ),
        "development_eval_repo_id": development_identity.repo_id,
        "development_eval_revision": development_identity.revision,
        "development_eval_manifest_sha256": expected_hashes["development_eval_manifest_sha256"],
        "development_eval_identity_sha256": expected_hashes["development_eval_identity_sha256"],
        "locked_evaluation_reference": approval["locked_evaluation_reference"],
        "audit_reports": expected_audits,
        "rights_reviewed": True,
        "consent_reviewed": True,
        "privacy_reviewed": True,
        "partition_audit_passed": True,
        "future_data_audit_passed": True,
        "exact_dedup_audit_passed": True,
        "semantic_dedup_audit_passed": True,
        "evaluation_contamination_audit_passed": True,
        "numeric_traceability_audit_passed": True,
        "canonical_system_prompt_enforced": True,
        "direct_identifier_scan_version": scan_version,
        "deletion_policy_id": approval["deletion_policy_id"],
        "limitations_notes": approval["limitations_notes"],
    }
    _validate_schema(manifest, "dataset_manifest.v4.schema.json", "dataset manifest")

    if destination.exists():
        raise FoundationDatasetError(f"freeze destination already exists: {destination}")
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = Path(
        tempfile.mkdtemp(prefix=f".{destination.name}.incomplete-", dir=destination.parent)
    )
    try:
        (temporary / "train.jsonl").write_bytes(current_train_bytes)
        (temporary / "validation.jsonl").write_bytes(current_validation_bytes)
        (temporary / "dataset_card.md").write_text(card, encoding="utf-8")
        (temporary / "dataset_manifest.json").write_bytes(canonical_json_bytes(manifest))
        checksums = {
            "schema_version": "dime-foundation-checksums-v1",
            "files": {
                filename: sha256_file(temporary / filename)
                for filename in (
                    "train.jsonl",
                    "validation.jsonl",
                    "dataset_manifest.json",
                    "dataset_card.md",
                )
            },
        }
        _validate_schema(
            checksums,
            "foundation_checksums.schema.json",
            "foundation checksums",
        )
        (temporary / "checksums.json").write_bytes(canonical_json_bytes(checksums))
        inventory = {path.name for path in temporary.iterdir()}
        if inventory != RELEASE_INVENTORY or any(
            path.is_symlink() or not path.is_file() for path in temporary.iterdir()
        ):
            raise FoundationDatasetError("frozen snapshot inventory is not exact")
        _assert_inputs_unchanged(freeze_input_fence, "freeze input")
        _assert_tree_inventory_unchanged(
            source_artifact_root,
            freeze_input_fence,
            "source artifact root",
        )
        _assert_tree_inventory_unchanged(
            external_audit_dir,
            freeze_input_fence,
            "external audit directory",
        )
        for path in temporary.iterdir():
            _fsync_file(path)
        _fsync_directory(temporary)
        _atomic_promote_directory_no_replace(temporary, destination)
        _fsync_directory(destination.parent)
    except Exception:
        if temporary.exists():
            shutil.rmtree(temporary)
        raise
    return manifest


def freeze_foundation_snapshot(
    *,
    train_paths: list[Path],
    validation_paths: list[Path],
    source_artifact_root: Path,
    source_registry_path: Path,
    review_ledger_path: Path,
    development_eval_paths: list[Path],
    development_eval_identity_path: Path,
    development_eval_manifest_path: Path,
    candidate_audit_path: Path,
    approval_path: Path,
    dataset_card_path: Path,
    external_audit_dir: Path,
    output_directory: Path,
    hf_token: str,
    development_eval_remote: DevelopmentEvalRemote | None = None,
    project_root: Path = PROJECT_ROOT,
) -> dict[str, Any]:
    """Re-run every candidate gate, then atomically freeze exact approved bytes."""

    saved_audit = load_json_document(
        candidate_audit_path,
        schema_name="foundation_candidate_audit.schema.json",
        label="candidate audit",
    )
    audit_result = audit_foundation_candidates(
        train_paths=train_paths,
        validation_paths=validation_paths,
        source_artifact_root=source_artifact_root,
        source_registry_path=source_registry_path,
        review_ledger_path=review_ledger_path,
        development_eval_paths=development_eval_paths,
        development_eval_identity_path=development_eval_identity_path,
        development_eval_manifest_path=development_eval_manifest_path,
        generated_at_utc=saved_audit["generated_at_utc"],
        hf_token=hf_token,
        development_eval_remote=development_eval_remote,
        project_root=project_root,
    )
    return _freeze_audited_snapshot(
        audit_result=audit_result,
        train_paths=train_paths,
        validation_paths=validation_paths,
        source_artifact_root=source_artifact_root,
        source_registry_path=source_registry_path,
        review_ledger_path=review_ledger_path,
        development_eval_paths=development_eval_paths,
        development_eval_identity_path=development_eval_identity_path,
        development_eval_manifest_path=development_eval_manifest_path,
        candidate_audit_path=candidate_audit_path,
        approval_path=approval_path,
        dataset_card_path=dataset_card_path,
        external_audit_dir=external_audit_dir,
        output_directory=output_directory,
        hf_token=hf_token,
        development_eval_remote=development_eval_remote,
        project_root=project_root,
    )
