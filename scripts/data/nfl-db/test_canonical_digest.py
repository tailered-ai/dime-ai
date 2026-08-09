#!/usr/bin/env python3
"""Tests for the canonical digest serialization (Phase 4).

    python3 scripts/data/nfl-db/test_canonical_digest.py

Phase 3 hashed `repr(row)` and stored 20 of 64 hex chars. No collision was ever
demonstrated against it -- an attempt to construct one failed. It was replaced
because its correctness rested on properties nothing enforced: it bound no
column names (so a rename was invisible), framed no row boundaries, kept 80 of
256 bits, carried no algorithm tag, and leaned on a debugging function with no
cross-interpreter stability contract.

The replacement earns its keep only if that is mechanically true, so these
tests are organised around proving it rather than asserting it:

  * INJECTIVITY is proven by DECODING. A stream that decodes back to exactly
    the rows that produced it cannot be a lossy encoding of them. The real
    corpus is round-tripped, not a toy fixture.
  * GOLDEN VECTORS pin the algorithm without a database, so an encoder change
    cannot hide behind "the data must have moved".
  * The MIGRATION CLAIM is kept falsifiable: the legacy hash is recomputed from
    the same cursor, so "the digest changed because we changed the hashing
    code" can never again be offered as sufficient evidence.
"""
from __future__ import annotations

import hashlib
import os
import sqlite3
import struct
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "lib"))

import season_pins as sp  # noqa: E402

DB = os.environ.get("NFLDB_TEST_DB", "")


def digest_of(table, where, cols, rows):
    """The whole-stream digest, built from the same primitives the real path
    uses. Kept local so a test cannot accidentally validate itself against a
    second copy of the production loop."""
    h = hashlib.sha256()
    h.update(sp.canonical_header(table, where, cols))
    for r in rows:
        h.update(sp.canonical_row(r))
    h.update(sp.canonical_footer(len(rows)))
    return h.hexdigest()


def stream_of(table, where, cols, rows):
    return (sp.canonical_header(table, where, cols)
            + b"".join(sp.canonical_row(r) for r in rows)
            + sp.canonical_footer(len(rows)))


# --------------------------------------------------------------------------
# Section 21 -- golden vectors
# --------------------------------------------------------------------------
class GoldenVectors(unittest.TestCase):
    """The algorithm is pinned independently of any database. Every expected
    value below is hand-decodable: tag byte, 8-byte big-endian length, payload."""

    def test_value_encodings(self):
        cases = {
            None: "4e" + "0000000000000000",
            0: "49" + "0000000000000008" + "0000000000000000",
            -1: "49" + "0000000000000008" + "ffffffffffffffff",
            2 ** 63 - 1: "49" + "0000000000000008" + "7fffffffffffffff",
            0.1: "46" + "0000000000000008" + "3fb999999999999a",
            "a": "53" + "0000000000000001" + "61",
            "": "53" + "0000000000000000",
            "José": "53" + "0000000000000005" + "4a6f73c3a9",
            b"\x00\xff": "42" + "0000000000000002" + "00ff",
        }
        for value, want in cases.items():
            self.assertEqual(sp.encode_value(value).hex(), want, repr(value))

    def test_whole_stream_digests(self):
        self.assertEqual(
            digest_of("t", "1=1", ["a"], []),
            "6d007b8270d563cffcbec4c7972bc52f8eb39b5776114baf5432ed454547f196")
        self.assertEqual(
            digest_of("t", "1=1", ["a", "b"], [(1, "x")]),
            "e782123074ea7104cb2d689056fe95634c78c0449411cd3ef36d43bf7b57605f")
        self.assertEqual(
            digest_of("t", "season <= 2025", ["id", "name"], [(1, "a"), (2, "b")]),
            "1191ac289537f4b5bcfb58900c26b99be6c71fc430ba2bb7697fb4bcdd4b04f8")
        self.assertEqual(
            digest_of("t", "1=1", ["n", "i", "f", "s", "b"],
                      [(None, -5, 0.5, "é", b"\x01")]),
            "0caf12314d1afdd978ed8b99560ba7ae1a7ac0835bb9caf6fe961f5dbb1611ba")

    def test_algorithm_tag_is_bound_into_the_hash(self):
        """D6: the version is hashed, not merely documented, so two algorithms
        cannot produce the same pin for the same rows."""
        before = digest_of("t", "1=1", ["a"], [(1,)])
        original = sp.DIGEST_ALGORITHM
        try:
            sp.DIGEST_ALGORITHM = "nfldb-canon-2"
            self.assertNotEqual(digest_of("t", "1=1", ["a"], [(1,)]), before)
        finally:
            sp.DIGEST_ALGORITHM = original

    def test_declared_algorithm_matches_the_pinned_vectors(self):
        self.assertEqual(sp.DIGEST_ALGORITHM, "nfldb-canon-1")


