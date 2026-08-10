#!/usr/bin/env python3
"""Tests for build provenance -- Phases 10 and 11.

    python3 scripts/data/nfl-db/test_build_provenance.py

Phase 9 reported `unexplained = -964,646` on a healthy database. A database
cannot hold more rows than its source produced, so that was never a measurement
of loss -- it was proof that the compared things did not belong together. The
extracts on disk predated the build, and nothing could tell, because a filename
is not provenance.

Two properties have to hold, and they pull in opposite directions:

  SENSITIVITY   one changed byte in one semantic input must change the
                fingerprint. Otherwise the binding certifies the wrong bytes.

  STABILITY     the same bytes under a different root, at a different time, on
                a different absolute path must fingerprint IDENTICALLY.
                Otherwise the clean-room phases can never match anything and the
                binding gets switched off by whoever is trying to ship.

The nastiest case is neither: a valid manifest sitting beside the WRONG
database. Nothing about the file contents is malformed. That is why the manifest
carries the output fingerprint and why the database is matched to the manifest
before any input hash it carries is believed.
"""
from __future__ import annotations

import json
import os
import shutil
import sqlite3
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "lib"))

import build_inputs as bi  # noqa: E402
import build_provenance as bp  # noqa: E402


def sandbox(tmp, marker=b"seed"):
    """A complete set of declared inputs, tiny, under a relocatable root."""
    root = os.path.join(tmp, "root")
    raw = os.path.join(tmp, "raw")
    os.makedirs(raw, exist_ok=True)
    for name, spec in bi.BUILD_INPUTS.items():
        if getattr(spec, "on_path", False):
            continue
        p = bi.path(name, root=root, raw_dir=raw)
        os.makedirs(os.path.dirname(p), exist_ok=True)
        with open(p, "wb") as fh:
            fh.write(b"%s:%s\n" % (name.encode(), marker))
    return root, raw


def db(tmp, name="t.db", rows=(("A", 1), ("B", 2))):
    """A database using DECLARED table names, so the completeness guard runs."""
    path = os.path.join(tmp, name)
    conn = sqlite3.connect(path)
    conn.execute("CREATE TABLE team (franchise_id INTEGER PRIMARY KEY, abbreviation TEXT)")
    conn.execute("CREATE TABLE team_alias (abbreviation TEXT PRIMARY KEY, franchise_id INTEGER)")
    conn.executemany("INSERT INTO team VALUES (?, ?)", [(n, a) for a, n in rows])
    conn.commit()
    return path, conn


class Canonicalisation(unittest.TestCase):

    def test_the_encoding_is_prefix_free(self):
        """('ab','c') and ('a','bc') must not collide -- the same discipline the
        Phase 4 serializer needed for exactly the same reason."""
        self.assertNotEqual(bp._hash([("ab", "c")]), bp._hash([("a", "bc")]))

    def test_key_order_does_not_matter(self):
        self.assertEqual(bp._hash([("a", "1"), ("b", "2")]),
                         bp._hash([("b", "2"), ("a", "1")]))

    def test_a_changed_value_changes_the_hash(self):
        self.assertNotEqual(bp._hash([("a", "1")]), bp._hash([("a", "2")]))


