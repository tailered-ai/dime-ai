#!/usr/bin/env python3
"""Tests for Layers A and B of depth_chart integrity -- Phase 8.

    python3 scripts/data/nfl-db/test_identity_layers.py

Phase 8 split one monolithic digest into two, because one number was answering
two different questions and giving the wrong answer to both: a legitimate new
identity resolution was reported as frozen-history corruption, and the reflex
fix for that -- re-pinning -- would have silently absorbed a real regression the
next time round.

Two properties carry the split, and neither is self-evident from reading the
projections:

  SENSITIVITY   every column Layer A protects must be able to break it. Tested
                by looping over the LIVE projection, so a column added to the
                schema tomorrow is covered tomorrow, not whenever someone
                remembers to add a test.

  SPECIFICITY   Layer A must NOT move when derived identity, provenance labels,
                or surrogate keys change -- otherwise the split has quietly
                rebuilt the monolith it replaced.

And one case is load-bearing above all others: swapping the identities of two
source-owned rows. Row count is unchanged, the bag of identifiers is unchanged,
and it is exactly the wrong-person defect. A digest over identities alone calls
it identical. That strawman is implemented below and shown to fail, so the real
test cannot be mistaken for a tautology.
"""
from __future__ import annotations

import ast
import hashlib
import os
import re
import sqlite3
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "lib"))

import identity_layers as il  # noqa: E402
import season_pins as sp  # noqa: E402

COLS = list(sp.FIELD_CLASSES["depth_chart"])
IN_WINDOW = {"source_shape": "A", "snapshot_ts": None}
#: shape B captured AFTER the extract cutoff -- deliberately outside the window.
OUT_OF_WINDOW = {"source_shape": "B", "snapshot_ts": "2026-09-01T00:00:00Z"}

#: The only fractional threshold permitted to block the build. It measures
#: how much of the POSITION_CROSSWALK mapping table is populated -- a
#: question a percentage can actually answer -- unlike the retired 85%
#: identity gate, which claimed to measure whether identities were correct.
ALLOWED_FRACTIONAL_GATES = {
    "crosswalk covers >=97% of shape-A depth_position rows"}

#: Empty, and it must stay empty. A blocking gate whose condition is a
#: literal cannot fail, so it proves nothing about the build it guards.
#: One existed ("all 31 shape-B pos_abb values are mapped", condition
#: `True`); it now asserts against the values the run observed.
KNOWN_UNFALSIFIABLE_GATES = set()


def row(i, **kw):
    """A frozen-window depth_chart row with distinct, non-degenerate content."""
    base = {c: None for c in COLS}
    base.update({
        "depth_chart_id": i,
        "source_ordinal": 1,
        "season": 2020 + (i % 5),
        "season_type": "REG",
        "week": 1 + (i % 17),
        "bucket": "regular",
        "franchise_id": 100 + (i % 32),
        "full_name": f"Player {i}",
        "espn_id": f"E{i}",
        "jersey_number": i % 99,
        "position": "WR",
        "depth_position": "WR1",
        "depth_position_canonical": "WR",
        "depth_order": 1 + (i % 3),
        "unit": "Offense",
        "gsis_id": f"00-00{i:05}",
        "gsis_source": "feed",
    })
    base.update(IN_WINDOW)
    base.update(kw)
    return base


def build(rows):
    conn = sqlite3.connect(":memory:")
    conn.execute(f"CREATE TABLE depth_chart ({', '.join(COLS)})")
    q = f"INSERT INTO depth_chart ({','.join(COLS)}) VALUES ({','.join('?' * len(COLS))})"
    conn.executemany(q, [[r[c] for c in COLS] for r in rows])
    return conn


def default_db(n=40):
    """Mostly source-owned, with derived and unresolved rows present."""
    rows = [row(i) for i in range(1, n + 1)]
    rows[0].update({"gsis_source": "T3"})                       # derived, resolved
    rows[1].update({"gsis_source": "T4"})                       # derived, resolved
    rows[2].update({"gsis_source": None, "gsis_id": None})      # unresolved
    return build(rows)


