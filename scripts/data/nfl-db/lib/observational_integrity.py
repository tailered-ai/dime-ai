#!/usr/bin/env python3
"""Observation of the explicitly NON-BLOCKING fields (Phase 6).

Phase 4 answers "are the bytes identical?" for immutable history. That question
is exactly wrong for the seven provider-derived floats: upstream R serialises at
15 significant digits while a double needs 17 to round-trip, so the same logical
value renders as "0.06" in one regeneration and "0.0599999999999999" in another.
An exact hash over those columns would fail on every regeneration; no observation
at all would let a genuine model revision pass unseen.

So this module answers a different question -- "are the VALUES materially
different?" -- and it is deliberately separate from content_digest.py. Exact
integrity and approximate numerical comparison are different contracts; merging
them would eventually let tolerance leak into the frozen-history gate.

What it must never do:
  * treat a structural difference (missing row, NULL transition, type change,
    non-finite value) as numerical noise -- tolerance applies only when the same
    semantic row holds two valid comparable numbers;
  * decide identity. A gsis_source transition is provenance, and provenance
    never ratifies a change to the human a row refers to;
  * silently become the new baseline.

Tolerances live in season_pins.OBSERVATION_SPECS. Nothing here defines one.
"""
from __future__ import annotations

import gzip
import hashlib
import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import season_pins as sp  # noqa: E402

BASELINE_VERSION = "nfldb-observational-1"

# ---- per-cell classifications (§13) --------------------------------------
SAME = "SAME"
NUMERICAL_NOISE = "NUMERICAL_NOISE"
MATERIAL_CHANGE = "MATERIAL_CHANGE"
TYPE_OR_NULL_CHANGE = "TYPE_OR_NULL_CHANGE"

# ---- overall status (§40) ------------------------------------------------
PASS = "PASS"                        # nothing moved
OBSERVED_NOISE = "OBSERVED_NOISE"    # only within-tolerance / benign relabels
REVIEW_REQUIRED = "REVIEW_REQUIRED"  # material movement; a human must look
FAIL = "FAIL"                        # a BLOCKING invariant broke during observation

_RANK = {PASS: 0, OBSERVED_NOISE: 1, REVIEW_REQUIRED: 2, FAIL: 3}


def worst(*statuses):
    return max(statuses, key=lambda s: _RANK[s]) if statuses else PASS


class AmbiguousKeyError(RuntimeError):
    """The observation key is not one-to-one. Never silently deduplicate."""


class BaselineError(RuntimeError):
    """The baseline is absent, malformed, or describes a different contract."""


# --------------------------------------------------------------------------
# Row alignment  (§11/§12)
# --------------------------------------------------------------------------
#: How each observed surface's semantic row key is formed. NOT the surrogate id:
#: Phase 5 proved those are assignment artefacts, so aligning on one would pair
#: unrelated rows whenever load order shifted.
#:
#: depth_chart's key is DERIVED (blocking projection minus the identity column
#: being cross-checked) rather than hand-listed, because a hand-listed key was
#: the defect this design exists to prevent. Phase 5 aligned depth_chart on nine
#: hand-picked columns; that key is NOT unique -- it collapses 331,628 of
#: 1,106,729 frozen rows -- so a dict load silently kept one row per key and
#: dropped the rest. The findings survived (re-verified by set difference over
#: the full population) but nothing had guaranteed it. Hence: derive the key and
#: PROVE uniqueness, rather than trusting a list someone wrote once.
KEY_SPEC = {
    "player_game_stats": {"explicit": ("gsis_id", "season", "week",
                                       "season_type", "game_id")},
    "depth_chart": {"projection_minus": ("gsis_id",)},
}


def observation_key(conn, table):
    spec = KEY_SPEC[table]
    if "explicit" in spec:
        return tuple(spec["explicit"])
    drop = set(spec["projection_minus"])
    return tuple(c for c in sp.projection(conn, table) if c not in drop)