class InputIdentity(unittest.TestCase):

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)

    def test_the_same_bytes_under_a_different_root_fingerprint_identically(self):
        """The property every clean-room phase depends on. Inputs are keyed by
        LOGICAL NAME; an absolute path is not part of identity."""
        a = tempfile.mkdtemp(dir=self.tmp.name)
        b = tempfile.mkdtemp(dir=self.tmp.name)
        r1, w1 = sandbox(a)
        r2, w2 = sandbox(b)
        self.assertNotEqual(r1, r2)
        f1 = bp.input_fingerprint(bp.semantic_inputs(r1, w1))
        f2 = bp.input_fingerprint(bp.semantic_inputs(r2, w2))
        self.assertEqual(f1, f2)

    def test_one_changed_byte_in_one_input_changes_the_fingerprint(self):
        root, raw = sandbox(self.tmp.name)
        before = bp.input_fingerprint(bp.semantic_inputs(root, raw))
        p = bi.path("players", root=root, raw_dir=raw)
        with open(p, "ab") as fh:
            fh.write(b"X")
        after = bp.input_fingerprint(bp.semantic_inputs(root, raw))
        self.assertNotEqual(before, after)

    def test_every_declared_input_is_covered(self):
        """A new declared input must not be able to arrive unfingerprinted."""
        root, raw = sandbox(self.tmp.name)
        got = set(bp.semantic_inputs(root, raw))
        want = {n for n, s in bi.BUILD_INPUTS.items() if not getattr(s, "on_path", False)}
        self.assertEqual(got, want)

    def test_a_missing_required_input_is_refused(self):
        root, raw = sandbox(self.tmp.name)
        os.remove(bi.path("players", root=root, raw_dir=raw))
        with self.assertRaises(bp.ProvenanceError):
            bp.semantic_inputs(root, raw)

    def test_touching_a_file_does_not_change_the_fingerprint(self):
        """mtime is not provenance. If it were, every checkout would look like a
        different build."""
        root, raw = sandbox(self.tmp.name)
        before = bp.input_fingerprint(bp.semantic_inputs(root, raw))
        p = bi.path("players", root=root, raw_dir=raw)
        os.utime(p, (0, 0))
        self.assertEqual(bp.input_fingerprint(bp.semantic_inputs(root, raw)), before)


class BuildIdentity(unittest.TestCase):

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root, self.raw = sandbox(self.tmp.name)
        self.inputs = bp.semantic_inputs(self.root, self.raw)

    def fp(self, code="c0ffee", tools=None, specs=None):
        return bp.build_fingerprint(code, self.inputs,
                                    specs or bp.specifications(),
                                    tools or bp.semantic_tools())

    def test_a_semantic_tool_version_change_changes_the_build_fingerprint(self):
        self.assertNotEqual(self.fp(), self.fp(tools={"sqlite3": "0.0.0"}))

    def test_a_code_revision_change_changes_the_build_fingerprint(self):
        self.assertNotEqual(self.fp(), self.fp(code="deadbee"))

    def test_a_specification_change_changes_the_build_fingerprint(self):
        specs = dict(bp.specifications())
        specs["canonical_serializer"] = "something-else"
        self.assertNotEqual(self.fp(), self.fp(specs=specs))

    def test_python_is_not_a_semantic_tool(self):
        """Justified, not assumed: the only place an interpreter could reach a
        hash is float encoding, and the serializer packs IEEE-754 bytes rather
        than calling repr()."""
        self.assertNotIn("python", bp.semantic_tools())
        with open(os.path.join(HERE, "lib", "season_pins.py")) as fh:
            self.assertIn('struct.pack(">d", v)', fh.read())


