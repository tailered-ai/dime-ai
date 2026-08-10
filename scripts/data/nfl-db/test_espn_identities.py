#!/usr/bin/env python3
"""Tests for the authoritative T4 loader/validator (lib/espn_identities.py).

    python3 scripts/data/nfl-db/test_espn_identities.py

Structural failures, relational failures, and -- equally important -- specificity:
a validator that rejects everything is not correct. Two matrix rows from the phase
spec are recorded N/A with a reason rather than faked: T4 records carry NO gsis_id
(verified against the tracked artifact), so "missing/malformed gsis_id" cannot be
tested without inventing schema.
"""
from __future__ import annotations

import copy
import json
import os
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "lib"))

import build_inputs as bi          # noqa: E402
import espn_identities as t4       # noqa: E402

REAL = os.path.join(HERE, "espn-identities.json")
with open(REAL) as _fh:
    REAL_RECORDS = json.load(_fh)


def write(records, name="espn-identities.json", raw=False):
    """raw=True writes the bytes verbatim (to test malformed JSON); otherwise the
    value is JSON-encoded, so a str payload becomes a JSON *string* root."""
    d = tempfile.mkdtemp()
    p = os.path.join(d, name)
    with open(p, "w") as fh:
        fh.write(records) if raw else json.dump(records, fh)
    return p


def rec(**over):
    r = copy.deepcopy(REAL_RECORDS[0])
    r.update(over)
    return r


# ============================ STRUCTURAL =====================================

class T2_Structural(unittest.TestCase):
    def test_T2_1_missing_file(self):
        with self.assertRaises(t4.T4InputError) as c:
            t4.load(path=os.path.join(tempfile.mkdtemp(), "absent.json"))
        self.assertIn("tracked file missing", str(c.exception))

    def test_T2_2_cache_cannot_satisfy_missing_tracked(self):
        root = tempfile.mkdtemp()
        legacy = os.path.join(root, "scripts/data/nfl-db/cache/b3/espn_identities.json")
        os.makedirs(os.path.dirname(legacy), exist_ok=True)
        with open(legacy, "w") as fh:
            json.dump(REAL_RECORDS, fh)
        # tracked absent, cache present -> must still fail
        with self.assertRaises(t4.T4InputError) as c:
            t4.load(root=root)
        msg = str(c.exception)
        self.assertIn("tracked file missing", msg)
        self.assertNotIn("/cache/", bi.path("espn_identities", root=root))

    def test_T2_3_malformed_json(self):
        with self.assertRaises(t4.T4InputError) as c:
            t4.load(path=write("{not json", raw=True))
        self.assertIn("malformed JSON", str(c.exception))

    def test_T2_4_wrong_root_type(self):
        for bad in ({}, "string", 123, None):
            with self.assertRaises(t4.T4InputError) as c:
                t4.load(path=write(bad))
            self.assertIn("wrong root type", str(c.exception))

    def test_T2_5_malformed_record_type(self):
        with self.assertRaises(t4.T4InputError) as c:
            t4.load(path=write([rec(), "not-an-object"]), )
        self.assertIn("malformed record", str(c.exception))

    def test_T2_6_missing_espn_id(self):
        r = rec()
        del r["espn_id"]
        with self.assertRaises(t4.T4InputError) as c:
            t4.load(path=write([r]), require_audited=False)
        self.assertIn("missing required field 'espn_id'", str(c.exception))

    def test_T2_7_malformed_espn_id(self):
        for bad in ("", "   ", "abc", "12345", "012345", "12345678", "4362191 "):
            with self.assertRaises(t4.T4InputError, msg=bad) as c:
                t4.load(path=write([rec(espn_id=bad)]), require_audited=False)
            self.assertIn("espn_id", str(c.exception))

    def test_T2_7b_numeric_espn_id_is_refused_not_coerced(self):
        with self.assertRaises(t4.T4InputError) as c:
            t4.load(path=write([rec(espn_id=4362191)]), require_audited=False)
        self.assertIn("not a string", str(c.exception))

    def test_T2_8_missing_or_empty_match_evidence(self):
        # T4 has no gsis_id; the mandatory identity evidence is espn_full.
        r = rec()
        del r["espn_full"]
        with self.assertRaises(t4.T4InputError) as c:
            t4.load(path=write([r]), require_audited=False)
        self.assertIn("espn_full", str(c.exception))
        for bad in ("", "   "):
            with self.assertRaises(t4.T4InputError):
                t4.load(path=write([rec(espn_full=bad)]), require_audited=False)

    def test_T2_9_gsis_validation_is_not_applicable(self):
        # Recorded, not faked: no record in the tracked artifact carries a gsis_id.
        self.assertTrue(all("gsis_id" not in r for r in REAL_RECORDS))

    def test_missing_college_key_is_rejected_but_null_value_is_allowed(self):
        r = rec()
        del r["college"]
        with self.assertRaises(t4.T4InputError):
            t4.load(path=write([r]), require_audited=False)
        v = t4.load(path=write([rec(college=None)]), require_audited=False)
        self.assertEqual(len(v.evidence_only), 1)

    def test_empty_document_is_rejected(self):
        with self.assertRaises(t4.T4InputError) as c:
            t4.load(path=write([]), require_audited=False)
        self.assertIn("no usable identity records", str(c.exception))


