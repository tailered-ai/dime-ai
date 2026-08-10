"""Layers A and B of depth_chart integrity (Phase 8).

WHY THE MONOLITHIC DIGEST HAD TO GO. Phase 4 pinned one canonical SHA-256 over
every column of the frozen depth_chart window, gsis_id included. That digest was
correct about its own contract and reproduced exactly -- it was verified healthy
immediately before retirement, not abandoned because it had become inconvenient.
But it hashed two things with different semantics into one number:

    1,101,152 rows  source-owned identity   immutable, belongs in a digest
        5,229 rows  crosswalk-derived       a join result, legitimately improvable
          348 rows  unresolved              legitimately becomes resolved

So a LEGITIMATE new resolution -- the exact event Phase 7 taught the system to
report as REVIEW_REQUIRED -- also broke the digest, which called it frozen
historical corruption. Two controls contradicted each other on the same event,
and the reflex fix (re-pin) would silently absorb a real regression later.

The split resolves it by giving each semantic class the mechanism it deserves:

    Layer A   immutable historical row facts    -> exact canonical SHA-256
    Layer B   source-owned historical identity  -> exact canonical SHA-256
    Layer C   reviewed derived identity         -> accepted-identities.json
    gsis_source                                 -> observational (Phase 6)
    coverage %                                  -> telemetry only

Nothing is ungoverned by the split: 1,101,152 + 5,229 + 348 = 1,106,729 exactly,
and that conservation is asserted rather than assumed.

WHY LAYER B IS NOT A BAG OF IDENTIFIERS. It hashes the semantic row TOGETHER with
its identity, so swapping the gsis_ids of two source-owned rows fails even though
the multiset of identifiers is unchanged. A digest over identities alone would
call that swap identical -- and it is precisely the wrong-person defect class.
"""
from __future__ import annotations

import hashlib
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import season_pins as sp  # noqa: E402

TABLE = "depth_chart"

#: Layer A excludes the identity column: identity is Layer B's or Layer C's job
#: depending on provenance. gsis_source and depth_chart_id are already outside
#: the blocking projection (Phase 5), so the exclusion here is exactly gsis_id.
LAYER_A_EXCLUDE = ("gsis_id",)

#: Layer B's population. Source-owned means the feed supplied the identity; those
#: rows were measured stationary across controlled builds and belong in a digest.
SOURCE_OWNED_PREDICATE = "gsis_source='feed'"

#: Full SHA-256 over the DIGEST_ALGORITHM serialization, from the accepted build.
LAYER_A_DIGEST = "445385e8fc7f6e701dd311d8b3c5a22ed53b95c215b62e3d1ad8df35fa2d90c0"
LAYER_B_DIGEST = "07b90ce753d8e1fd76251dbf861f27eaf63578415eaf456a47eade5d767f4346"
LAYER_A_ROWS = 1_106_729
LAYER_B_ROWS = 1_101_152

#: The retired monolithic digest, kept as HISTORICAL EVIDENCE ONLY. It is not
#: consulted by any gate. It is recorded so the migration can be audited: this
#: value reproduced exactly at the moment of retirement.
RETIRED_MONOLITHIC_DIGEST = (
    "cf0e5b7749e2c07858f51f6670840017650713cfe4b01177f94f02ba5fc311b1")
RETIRED_MONOLITHIC_ROWS = 1_106_729


def layer_a_projection(conn):
    return [c for c in sp.projection(conn, TABLE) if c not in LAYER_A_EXCLUDE]


def layer_b_projection(conn):
    """Layer A's columns PLUS the identity, so the identity is bound to the row."""
    return layer_a_projection(conn) + ["gsis_id"]


def _digest(conn, where, cols):
    h = hashlib.sha256()
    h.update(sp.canonical_header(TABLE, where, cols))
    q = ", ".join(cols)
    n = 0
    for row in conn.execute(f"SELECT {q} FROM {TABLE} WHERE {where} ORDER BY {q}"):
        h.update(sp.canonical_row(row))
        n += 1
    h.update(sp.canonical_footer(n))
    return h.hexdigest(), n


def layer_a(conn):
    """(digest, rows, projection) over immutable historical row facts."""
    cols = layer_a_projection(conn)
    d, n = _digest(conn, sp.window(TABLE).predicate, cols)
    return d, n, cols


def layer_b(conn):
    """(digest, rows, projection) over source-owned identity bound to its row."""
    cols = layer_b_projection(conn)
    where = f"({sp.window(TABLE).predicate}) AND {SOURCE_OWNED_PREDICATE}"
    d, n = _digest(conn, where, cols)
    return d, n, cols


def verdicts(conn):
    """[(layer, ok, detail)] for A and B."""
    out = []
    for name, fn, want_d, want_n in (("A", layer_a, LAYER_A_DIGEST, LAYER_A_ROWS),
                                     ("B", layer_b, LAYER_B_DIGEST, LAYER_B_ROWS)):
        d, n, _ = fn(conn)
        out.append((name, d == want_d and n == want_n,
                    f"{d[:16]}... rows {n:,} (pinned {want_n:,})"))
    return out


def conservation(conn):
    """Every frozen row is governed by exactly one identity mechanism.

    Returned rather than asserted so a caller can report the arithmetic; the
    point is that 'nothing is ungoverned' is a computed fact, not a claim.
    """
    w = sp.window(TABLE).predicate
    q = lambda extra: conn.execute(
        f"SELECT COUNT(*) FROM {TABLE} WHERE {w} AND {extra}").fetchone()[0]
    total = conn.execute(f"SELECT COUNT(*) FROM {TABLE} WHERE {w}").fetchone()[0]
    source_owned = q(SOURCE_OWNED_PREDICATE)
    derived = q(f"gsis_source IS NOT 'feed' AND gsis_id IS NOT NULL")
    unresolved = q("gsis_source IS NULL")
    return {"frozen_rows": total, "layer_b_source_owned": source_owned,
            "layer_c_resolved": derived, "layer_c_unresolved": unresolved,
            "governed": source_owned + derived + unresolved,
            "ungoverned": total - (source_owned + derived + unresolved)}