class OutputIdentity(unittest.TestCase):

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)

    def test_content_changes_change_the_output_fingerprint(self):
        p, conn = db(self.tmp.name)
        before, _ = bp.output_fingerprint(conn)
        conn.execute("UPDATE team SET abbreviation='Z' WHERE franchise_id=1")
        self.assertNotEqual(bp.output_fingerprint(conn)[0], before)
        conn.close()

    def test_a_new_row_changes_the_output_fingerprint(self):
        p, conn = db(self.tmp.name)
        before, _ = bp.output_fingerprint(conn)
        conn.execute("INSERT INTO team VALUES (99, 'ZZ')")
        self.assertNotEqual(bp.output_fingerprint(conn)[0], before)
        conn.close()

    def test_insertion_order_does_not_change_the_output_fingerprint(self):
        """Logical identity, not physical. Two builds that insert the same rows
        in different orders are the same database."""
        p1, c1 = db(self.tmp.name, "a.db", rows=(("A", 1), ("B", 2)))
        p2, c2 = db(self.tmp.name, "b.db", rows=(("B", 2), ("A", 1)))
        self.assertEqual(bp.output_fingerprint(c1)[0], bp.output_fingerprint(c2)[0])
        c1.close()
        c2.close()

    def test_surrogate_columns_come_from_the_registry(self):
        self.assertEqual(bp.surrogate_columns("depth_chart"), ("depth_chart_id",))
        self.assertEqual(bp.surrogate_columns("roster_season"), ("roster_row_id",))

    def test_a_semantic_integer_primary_key_is_not_treated_as_a_surrogate(self):
        """team.franchise_id is an INTEGER PRIMARY KEY carrying the ESPN
        franchise id. A rule of 'exclude every INTEGER PRIMARY KEY' would have
        dropped real content out of output identity."""
        self.assertEqual(bp.surrogate_columns("team"), ())
        p, conn = db(self.tmp.name)
        self.assertIn("franchise_id", bp.output_projection(conn, "team"))
        conn.close()

    def test_an_undeclared_table_is_refused(self):
        """New-table silence guard. Whether a new table's keys participate in
        output identity must be decided, not defaulted."""
        p, conn = db(self.tmp.name)
        conn.execute("CREATE TABLE zzz_unknown (a)")
        with self.assertRaises(bp.ProvenanceError):
            bp.output_fingerprint(conn)
        conn.close()


