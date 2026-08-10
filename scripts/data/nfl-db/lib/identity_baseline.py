"""Identity governance for CROSSWALK-DERIVED depth-chart identities (Layer C).

WHY THIS EXISTS -- AND WHY A DIGEST WAS THE WRONG TOOL.

The first attempt at protecting settled history hashed every column of the frozen
window, `gsis_id` included, and called a mismatch "settled history changed". That
was wrong, and measurement proves it: for 5,577 of the 1,106,729 frozen rows,
`gsis_id` is not source data at all. It is a JOIN RESULT recomputed on every build
by `build_espn_gsis_crosswalk()` against `players.csv` and `rosters.csv`, which
nflverse revises continuously. Hashing it pins a current INTERPRETATION of history
and mislabels it as history. The next routine upstream backfill would fail the
build, discard the database, and offer the operator nothing but a hash pair -- and
the reflex repair (re-pin) would silently absorb a real regression later.

THE MEASURED SPLIT (full population, clean-clone builds 2026-07-27 vs 2026-08-08):

    frozen window                     1,106,729 rows
      shape A, feed-supplied            552,514   multiset IDENTICAL between builds
      shape B, feed-supplied            548,638   0 gsis_id changes
      shape B, crosswalk-derived          5,229
      shape B, unresolved                   348

So 1,101,152 rows (99.50%) carry a source-owned identity that is provably
stationary and belongs in a blocking digest. The remaining 5,577 (0.50%) carry
derived identity and belong here.

WHY A MAPPING BASELINE RATHER THAN ROW COPIES. Those 5,577 rows collapse to just
204 unique `espn_id` values -- a player recurs across snapshots. `espn_id` was
verified to be a strict 1:1 key over this population. Governing 204 mappings
instead of 5,577 rows makes the baseline 27x smaller, human-auditable, and immune
to row-count churn.

THE GOVERNING PRINCIPLE. Current derivation PROPOSES an identity; the accepted
baseline DECIDES whether that identity is already trusted:

    previously known identity lost        -> FAIL
    previously known person changed       -> FAIL
    previously unresolved, still so       -> PASS
    previously unresolved, now resolved   -> REVIEW_REQUIRED
    reviewed improvement accepted         -> PASS thereafter

No percentage. No hash of an evolving join. No silent baseline generation. And no
dependence on `gsis_source`: provenance is observational (Phase 6) and never
decides who a row refers to.
"""
from __future__ import annotations

import json
import os
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, _HERE)

import build_inputs  # noqa: E402
import season_pins as sp  # noqa: E402

SCHEMA_VERSION = "nfldb-accepted-identities-1"

#: THE path authority. Resolved through the canonical build-input contract so
#: build, validation, acceptance tooling, observation and tests cannot drift onto
#: different files -- and so a cache copy can never stand in for reviewed
#: evidence.
BASELINE_INPUT = "accepted_identities"

RESOLVED = "resolved"
UNRESOLVED = "unresolved"

PASS = "PASS"
FAIL = "FAIL"
REVIEW_REQUIRED = "REVIEW_REQUIRED"

_RANK = {PASS: 0, REVIEW_REQUIRED: 1, FAIL: 2}


def worst(*verdicts):
    return max(verdicts, key=lambda v: _RANK[v]) if verdicts else PASS


class BaselineError(RuntimeError):
    """The accepted baseline is absent, malformed, or self-inconsistent."""


def baseline_path(root=None):
    """One path authority (§10). No cache fallback, no alternate artifact."""
    return build_inputs.path(BASELINE_INPUT, root=root)


# --------------------------------------------------------------------------
# Structural validation  (§11/§41) -- separate from agreement with a build
# --------------------------------------------------------------------------
def validate_document(doc):
    """Structural validity ONLY. Says nothing about whether a build agrees.

    Deliberately separated: 'the reviewed evidence is well-formed' is knowable at
    preflight, before any database exists, and must fail there rather than
    minutes later.
    """
    if not isinstance(doc, dict):
        raise BaselineError("baseline root must be an object")
    if doc.get("schema") != SCHEMA_VERSION:
        raise BaselineError(
            f"baseline schema is {doc.get('schema')!r}, expected {SCHEMA_VERSION!r}")
    mappings = doc.get("mappings")
    if not isinstance(mappings, list) or not mappings:
        raise BaselineError("baseline has no mappings")
    accepted, seen_gsis = {}, {}
    for i, m in enumerate(mappings):
        if not isinstance(m, dict):
            raise BaselineError(f"mapping {i} is not an object")
        espn = m.get("espn_id")
        if not isinstance(espn, str) or not espn.isdigit():
            raise BaselineError(f"mapping {i} has a malformed espn_id {espn!r}")
        if espn in accepted:
            raise BaselineError(
                f"espn_id {espn!r} appears more than once; the mapping must be 1:1")
        state, gsis = m.get("state"), m.get("gsis_id")
        if state not in (RESOLVED, UNRESOLVED):
            raise BaselineError(f"{espn}: state {state!r} must be "
                                f"{RESOLVED!r} or {UNRESOLVED!r}")
        if state == RESOLVED:
            if not isinstance(gsis, str) or not gsis:
                raise BaselineError(f"{espn}: resolved entry has no gsis_id")
            if gsis in seen_gsis:
                raise BaselineError(
                    f"gsis_id {gsis!r} is accepted for both {seen_gsis[gsis]!r} and "
                    f"{espn!r}; two source identities may not name one person")
            seen_gsis[gsis] = espn
        else:
            if gsis is not None:
                raise BaselineError(
                    f"{espn}: unresolved entry carries gsis_id {gsis!r} -- "
                    f"contradictory state")
        accepted[espn] = gsis
    return accepted