def read_observed(conn, table):
    """(values, key_digest, rows) for one surface, in canonical key order.

    The key columns are NOT returned: every one of them is a blocking field, so
    Phase 4's digest already pins them. What is returned instead is a digest of
    the ordered key sequence, which proves the two sides line up. If it differs,
    the comparison reports a structural difference rather than pairing rows that
    may not correspond.

    Ordering happens in Python, not SQL. `ORDER BY` over depth_chart's 22-column
    key made SQLite spill to a disk sort and cost ~100s; the same sort in memory
    costs a few seconds. Uniqueness is proven in the SAME pass by comparing
    adjacent keys -- a separate `SELECT DISTINCT` over 22 columns cost another
    ~200s and proved exactly what an adjacency check proves for free.
    """
    key = observation_key(conn, table)
    fields = list(sp.observed_fields(table))
    if not fields:
        return [], "", 0
    nk = len(key)
    sel = f"{', '.join(key)}, {', '.join(fields)}"
    rows = conn.execute(
        f"SELECT {sel} FROM {table} WHERE {sp.window(table).predicate}").fetchall()
    # Sort by repr(key) -- one string per row rather than a 22-element tuple of
    # coerced values. Ordering by repr is not value order, and does not need to
    # be: it only has to be a deterministic total order that both sides compute
    # identically. It also happens to be the exact string already needed for the
    # sequence digest, so the work is done once instead of twice.
    keyed = [(repr(r[:nk]), r) for r in rows]
    keyed.sort(key=lambda p: p[0])
    h = hashlib.sha256()
    values = []
    previous = None
    for krepr, row in keyed:
        if krepr == previous:
            raise AmbiguousKeyError(
                f"{table}: observation key is not one-to-one (duplicate at "
                f"{krepr}). Alignment would be ambiguous, so the comparison is "
                f"refused rather than silently deduplicated.")
        previous = krepr
        h.update(krepr.encode())
        values.append(row[nk:])
    return values, h.hexdigest(), len(values)


def prove_key_is_unique(conn, table):
    """Refuse to observe on an ambiguous key. §11.

    Kept as an explicit, independently callable check -- read_observed also
    proves it in-pass, but a caller that wants the guarantee without materialising
    the surface should not have to know that."""
    key = observation_key(conn, table)
    where = sp.window(table).predicate
    total = conn.execute(f"SELECT COUNT(*) FROM {table} WHERE {where}").fetchone()[0]
    distinct = conn.execute(
        f"SELECT COUNT(*) FROM (SELECT DISTINCT {', '.join(key)} "
        f"FROM {table} WHERE {where})").fetchone()[0]
    if total != distinct:
        raise AmbiguousKeyError(
            f"{table}: observation key is not one-to-one -- {total:,} rows collapse "
            f"to {distinct:,} distinct keys. Alignment would be ambiguous, so the "
            f"comparison is refused rather than silently deduplicated.")
    return total


# --------------------------------------------------------------------------
# The comparator
# --------------------------------------------------------------------------
def classify_numeric(old, new, spec):
    """Classify one numeric cell.

    Order matters. Structural cases are decided BEFORE tolerance is consulted,
    because tolerance is only meaningful between two valid comparable numbers.
    Letting a NULL transition or a NaN reach the tolerance branch is how an
    integrity system quietly starts excusing structural change as rounding.
    """
    if old is None and new is None:
        return SAME, 0.0, 0.0
    if old is None or new is None:
        return TYPE_OR_NULL_CHANGE, float("nan"), float("nan")
    if isinstance(old, bool) or isinstance(new, bool):
        return TYPE_OR_NULL_CHANGE, float("nan"), float("nan")
    if not isinstance(old, (int, float)) or not isinstance(new, (int, float)):
        return TYPE_OR_NULL_CHANGE, float("nan"), float("nan")
    if not math.isfinite(old) or not math.isfinite(new):
        # The governed corpus holds zero non-finite values (measured over both
        # controlled builds), so an appearance is a contract violation, never a
        # rounding artefact.
        return TYPE_OR_NULL_CHANGE, float("nan"), float("nan")
    if old == new:
        return SAME, 0.0, 0.0
    delta = abs(new - old)
    denom = max(abs(old), abs(new))
    relative = delta / denom if denom > 0 else float("inf")
    within = (delta <= spec.abs_tolerance
              or (denom > 0 and relative <= spec.rel_tolerance))
    return (NUMERICAL_NOISE if within else MATERIAL_CHANGE), delta, relative