# --------------------------------------------------------------------------
# Section 22 -- injectivity, proven by decoding
# --------------------------------------------------------------------------
class Injectivity(unittest.TestCase):

    def test_round_trip_preserves_values_and_types(self):
        cols = ["n", "i", "f", "s", "b"]
        rows = [(None, 0, 0.0, "", b""),
                (-2 ** 63, 2 ** 63 - 1, -0.5, "José", b"\x00\xff"),
                (7, -7, 1e308, "tab\tnew\nline", b"\x7f")]
        algo, table, where, got_cols, got = sp.decode_canonical(
            stream_of("depth_chart", "season <= 2025", cols, rows))
        self.assertEqual((algo, table, where), (sp.DIGEST_ALGORITHM,
                                                "depth_chart", "season <= 2025"))
        self.assertEqual(got_cols, cols)
        self.assertEqual(got, rows)
        for orig, back in zip(rows, got):                     # types too, not just ==
            for a, b in zip(orig, back):
                self.assertIs(type(a), type(b), f"{a!r} came back as {type(b)}")

    def test_int_and_float_do_not_collapse(self):
        """1 == 1.0 in Python; they must not be the same protected fact."""
        self.assertNotEqual(sp.encode_value(1), sp.encode_value(1.0))
        _, _, _, _, rows = sp.decode_canonical(
            stream_of("t", "1=1", ["a", "b"], [(1, 1.0)]))
        self.assertIs(type(rows[0][0]), int)
        self.assertIs(type(rows[0][1]), float)

    def test_negative_zero_is_preserved(self):
        _, _, _, _, rows = sp.decode_canonical(stream_of("t", "1=1", ["a"], [(-0.0,)]))
        self.assertEqual(struct.pack(">d", rows[0][0]), struct.pack(">d", -0.0))

    def test_separator_lookalikes_in_text_cannot_forge_framing(self):
        """The payload is length-delimited, so bytes that resemble tags or
        lengths inside a string are inert."""
        nasty = ["R\x00\x00\x00\x02", "Z" + "\xff" * 8, "\x00" * 9, "),('"]
        for s in nasty:
            _, _, _, _, rows = sp.decode_canonical(stream_of("t", "1=1", ["a"], [(s,)]))
            self.assertEqual(rows, [(s,)], repr(s))

    def test_truncated_stream_is_rejected_not_silently_short(self):
        blob = stream_of("t", "1=1", ["a"], [(1,), (2,)])
        with self.assertRaises(ValueError):
            sp.decode_canonical(blob[:-3])

    def test_footer_row_count_is_enforced(self):
        blob = (sp.canonical_header("t", "1=1", ["a"])
                + sp.canonical_row((1,)) + sp.canonical_footer(9))
        with self.assertRaises(ValueError):
            sp.decode_canonical(blob)

    def test_trailing_bytes_are_rejected(self):
        with self.assertRaises(ValueError):
            sp.decode_canonical(stream_of("t", "1=1", ["a"], [(1,)]) + b"x")

    def test_unencodable_types_fail_loudly(self):
        for bad in (True, [1], {"a": 1}, 2 ** 63):
            with self.assertRaises((TypeError, ValueError), msg=repr(bad)):
                sp.encode_value(bad)

    @unittest.skipUnless(DB and os.path.exists(DB), "needs NFLDB_TEST_DB")
    def test_round_trip_over_the_real_corpus(self):
        """The claim is about 1.76M real rows, so it is tested on them. A
        sample would only prove the encoder works on the rows it was shown."""
        c = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
        try:
            for t in sp.governed_tables():
                w = sp.window(t)
                keep = sp.projection(c, t)
                proj = ", ".join(keep)
                n = 0
                for row in c.execute(f"SELECT {proj} FROM {t} "
                                     f"WHERE {w.predicate} ORDER BY {proj}"):
                    # decode one row at a time: a whole-corpus buffer would be
                    # gigabytes, and per-row framing is what is under test.
                    _, _, _, _, back = sp.decode_canonical(
                        sp.canonical_header(t, w.predicate, keep)
                        + sp.canonical_row(row) + sp.canonical_footer(1))
                    self.assertEqual(back[0], tuple(row), f"{t} row {n}")
                    n += 1
                self.assertEqual(n, w.expected_count, t)
        finally:
            c.close()

    @unittest.skipUnless(DB and os.path.exists(DB), "needs NFLDB_TEST_DB")
    def test_multi_row_framing_on_real_rows(self):
        """The per-row test above re-frames each row on its own, so it proves
        value fidelity but not that a CONCATENATED stream stays unambiguous.
        Buffering all 1.76M rows would cost gigabytes, so this decodes a bounded
        window of consecutive real rows per table as one blob -- enough to
        exercise row-to-row boundaries on production data."""
        c = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
        try:
            for t in sp.governed_tables():
                w = sp.window(t)
                keep = sp.projection(c, t)
                proj = ", ".join(keep)
                rows = [tuple(r) for r in c.execute(
                    f"SELECT {proj} FROM {t} WHERE {w.predicate} "
                    f"ORDER BY {proj} LIMIT 10000")]
                self.assertGreater(len(rows), 0, t)
                _, _, _, cols, back = sp.decode_canonical(
                    stream_of(t, w.predicate, keep, rows))
                self.assertEqual(cols, keep, t)
                self.assertEqual(back, rows, f"{t}: multi-row framing lost data")
        finally:
            c.close()