def load_baseline(path=None, root=None):
    """(accepted, doc). Accepted is {espn_id: gsis_id or None}."""
    path = path or baseline_path(root)
    if not os.path.exists(path):
        raise BaselineError(
            f"accepted identity baseline missing at {path!r}. It is a tracked, "
            f"repository-owned build input: without it the build cannot tell a "
            f"legitimate new resolution from a silent identity regression. It is "
            f"NOT regenerable from the build it governs.")
    try:
        with open(path) as fh:
            doc = json.load(fh)
    except json.JSONDecodeError as exc:
        raise BaselineError(f"{path}: malformed JSON -- {exc}") from exc
    return validate_document(doc), doc


# --------------------------------------------------------------------------
# Observation of what THIS build derived  (§7/§21/§22/§39)
# --------------------------------------------------------------------------
def observe(conn, accepted_keys):
    """(current, derived_keys, mixed) at the MAPPING level, not the row level.

    Two scopes, deliberately different, because they answer different questions:

      * an ACCEPTED identity is looked up across the WHOLE frozen window,
        provenance-agnostic. Scoping it by `gsis_source != 'feed'` -- as an
        earlier version did -- meant that an identity whose resolution IMPROVED
        to feed-supplied vanished from the comparison and was reported as a
        disappearance. That is an escape hatch: an accepted identity could leave
        governance by having its provenance relabelled. Acceptance is permanent;
        provenance is observational.

      * a candidate NEW identity is scoped to crosswalk-derived rows only,
        because feed-supplied identities are governed by the blocking digest and
        would otherwise flood Case F with thousands of already-protected keys.

    `mixed` catches one source key carrying two different identities in the same
    build (or an identity and a NULL). That is internal inconsistency, never a
    majority vote.
    """
    where = sp.window("depth_chart").predicate
    per_key = {}
    # espn_id IS NOT NULL is load-bearing, not defensive tidying. Shape-A rows
    # (2010-2024) carry no espn_id at all, so without it every one of them lands
    # in a single NULL bucket holding thousands of distinct gsis_ids, and the
    # mixed-state check reports one enormous false inconsistency. A row with no
    # source identity key cannot participate in a baseline keyed by that key --
    # its identity is feed-supplied and governed by the blocking digest.
    for espn, gsis, src, n in conn.execute(
            f"SELECT espn_id, gsis_id, gsis_source, COUNT(*) FROM depth_chart "
            f"WHERE {where} AND espn_id IS NOT NULL "
            f"GROUP BY espn_id, gsis_id, gsis_source"):
        e = per_key.setdefault(espn, {"gsis": set(), "sources": set(), "rows": 0})
        e["gsis"].add(gsis)
        e["sources"].add(src)
        e["rows"] += n

    mixed = [{"espn_id": e, "gsis": sorted(x for x in v["gsis"] if x),
              "has_null": None in v["gsis"], "rows": v["rows"]}
             for e, v in per_key.items() if len(v["gsis"]) > 1]

    current = {}
    for e in accepted_keys:
        v = per_key.get(e)
        current[e] = None if v is None else next(iter(v["gsis"])) if len(v["gsis"]) == 1 else None
    present = {e for e in accepted_keys if e in per_key}

    derived_keys = {e for e, v in per_key.items()
                    if v["sources"] - {"feed"} and e not in accepted_keys}
    return current, present, derived_keys, per_key, mixed


