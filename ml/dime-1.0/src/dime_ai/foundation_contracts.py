"""Strict loading and semantic validation for the proposed Foundation v1 contracts."""

from __future__ import annotations

import errno
import hashlib
import json
import math
import os
import re
import stat
from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from decimal import Decimal
from pathlib import Path, PurePosixPath
from types import MappingProxyType
from typing import Any

import yaml
from jsonschema import Draft202012Validator
from jsonschema.exceptions import SchemaError
from yaml.events import AliasEvent
from yaml.nodes import MappingNode

PROJECT_ROOT = Path(__file__).resolve().parents[2]
BUILD_CONFIG_PATH = "configs/foundation_v1_build.yaml"
BUILD_SCHEMA_PATH = "schemas/foundation_build.schema.json"
BUILD_SCHEMA_VERSION = "dime-foundation-build-v2"
DATASET_VERSION = "dime-sft-foundation-v1"
MANIFEST_SCHEMA_VERSION = "dime-foundation-contract-bundle-manifest-v1"
CANONICAL_IDENTIFIER = re.compile(r"^[a-z][a-z0-9]*(?:[_-][a-z0-9]+)*$")
EMAIL_PATTERN = re.compile(r"[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}")
MAX_ERROR_LENGTH = 2_048
GOVERNED_RECOMPUTATION_TOLERANCE = Decimal("0.000000001")
GOVERNED_ROI_TOLERANCE = GOVERNED_RECOMPUTATION_TOLERANCE
REFERENCE_KEYWORDS = frozenset({"$ref", "$dynamicRef", "$recursiveRef"})

EXPECTED_REGISTRY: Mapping[str, Mapping[str, str]] = MappingProxyType(
    {
        "taxonomy": MappingProxyType(
            {
                "config_path": "configs/foundation_taxonomy_v1.yaml",
                "schema_path": "schemas/foundation_taxonomy.schema.json",
                "schema_version": "dime-foundation-taxonomy-v1",
            }
        ),
        "stage_profiles": MappingProxyType(
            {
                "config_path": "configs/foundation_stage_profiles_v1.yaml",
                "schema_path": "schemas/foundation_stage_profiles.schema.json",
                "schema_version": "dime-foundation-stage-profiles-v1",
            }
        ),
        "numeric_policy": MappingProxyType(
            {
                "config_path": "configs/foundation_numeric_policy_v1.yaml",
                "schema_path": "schemas/foundation_numeric_policy.schema.json",
                "schema_version": "dime-foundation-numeric-policy-v1",
            }
        ),
        "separation_of_duties": MappingProxyType(
            {
                "config_path": "configs/foundation_separation_of_duties_v1.yaml",
                "schema_path": "schemas/foundation_separation_of_duties.schema.json",
                "schema_version": "dime-foundation-separation-of-duties-v1",
            }
        ),
    }
)

EXPECTED_UNRESOLVED = (
    "foundation_skill_ids",
    "foundation_synthetic_provider_ids",
    "evaluation_task_types",
    "evaluation_data_quality_conditions",
    "task_family_to_skill_mapping",
    "curriculum_to_evaluation_family_mapping",
    "foundation_screen_to_evaluation_family_mapping",
)

EXPECTED_VOCABULARIES: Mapping[str, tuple[str, ...]] = MappingProxyType(
    {
        "task_families": (
            "conversation_epistemics",
            "tool_selection_arguments",
            "tool_grounding_failures",
            "market_math",
            "odds_movement_splits",
            "matchup_trends_projections",
            "bet_tracker_coaching",
            "simulation_analysis",
            "safety_privacy_security",
        ),
        "interaction_modes": (
            "successful_tool_assisted",
            "degraded_tool_assisted",
            "direct_no_tool",
            "clarification",
            "abstention",
            "protective_response",
        ),
        "difficulties": ("foundation", "intermediate", "hard", "adversarial"),
        "evidence_statuses": (
            "complete",
            "partial",
            "stale",
            "conflicting",
            "missing",
            "unauthorized",
            "blocked",
            "error",
            "not_applicable",
        ),
        "policy_actions": (
            "allow",
            "clarify",
            "abstain",
            "partial",
            "privacy_block",
            "age_block",
            "jurisdiction_block",
            "self_exclusion_block",
            "protective_block",
            "acute_distress_block",
            "not_applicable",
        ),
        "risk_tiers": ("standard", "high", "critical"),
        "answer_lengths": ("concise", "normal", "detailed"),
        "market_math_operations": (
            "implied_probability",
            "remove_vig",
            "market_hold",
            "expected_value",
            "settled_profit",
            "roi",
            "probability_clv",
        ),
        "numeric_units": (
            "probability",
            "percentage_points",
            "decimal_odds",
            "american_odds",
            "units",
            "roi",
            "count",
        ),
        "numeric_comparators": ("exact", "approximate"),
        "numeric_evidence_classes": (
            "tool_result",
            "user_input",
            "policy_constant",
            "deterministic_derivation",
        ),
        "safety_subfamilies": (
            "responsible_gaming",
            "privacy",
            "security",
            "eligibility",
            "acute_distress",
            "not_applicable",
        ),
        "sports": (
            "american_football",
            "baseball",
            "basketball",
            "ice_hockey",
            "soccer",
        ),
        "leagues": ("nfl", "mlb", "nba", "wnba", "nhl", "ncaaf", "ncaab", "epl"),
        "tool_statuses": (
            "ok",
            "partial",
            "not_found",
            "stale",
            "unauthorized",
            "blocked_by_policy",
            "error",
        ),
        "evaluation_splits": ("dev", "validation", "locked", "hidden", "red_team"),
        "evaluation_suites": ("standard", "safety", "privacy", "red_team", "operations"),
        "severities": ("low", "medium", "high", "critical"),
        "evaluation_risk_states": ("normal", "elevated", "blocked"),
        "market_phases": ("pregame", "live", "general"),
        "standard_evaluation_program_families": (
            "market_math",
            "odds_history_splits",
            "matchup_game_live",
            "simulation_projections",
            "bet_tracker_coaching",
            "degraded_data_abstention",
            "privacy_authorization",
            "responsible_gaming_eligibility",
            "general_multiturn_communication",
        ),
        "red_team_program_families": (
            "prompt_tool_injection_and_secret_extraction",
            "cross_tenant_history_pii_exfiltration",
            "eligibility_and_self_exclusion_bypass",
            "chasing_borrowing_escalation_guarantees",
            "acute_distress_or_self_harm",
            "future_data_poisoning_fake_fixtures",
            "malformed_forbidden_or_write_tools",
            "obfuscation_roleplay_history_conflict",
        ),
        "review_decisions": ("approve", "changes_requested", "reject"),
        "external_audit_types": (
            "semantic_deduplication",
            "privacy_and_identifiers",
            "rights",
            "development_evaluation_contamination",
            "locked_evaluation_contamination",
            "numeric_traceability",
        ),
    }
)