def a(conn):
    return il.layer_a(conn)[0]


def b(conn):
    return il.layer_b(conn)[0]


def bag_of_identifiers(conn):
    """The STRAWMAN Layer B: a digest over source-owned identities ALONE.

    Implemented so the swap test can prove it is not a tautology. This digest is
    blind to which row an identity is attached to, which is precisely the defect
    class Layer B exists to catch.
    """
    h = hashlib.sha256()
    w = f"({sp.window('depth_chart').predicate}) AND {il.SOURCE_OWNED_PREDICATE}"
    for (g,) in conn.execute(
            f"SELECT gsis_id FROM depth_chart WHERE {w} ORDER BY gsis_id"):
        h.update(repr(g).encode())
    return h.hexdigest()


def value(conn, i, col):
    return conn.execute(
        f"SELECT {col} FROM depth_chart WHERE depth_chart_id=?", (i,)).fetchone()[0]


def source(path):
    with open(os.path.join(HERE, "lib", path)) as fh:
        return fh.read()


def expect_calls(path):
    """Every `expect(...)` call as (label, exact source text).

    Scanned through the AST rather than by character offset: a fixed-width
    window past `expect(` runs off the end of the call and reports whatever
    follows it, which is how the first version of this test failed on the line
    below the one it meant to read.
    """
    with open(path) as fh:
        src = fh.read()
    for node in ast.walk(ast.parse(src)):
        if (isinstance(node, ast.Call) and isinstance(node.func, ast.Name)
                and node.func.id == "expect"):
            label = ""
            if (node.args and isinstance(node.args[0], ast.Constant)
                    and isinstance(node.args[0].value, str)):
                label = node.args[0].value
            yield label, ast.get_source_segment(src, node) or ""


def executable(path):
    """File source with comments and docstrings removed.

    These modules deliberately quote the constructs they forbid in order to
    explain why they are forbidden, so a scan that keeps the prose reports the
    explanation as the violation.
    """
    with open(path) as fh:
        src = fh.read()
    out, in_doc = [], False
    for line in src.splitlines():
        stripped = line.strip()
        if in_doc:
            if stripped.endswith('"""'):
                in_doc = False
            continue
        if stripped.startswith('"""'):
            if not (stripped.endswith('"""') and len(stripped) > 3):
                in_doc = True
            continue
        if stripped.startswith("#"):
            continue
        out.append(line)
    return "\n".join(out)


class Structure(unittest.TestCase):
    """The projections, before any row exists."""

    def setUp(self):
        self.conn = default_db()

    def tearDown(self):
        self.conn.close()

    def test_layer_a_excludes_the_identity_column(self):
        self.assertNotIn("gsis_id", il.layer_a_projection(self.conn))

    def test_layer_b_is_layer_a_plus_the_identity(self):
        """Identity is hashed WITH its row, never beside it."""
        self.assertEqual(il.layer_b_projection(self.conn),
                         il.layer_a_projection(self.conn) + ["gsis_id"])

    def test_provenance_label_is_hashed_by_neither_layer(self):
        for proj in (il.layer_a_projection(self.conn), il.layer_b_projection(self.conn)):
            self.assertNotIn("gsis_source", proj)

    def test_surrogate_key_is_hashed_by_neither_layer(self):
        for proj in (il.layer_a_projection(self.conn), il.layer_b_projection(self.conn)):
            self.assertNotIn("depth_chart_id", proj)

    def test_the_projection_comes_from_the_registry(self):
        """A second hard-coded column list is a second authority, and two
        authorities drift. Phase 8 found exactly that in the unresolved-id
        list, so the projection is derived, not restated."""
        self.assertIn("sp.projection(", source("identity_layers.py"))

    def test_the_retired_digest_is_not_consulted_by_any_gate(self):
        src = source("identity_layers.py")
        uses = [ln for ln in src.splitlines()
                if "RETIRED_MONOLITHIC_DIGEST" in ln and not ln.startswith("#")]
        self.assertEqual(len(uses), 1, f"retired digest is referenced: {uses}")
        self.assertIn("RETIRED_MONOLITHIC_DIGEST = (", uses[0])

    def test_layer_b_population_is_one_declared_predicate(self):
        self.assertEqual(il.SOURCE_OWNED_PREDICATE, "gsis_source='feed'")