# --------------------------------------------------------------------------
# THE state machine  (§13-§21) -- one authority, no second implementation
# --------------------------------------------------------------------------
#: Human-readable meaning of each case, so a consumer never has to re-describe
#: them (and never has to re-DECIDE them).
CASE_WHY = {
    "A": "identity unchanged",
    "B": "previously resolved identity became unresolved (the T4-regression class); "
         "no fill-rate percentage excuses it",
    "C": "identity reassigned to a DIFFERENT person; only an explicit reviewed "
         "correction may change this, never the generic new-resolution path",
    "D": "still unresolved; no regression",
    "E": "newly resolved upstream; verify the person, then admit it through the "
         "targeted accepted-delta process",
    "F": "a crosswalk-derived source identity not present in the accepted baseline; "
         "classify it before it can pass",
    "G": "an accepted frozen source identity vanished from the build",
    "H": "one source identity carries multiple identities in a single build; the "
         "mapping is internally inconsistent",
}


def classify_pair(accepted, current, present=True):
    """THE decision for ONE identity pair -> (case, verdict).

    Every identity-aware consumer routes through this, including Phase 6's
    provenance cross-check. A second implementation of "is this the same person"
    is precisely how two parts of an integrity system come to disagree about a
    wrong-person replacement, so there is exactly one.
    """
    if not present:
        return "G", FAIL
    if accepted and current:
        return ("A", PASS) if accepted == current else ("C", FAIL)
    if accepted and not current:
        return "B", FAIL
    if not accepted and not current:
        return "D", PASS
    return "E", REVIEW_REQUIRED


def classify(accepted, current, present=None, derived_keys=(), mixed=()):
    """Compare accepted identity knowledge with what this build derived.

    Returns (verdict, findings). Findings carry enough detail to act on without
    re-running a diff.

    `present` distinguishes "this build says the identity is unresolved" from
    "this build has no such source identity at all" -- Case B versus Case G. It
    defaults to the keys `current` actually holds, which is the right reading
    when a caller passes a plain observed mapping.
    """
    if present is None:
        present = set(current)
    findings = []
    for espn, want in accepted.items():
        got = current.get(espn)
        case, verdict = classify_pair(want, got, present=espn in present)
        if verdict == PASS:
            continue                                          # Cases A and D
        findings.append({"case": case, "verdict": verdict, "espn_id": espn,
                         "accepted": want,
                         "observed": "ABSENT" if case == "G" else got,
                         "why": CASE_WHY[case]})
    for espn in sorted(derived_keys):                                   # Case F
        findings.append({"case": "F", "verdict": REVIEW_REQUIRED, "espn_id": espn,
                         "accepted": "ABSENT", "observed": None,
                         "why": CASE_WHY["F"]})
    for m in mixed:                                                     # Case H
        findings.append({"case": "H", "verdict": FAIL, "espn_id": m["espn_id"],
                         "accepted": accepted.get(m["espn_id"]),
                         "observed": m["gsis"], "why": CASE_WHY["H"]})
    return worst(*[f["verdict"] for f in findings]) if findings else PASS, findings


def collisions(current):
    """Relational integrity of the mapping itself. Identity is not just NULL counts."""
    e2g, g2e, bad = {}, {}, []
    for espn, gsis in current.items():
        if not gsis:
            continue
        e2g.setdefault(espn, set()).add(gsis)
        g2e.setdefault(gsis, set()).add(espn)
    for espn, gs in e2g.items():
        if len(gs) > 1:
            bad.append({"kind": "one_espn_many_gsis", "espn_id": espn,
                        "gsis": sorted(gs)})
    for gsis, es in g2e.items():
        if len(es) > 1:
            bad.append({"kind": "one_gsis_many_espn", "gsis_id": gsis,
                        "espn": sorted(es)})
    return bad


def check(conn, path=None, root=None):
    """The whole Layer C verdict for a built database."""
    accepted, doc = load_baseline(path, root)
    current, present, derived_keys, per_key, mixed = observe(conn, set(accepted))
    verdict, findings = classify(accepted, current, present, derived_keys, mixed)
    coll = collisions(current)
    if coll:
        verdict = FAIL
        findings += [{"case": "COLLISION", "verdict": FAIL, **c} for c in coll]
    return verdict, findings, {"accepted": len(accepted),
                               "resolved": sum(1 for v in accepted.values() if v),
                               "unresolved": sum(1 for v in accepted.values() if not v),
                               "observed_keys": len(per_key)}


# --------------------------------------------------------------------------
# Deterministic serialisation  (§32/§54)
# --------------------------------------------------------------------------
def dump_document(doc):
    """Byte-stable output: sorted by the canonical key, fixed separators, so a
    targeted acceptance produces a minimal reviewable diff instead of reordering
    every record."""
    out = dict(doc)
    out["mappings"] = sorted(doc["mappings"], key=lambda m: int(m["espn_id"]))
    return json.dumps(out, indent=1, sort_keys=True, ensure_ascii=False) + "\n"


def accepted_unresolved(accepted):
    """The one authority for the accepted-unresolved set. Derived, never a
    second hand-maintained list."""
    return frozenset(e for e, g in accepted.items() if not g)