# --------------------------------------------------------------------------
# Section 23/24 -- the migration claim stays falsifiable
# --------------------------------------------------------------------------
class MigrationEvidence(unittest.TestCase):

    def test_legacy_pins_are_recorded_at_full_width(self):
        self.assertEqual(set(sp.LEGACY_CONTENT_DIGESTS), set(sp.CONTENT_DIGESTS))
        for t, d in sp.LEGACY_CONTENT_DIGESTS.items():
            self.assertEqual(len(d), 64, t)

    def test_canonical_pins_are_full_sha256(self):
        for t, d in sp.CONTENT_DIGESTS.items():
            self.assertEqual(len(d), 64, t)
            int(d, 16)                                    # hex, not a placeholder
            self.assertNotEqual(d, sp.LEGACY_CONTENT_DIGESTS[t],
                                f"{t}: canonical pin equals the legacy hash")

    def test_phase3_pins_were_prefixes_of_the_recorded_legacy_hashes(self):
        """The §5 continuity gate, frozen into the suite: the 20-char pins this
        phase replaced must remain derivable from what is recorded here."""
        for t, twenty in {
                "depth_chart": "d165550d624c6ccaf397",
                "player_game_stats": "c30625670748f488ff35",
                "snap_count": "ea44a47fecfeb0af8683",
                "roster_season": "4c610696494640288603"}.items():
            self.assertTrue(sp.LEGACY_CONTENT_DIGESTS[t].startswith(twenty), t)

    @unittest.skipUnless(DB and os.path.exists(DB), "needs NFLDB_TEST_DB")
    def test_content_is_unchanged_and_only_representation_moved(self):
        """Both hashes come off ONE cursor, so they cannot have seen different
        rows. If content ever drifts, the legacy hash moves too -- which is what
        stops 'we changed the hashing code' from covering a real change."""
        c = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
        try:
            for t in sp.governed_tables():
                w = sp.window(t)
                keep = sp.projection(c, t)
                proj = ", ".join(keep)
                legacy = hashlib.sha256()
                canon = hashlib.sha256()
                canon.update(sp.canonical_header(t, w.predicate, keep))
                n = 0
                for row in c.execute(f"SELECT {proj} FROM {t} "
                                     f"WHERE {w.predicate} ORDER BY {proj}"):
                    legacy.update(repr(row).encode())
                    canon.update(sp.canonical_row(row))
                    n += 1
                canon.update(sp.canonical_footer(n))
                self.assertEqual(legacy.hexdigest(), sp.LEGACY_CONTENT_DIGESTS[t],
                                 f"{t}: CONTENT changed, not just its encoding")
                self.assertEqual(canon.hexdigest(), sp.CONTENT_DIGESTS[t], t)
                self.assertEqual(n, w.expected_count, t)
        finally:
            c.close()

    @unittest.skipUnless(DB and os.path.exists(DB), "needs NFLDB_TEST_DB")
    def test_production_path_reproduces_the_pins(self):
        """content_digest() itself -- not a re-implementation -- must produce
        the pinned values and be accepted by content_verdict()."""
        c = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
        try:
            for t in sp.governed_tables():
                w = sp.window(t)
                dg, n, keep = sp.content_digest(c, t, w.predicate)
                self.assertEqual(len(dg), 64, t)
                ok, detail = sp.content_verdict(t, dg)
                self.assertTrue(ok, f"{t}: {detail}")
                self.assertEqual(n, w.expected_count, t)
                lg, ln, _ = sp.legacy_content_digest(c, t, w.predicate)
                self.assertEqual(lg, sp.LEGACY_CONTENT_DIGESTS[t], t)
                self.assertEqual(ln, n, t)
        finally:
            c.close()