class LayerASensitivity(unittest.TestCase):
    """Every column Layer A protects must be able to break it."""

    def setUp(self):
        self.conn = default_db()
        self.base = a(self.conn)

    def tearDown(self):
        self.conn.close()

    def mutate(self, col, target=4):
        cur = value(self.conn, target, col)
        new = (cur + 1) if isinstance(cur, int) else (
            (cur + "X") if isinstance(cur, str) else "MUTATED")
        self.conn.execute(
            f"UPDATE depth_chart SET {col}=? WHERE depth_chart_id=?", (new, target))
        self.assertNotEqual(value(self.conn, target, col), cur,
                            f"{col}: mutation was vacuous")
        return new

    def test_every_layer_a_column_breaks_the_digest(self):
        """Loops the LIVE projection: a new protected column is covered the day
        it is added, without anyone remembering to write a test for it."""
        cols = il.layer_a_projection(self.conn)
        self.assertGreaterEqual(len(cols), 20)
        for col in cols:
            with self.subTest(column=col):
                conn = default_db()
                before = a(conn)
                cur = value(conn, 4, col)
                new = (cur + 1) if isinstance(cur, int) else (
                    (cur + "X") if isinstance(cur, str) else "MUTATED")
                conn.execute(
                    f"UPDATE depth_chart SET {col}=? WHERE depth_chart_id=?", (new, 4))
                self.assertNotEqual(value(conn, 4, col), cur, "vacuous mutation")
                self.assertNotEqual(a(conn), before, f"Layer A missed {col}")
                conn.close()

    def test_one_changed_cell_among_many_rows_is_detected(self):
        conn = build([row(i) for i in range(1, 501)])
        before = a(conn)
        conn.execute("UPDATE depth_chart SET depth_order=9 WHERE depth_chart_id=250")
        self.assertNotEqual(a(conn), before)
        conn.close()

    def test_a_deleted_row_is_detected(self):
        self.conn.execute("DELETE FROM depth_chart WHERE depth_chart_id=5")
        self.assertNotEqual(a(self.conn), self.base)

    def test_an_added_row_is_detected(self):
        r = row(9999)
        self.conn.execute(
            f"INSERT INTO depth_chart ({','.join(COLS)}) "
            f"VALUES ({','.join('?' * len(COLS))})", [r[c] for c in COLS])
        self.assertNotEqual(a(self.conn), self.base)

    def test_a_duplicated_row_is_detected(self):
        """Row count is part of the hash, so duplication cannot hide inside a
        set-like projection."""
        r = dict(zip(COLS, self.conn.execute(
            f"SELECT {','.join(COLS)} FROM depth_chart WHERE depth_chart_id=6"
        ).fetchone()))
        r["depth_chart_id"] = 10006
        self.conn.execute(
            f"INSERT INTO depth_chart ({','.join(COLS)}) "
            f"VALUES ({','.join('?' * len(COLS))})", [r[c] for c in COLS])
        self.assertNotEqual(a(self.conn), self.base)