class ManifestAndBinding(unittest.TestCase):
    """Phase 11 §28. The gate Phase 9 sits behind."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root, self.raw = sandbox(self.tmp.name)
        self.db_path, self.conn = db(self.tmp.name)
        self.addCleanup(self.conn.close)
        self.write()

    def write(self, **kw):
        return bp.write_manifest(self.conn, self.db_path, root=self.root,
                                 raw_dir=self.raw, require_clean=False, **kw)

    def bind(self):
        return bp.verify_db_input_binding(self.conn, self.db_path,
                                          root=self.root, raw_dir=self.raw)

    def test_a_matching_build_is_bound(self):
        status, detail = self.bind()
        self.assertEqual(status, bp.BOUND, detail)

    def test_a_missing_manifest_refuses(self):
        os.remove(bp.manifest_path(self.db_path))
        self.assertEqual(self.bind()[0], bp.MANIFEST_MISSING)

    def test_a_malformed_manifest_refuses(self):
        with open(bp.manifest_path(self.db_path), "w") as fh:
            fh.write("{not json")
        self.assertEqual(self.bind()[0], bp.MANIFEST_INVALID)

    def test_an_unsupported_schema_refuses(self):
        path = bp.manifest_path(self.db_path)
        doc = json.load(open(path))
        doc["schema"] = "nfldb-build-provenance-999"
        json.dump(doc, open(path, "w"))
        self.assertEqual(self.bind()[0], bp.MANIFEST_INVALID)

    def test_a_truncated_manifest_refuses(self):
        path = bp.manifest_path(self.db_path)
        doc = json.load(open(path))
        del doc["canonical"]["output_fingerprint"]
        json.dump(doc, open(path, "w"))
        self.assertEqual(self.bind()[0], bp.MANIFEST_INVALID)

    def test_one_changed_source_byte_after_the_build_is_an_input_mismatch(self):
        with open(bi.path("players", root=self.root, raw_dir=self.raw), "ab") as fh:
            fh.write(b"X")
        status, detail = self.bind()
        self.assertEqual(status, bp.INPUT_MISMATCH)
        self.assertEqual([d["input"] for d in detail["differing"]], ["players"])

    def test_a_sidecar_copied_beside_another_database_is_an_output_mismatch(self):
        """The case with no malformed bytes anywhere: a perfectly valid manifest
        certifying a database it never described."""
        other, oconn = db(self.tmp.name, "other.db", rows=(("Q", 7),))
        self.addCleanup(oconn.close)
        shutil.copy(bp.manifest_path(self.db_path), bp.manifest_path(other))
        status, detail = bp.verify_db_input_binding(oconn, other, root=self.root,
                                                    raw_dir=self.raw)
        self.assertEqual(status, bp.OUTPUT_MISMATCH, detail)

    def test_a_database_changed_after_the_manifest_is_an_output_mismatch(self):
        self.conn.execute("INSERT INTO team VALUES (55, 'XX')")
        self.assertEqual(self.bind()[0], bp.OUTPUT_MISMATCH)

    def test_an_input_missing_from_the_manifest_refuses(self):
        path = bp.manifest_path(self.db_path)
        doc = json.load(open(path))
        del doc["canonical"]["inputs"]["players"]
        json.dump(doc, open(path, "w"))
        status, detail = self.bind()
        self.assertEqual(status, bp.INPUT_MISMATCH)
        self.assertEqual([d["input"] for d in detail["differing"]], ["players"])

    def test_the_same_bytes_under_a_relocated_root_still_bind(self):
        moved = os.path.join(self.tmp.name, "moved")
        shutil.copytree(self.root, os.path.join(moved, "root"))
        shutil.copytree(self.raw, os.path.join(moved, "raw"))
        status, detail = bp.verify_db_input_binding(
            self.conn, self.db_path, root=os.path.join(moved, "root"),
            raw_dir=os.path.join(moved, "raw"))
        self.assertEqual(status, bp.BOUND, detail)

    def test_two_independent_manifests_of_the_same_build_are_identical(self):
        _, first = self.write()
        _, second = self.write()
        self.assertEqual(first["canonical"], second["canonical"])

    def test_diagnostics_are_not_part_of_the_canonical_body(self):
        _, doc = self.write()
        canon = json.dumps(doc["canonical"], sort_keys=True)
        for leaked in (sys.version.split()[0], self.tmp.name):
            self.assertNotIn(leaked, canon)

    def test_a_dirty_worktree_refuses_accepted_evidence(self):
        real = bp.code_revision
        bp.code_revision = lambda root=None: ("abc123", True)
        try:
            with self.assertRaises(bp.ProvenanceError):
                bp.build_manifest(self.conn, self.root, self.raw, require_clean=True)
        finally:
            bp.code_revision = real

    def test_an_input_that_changes_during_the_build_refuses(self):
        """TOCTOU. The build consumed something; by the end it was something
        else; no after-the-fact hash can say which one produced the rows."""
        pre = bp.semantic_inputs(self.root, self.raw)
        with open(bi.path("rosters", root=self.root, raw_dir=self.raw), "ab") as fh:
            fh.write(b"X")
        with self.assertRaises(bp.ProvenanceError) as ctx:
            bp.build_manifest(self.conn, self.root, self.raw,
                              require_clean=False, pre_inputs=pre)
        self.assertIn("rosters", str(ctx.exception))

    def test_an_unchanged_build_passes_the_mutation_check(self):
        """Specificity: the TOCTOU guard must not fire on a normal build."""
        pre = bp.semantic_inputs(self.root, self.raw)
        doc = bp.build_manifest(self.conn, self.root, self.raw,
                                require_clean=False, pre_inputs=pre)
        self.assertEqual(doc["canonical"]["input_fingerprint"],
                         bp.input_fingerprint(pre))


class AgainstTheAcceptedBuild(unittest.TestCase):
    """Only runs when a built database is supplied via NFLDB_TEST_DB."""

    def setUp(self):
        path = os.environ.get("NFLDB_TEST_DB", "")
        if not path or not os.path.exists(path):
            self.skipTest("set NFLDB_TEST_DB to a built nfl.db")
        self.conn = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
        self.addCleanup(self.conn.close)

    def test_every_table_in_the_real_database_is_classified(self):
        for t in bp.tables(self.conn):
            with self.subTest(table=t):
                bp.surrogate_columns(t)

    def test_the_output_fingerprint_is_stable_across_two_reads(self):
        first, _ = bp.output_fingerprint(self.conn)
        second, _ = bp.output_fingerprint(self.conn)
        self.assertEqual(first, second)


if __name__ == "__main__":
    unittest.main(verbosity=2)