def classify_categorical(old, new):
    """Exact. A category has no neighbourhood, so tolerance is a category error."""
    return SAME if old == new else MATERIAL_CHANGE


# --------------------------------------------------------------------------
# Observations
# --------------------------------------------------------------------------
class FieldObservation:
    def __init__(self, table, column):
        self.table, self.column = table, column
        self.exact_unequal = 0          # raw inequality, including noise (§38)
        self.noise = 0
        self.material = 0
        self.structural = 0
        self.max_abs = 0.0
        self.max_rel = 0.0
        self.sum_abs = 0.0
        self.positive = 0
        self.negative = 0
        self.examples = []

    def status(self):
        if self.material or self.structural:
            return REVIEW_REQUIRED
        return OBSERVED_NOISE if self.noise else PASS

    def as_dict(self):
        return {"table": self.table, "column": self.column,
                "exact_unequal": self.exact_unequal, "noise": self.noise,
                "material": self.material, "structural": self.structural,
                "max_abs_delta": self.max_abs, "max_rel_delta": self.max_rel,
                "sum_abs_delta": self.sum_abs, "positive": self.positive,
                "negative": self.negative, "status": self.status()}


class ProvenanceObservation:
    def __init__(self):
        self.transitions = {}
        self.unknown_values = {}
        self.identity_changed = []
        self.identity_improved = 0
        self.identity_regressed = 0
        self.benign_relabels = 0

    def status(self):
        if self.unknown_values or self.identity_changed or self.identity_regressed:
            return FAIL
        if self.identity_improved:
            return REVIEW_REQUIRED
        return OBSERVED_NOISE if self.benign_relabels else PASS


def observe_numeric(table, columns, baseline_values, current_values,
                    max_examples=25):
    obs = {c: FieldObservation(table, c) for c in columns}
    specs = [sp.observation(table, c) for c in columns]
    for pos, (base, cur) in enumerate(zip(baseline_values, current_values)):
        for i, col in enumerate(columns):
            verdict, delta, rel = classify_numeric(base[i], cur[i], specs[i])
            if verdict == SAME:
                continue
            f = obs[col]
            f.exact_unequal += 1
            if verdict == TYPE_OR_NULL_CHANGE:
                f.structural += 1
                if len(f.examples) < max_examples:
                    f.examples.append({"row": pos, "old": base[i], "new": cur[i],
                                       "classification": verdict})
                continue
            f.max_abs = max(f.max_abs, delta)
            f.max_rel = max(f.max_rel, rel)
            f.sum_abs += delta
            if cur[i] > base[i]:
                f.positive += 1
            else:
                f.negative += 1
            if verdict == NUMERICAL_NOISE:
                f.noise += 1
            else:
                f.material += 1
                if len(f.examples) < max_examples:
                    f.examples.append({
                        "row": pos, "old": base[i], "new": cur[i],
                        "abs_delta": delta, "rel_delta": rel,
                        "abs_tolerance": specs[i].abs_tolerance,
                        "rel_tolerance": specs[i].rel_tolerance,
                        "classification": verdict})
    return [obs[c] for c in columns]


def observe_provenance(baseline_values, current_values, current_identity=None,
                       baseline_identity=None):
    """Exact categorical transitions, cross-checked against identity.

    The cross-check is the point. gsis_source sits outside the blocking digest,
    so if provenance observation were allowed to absorb identity movement, a
    relabel would become a laundering path for replacing the human a row refers
    to. Identity movement is therefore routed OUT of this surface -- to FAIL or
    to review -- never reported as provenance drift.

    Identity columns are optional because the blocking digest already pins
    gsis_id: when it passes, identity cannot have moved. They are accepted so
    the cross-check can be exercised directly, and so a caller comparing two
    databases (rather than a baseline) still gets it.
    """
    p = ProvenanceObservation()
    for seq in (baseline_values, current_values):
        for v in seq:
            src = v[0]
            if src not in sp.KNOWN_GSIS_SOURCES:
                p.unknown_values[src] = p.unknown_values.get(src, 0) + 1
    for pos, (base, cur) in enumerate(zip(baseline_values, current_values)):
        old_src, new_src = base[0], cur[0]
        old_id = baseline_identity[pos] if baseline_identity else None
        new_id = current_identity[pos] if current_identity else None
        ids_known = baseline_identity is not None and current_identity is not None
        if old_src == new_src and (not ids_known or old_id == new_id):
            continue
        if old_src != new_src:
            t = (old_src, new_src)
            p.transitions[t] = p.transitions.get(t, 0) + 1
        if not ids_known or old_id == new_id:
            if old_src != new_src:
                p.benign_relabels += 1
        elif old_id is None and new_id is not None:
            p.identity_improved += 1
        elif old_id is not None and new_id is None:
            p.identity_regressed += 1
        else:
            p.identity_changed.append({"row": pos, "old_gsis_id": old_id,
                                       "new_gsis_id": new_id,
                                       "old_source": old_src,
                                       "new_source": new_src})
    return p