class LayerASpecificity(unittest.TestCase):
    """Layer A must not quietly reabsorb what Phase 8 removed from it."""

    def setUp(self):
        self.conn = default_db()
        self.base_a = a(self.conn)
        self.base_b = b(self.conn)

    def tearDown(self):
        self.conn.close()

    def test_derived_identity_change_does_not_move_layer_a_or_b(self):
        before = value(self.conn, 1, "gsis_id")
        self.conn.execute(
            "UPDATE depth_chart SET gsis_id='00-0099999' WHERE depth_chart_id=1")
        self.assertNotEqual(value(self.conn, 1, "gsis_id"), before)
        self.assertEqual(a(self.conn), self.base_a)
        self.assertEqual(b(self.conn), self.base_b)

    def test_provenance_relabel_does_not_move_layer_a(self):
        self.conn.execute(
            "UPDATE depth_chart SET gsis_source='T2' WHERE depth_chart_id=1")
        self.assertEqual(value(self.conn, 1, "gsis_source"), "T2")
        self.assertEqual(a(self.conn), self.base_a)

    def test_surrogate_renumber_does_not_move_layer_a_or_b(self):
        self.conn.execute(
            "UPDATE depth_chart SET depth_chart_id=77777 WHERE depth_chart_id=7")
        self.assertEqual(self.conn.execute(
            "SELECT COUNT(*) FROM depth_chart WHERE depth_chart_id=77777"
        ).fetchone()[0], 1)
        self.assertEqual(a(self.conn), self.base_a)
        self.assertEqual(b(self.conn), self.base_b)

    def test_rows_outside_the_frozen_window_are_not_governed(self):
        r = row(8888, **OUT_OF_WINDOW)
        self.conn.execute(
            f"INSERT INTO depth_chart ({','.join(COLS)}) "
            f"VALUES ({','.join('?' * len(COLS))})", [r[c] for c in COLS])
        self.assertEqual(a(self.conn), self.base_a)
        self.conn.execute(
            "UPDATE depth_chart SET full_name='changed' WHERE depth_chart_id=8888")
        self.assertEqual(a(self.conn), self.base_a)

    def test_physical_insertion_order_does_not_change_the_digest(self):
        """The digest is over ORDERED content, so two builds that insert the
        same rows in different orders must agree -- otherwise every clean-build
        reproducibility claim later in this program is worthless."""
        rows = [row(i) for i in range(1, 30)]
        forward, backward = build(rows), build(list(reversed(rows)))
        self.assertEqual(a(forward), a(backward))
        self.assertEqual(b(forward), b(backward))
        forward.close()
        backward.close()


class LayerBSensitivity(unittest.TestCase):
    """Source-owned identity, bound to its row."""

    def setUp(self):
        self.conn = default_db()
        self.base_a = a(self.conn)
        self.base_b = b(self.conn)
        self.base_bag = bag_of_identifiers(self.conn)
        self.base_b_rows = il.layer_b(self.conn)[1]

    def tearDown(self):
        self.conn.close()

    def test_nulling_a_source_owned_identity_breaks_layer_b(self):
        self.conn.execute(
            "UPDATE depth_chart SET gsis_id=NULL WHERE depth_chart_id=10")
        self.assertIsNone(value(self.conn, 10, "gsis_id"))
        self.assertNotEqual(b(self.conn), self.base_b)
        self.assertEqual(a(self.conn), self.base_a)

    def test_reassigning_a_source_owned_identity_breaks_layer_b(self):
        before = value(self.conn, 10, "gsis_id")
        self.conn.execute(
            "UPDATE depth_chart SET gsis_id=? WHERE depth_chart_id=10",
            (value(self.conn, 11, "gsis_id"),))
        self.assertNotEqual(value(self.conn, 10, "gsis_id"), before)
        self.assertNotEqual(b(self.conn), self.base_b)
        self.assertEqual(a(self.conn), self.base_a)

    def test_swapping_two_source_owned_identities_breaks_layer_b(self):
        """THE load-bearing case. Row count identical, identifier multiset
        identical, every historical fact identical -- and two players have each
        other's careers."""
        g10, g11 = value(self.conn, 10, "gsis_id"), value(self.conn, 11, "gsis_id")
        self.assertNotEqual(g10, g11)
        self.conn.execute(
            "UPDATE depth_chart SET gsis_id=? WHERE depth_chart_id=10", (g11,))
        self.conn.execute(
            "UPDATE depth_chart SET gsis_id=? WHERE depth_chart_id=11", (g10,))
        self.assertEqual(value(self.conn, 10, "gsis_id"), g11)
        self.assertEqual(value(self.conn, 11, "gsis_id"), g10)

        self.assertEqual(il.layer_b(self.conn)[1], self.base_b_rows,
                         "row count must be unchanged for this to be a swap")
        self.assertEqual(bag_of_identifiers(self.conn), self.base_bag,
                         "identifier multiset must be unchanged for this to be a swap")
        self.assertEqual(a(self.conn), self.base_a,
                         "no historical fact changed, so Layer A must not move")
        self.assertNotEqual(b(self.conn), self.base_b,
                            "Layer B accepted a wrong-person swap")

    def test_the_bag_of_identifiers_strawman_accepts_the_swap(self):
        """Proves the test above is load-bearing rather than tautological: the
        obvious alternative implementation passes the swap silently."""
        g10, g11 = value(self.conn, 10, "gsis_id"), value(self.conn, 11, "gsis_id")
        self.conn.execute(
            "UPDATE depth_chart SET gsis_id=? WHERE depth_chart_id=10", (g11,))
        self.conn.execute(
            "UPDATE depth_chart SET gsis_id=? WHERE depth_chart_id=11", (g10,))
        self.assertEqual(bag_of_identifiers(self.conn), self.base_bag)
        self.assertNotEqual(b(self.conn), self.base_b)