class FoundationContractError(ValueError):
    """Raised when the governed Foundation contract bundle is unsafe or inconsistent."""

    def __init__(self, message: str) -> None:
        bounded = message
        if len(bounded) > MAX_ERROR_LENGTH:
            bounded = bounded[: MAX_ERROR_LENGTH - 3] + "..."
        super().__init__(bounded)


@dataclass(frozen=True)
class LoadedFoundationContract:
    """One schema-validated contract and its exact byte identities."""

    name: str
    config_path: str
    schema_path: str
    schema_version: str
    document: Mapping[str, Any]
    config_sha256: str
    schema_sha256: str


@dataclass(frozen=True)
class FoundationContractBundle:
    """A fully validated Foundation contract bundle."""

    build: LoadedFoundationContract
    contracts: Mapping[str, LoadedFoundationContract]
    manifest: Mapping[str, Any]
    bundle_sha256: str


class _StrictYamlError(ValueError):
    pass


class _StrictJsonError(ValueError):
    pass


class _StrictSafeLoader(yaml.SafeLoader):
    def compose_node(self, parent: Any, index: Any) -> Any:
        if self.check_event(AliasEvent):
            raise _StrictYamlError("YAML aliases are not allowed")
        return super().compose_node(parent, index)


def _construct_strict_mapping(
    loader: _StrictSafeLoader,
    node: MappingNode,
    deep: bool = False,
) -> dict[str, Any]:
    if not isinstance(node, MappingNode):
        raise _StrictYamlError("expected a YAML mapping")
    mapping: dict[str, Any] = {}
    for key_node, value_node in node.value:
        if key_node.tag == "tag:yaml.org,2002:merge" or key_node.value == "<<":
            raise _StrictYamlError("YAML merge keys are not allowed")
        key = loader.construct_object(key_node, deep=deep)
        if not isinstance(key, str):
            raise _StrictYamlError("YAML requires string mapping keys")
        if key in mapping:
            raise _StrictYamlError("duplicate YAML key")
        mapping[key] = loader.construct_object(value_node, deep=deep)
    return mapping


_StrictSafeLoader.add_constructor(
    yaml.resolver.BaseResolver.DEFAULT_MAPPING_TAG,
    _construct_strict_mapping,
)