class StructuralReport:
    def __init__(self):
        self.rows_baseline = 0
        self.rows_current = 0
        self.key_sequence_matches = True

    @property
    def aligned(self):
        return self.key_sequence_matches and self.rows_baseline == self.rows_current

    def status(self):
        return PASS if self.aligned else REVIEW_REQUIRED


# --------------------------------------------------------------------------
# Baseline artifact  (§35/§36/§37)
# --------------------------------------------------------------------------
def encode_value(v):
    """Type-aware, because repr() is right for exactly one of these cases.

    For a float, repr() is the SHORTEST string that round-trips the double
    exactly -- smaller than 17-digit decimal and reviewable in a diff, and
    crucially NOT the 15-significant-digit rendering that caused the upstream
    noise in the first place (§37). For a string it is wrong: repr('feed') is
    "'feed'", quotes included, which decodes back to a different value. Applying
    it to everything made the baseline lossy for all 1,106,381 non-null
    provenance rows while the 348 NULLs round-tripped fine.
    """
    if v is None:
        return ""
    if isinstance(v, float):
        return repr(v)
    if isinstance(v, int):
        return str(v)
    if isinstance(v, str):
        if v == "" or "|" in v or "\n" in v:
            raise BaselineError(
                f"value {v!r} collides with the baseline field/row delimiters or "
                f"is indistinguishable from NULL; the format must be extended "
                f"deliberately rather than silently corrupting it")
        return v
    raise BaselineError(f"unencodable baseline value of type {type(v).__name__}")


def decode_value(s, numeric):
    if s == "":
        return None
    return float(s) if numeric else s


def write_baseline(conn, table, path):
    values, digest, n = read_observed(conn, table)
    fields = list(sp.observed_fields(table))
    key = observation_key(conn, table)
    head = [f"#{BASELINE_VERSION}", f"#table {table}",
            f"#key {','.join(key)}", f"#fields {','.join(fields)}",
            f"#rows {n}", f"#key_sequence_digest {digest}"]
    body = "\n".join("|".join(encode_value(v) for v in row) for row in values)
    payload = ("\n".join(head) + "\n" + body + ("\n" if body else "")).encode()
    with gzip.GzipFile(path, "wb", compresslevel=9, mtime=0) as fh:
        fh.write(payload)                       # mtime=0 keeps the file byte-stable
    return n, digest, len(payload)