# ============================ RELATIONAL =====================================

class T2_Relational(unittest.TestCase):
    def test_T2_10_duplicate_espn_id_identical_mapping_still_fails(self):
        r = rec()
        with self.assertRaises(t4.T4InputError) as c:
            t4.load(path=write([r, copy.deepcopy(r)]), require_audited=False)
        self.assertIn("duplicate espn_id", str(c.exception))

    def test_T2_11_duplicate_espn_id_conflicting_evidence_fails(self):
        a = rec()
        b = rec(espn_full="Someone Else", college="Elsewhere")
        with self.assertRaises(t4.T4InputError) as c:
            t4.load(path=write([a, b]), require_audited=False)
        self.assertIn("duplicate espn_id", str(c.exception))

    def test_T2_12_two_espn_ids_sharing_evidence_is_allowed_here(self):
        # Recorded honestly: T4 asserts no gsis mapping, so espn->gsis collision
        # rules do not belong to this input. They are enforced downstream on the
        # crosswalk OUTPUT (identity_baseline.collisions), where the mapping exists.
        a = rec(espn_id="1111111")
        b = rec(espn_id="2222222")
        v = t4.load(path=write([a, b]), require_audited=False)
        self.assertEqual(len(v), 2)

    def test_T2_13_semantic_truncation_fails_even_though_json_is_valid(self):
        short = [r for r in REAL_RECORDS if r["espn_id"] != "3043133"]
        self.assertEqual(len(short), len(REAL_RECORDS) - 1)
        with self.assertRaises(t4.T4InputError) as c:
            t4.load(path=write(short))
        self.assertIn("audited T4 evidence altered", str(c.exception))
        self.assertIn("3043133", str(c.exception))

    def test_T2_14_substitution_with_unchanged_count_fails(self):
        swapped = copy.deepcopy(REAL_RECORDS)
        for r in swapped:
            if r["espn_id"] == "3043133":
                r["espn_full"] = "Somebody Different"
        self.assertEqual(len(swapped), len(REAL_RECORDS))     # cardinality preserved
        with self.assertRaises(t4.T4InputError) as c:
            t4.load(path=write(swapped))
        self.assertIn("audited T4 evidence altered", str(c.exception))

    def test_T2_14b_college_substitution_also_fails(self):
        swapped = copy.deepcopy(REAL_RECORDS)
        for r in swapped:
            if r["espn_id"] == "4362191":
                r["college"] = "Somewhere Else"
        with self.assertRaises(t4.T4InputError):
            t4.load(path=write(swapped))


# ============================ SPECIFICITY ====================================

class P2_Specificity(unittest.TestCase):
    def test_P2_1_the_real_tracked_file_passes(self):
        v = t4.load()
        self.assertEqual(len(v), 39)
        self.assertEqual(len(v.t4_capable), 38)
        self.assertEqual(len(v.evidence_only), 1)

    def test_P2_2_record_order_is_semantically_irrelevant(self):
        a = t4.load(path=write(REAL_RECORDS))
        b = t4.load(path=write(list(reversed(REAL_RECORDS))))
        self.assertEqual(a.as_crosswalk_map(), b.as_crosswalk_map())
        self.assertEqual(sorted(a.t4_capable), sorted(b.t4_capable))

    def test_P2_4_stray_cache_does_not_change_the_canonical_result(self):
        v = t4.load()
        legacy = os.path.join(bi.NFLDB, "cache/b3/espn_identities.json")
        self.assertEqual(v.path, bi.path("espn_identities"))
        self.assertNotIn("/cache/", v.path)
        if os.path.exists(legacy):
            self.assertNotEqual(v.path, legacy)

    def test_P2_5_an_espn_id_absent_from_t4_is_not_an_error(self):
        # A mandatory T4 file does not mean every ESPN id must appear in it.
        v = t4.load()
        self.assertNotIn("9999999", v.by_espn_id)
        self.assertIsNone(v.as_crosswalk_map().get("9999999"))

    def test_additional_records_are_permitted(self):
        extra = REAL_RECORDS + [rec(espn_id="1234567", espn_full="New Person",
                                    college="Somewhere")]
        v = t4.load(path=write(extra))
        self.assertEqual(len(v), 40)