def _sha256(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def _freeze(value: Any) -> Any:
    if isinstance(value, dict):
        return MappingProxyType({key: _freeze(item) for key, item in value.items()})
    if isinstance(value, list):
        return tuple(_freeze(item) for item in value)
    return value


def _project_directory(project_root: str | Path | None) -> Path:
    candidate = PROJECT_ROOT if project_root is None else Path(project_root).absolute()
    try:
        resolved = candidate.resolve(strict=True)
    except OSError as exc:
        raise FoundationContractError("project_root: missing directory") from exc
    if resolved != candidate or candidate.is_symlink():
        raise FoundationContractError("project_root: symlink paths are not allowed")
    if not candidate.is_dir():
        raise FoundationContractError("project_root: expected a real directory")
    return candidate


def _safe_relative_path(value: str, *, label: str) -> PurePosixPath:
    if not isinstance(value, str) or not value:
        raise FoundationContractError(f"{label}: expected a nonempty repository-relative path")
    if "\\" in value:
        raise FoundationContractError(f"{label}: backslashes are not allowed")
    parts = value.split("/")
    if any(part in {"", ".", ".."} for part in parts):
        raise FoundationContractError(f"{label}: dot, empty, or traversal segments are not allowed")
    relative = PurePosixPath(value)
    if relative.is_absolute():
        raise FoundationContractError(f"{label}: absolute paths are not allowed")
    return relative


def _read_file_once(
    root: Path,
    relative_path: str,
    *,
    logical_name: str,
    kind: str,
) -> bytes:
    relative = _safe_relative_path(relative_path, label=f"{logical_name} {kind}")
    label = f"{logical_name} {kind} {relative_path}"
    if (
        not hasattr(os, "O_CLOEXEC")
        or not hasattr(os, "O_DIRECTORY")
        or not hasattr(os, "O_NOFOLLOW")
        or not hasattr(os, "O_NONBLOCK")
        or os.open not in os.supports_dir_fd
    ):
        raise FoundationContractError(
            f"{label}: secure descriptor-based file access is unavailable"
        )

    common_flags = os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW
    directory_flags = common_flags | os.O_DIRECTORY
    final_file_flags = common_flags | os.O_NONBLOCK
    descriptors: list[int] = []
    operation = "project_root"
    try:
        root_fd = os.open(root, directory_flags)
        descriptors.append(root_fd)
        if not stat.S_ISDIR(os.fstat(root_fd).st_mode):
            raise FoundationContractError("project_root: expected a real directory")

        directory_fd = root_fd
        operation = "directory"
        for part in relative.parts[:-1]:
            directory_fd = os.open(part, directory_flags, dir_fd=directory_fd)
            descriptors.append(directory_fd)
            if not stat.S_ISDIR(os.fstat(directory_fd).st_mode):
                raise FoundationContractError(f"{label}: path components must be real directories")

        operation = "file"
        file_fd = os.open(relative.parts[-1], final_file_flags, dir_fd=directory_fd)
        descriptors.append(file_fd)
        if not stat.S_ISREG(os.fstat(file_fd).st_mode):
            raise FoundationContractError(f"{label}: expected a regular file")

        operation = "read"
        chunks = []
        while chunk := os.read(file_fd, 1024 * 1024):
            chunks.append(chunk)
        return b"".join(chunks)
    except FoundationContractError:
        raise
    except OSError as exc:
        if operation == "project_root":
            if exc.errno in {errno.ELOOP, errno.ENOTDIR}:
                message = "project_root: symlink paths are not allowed"
            elif exc.errno == errno.ENOENT:
                message = "project_root: missing directory"
            else:
                message = "project_root: could not safely open directory"
        elif exc.errno == errno.ENOENT:
            message = f"{label}: missing file"
        elif exc.errno in {errno.ELOOP, errno.ENOTDIR}:
            message = f"{label}: symlink paths are not allowed"
        elif exc.errno == errno.EISDIR:
            message = f"{label}: expected a regular file"
        else:
            message = f"{label}: could not safely {operation}"
        raise FoundationContractError(message) from exc
    finally:
        for descriptor in reversed(descriptors):
            try:
                os.close(descriptor)
            except OSError:
                pass


def _decode_utf8(value: bytes, *, label: str) -> str:
    try:
        return value.decode("utf-8", errors="strict")
    except UnicodeDecodeError as exc:
        raise FoundationContractError(f"{label}: invalid UTF-8") from exc


def _check_supported_yaml(value: Any) -> None:
    if value is None or isinstance(value, (str, bool, int)):
        return
    if isinstance(value, float):
        if not math.isfinite(value):
            raise _StrictYamlError("YAML numeric values must be finite")
        return
    if isinstance(value, list):
        for item in value:
            _check_supported_yaml(item)
        return
    if isinstance(value, dict):
        for key, item in value.items():
            if not isinstance(key, str):
                raise _StrictYamlError("YAML requires string mapping keys")
            _check_supported_yaml(item)
        return
    raise _StrictYamlError("unsupported YAML scalar or object type")


def _strict_yaml(value: bytes, *, label: str) -> dict[str, Any]:
    text = _decode_utf8(value, label=label)
    loader = _StrictSafeLoader(text)
    try:
        document = loader.get_single_data()
    except _StrictYamlError as exc:
        raise FoundationContractError(f"{label}: {exc}") from exc
    except yaml.composer.ComposerError as exc:
        raise FoundationContractError(f"{label}: expected a single YAML document") from exc
    except yaml.YAMLError as exc:
        raise FoundationContractError(f"{label}: invalid YAML") from exc
    finally:
        loader.dispose()
    if not isinstance(document, dict):
        raise FoundationContractError(f"{label}: expected one top-level object")
    try:
        _check_supported_yaml(document)
    except _StrictYamlError as exc:
        raise FoundationContractError(f"{label}: {exc}") from exc
    return document


def _check_finite_json(value: Any) -> None:
    if isinstance(value, float) and not math.isfinite(value):
        raise _StrictJsonError("JSON numeric values must be finite")
    if isinstance(value, list):
        for item in value:
            _check_finite_json(item)
    elif isinstance(value, dict):
        for item in value.values():
            _check_finite_json(item)


def _parse_strict_json(value: bytes, *, label: str) -> Any:
    text = _decode_utf8(value, label=label)

    def object_pairs(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
        document: dict[str, Any] = {}
        for key, item in pairs:
            if key in document:
                raise _StrictJsonError("duplicate JSON key")
            document[key] = item
        return document

    def reject_constant(_constant: str) -> None:
        raise _StrictJsonError("JSON numeric values must be finite")

    try:
        document = json.loads(
            text,
            object_pairs_hook=object_pairs,
            parse_constant=reject_constant,
        )
        _check_finite_json(document)
    except _StrictJsonError as exc:
        raise FoundationContractError(f"{label}: {exc}") from exc
    except json.JSONDecodeError as exc:
        raise FoundationContractError(
            f"{label}: invalid JSON at line {exc.lineno}, column {exc.colno}"
        ) from exc
    return document


def _strict_json(value: bytes, *, label: str) -> dict[str, Any]:
    document = _parse_strict_json(value, label=label)
    if not isinstance(document, dict):
        raise FoundationContractError(f"{label}: expected one top-level object")
    return document


def _walk_refs(value: Any, *, label: str) -> None:
    if isinstance(value, dict):
        for key, item in value.items():
            if key in REFERENCE_KEYWORDS and (
                not isinstance(item, str) or not item.startswith("#")
            ):
                raise FoundationContractError(
                    f"{label}: JSON Schema references must be local fragments"
                )
            _walk_refs(item, label=label)
    elif isinstance(value, list):
        for item in value:
            _walk_refs(item, label=label)


def _strict_schema(value: bytes, *, label: str) -> dict[str, Any]:
    schema = _strict_json(value, label=label)
    if schema.get("$schema") != "https://json-schema.org/draft/2020-12/schema":
        raise FoundationContractError(f"{label}: expected JSON Schema Draft 2020-12")
    _walk_refs(schema, label=label)
    try:
        Draft202012Validator.check_schema(schema)
    except SchemaError as exc:
        raise FoundationContractError(f"{label}: invalid JSON Schema") from exc
    return schema


def _schema_reason(error: Any) -> str:
    reasons = {
        "additionalProperties": "Additional properties are not allowed",
        "anyOf": "must satisfy one governed alternative",
        "contains": "must contain the governed value",
        "const": "must equal the governed constant",
        "enum": "must use a governed value",
        "maxItems": "contains too many items",
        "maxLength": "is longer than the governed maximum",
        "maximum": "exceeds the governed maximum",
        "maxProperties": "contains too many properties",
        "minItems": "contains too few items",
        "minLength": "is shorter than the governed minimum",
        "minimum": "is below the governed minimum",
        "minProperties": "contains too few properties",
        "oneOf": "must satisfy exactly one governed alternative",
        "pattern": "must use a canonical identifier",
        "propertyNames": "contains a noncanonical property name",
        "required": "a required field is missing",
        "type": "has the wrong type",
        "uniqueItems": "items must be unique",
    }
    return reasons.get(error.validator, f"failed {error.validator} validation")


def _safe_schema_error_message(error: Any, *, label: str) -> str:
    """Describe a schema failure without reflecting instance content or paths."""

    schema_path = ".".join(str(item) for item in error.absolute_schema_path) or "$"
    return (
        f"{label}: schema violation (validation failed) at governed schema {schema_path}: "
        f"{_schema_reason(error)}"
    )


def _validate_document(
    document: Mapping[str, Any],
    schema: Mapping[str, Any],
    *,
    label: str,
) -> None:
    errors = sorted(
        Draft202012Validator(schema).iter_errors(document),
        key=lambda error: (
            tuple(str(item) for item in error.absolute_schema_path),
            str(error.validator),
        ),
    )
    if not errors:
        return
    lines = [_safe_schema_error_message(error, label=label) for error in errors[:20]]
    raise FoundationContractError("\n".join(lines))


def _capture_yaml(
    root: Path,
    relative_path: str,
    *,
    logical_name: str,
    kind: str = "config",
) -> tuple[bytes, dict[str, Any]]:
    data = _read_file_once(
        root,
        relative_path,
        logical_name=logical_name,
        kind=kind,
    )
    return data, _strict_yaml(data, label=f"{logical_name} {kind} {relative_path}")


def _capture_json(
    root: Path,
    relative_path: str,
    *,
    logical_name: str,
    kind: str,
) -> tuple[bytes, dict[str, Any]]:
    data = _read_file_once(
        root,
        relative_path,
        logical_name=logical_name,
        kind=kind,
    )
    return data, _strict_json(data, label=f"{logical_name} {kind} {relative_path}")


def _capture_schema(
    root: Path,
    relative_path: str,
    *,
    logical_name: str,
) -> tuple[bytes, dict[str, Any]]:
    data = _read_file_once(
        root,
        relative_path,
        logical_name=logical_name,
        kind="schema",
    )
    return data, _strict_schema(data, label=f"{logical_name} schema {relative_path}")


def _assert_equal(
    *,
    logical_name: str,
    path: str,
    actual: Any,
    expected: Any,
    reason: str,
) -> None:
    if actual != expected:
        raise FoundationContractError(f"{logical_name} at {path}: {reason}")


def _validate_authorization(document: Mapping[str, Any], logical_name: str) -> None:
    effect = document["authorization_effect"]
    _assert_equal(
        logical_name=logical_name,
        path="authorization_effect.scope",
        actual=effect["scope"],
        expected="governance_validation_only",
        reason="must remain governance validation only",
    )
    for key, value in effect.items():
        if key != "scope" and value is not False:
            raise FoundationContractError(
                f"{logical_name} at authorization_effect.{key}: authorization must remain false"
            )


def _tool_catalog(root: Path) -> tuple[dict[str, Any], ...]:
    data = _read_file_once(
        root,
        "tools/tools.v1.json",
        logical_name="tool_catalog",
        kind="config",
    )
    parsed = _parse_strict_json(
        data,
        label="tool_catalog config tools/tools.v1.json",
    )
    if not isinstance(parsed, list) or not all(isinstance(item, dict) for item in parsed):
        raise FoundationContractError("tool_catalog config tools/tools.v1.json: expected an array")
    return tuple(parsed)


def _reviewer_roles_and_registry(root: Path) -> tuple[tuple[str, ...], dict[str, Any]]:
    schema_bytes = _read_file_once(
        root,
        "schemas/foundation_reviewer_registry.schema.json",
        logical_name="reviewer_registry",
        kind="schema",
    )
    schema = _strict_schema(
        schema_bytes,
        label="reviewer_registry schema schemas/foundation_reviewer_registry.schema.json",
    )
    registry_bytes, registry = _capture_json(
        root,
        "configs/foundation_reviewer_registry.json",
        logical_name="reviewer_registry",
        kind="config",
    )
    del registry_bytes
    _validate_document(registry, schema, label="reviewer_registry")
    try:
        roles = tuple(schema["$defs"]["reviewer"]["properties"]["roles"]["items"]["enum"])
    except (KeyError, TypeError) as exc:
        raise FoundationContractError(
            "reviewer_registry schema: reviewer role inventory is missing"
        ) from exc
    return roles, registry


def _governed_programs(root: Path) -> tuple[dict[str, Any], dict[str, Any]]:
    _, curriculum = _capture_yaml(
        root,
        "configs/curriculum_v1.yaml",
        logical_name="curriculum",
    )
    _, evaluation = _capture_yaml(
        root,
        "configs/evaluation_program_v1.yaml",
        logical_name="evaluation_program",
    )
    return curriculum, evaluation


def _validate_taxonomy(
    taxonomy: Mapping[str, Any],
    *,
    build: Mapping[str, Any],
    curriculum: Mapping[str, Any],
    evaluation: Mapping[str, Any],
    tools: tuple[dict[str, Any], ...],
    reviewer_roles: tuple[str, ...],
) -> None:
    logical_name = "taxonomy"
    _validate_authorization(taxonomy, logical_name)
    vocabularies = taxonomy["vocabularies"]
    for name, values in vocabularies.items():
        if len(values) != len(set(values)):
            raise FoundationContractError(
                f"taxonomy at vocabularies.{name}: identifiers must be unique"
            )
        for value in values:
            if not CANONICAL_IDENTIFIER.fullmatch(value):
                raise FoundationContractError(
                    f"taxonomy at vocabularies.{name}: identifier must be canonical"
                )
    _assert_equal(
        logical_name=logical_name,
        path="vocabularies",
        actual=set(vocabularies),
        expected=set(EXPECTED_VOCABULARIES),
        reason="closed vocabulary inventory must remain exact",
    )
    for name, expected_values in EXPECTED_VOCABULARIES.items():
        _assert_equal(
            logical_name=logical_name,
            path=f"vocabularies.{name}",
            actual=tuple(vocabularies[name]),
            expected=expected_values,
            reason="closed vocabulary values must remain exact",
        )
    unresolved = taxonomy["unresolved_decisions"]
    _assert_equal(
        logical_name=logical_name,
        path="unresolved_decisions",
        actual=tuple(unresolved),
        expected=EXPECTED_UNRESOLVED,
        reason="unresolved decision inventory must remain explicit and unique",
    )

    aliases_seen: dict[str, str] = {}
    for category in ("sports", "leagues"):
        canonical_values = set(vocabularies[category])
        aliases = taxonomy["aliases"][category]
        _assert_equal(
            logical_name=logical_name,
            path=f"aliases.{category}",
            actual=set(aliases),
            expected=canonical_values,
            reason="alias groups must match canonical values",
        )
        for canonical, values in aliases.items():
            for alias in values:
                owner = aliases_seen.get(alias)
                if owner is not None and owner != canonical:
                    raise FoundationContractError(
                        f"taxonomy at aliases.{category}.{canonical}: alias collision"
                    )
                if alias in canonical_values and alias != canonical:
                    raise FoundationContractError(
                        f"taxonomy at aliases.{category}.{canonical}: "
                        "canonical value stored as alias"
                    )
                aliases_seen[alias] = canonical

    _assert_equal(
        logical_name=logical_name,
        path="aliases",
        actual=taxonomy["aliases"],
        expected={
            "sports": curriculum["distribution_aliases"]["sports"],
            "leagues": curriculum["distribution_aliases"]["leagues"],
        },
        reason="aliases must match curriculum",
    )
    _assert_equal(
        logical_name=logical_name,
        path="relationships.league_to_sport",
        actual=taxonomy["relationships"]["league_to_sport"],
        expected=curriculum["distribution_aliases"]["league_sports"],
        reason="league-to-sport mapping must match curriculum",
    )
    tool_names = tuple(item["function"]["name"] for item in tools)
    _assert_equal(
        logical_name=logical_name,
        path="registered_tools",
        actual=tuple(taxonomy["registered_tools"]),
        expected=tool_names,
        reason="registered tools must exactly match tool catalog",
    )
    _assert_equal(
        logical_name=logical_name,
        path="reviewer_roles",
        actual=tuple(taxonomy["reviewer_roles"]),
        expected=reviewer_roles,
        reason="reviewer roles must exactly match reviewer registry schema",
    )
    allowed_sources = taxonomy["source_classes"]["foundation_allowed"]
    recognized_sources = taxonomy["source_classes"]["recognized"]
    if not set(allowed_sources).issubset(recognized_sources):
        raise FoundationContractError(
            "taxonomy at source_classes: Foundation source class must be recognized"
        )
    _assert_equal(
        logical_name=logical_name,
        path="source_classes.foundation_allowed",
        actual=list(allowed_sources),
        expected=build["source_policy"]["allowed_source_classes"],
        reason="Foundation source classes must match build source policy",
    )
    governed_matches = {
        "task_families": tuple(curriculum["task_families"]),
        "interaction_modes": tuple(curriculum["interaction_modes"]),
        "answer_lengths": tuple(curriculum["answer_length_distribution"]),
        "market_math_operations": tuple(curriculum["market_math_operation_quotas"]),
        "sports": tuple(curriculum["distribution_aliases"]["sports"]),
        "leagues": tuple(curriculum["distribution_aliases"]["leagues"]),
        "standard_evaluation_program_families": tuple(evaluation["standard_task_quotas"]),
        "red_team_program_families": tuple(evaluation["red_team_task_quotas"]),
        "external_audit_types": tuple(build["external_audit_policy"]),
    }
    for name, expected in governed_matches.items():
        _assert_equal(
            logical_name=logical_name,
            path=f"vocabularies.{name}",
            actual=tuple(vocabularies[name]),
            expected=expected,
            reason="vocabulary must match governed source",
        )
    _assert_equal(
        logical_name=logical_name,
        path="relationships.market_type_required_task_families",
        actual=list(taxonomy["relationships"]["market_type_required_task_families"]),
        expected=curriculum["metadata_requirements"]["market_type_required_task_families"],
        reason="market metadata relationship must match curriculum",
    )
    _assert_equal(
        logical_name=logical_name,
        path="relationships.provider_ids_required_tools",
        actual=list(taxonomy["relationships"]["provider_ids_required_tools"]),
        expected=curriculum["metadata_requirements"]["provider_id_required_tools"],
        reason="provider relationship must match curriculum",
    )


def _split_total(profile: Mapping[str, Any]) -> int:
    return sum(profile["splits"].values())


def _assert_split_allocations(
    profile: Mapping[str, Any],
    key: str,
    *,
    taxonomy_values: Iterable[str],
) -> None:
    allocations = profile[key]
    if not set(allocations).issubset(taxonomy_values):
        raise FoundationContractError(
            f"stage_profiles at profiles.{profile['profile_id']}.{key}: unknown task or interaction"
        )
    if not allocations:
        return
    expected_train = profile["splits"].get("train", 0)
    expected_validation = profile["splits"].get("validation", 0)
    if sum(value["train"] for value in allocations.values()) != expected_train:
        raise FoundationContractError(
            f"stage_profiles at profiles.{profile['profile_id']}.{key}: train allocation mismatch"
        )
    if sum(value["validation"] for value in allocations.values()) != expected_validation:
        raise FoundationContractError(
            f"stage_profiles at profiles.{profile['profile_id']}.{key}: "
            "validation allocation mismatch"
        )


def _validate_stage_profiles(
    stage_profiles: Mapping[str, Any],
    *,
    taxonomy: Mapping[str, Any],
    curriculum: Mapping[str, Any],
    evaluation: Mapping[str, Any],
) -> None:
    logical_name = "stage_profiles"
    _validate_authorization(stage_profiles, logical_name)
    profiles = stage_profiles["profiles"]
    ids = tuple(profile["profile_id"] for profile in profiles)
    _assert_equal(
        logical_name=logical_name,
        path="profiles",
        actual=ids,
        expected=tuple(stage_profiles["readiness_sequence"]),
        reason="stage order must be exact and acyclic",
    )
    source_ids = tuple(profile["source_stage_id"] for profile in profiles)
    if len(source_ids) != len(set(source_ids)):
        raise FoundationContractError("stage_profiles at profiles: source-stage IDs must be unique")
    curriculum_stages = curriculum["stages"][:4]
    _assert_equal(
        logical_name=logical_name,
        path="profiles.source_stage_id",
        actual=source_ids,
        expected=tuple(stage["name"] for stage in curriculum_stages),
        reason="source stages must match curriculum",
    )
    by_id = {profile["profile_id"]: profile for profile in profiles}
    expected_boundaries = {
        "foundation_screen_v1": (48, {"development": 48}),
        "overfit_diagnostic_v1": (32, {"train": 32, "validation": 0}),
        "foundation_tranche_v1": (600, {"train": 540, "validation": 60}),
        "complete_foundation_sft_v1": (2400, {"train": 2160, "validation": 240}),
    }
    expected_metadata = {
        "foundation_screen_v1": ("development_evaluation", False),
        "overfit_diagnostic_v1": ("sft_diagnostic", True),
        "foundation_tranche_v1": ("sft_candidate", False),
        "complete_foundation_sft_v1": ("sft_candidate", False),
    }
    for profile_id, (expected_total, expected_splits) in expected_boundaries.items():
        profile = by_id[profile_id]
        if profile["total"] != expected_total or dict(profile["splits"]) != expected_splits:
            raise FoundationContractError(
                f"stage_profiles at profiles.{profile_id}.split: profile boundary mismatch"
            )
        artifact_type, gpu_required = expected_metadata[profile_id]
        if profile["artifact_type"] != artifact_type or profile["gpu_required"] is not gpu_required:
            raise FoundationContractError(
                f"stage_profiles at profiles.{profile_id}: artifact or GPU metadata mismatch"
            )
        if _split_total(profile) != profile["total"]:
            raise FoundationContractError(
                f"stage_profiles at profiles.{profile_id}.split: total does not equal splits"
            )
        for name, minimum in profile["cross_cutting_minimums"].items():
            if minimum < 0 or minimum > profile["total"]:
                raise FoundationContractError(
                    f"stage_profiles at profiles.{profile_id}.{name}: minimum outside stage total"
                )
        if set(profile["tool_single_call_minimums"]) - set(taxonomy["registered_tools"]):
            raise FoundationContractError(
                f"stage_profiles at profiles.{profile_id}: unknown tool minimum"
            )
        _assert_split_allocations(
            profile,
            "task_allocations",
            taxonomy_values=taxonomy["vocabularies"]["task_families"],
        )
        _assert_split_allocations(
            profile,
            "interaction_allocations",
            taxonomy_values=taxonomy["vocabularies"]["interaction_modes"],
        )
        eligibility = profile["eligibility"]
        if profile_id != "complete_foundation_sft_v1" and (
            eligibility["candidate_audit_eligible"] or eligibility["freeze_gate_eligible"]
        ):
            raise FoundationContractError(
                f"stage_profiles at profiles.{profile_id}.freeze: partial profile is ineligible"
            )
        if eligibility["release_eligible"]:
            raise FoundationContractError(
                f"stage_profiles at profiles.{profile_id}.release: "
                "release eligibility is prohibited"
            )

    screen = by_id["foundation_screen_v1"]
    _assert_equal(
        logical_name=logical_name,
        path="profiles.foundation_screen_v1.category_quotas",
        actual=screen["category_quotas"],
        expected=evaluation["foundation_screen"]["task_quotas"],
        reason="screen quotas must match evaluation program",
    )
    _assert_equal(
        logical_name=logical_name,
        path="profiles.foundation_screen_v1.cross_cutting_minimums",
        actual=screen["cross_cutting_minimums"],
        expected=evaluation["foundation_screen"]["minimums"],
        reason="screen minimums must match evaluation program",
    )
    if sum(screen["category_quotas"].values()) != screen["total"]:
        raise FoundationContractError(
            "stage_profiles at profiles.foundation_screen_v1: category quota total mismatch"
        )

    expected_diagnostic_tasks = {
        "conversation_epistemics": {"train": 3, "validation": 0},
        "tool_selection_arguments": {"train": 5, "validation": 0},
        "tool_grounding_failures": {"train": 5, "validation": 0},
        "market_math": {"train": 4, "validation": 0},
        "odds_movement_splits": {"train": 3, "validation": 0},
        "matchup_trends_projections": {"train": 3, "validation": 0},
        "bet_tracker_coaching": {"train": 3, "validation": 0},
        "simulation_analysis": {"train": 2, "validation": 0},
        "safety_privacy_security": {"train": 4, "validation": 0},
    }
    _assert_equal(
        logical_name=logical_name,
        path="profiles.overfit_diagnostic_v1.task_allocations",
        actual=by_id["overfit_diagnostic_v1"]["task_allocations"],
        expected=expected_diagnostic_tasks,
        reason="diagnostic allocation must remain exact",
    )
    diagnostic_tools = by_id["overfit_diagnostic_v1"]["tool_single_call_minimums"]
    if set(diagnostic_tools) != set(taxonomy["registered_tools"]) or any(
        minimum < 1 for minimum in diagnostic_tools.values()
    ):
        raise FoundationContractError(
            "stage_profiles at profiles.overfit_diagnostic_v1: "
            "diagnostic tool minimums must cover all registered tools"
        )

    expected_tranche_tasks = {
        "conversation_epistemics": {"train": 54, "validation": 6},
        "tool_selection_arguments": {"train": 81, "validation": 9},
        "tool_grounding_failures": {"train": 81, "validation": 9},
        "market_math": {"train": 54, "validation": 6},
        "odds_movement_splits": {"train": 68, "validation": 7},
        "matchup_trends_projections": {"train": 54, "validation": 6},
        "bet_tracker_coaching": {"train": 54, "validation": 6},
        "simulation_analysis": {"train": 40, "validation": 5},
        "safety_privacy_security": {"train": 54, "validation": 6},
    }
    expected_tranche_interactions = {
        "successful_tool_assisted": {"train": 270, "validation": 30},
        "degraded_tool_assisted": {"train": 95, "validation": 10},
        "direct_no_tool": {"train": 108, "validation": 12},
        "clarification": {"train": 23, "validation": 2},
        "abstention": {"train": 22, "validation": 3},
        "protective_response": {"train": 22, "validation": 3},
    }
    tranche = by_id["foundation_tranche_v1"]
    _assert_equal(
        logical_name=logical_name,
        path="profiles.foundation_tranche_v1.task_allocations",
        actual=tranche["task_allocations"],
        expected=expected_tranche_tasks,
        reason="tranche task allocation must remain exact",
    )
    _assert_equal(
        logical_name=logical_name,
        path="profiles.foundation_tranche_v1.interaction_allocations",
        actual=tranche["interaction_allocations"],
        expected=expected_tranche_interactions,
        reason="tranche interaction allocation must remain exact",
    )
    tranche_tools = tranche["tool_single_call_minimums"]
    if set(tranche_tools) != set(taxonomy["registered_tools"]) or any(
        minimum < 10 for minimum in tranche_tools.values()
    ):
        raise FoundationContractError(
            "stage_profiles at profiles.foundation_tranche_v1: "
            "tranche tool minimums must cover every tool at ten or more"
        )

    complete = by_id["complete_foundation_sft_v1"]
    if complete["eligibility"] != {
        "candidate_audit_eligible": True,
        "freeze_gate_eligible": True,
        "release_eligible": False,
    }:
        raise FoundationContractError(
            "stage_profiles at profiles.complete_foundation_sft_v1.freeze: "
            "complete audit and freeze eligibility must remain exact"
        )
    _assert_equal(
        logical_name=logical_name,
        path="profiles.complete_foundation_sft_v1.task_allocations",
        actual=complete["task_allocations"],
        expected=curriculum["task_families"],
        reason="complete task allocation must match curriculum",
    )
    _assert_equal(
        logical_name=logical_name,
        path="profiles.complete_foundation_sft_v1.interaction_allocations",
        actual=complete["interaction_allocations"],
        expected=curriculum["interaction_modes"],
        reason="complete interaction allocation must match curriculum",
    )
    complete_matches = {
        "cross_cutting_minimums": curriculum["cross_cutting_minimums"],
        "tool_single_call_minimums": curriculum["tool_single_call_minimums"],
        "answer_length_distribution": curriculum["answer_length_distribution"],
        "market_math_operation_quotas": curriculum["market_math_operation_quotas"],
        "safety_subfamily_minimums": curriculum["safety_subfamily_minimums"],
        "control_pair_minimums": curriculum["control_pair_minimums"],
        "control_pair_policy": curriculum["control_pair_policy"],
        "distribution_caps": curriculum["distribution_caps"],
    }
    for field, expected in complete_matches.items():
        actual = (
            complete[field]
            if field in {"cross_cutting_minimums", "tool_single_call_minimums"}
            else complete["complete_requirements"][field]
        )
        _assert_equal(
            logical_name=logical_name,
            path=f"profiles.complete_foundation_sft_v1.{field}",
            actual=actual,
            expected=expected,
            reason="complete profile must match curriculum",
        )


def _validate_numeric_policy(
    numeric: Mapping[str, Any],
    *,
    taxonomy: Mapping[str, Any],
    build: Mapping[str, Any],
    curriculum: Mapping[str, Any],
    tools: tuple[dict[str, Any], ...],
) -> None:
    logical_name = "numeric_policy"
    _validate_authorization(numeric, logical_name)
    _assert_equal(
        logical_name=logical_name,
        path="tolerances",
        actual=numeric["tolerances"],
        expected=build["record_policy"]["numeric_tolerance_maximums"],
        reason="tolerances must exactly match build config",
    )
    for unit, tolerance in numeric["tolerances"].items():
        if isinstance(tolerance, bool) or not isinstance(tolerance, (int, float)):
            raise FoundationContractError(
                f"numeric_policy at tolerances.{unit}: tolerance must be numeric"
            )
        if not math.isfinite(float(tolerance)) or tolerance < 0:
            raise FoundationContractError(
                f"numeric_policy at tolerances.{unit}: tolerance must be finite and nonnegative"
            )
    for exact_unit in ("american_odds", "count"):
        if numeric["tolerances"][exact_unit] != 0:
            raise FoundationContractError(
                f"numeric_policy at tolerances.{exact_unit}: exact unit requires zero tolerance"
            )
    if Decimal(str(numeric["tolerances"]["roi"])) != GOVERNED_ROI_TOLERANCE:
        raise FoundationContractError(
            "numeric_policy at tolerances.roi: governed runtime tolerance mismatch"
        )
    _assert_equal(
        logical_name=logical_name,
        path="tolerances",
        actual=set(numeric["tolerances"]),
        expected=set(taxonomy["vocabularies"]["numeric_units"]),
        reason="numeric units must match taxonomy",
    )
    _assert_equal(
        logical_name=logical_name,
        path="evidence_classes",
        actual=set(numeric["evidence_classes"]),
        expected=set(taxonomy["vocabularies"]["numeric_evidence_classes"]),
        reason="numeric evidence classes must match taxonomy",
    )
    operations = tuple(numeric["market_math"]["operations"])
    _assert_equal(
        logical_name=logical_name,
        path="market_math.operations",
        actual=operations,
        expected=tuple(curriculum["market_math_operation_quotas"]),
        reason="market-math operations must match curriculum",
    )
    calculate_tool = next(
        item for item in tools if item["function"]["name"] == "calculate_market_math"
    )
    catalog_operations = tuple(
        calculate_tool["function"]["parameters"]["properties"]["operation"]["enum"]
    )
    _assert_equal(
        logical_name=logical_name,
        path="market_math.operations",
        actual=operations,
        expected=catalog_operations,
        reason="market-math operations must match tool catalog",
    )
    _assert_equal(
        logical_name=logical_name,
        path="evidence_classes.tool_result.verified_status",
        actual=numeric["evidence_classes"]["tool_result"]["verified_status"],
        expected="ok",
        reason="only ok tool evidence may be verified",
    )
    if not numeric["market_math"]["independent_recomputation_required"]:
        raise FoundationContractError(
            "numeric_policy at market_math.recomputation: independent recomputation is required"
        )
    if (
        Decimal(str(numeric["market_math"]["recomputation_tolerance"]))
        != GOVERNED_RECOMPUTATION_TOLERANCE
    ):
        raise FoundationContractError(
            "numeric_policy at market_math.recomputation: governed runtime tolerance mismatch"
        )


def _validate_separation(
    separation: Mapping[str, Any],
    *,
    taxonomy: Mapping[str, Any],
    build: Mapping[str, Any],
    reviewer_roles: tuple[str, ...],
    reviewer_registry: Mapping[str, Any],
) -> None:
    logical_name = "separation_of_duties"
    _validate_authorization(separation, logical_name)
    record_review = separation["record_review"]
    if set(record_review["allowed_reviewer_principal_types"]) != {"human", "ai_agent"}:
        raise FoundationContractError(
            "separation_of_duties at record_review.principals: "
            "human and AI-agent reviewers must both be supported"
        )
    if not record_review["automated_agent_may_approve"]:
        raise FoundationContractError(
            "separation_of_duties at record_review.automated: "
            "registered AI-agent approval must be supported"
        )
    if not record_review["agent_profile_binding_required"]:
        raise FoundationContractError(
            "separation_of_duties at record_review.agent_profile: "
            "AI-agent profile binding is required"
        )
    if not record_review["agent_decision_receipt_required"]:
        raise FoundationContractError(
            "separation_of_duties at record_review.agent_receipt: "
            "AI-agent decision receipts are required"
        )
    if not record_review["agent_decision_receipt_signature_verification_required"]:
        raise FoundationContractError(
            "separation_of_duties at record_review.agent_receipt_signature: "
            "AI-agent receipt signature verification is required"
        )
    if record_review["agent_may_review_own_output"]:
        raise FoundationContractError(
            "separation_of_duties at record_review.agent_self_review: "
            "AI agents may not review their own output"
        )
    if record_review["author_may_review_own_record"]:
        raise FoundationContractError(
            "separation_of_duties at record_review.author: author self-review is prohibited"
        )
    if record_review["standard_minimum_approvals"] < 1:
        raise FoundationContractError(
            "separation_of_duties at record_review.standard: at least one approval is required"
        )
    if record_review["elevated_minimum_approvals"] < 2:
        raise FoundationContractError(
            "separation_of_duties at record_review.elevated: at least two approvals are required"
        )
    if separation["dataset_approval"]["minimum_dataset_approvals"] < 2:
        raise FoundationContractError(
            "separation_of_duties at dataset_approval: at least two approvals are required"
        )
    _assert_equal(
        logical_name=logical_name,
        path="elevated_review.task_families",
        actual=list(separation["elevated_review"]["task_families"]),
        expected=build["review_policy"]["elevated_task_families"],
        reason="elevated tasks must match build policy",
    )
    _assert_equal(
        logical_name=logical_name,
        path="elevated_review.policy_actions",
        actual=list(separation["elevated_review"]["policy_actions"]),
        expected=build["review_policy"]["elevated_policy_actions"],
        reason="elevated actions must match build policy",
    )
    _assert_equal(
        logical_name=logical_name,
        path="elevated_review.required_specialists",
        actual=separation["elevated_review"]["required_specialists"],
        expected=build["review_policy"]["required_specialist_roles"],
        reason="specialist mapping must match build policy",
    )
    roles = set(reviewer_roles)
    used_roles = {
        *separation["elevated_review"]["required_specialists"].values(),
        separation["dataset_approval"]["required_role"],
        *(value["required_role"] for value in separation["external_audits"].values()),
    }
    if not used_roles.issubset(roles):
        raise FoundationContractError(
            "separation_of_duties at roles: unknown reviewer role or specialist"
        )
    if not set(separation["elevated_review"]["task_families"]).issubset(
        taxonomy["vocabularies"]["task_families"]
    ):
        raise FoundationContractError(
            "separation_of_duties at elevated_review.task_families: unknown task"
        )
    if not set(separation["elevated_review"]["policy_actions"]).issubset(
        taxonomy["vocabularies"]["policy_actions"]
    ):
        raise FoundationContractError(
            "separation_of_duties at elevated_review.policy_actions: unknown policy action"
        )
    for audit_name, expected in build["external_audit_policy"].items():
        actual = separation["external_audits"][audit_name]
        if (
            actual["tool_id"] != expected["tool_id"]
            or actual["tool_version"] != expected["tool_version"]
        ):
            raise FoundationContractError(
                f"separation_of_duties at external_audits.{audit_name}: audit tool mismatch"
            )
    if reviewer_registry["status"] != "proposed" or any(
        reviewer["active"] for reviewer in reviewer_registry["reviewers"]
    ):
        raise FoundationContractError(
            "separation_of_duties at reviewer registry: "
            "registry must remain proposed with no active reviewers"
        )
    serialized = json.dumps(separation, ensure_ascii=False, allow_nan=False)
    if EMAIL_PATTERN.search(serialized):
        raise FoundationContractError(
            "separation_of_duties at prohibited content: email addresses are not allowed"
        )


def _load_bundle(project_root: str | Path | None) -> FoundationContractBundle:
    root = _project_directory(project_root)
    build_bytes, build_document = _capture_yaml(
        root,
        BUILD_CONFIG_PATH,
        logical_name="foundation_build",
    )
    build_schema_bytes, build_schema = _capture_schema(
        root,
        BUILD_SCHEMA_PATH,
        logical_name="foundation_build",
    )
    _validate_document(build_document, build_schema, label="foundation_build")
    if build_document["schema_version"] != BUILD_SCHEMA_VERSION:
        raise FoundationContractError(
            "foundation_build at schema_version: build schema version mismatch"
        )

    registry = build_document["contract_registry"]["contracts"]
    _assert_equal(
        logical_name="foundation_build",
        path="contract_registry.contracts",
        actual=set(registry),
        expected=set(EXPECTED_REGISTRY),
        reason="registry must contain exactly four contracts",
    )
    seen_paths: set[str] = set()
    loaded: dict[str, LoadedFoundationContract] = {}
    mutable_documents: dict[str, dict[str, Any]] = {}
    for name in sorted(EXPECTED_REGISTRY):
        entry = registry[name]
        expected = EXPECTED_REGISTRY[name]
        for field in ("config_path", "schema_path", "schema_version"):
            _assert_equal(
                logical_name="foundation_build",
                path=f"contract_registry.contracts.{name}.{field}",
                actual=entry[field],
                expected=expected[field],
                reason="registry entry must use the canonical value",
            )
        for field in ("config_path", "schema_path"):
            path = entry[field]
            _safe_relative_path(path, label=f"{name} {field}")
            if path in seen_paths:
                raise FoundationContractError(
                    f"foundation_build at contract_registry.contracts.{name}.{field}: "
                    "duplicate path"
                )
            seen_paths.add(path)
        config_bytes, document = _capture_yaml(
            root,
            entry["config_path"],
            logical_name=name,
        )
        schema_bytes, schema = _capture_schema(
            root,
            entry["schema_path"],
            logical_name=name,
        )
        _validate_document(document, schema, label=f"{name} {entry['config_path']}")
        if document.get("schema_version") != entry["schema_version"]:
            raise FoundationContractError(
                f"{name} at schema_version: child schema version does not match registry"
            )
        mutable_documents[name] = document
        loaded[name] = LoadedFoundationContract(
            name=name,
            config_path=entry["config_path"],
            schema_path=entry["schema_path"],
            schema_version=entry["schema_version"],
            document=_freeze(document),
            config_sha256=_sha256(config_bytes),
            schema_sha256=_sha256(schema_bytes),
        )

    from dime_ai.tool_contracts import MARKET_CATALOG_PATH, load_tool_contracts

    tool_contracts = load_tool_contracts(project_root=root)
    if build_document["tool_contract_bundle_sha256"] != tool_contracts.bundle_sha256:
        raise FoundationContractError(
            "foundation_build at tool_contract_bundle_sha256: tool contract bundle mismatch"
        )
    tools = _tool_catalog(root)
    reviewer_roles, reviewer_registry = _reviewer_roles_and_registry(root)
    curriculum, evaluation = _governed_programs(root)
    taxonomy = mutable_documents["taxonomy"]
    if taxonomy["market_catalog"] != {
        "path": MARKET_CATALOG_PATH,
        "version": tool_contracts.market_catalog["catalog_version"],
        "sha256": tool_contracts.file_sha256[MARKET_CATALOG_PATH],
    }:
        raise FoundationContractError(
            "taxonomy at market_catalog: canonical market catalog binding mismatch"
        )
    stage_profiles = mutable_documents["stage_profiles"]
    numeric = mutable_documents["numeric_policy"]
    separation = mutable_documents["separation_of_duties"]
    for name, document in mutable_documents.items():
        _assert_equal(
            logical_name=name,
            path="dataset_version",
            actual=document["dataset_version"],
            expected=build_document["dataset_version"],
            reason="dataset version must match build config",
        )
    _validate_taxonomy(
        taxonomy,
        build=build_document,
        curriculum=curriculum,
        evaluation=evaluation,
        tools=tools,
        reviewer_roles=reviewer_roles,
    )
    _validate_stage_profiles(
        stage_profiles,
        taxonomy=taxonomy,
        curriculum=curriculum,
        evaluation=evaluation,
    )
    _validate_numeric_policy(
        numeric,
        taxonomy=taxonomy,
        build=build_document,
        curriculum=curriculum,
        tools=tools,
    )
    _validate_separation(
        separation,
        taxonomy=taxonomy,
        build=build_document,
        reviewer_roles=reviewer_roles,
        reviewer_registry=reviewer_registry,
    )

    build_contract = LoadedFoundationContract(
        name="foundation_build",
        config_path=BUILD_CONFIG_PATH,
        schema_path=BUILD_SCHEMA_PATH,
        schema_version=BUILD_SCHEMA_VERSION,
        document=_freeze(build_document),
        config_sha256=_sha256(build_bytes),
        schema_sha256=_sha256(build_schema_bytes),
    )
    ordered_contracts = MappingProxyType({name: loaded[name] for name in sorted(loaded)})
    all_contracts = [build_contract, *ordered_contracts.values()]
    manifest_bytes = canonical_contract_manifest_bytes(all_contracts)
    manifest_document = json.loads(manifest_bytes)
    return FoundationContractBundle(
        build=build_contract,
        contracts=ordered_contracts,
        manifest=_freeze(manifest_document),
        bundle_sha256=_sha256(manifest_bytes),
    )


def canonical_contract_manifest_bytes(
    contracts: Iterable[LoadedFoundationContract],
) -> bytes:
    """Serialize exact contract identities into the canonical five-entry manifest."""

    entries = []
    seen: set[str] = set()
    for contract in contracts:
        if contract.name in seen:
            raise FoundationContractError("bundle manifest: duplicate contract name")
        seen.add(contract.name)
        entries.append(
            {
                "name": contract.name,
                "config_path": contract.config_path,
                "config_sha256": contract.config_sha256,
                "schema_path": contract.schema_path,
                "schema_sha256": contract.schema_sha256,
                "schema_version": contract.schema_version,
            }
        )
    entries.sort(key=lambda entry: entry["name"])
    if [entry["name"] for entry in entries] != [
        "foundation_build",
        "numeric_policy",
        "separation_of_duties",
        "stage_profiles",
        "taxonomy",
    ]:
        raise FoundationContractError(
            "bundle manifest: expected exactly five canonical contract entries"
        )
    document = {
        "schema_version": MANIFEST_SCHEMA_VERSION,
        "entries": entries,
    }
    return (
        json.dumps(
            document,
            sort_keys=True,
            separators=(",", ":"),
            ensure_ascii=False,
            allow_nan=False,
        ).encode("utf-8")
        + b"\n"
    )


def load_foundation_contracts(
    *,
    project_root: str | Path | None = None,
) -> FoundationContractBundle:
    """Load, validate, and identify the complete Foundation contract bundle."""

    try:
        return _load_bundle(project_root)
    except FoundationContractError:
        raise
    except Exception as exc:
        raise FoundationContractError(
            "foundation contract bundle: unexpected validation failure"
        ) from exc


def load_foundation_contract(
    name: str,
    *,
    project_root: str | Path | None = None,
) -> LoadedFoundationContract:
    """Load one named child contract through the fully validated bundle."""

    if name not in EXPECTED_REGISTRY:
        raise FoundationContractError("unknown contract name")
    return load_foundation_contracts(project_root=project_root).contracts[name]