class ProductionPathWithoutADatabase(unittest.TestCase):
    """content_digest() itself, pinned against a fixture small enough to check
    by hand.

    The golden vectors above assemble the stream from primitives, which proves
    the ENCODING but not that the production loop uses it correctly -- the §32
    mutation matrix caught exactly that gap: dropping the footer from
    content_digest(), and truncating its output back to 20 chars, both passed
    every DB-free test. These close it, so the build path is defended even where
    no nfl.db is available (CI, a fresh clone, a contributor's laptop).
    """

    COLS = ["season", "player", "pct", "note"]
    ROWS = [(2025, "b", 0.5, None), (2024, "a", 1.0, "x"), (2026, "live", 0.25, "z")]
    WHERE = "season <= 2025"
    PIN = "1b0da1f957effe0d8d005db71f3ca94bec0c308fd46dade1ccc1a9e2cd60b5d4"

    def fixture(self):
        c = sqlite3.connect(":memory:")
        c.execute("CREATE TABLE snap_count (season INTEGER, player TEXT, "
                  "pct REAL, note TEXT)")
        c.executemany("INSERT INTO snap_count VALUES (?,?,?,?)", self.ROWS)
        return c

    def test_production_digest_matches_its_pin(self):
        c = self.fixture()
        try:
            d, n, keep = sp.content_digest(c, "snap_count", self.WHERE)
            self.assertEqual(keep, self.COLS)
            self.assertEqual(n, 2, "the 2026 row must be outside the window")
            self.assertEqual(len(d), 64, "production path is not emitting full SHA-256")
            self.assertEqual(d, self.PIN)
        finally:
            c.close()

    def test_production_path_uses_the_golden_vector_algorithm(self):
        """Ties the build loop to the DB-free algorithm pin: if content_digest()
        stops emitting header, rows or footer exactly as canonical_* produce
        them, these two stop agreeing."""
        c = self.fixture()
        try:
            d, _, keep = sp.content_digest(c, "snap_count", self.WHERE)
            expected = digest_of("snap_count", self.WHERE, keep,
                                 [(2024, "a", 1.0, "x"), (2025, "b", 0.5, None)])
            self.assertEqual(d, expected)
        finally:
            c.close()

    def test_legacy_path_still_differs_and_is_full_width(self):
        c = self.fixture()
        try:
            lg, n, _ = sp.legacy_content_digest(c, "snap_count", self.WHERE)
            self.assertEqual(len(lg), 64)
            self.assertEqual(n, 2)
            self.assertNotEqual(lg, self.PIN)
        finally:
            c.close()