# ============================ AUTHORITY ======================================

class T2_PreflightOrdering(unittest.TestCase):
    """Section 18: malformed T4 is knowable at startup, so preflight -- not a
    surprise minutes into construction -- must reject it. Without this test,
    deleting the validator call from preflight_raw() is invisible."""

    @staticmethod
    def _fixture(t4_bytes):
        root = tempfile.mkdtemp()
        for name, spec in bi.BUILD_INPUTS.items():
            if spec.on_path:
                continue
            p = os.path.join(root, spec.relpath)
            os.makedirs(os.path.dirname(p), exist_ok=True)
            with open(p, "w") as fh:
                fh.write("[]" if p.endswith(".json") else "x\n")
        with open(os.path.join(root, "scripts/data/nfl-db/espn-identities.json"), "w") as fh:
            fh.write(t4_bytes)
        # Phase 7 made the accepted identity baseline a required input, and
        # preflight validates its STRUCTURE. A stub "[]" is structurally invalid,
        # so it would abort preflight before T4 ordering is reached and these
        # tests would pass or fail for the wrong reason. Write a minimal VALID
        # document instead: the subject here is T4, not Layer C.
        with open(os.path.join(root,
                               "scripts/data/nfl-db/accepted-identities.json"), "w") as fh:
            json.dump({"schema": "nfldb-accepted-identities-1",
                       "mappings": [{"espn_id": "1234567", "state": "unresolved",
                                     "gsis_id": None}]}, fh)
        return root

    @staticmethod
    def _build_db():
        import importlib.util
        spec = importlib.util.spec_from_file_location(
            "build_db_under_test", os.path.join(HERE, "build_db.py"))
        m = importlib.util.module_from_spec(spec)
        sys.modules["build_db_under_test"] = m
        spec.loader.exec_module(m)
        return m

    def test_preflight_rejects_malformed_t4_before_construction(self):
        bd = self._build_db()
        root = self._fixture("{BROKEN")
        bd.ROOT, bd.RAW = root, os.path.join(root, "scripts/data/nfl-db/raw")
        with self.assertRaises(t4.T4InputError) as c:
            bd.preflight_raw()
        self.assertIn("malformed JSON", str(c.exception))

    def test_preflight_rejects_semantically_truncated_t4(self):
        bd = self._build_db()
        short = [r for r in REAL_RECORDS if r["espn_id"] != "3043133"]
        root = self._fixture(json.dumps(short))
        bd.ROOT, bd.RAW = root, os.path.join(root, "scripts/data/nfl-db/raw")
        with self.assertRaises(t4.T4InputError) as c:
            bd.preflight_raw()
        self.assertIn("audited T4 evidence altered", str(c.exception))

    def test_preflight_accepts_valid_t4(self):
        bd = self._build_db()
        root = self._fixture(json.dumps(REAL_RECORDS))
        bd.ROOT, bd.RAW = root, os.path.join(root, "scripts/data/nfl-db/raw")
        # T4 is valid, so preflight proceeds past it; it then legitimately fails on
        # the raw row FLOORS (the fixture CSVs are stubs). Reaching SystemExit means
        # T4 validation passed rather than short-circuiting.
        with self.assertRaises(SystemExit):
            bd.preflight_raw()


class T2_OneAuthority(unittest.TestCase):
    def test_no_governed_consumer_parses_t4_independently(self):
        """Section 27: falsifiable evidence that a second parser cannot creep back."""
        governed = [os.path.join(HERE, "build_db.py"),
                    os.path.join(HERE, "lib", "depth_charts.py")]
        offenders = []
        for f in governed:
            src = open(f).read()
            for pat in ('json.load(open(identities',
                        '{r["espn_id"]:', "{r['espn_id']:",
                        'json.loads(open('):
                if pat in src:
                    offenders.append((os.path.basename(f), pat))
        self.assertEqual(offenders, [], f"independent T4 parsing reintroduced: {offenders}")

    def test_loader_resolves_through_the_build_input_contract(self):
        self.assertEqual(t4.load().path, bi.path("espn_identities"))

    def test_single_canonical_representation(self):
        a = t4.load().as_crosswalk_map()
        b = t4.load().as_crosswalk_map()
        self.assertEqual(a, b)
        self.assertTrue(all(set(x) == {"fullName", "college"} for x in a.values()))


if __name__ == "__main__":
    unittest.main(verbosity=2)