def read_baseline(path, table, expect_fields):
    if not os.path.exists(path):
        raise BaselineError(
            f"no observational baseline at {path}. Observation is audit-only: the "
            f"database build does not require it, but comparison cannot run "
            f"without it. Generate one from an accepted build.")
    with gzip.GzipFile(path, "rb") as fh:
        text = fh.read().decode()
    lines = text.split("\n")
    meta, i = {}, 0
    while i < len(lines) and lines[i].startswith("#"):
        parts = lines[i][1:].split(" ", 1)
        meta[parts[0]] = parts[1] if len(parts) > 1 else True
        i += 1
    if BASELINE_VERSION not in meta:
        raise BaselineError(f"{path}: not a {BASELINE_VERSION} baseline")
    if meta.get("table") != table:
        raise BaselineError(f"{path}: baseline is for {meta.get('table')}, not {table}")
    fields = meta["fields"].split(",") if meta.get("fields") else []
    if fields != list(expect_fields):
        raise BaselineError(
            f"{path}: baseline observes {fields} but the registry now declares "
            f"{list(expect_fields)}. Classify the change before comparing.")
    numeric = [sp.observation(table, f).mode == sp.OBSERVE_TOLERANCE_NUMERIC
               for f in fields]
    declared = int(meta["rows"])
    # Take exactly `declared` lines. Do NOT skip empty ones: a row whose only
    # observed field is NULL encodes to an empty line, and skipping those silently
    # dropped the 348 unresolved depth_chart rows -- a lossy baseline, which is
    # the one thing a baseline may never be. The trailing newline is handled by
    # slicing to the declared count rather than by filtering.
    body = lines[i:i + declared]
    if len(body) != declared:
        raise BaselineError(
            f"{path}: header claims {declared} rows, body holds {len(body)}")
    rows = [tuple(decode_value(c, numeric[j])
                  for j, c in enumerate(line.split("|")))
            for line in body]
    for r in rows:
        if len(r) != len(fields):
            raise BaselineError(f"{path}: row has {len(r)} cells, expected {len(fields)}")
    return rows, meta["key_sequence_digest"], fields


# --------------------------------------------------------------------------
# Reporting
# --------------------------------------------------------------------------
def format_report(numeric, provenance, structural):
    out = ["OBSERVATIONAL INTEGRITY", ""]
    by_table = {}
    for f in numeric:
        by_table.setdefault(f.table, []).append(f)
    for table, fields in sorted(by_table.items()):
        out.append(f"{table}:")
        for f in sorted(fields, key=lambda x: x.column):
            out.append(f"  {f.column}")
            out.append(f"    exact changes  : {f.exact_unequal:,}")
            out.append(f"    numerical noise: {f.noise:,}")
            out.append(f"    material       : {f.material:,}")
            out.append(f"    structural     : {f.structural:,}")
            if f.exact_unequal:
                out.append(f"    max |delta|    : {f.max_abs:.3e}"
                           f"    max relative: {f.max_rel:.3e}")
                out.append(f"    direction      : +{f.positive:,} / -{f.negative:,}")
            for ex in f.examples:
                out.append(f"    ** {ex['classification']} at row {ex['row']}: "
                           f"{ex['old']} -> {ex['new']}"
                           + (f"  |d|={ex['abs_delta']:.3e} rel={ex['rel_delta']:.3e}"
                              f"  tol(abs={ex['abs_tolerance']:.0e},"
                              f" rel={ex['rel_tolerance']:.0e})"
                              if "abs_delta" in ex else ""))
        out.append("")
    if provenance is not None:
        out += ["depth_chart:", "  gsis_source"]
        if provenance.transitions:
            for (a, b), n in sorted(provenance.transitions.items(), key=lambda kv: -kv[1]):
                out.append(f"    {str(a):>6} -> {str(b):<6} {n:>9,}")
        else:
            out.append("    (no transitions)")
        out.append(f"    benign relabels    : {provenance.benign_relabels:,}")
        out.append(f"    identity improved  : {provenance.identity_improved:,}")
        out.append(f"    identity regressed : {provenance.identity_regressed:,}")
        out.append(f"    identity CHANGED   : {len(provenance.identity_changed):,}")
        if provenance.unknown_values:
            out.append(f"    ** UNKNOWN PROVENANCE VALUES: {provenance.unknown_values}")
        for bad in provenance.identity_changed[:10]:
            out.append(f"    ** WRONG-PERSON: {bad}")
        out.append("")
    if structural is not None and not structural.aligned:
        out += ["structural:",
                f"  baseline rows {structural.rows_baseline:,} vs current "
                f"{structural.rows_current:,}",
                f"  key sequence matches: {structural.key_sequence_matches}",
                "  -> rows could not be aligned one-to-one; this is a structural",
                "     difference, NOT numerical noise, and the blocking digest is",
                "     the authority on what moved.", ""]
    return "\n".join(out)


def overall_status(numeric, provenance, structural):
    s = worst(*[f.status() for f in numeric]) if numeric else PASS
    if provenance is not None:
        s = worst(s, provenance.status())
    if structural is not None:
        s = worst(s, structural.status())
    return s
