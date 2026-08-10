"""The composed whole-build integrity verdict (Phase 8.9).

Four mechanisms now govern depth_chart, each answering a different question:

    Layer A   are the immutable historical row facts unchanged?   exact digest
    Layer B   is source-owned identity still bound to its row?    exact digest
    Layer C   is derived identity what review accepted?           state machine
    provenance                                                    observational

This module composes them, and the composition rule is the point. Before Phase 8
a legitimate new resolution was simultaneously Layer C REVIEW_REQUIRED and
monolithic-digest corruption -- two controls contradicting each other about one
event. The fix is not to soften either; it is to give each class the mechanism
it deserves and then compose WORST-WINS:

    FAIL  >  REVIEW_REQUIRED  >  OBSERVED  >  PASS

so no green gate can ever downgrade a stronger verdict. A build with a
wrong-person reassignment does not become acceptable because Layer A passes and
coverage improved; a legitimate new resolution does not become corruption
because a digest happened to include a derived join result.

Coverage is deliberately absent from this function. It is telemetry: it cannot
raise, lower, or otherwise touch the correctness state.
"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import identity_baseline as ib  # noqa: E402
import identity_layers as il  # noqa: E402

PASS = "PASS"
OBSERVED = "OBSERVED"
REVIEW_REQUIRED = "REVIEW_REQUIRED"
FAIL = "FAIL"

_RANK = {PASS: 0, OBSERVED: 1, REVIEW_REQUIRED: 2, FAIL: 3}


def worst(*verdicts):
    """Worst-wins. A stronger verdict can never be downgraded by a green peer."""
    return max(verdicts, key=lambda v: _RANK[v]) if verdicts else PASS


def compose(layer_a, layer_b, layer_c, provenance=PASS, coverage_delta=None):
    """The whole-build verdict.

    `coverage_delta` is accepted ONLY so callers can report it. It is not read.
    Passing a catastrophic coverage change cannot alter the result, which is the
    mechanical expression of 'coverage is telemetry'.
    """
    return worst(layer_a, layer_b, layer_c, provenance)


def evaluate(conn, baseline_path=None, root=None):
    """(overall, parts) for a built database."""
    parts = {}
    a_ok = b_ok = True
    for name, ok, detail in il.verdicts(conn):
        parts[f"layer_{name.lower()}"] = {"verdict": PASS if ok else FAIL,
                                          "detail": detail}
        if name == "A":
            a_ok = ok
        else:
            b_ok = ok
    c_verdict, findings, stats = ib.check(conn, path=baseline_path, root=root)
    parts["layer_c"] = {"verdict": c_verdict, "detail": stats,
                        "findings": findings}
    cons = il.conservation(conn)
    # Both directions. A row governed by NO mechanism is unprotected; a row
    # counted by TWO is a broken partition, and two such errors of opposite sign
    # once made `ungoverned` read 0 on a database that had an unprotected row.
    parts["conservation"] = {
        "verdict": PASS if (cons["ungoverned"] == 0 and cons["overlapping"] == 0)
        else FAIL, "detail": cons}
    overall = compose(PASS if a_ok else FAIL, PASS if b_ok else FAIL, c_verdict,
                      parts["conservation"]["verdict"])
    return overall, parts