class VerdictWidth(unittest.TestCase):
    """D6: a legacy-width digest must be diagnosed, not read as corruption."""

    def test_truncated_digest_is_rejected_with_an_algorithm_message(self):
        ok, detail = sp.content_verdict("depth_chart", sp.CONTENT_DIGESTS["depth_chart"][:20])
        self.assertFalse(ok)
        self.assertIn("legacy digest?", detail)

    def test_correct_digest_passes(self):
        ok, _ = sp.content_verdict("depth_chart", sp.CONTENT_DIGESTS["depth_chart"])
        self.assertTrue(ok)

    def test_unpinned_table_still_reports_rather_than_fails(self):
        ok, _ = sp.content_verdict("not_pinned", "0" * 64)
        self.assertIsNone(ok)


# --------------------------------------------------------------------------
# Section 30 -- negative matrix: each must CHANGE the digest
# --------------------------------------------------------------------------
class NegativeMatrix(unittest.TestCase):

    BASE = ("depth_chart", "season <= 2025", ["id", "name"], [(1, "a"), (2, "b")])

    def base(self):
        return digest_of(*self.BASE)

    def test_s4_1_value_change(self):
        self.assertNotEqual(
            digest_of("depth_chart", "season <= 2025", ["id", "name"],
                      [(1, "a"), (2, "c")]), self.base())

    def test_s4_2_type_change_same_text(self):
        self.assertNotEqual(
            digest_of("depth_chart", "season <= 2025", ["id", "name"],
                      [("1", "a"), (2, "b")]), self.base())

    def test_s4_3_null_versus_empty_string(self):
        a = digest_of("t", "1=1", ["x"], [(None,)])
        b = digest_of("t", "1=1", ["x"], [("",)])
        self.assertNotEqual(a, b)

    def test_s4_4_row_dropped(self):
        self.assertNotEqual(
            digest_of("depth_chart", "season <= 2025", ["id", "name"], [(1, "a")]),
            self.base())

    def test_s4_5_row_duplicated(self):
        self.assertNotEqual(
            digest_of("depth_chart", "season <= 2025", ["id", "name"],
                      [(1, "a"), (1, "a"), (2, "b")]), self.base())

    def test_s4_6_column_renamed_with_identical_values(self):
        """The defect that motivated the phase. The canonical digest moves; the
        legacy digest provably did NOT -- asserted here so the regression is
        recorded rather than remembered."""
        renamed = digest_of("depth_chart", "season <= 2025", ["week", "team"],
                            [(1, "a"), (2, "b")])
        self.assertNotEqual(renamed, self.base())
        legacy = hashlib.sha256()
        for r in [(1, "a"), (2, "b")]:
            legacy.update(repr(r).encode())
        self.assertEqual(legacy.hexdigest()[:20], "74582db91cf3c4bd1315",
                         "the legacy encoding no longer behaves as recorded")

    def test_s4_7_population_predicate_changed(self):
        self.assertNotEqual(
            digest_of("depth_chart", "season <= 2024", ["id", "name"],
                      [(1, "a"), (2, "b")]), self.base())

    def test_s4_8_table_identity_changed(self):
        self.assertNotEqual(
            digest_of("snap_count", "season <= 2025", ["id", "name"],
                      [(1, "a"), (2, "b")]), self.base())

    def test_s4_9_column_order_swapped(self):
        self.assertNotEqual(
            digest_of("depth_chart", "season <= 2025", ["name", "id"],
                      [(1, "a"), (2, "b")]), self.base())