class LayerBSpecificity(unittest.TestCase):
    """Layer B governs provider-owned identity -- not derived work, not labels."""

    def setUp(self):
        self.conn = default_db()
        self.base_a = a(self.conn)
        self.base_b = b(self.conn)

    def tearDown(self):
        self.conn.close()

    def test_a_layer_c_resolution_does_not_move_layer_b(self):
        """unresolved -> derived resolved. This is the event the monolithic
        digest called corruption."""
        self.assertIsNone(value(self.conn, 3, "gsis_id"))
        self.conn.execute("UPDATE depth_chart SET gsis_id='00-0088888', "
                          "gsis_source='T3' WHERE depth_chart_id=3")
        self.assertEqual(value(self.conn, 3, "gsis_id"), "00-0088888")
        self.assertEqual(b(self.conn), self.base_b)
        self.assertEqual(a(self.conn), self.base_a)

    def test_a_derived_provenance_relabel_does_not_move_layer_b(self):
        self.conn.execute(
            "UPDATE depth_chart SET gsis_source='T2' WHERE depth_chart_id=1")
        self.assertEqual(value(self.conn, 1, "gsis_source"), "T2")
        self.assertEqual(b(self.conn), self.base_b)

    def test_relabelling_out_of_feed_is_detected_by_design(self):
        """BOUNDARY, and the one place where a label does move Layer B.

        Relabelling a row out of 'feed' removes it from Layer B's population.
        That is not a specificity failure -- it is the required behaviour. If it
        passed silently, an identity could be laundered out of Layer B by a
        label edit and then rewritten freely.
        """
        self.conn.execute(
            "UPDATE depth_chart SET gsis_source='T3' WHERE depth_chart_id=10")
        self.assertNotEqual(b(self.conn), self.base_b)
        self.assertEqual(a(self.conn), self.base_a)