# --------------------------------------------------------------------------
# Section 31 -- specificity: each must NOT change the digest
# --------------------------------------------------------------------------
class Specificity(unittest.TestCase):
    """A gate that fires on everything is as useless as one that fires on
    nothing. These pin what the digest deliberately ignores."""

    def test_p4_1_recomputation_is_stable(self):
        a = digest_of("t", "1=1", ["a", "b"], [(1, "x"), (2, "y")])
        b = digest_of("t", "1=1", ["a", "b"], [(1, "x"), (2, "y")])
        self.assertEqual(a, b)

    def test_p4_2_excluded_columns_do_not_reach_the_projection(self):
        c = sqlite3.connect(":memory:")
        c.execute("CREATE TABLE depth_chart (gsis_id TEXT, gsis_source TEXT, "
                  "depth_chart_id INTEGER)")
        c.execute("INSERT INTO depth_chart VALUES ('00-1','T4',1)")
        proj = sp.projection(c, "depth_chart")
        self.assertEqual(proj, ["gsis_id"])
        before, _, _ = sp.content_digest(c, "depth_chart", "1=1")
        c.execute("UPDATE depth_chart SET gsis_source='feed', depth_chart_id=99")
        after, _, _ = sp.content_digest(c, "depth_chart", "1=1")
        self.assertEqual(before, after,
                         "an excluded field leaked into the protected content")
        c.close()

    def test_p4_3_physical_row_order_is_irrelevant(self):
        """ORDER BY the full projection: insertion order must not matter."""
        digs = []
        for order in ([(1, "a"), (2, "b")], [(2, "b"), (1, "a")]):
            c = sqlite3.connect(":memory:")
            c.execute("CREATE TABLE snap_count (season INTEGER, name TEXT)")
            c.executemany("INSERT INTO snap_count VALUES (?,?)", order)
            digs.append(sp.content_digest(c, "snap_count", "1=1")[0])
            c.close()
        self.assertEqual(digs[0], digs[1])

    def test_p4_4_rows_outside_the_window_are_ignored(self):
        c = sqlite3.connect(":memory:")
        c.execute("CREATE TABLE snap_count (season INTEGER, name TEXT)")
        c.execute("INSERT INTO snap_count VALUES (2025,'a')")
        before, n0, _ = sp.content_digest(c, "snap_count", "season <= 2025")
        c.execute("INSERT INTO snap_count VALUES (2026,'live')")
        after, n1, _ = sp.content_digest(c, "snap_count", "season <= 2025")
        self.assertEqual((before, n0), (after, n1))
        c.close()

    def test_p4_5_unrelated_tables_are_ignored(self):
        c = sqlite3.connect(":memory:")
        c.execute("CREATE TABLE snap_count (season INTEGER)")
        c.execute("CREATE TABLE other (x TEXT)")
        c.execute("INSERT INTO snap_count VALUES (2025)")
        before, _, _ = sp.content_digest(c, "snap_count", "1=1")
        c.execute("INSERT INTO other VALUES ('noise')")
        self.assertEqual(sp.content_digest(c, "snap_count", "1=1")[0], before)
        c.close()

    def test_p4_6_digest_is_independent_of_the_database_file(self):
        digs = []
        for _ in range(2):
            c = sqlite3.connect(":memory:")
            c.execute("CREATE TABLE snap_count (season INTEGER, name TEXT)")
            c.execute("INSERT INTO snap_count VALUES (2025,'a')")
            digs.append(sp.content_digest(c, "snap_count", "1=1")[0])
            c.close()
        self.assertEqual(digs[0], digs[1])


if __name__ == "__main__":
    unittest.main(verbosity=2)