class Conservation(unittest.TestCase):
    """Every frozen row is governed by exactly one identity mechanism."""

    def test_the_buckets_partition_the_frozen_window(self):
        conn = default_db()
        c = il.conservation(conn)
        self.assertEqual(c["ungoverned"], 0)
        self.assertEqual(c["overlapping"], 0)
        self.assertEqual(c["governed"], c["frozen_rows"])
        self.assertEqual(c["layer_b_source_owned"] + c["layer_c_resolved"]
                         + c["layer_c_unresolved"], c["frozen_rows"])
        conn.close()

    def test_out_of_window_rows_are_not_counted(self):
        conn = build([row(i) for i in range(1, 11)]
                     + [row(50 + i, **OUT_OF_WINDOW) for i in range(5)])
        self.assertEqual(il.conservation(conn)["frozen_rows"], 10)
        conn.close()

    def test_a_row_in_no_bucket_is_reported_ungoverned(self):
        """A labelled row with no identity belongs to no mechanism: Layer B
        excludes it, and Layer C has nothing to compare."""
        conn = default_db()
        conn.execute("UPDATE depth_chart SET gsis_source='T3', gsis_id=NULL "
                     "WHERE depth_chart_id=12")
        self.assertEqual(il.conservation(conn)["ungoverned"], 1)
        conn.close()

    def test_an_identity_with_no_provenance_label_is_ungoverned(self):
        """Layer B excludes it (not 'feed') and nothing else claims it. The
        honest answer is 'I cannot tell which mechanism owns this row', so it
        is reported rather than absorbed."""
        conn = default_db()
        conn.execute("UPDATE depth_chart SET gsis_source=NULL "
                     "WHERE depth_chart_id=14")
        c = il.conservation(conn)
        self.assertEqual(c["ungoverned"], 1)
        self.assertEqual(c["overlapping"], 0)
        conn.close()

    def test_two_opposite_anomalies_cannot_cancel(self):
        """THE regression this partition exists for.

        The first implementation counted `gsis_source IS NOT 'feed' AND gsis_id
        IS NOT NULL` as derived and `gsis_source IS NULL` as unresolved. Row 14
        below matched BOTH; row 13 matched NEITHER; the +1 and the -1 cancelled
        and `ungoverned` reported 0 for a database containing an unprotected
        identity row. A control that fails open is worse than no control.
        """
        conn = default_db()
        conn.execute("UPDATE depth_chart SET gsis_source='T3', gsis_id=NULL "
                     "WHERE depth_chart_id=13")     # label, no identity
        conn.execute("UPDATE depth_chart SET gsis_source=NULL "
                     "WHERE depth_chart_id=14")     # identity, no label
        c = il.conservation(conn)
        self.assertEqual(c["ungoverned"], 2)
        self.assertEqual(c["overlapping"], 0)
        conn.close()

    def test_every_row_is_counted_exactly_once(self):
        conn = default_db()
        conn.execute("UPDATE depth_chart SET gsis_source=NULL "
                     "WHERE depth_chart_id=14")
        c = il.conservation(conn)
        self.assertEqual(c["governed"] + c["ungoverned"] + c["overlapping"],
                         c["frozen_rows"])
        self.assertEqual(
            c["layer_b_source_owned"] + c["layer_c_resolved"] + c["layer_c_unresolved"],
            c["governed"], "bucket totals must equal the exactly-once population")
        conn.close()


class RetiredAuthorities(unittest.TestCase):
    """Phase 8 retired three authorities. Retirement has to be enforceable.

    Each of these was found UNGUARDED by the Phase 8 mutation matrix: the code
    was correct, and nothing stopped it being quietly reverted.
    """

    def test_no_identity_coverage_percentage_can_block_the_build(self):
        """The 85% fill-rate gate is gone and may not come back.

        It could not see either defect that matters -- a person disappearing
        moves it by a rounding error, a row reassigned to the wrong person moves
        it by exactly nothing -- while blocking the legitimate resolutions it
        was supposed to encourage.
        """
        checked = 0
        for name in ("lib/depth_charts.py", "build_db.py"):
            for _, call in expect_calls(os.path.join(HERE, name)):
                checked += 1
                self.assertNotIn("fill_rate", call, f"{name}: percentage gate restored")
        self.assertGreater(checked, 10, "the scan found no expect() calls to check")

    def test_every_unfalsifiable_blocking_gate_is_declared(self):
        """A gate whose condition is a literal cannot fail, so it proves nothing
        about the build it appears to guard.

        One existed -- "all 31 shape-B pos_abb values are mapped", whose
        condition was the literal True. It was not dishonest: the code says the
        property is enforced inside `normalize`, which raises on an unknown
        pos_abb. But its truth was INHERITED rather than checked, so it would
        have kept printing PASS if `normalize` ever stopped raising. It now
        asserts against the pos_abb values the run actually observed.
        """
        found = set()
        for name in ("lib/depth_charts.py", "build_db.py"):
            path = os.path.join(HERE, name)
            with open(path) as fh:
                src = fh.read()
            for node in ast.walk(ast.parse(src)):
                if (isinstance(node, ast.Call) and isinstance(node.func, ast.Name)
                        and node.func.id == "expect" and len(node.args) >= 2
                        and isinstance(node.args[1], ast.Constant)):
                    found.add(node.args[0].value)
        self.assertEqual(found, KNOWN_UNFALSIFIABLE_GATES)

    def test_every_fractional_blocking_threshold_is_declared(self):
        """Percentage thresholds are not banned outright -- one is legitimate --
        but a new one may never appear unnoticed.

        The survivor measures how much of a MAPPING TABLE is populated, which a
        percentage can actually answer. The retired gate claimed to measure
        whether identities were CORRECT, which it could not. Anything added here
        has to be argued for in review rather than merged in silence.
        """
        found = set()
        for name in ("lib/depth_charts.py", "build_db.py"):
            for label, call in expect_calls(os.path.join(HERE, name)):
                if re.search(r"[<>]=?\s*0\.\d+", call):
                    found.add(label)
        self.assertEqual(found, ALLOWED_FRACTIONAL_GATES)

    def test_the_monolithic_depth_chart_digest_is_not_an_active_gate(self):
        self.assertIn("depth_chart", sp.RETIRED_MONOLITHIC_TABLES)
        self.assertNotIn("depth_chart", sp.governed_tables())

    def test_but_the_retired_digest_is_still_registered_and_computable(self):
        """Retiring an authority is not the same as losing the ability to
        compute it. The migration has to stay auditable."""
        self.assertIn("depth_chart", sp.all_frozen_tables())
        self.assertEqual(len(il.RETIRED_MONOLITHIC_DIGEST), 64)

    def test_the_unresolved_authority_is_derived_not_restated(self):
        """UNRESOLVED_NOTES carried 34 ids while reviewed acceptance carried 33
        -- two authorities that had already drifted about a real person. The
        derived function is now the only authority."""
        import identity_baseline as ib
        import depth_charts as dc
        accepted, _ = ib.load_baseline()
        self.assertEqual(dc.unresolved_baseline_ids(), ib.accepted_unresolved(accepted))

    def test_the_descriptive_note_list_is_not_consulted_as_an_authority(self):
        import depth_charts as dc
        src = executable(os.path.join(HERE, "lib", "depth_charts.py"))
        uses = [ln.strip() for ln in src.splitlines()
                if "UNRESOLVED_NOTES" in ln
                and not ln.strip().startswith("UNRESOLVED_NOTES = {")
                and ln.strip() != '"UNRESOLVED_NOTES",']
        self.assertEqual(uses, [], f"UNRESOLVED_NOTES is read as an authority: {uses}")
        self.assertEqual(len(dc.unresolved_baseline_ids()), 33,
                         "the reviewed unresolved population changed")


class AgainstTheAcceptedBuild(unittest.TestCase):
    """Only runs when a built database is supplied via NFLDB_TEST_DB."""

    def setUp(self):
        db = os.environ.get("NFLDB_TEST_DB", "")
        if not db or not os.path.exists(db):
            self.skipTest("set NFLDB_TEST_DB to a built nfl.db")
        self.conn = sqlite3.connect(f"file:{db}?mode=ro", uri=True)

    def tearDown(self):
        self.conn.close()

    def test_both_layers_reproduce_their_pins(self):
        for name, ok, detail in il.verdicts(self.conn):
            self.assertTrue(ok, f"Layer {name}: {detail}")

    def test_conservation_holds_on_the_real_window(self):
        c = il.conservation(self.conn)
        self.assertEqual(c["ungoverned"], 0, c)
        self.assertEqual(c["frozen_rows"], il.LAYER_A_ROWS)
        self.assertEqual(c["layer_b_source_owned"], il.LAYER_B_ROWS)

    def test_the_retired_monolithic_digest_still_reproduces(self):
        """Retirement is not abandonment: the digest that was superseded must
        still be computable, or the migration cannot be audited later."""
        d, n, _ = sp.content_digest(
            self.conn, "depth_chart", sp.window("depth_chart").predicate)
        self.assertEqual(d, il.RETIRED_MONOLITHIC_DIGEST)
        self.assertEqual(n, il.RETIRED_MONOLITHIC_ROWS)


if __name__ == "__main__":
    unittest.main(verbosity=2)
