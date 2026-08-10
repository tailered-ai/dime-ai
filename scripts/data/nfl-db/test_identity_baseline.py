#!/usr/bin/env python3
"""Tests for the accepted derived-identity baseline -- Layer C (Phase 7).

    python3 scripts/data/nfl-db/test_identity_baseline.py

The contract this proves is a single sentence: current derivation PROPOSES an
identity, and the accepted baseline DECIDES whether that identity is already
trusted. Everything below is one of the ways that can go wrong.

The two defects that matter cannot be seen by a coverage percentage:

  * a previously known person DISAPPEARS -- fill rate barely moves;
  * a row is REASSIGNED to a different person -- fill rate does not move at all.

So the state machine is tested case by case, and no case is allowed to be
inferred from another.
"""
from __future__ import annotations

import json
import os
import sqlite3
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "lib"))

import build_inputs  # noqa: E402
import identity_baseline as ib  # noqa: E402
import season_pins as sp  # noqa: E402

DB = os.environ.get("NFLDB_TEST_DB", "")
ROC = "4431597"
ROC_GSIS = "00-0040531"


def read(path):
    with open(path) as fh:
        return fh.read()


def executable_body(path, start, end):
    """Source between two markers with comments AND docstrings removed.

    Text-scanning tests are only as good as their stripping. These modules
    deliberately quote the constructs they forbid in order to explain why -- so a
    scan that keeps docstrings reports the explanation as the violation.
    """
    src = read(path)
    body = src[src.index(start):src.index(end)]
    out, in_doc = [], False
    for line in body.splitlines():
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


def doc(mappings, schema=ib.SCHEMA_VERSION):
    return {"schema": schema, "mappings": mappings}


def entry(espn, gsis=None):
    return {"espn_id": espn, "state": ib.RESOLVED if gsis else ib.UNRESOLVED,
            "gsis_id": gsis}


def write(tmp, document):
    p = os.path.join(tmp, "accepted-identities.json")
    open(p, "w").write(json.dumps(document))
    return p


# --------------------------------------------------------------------------
# Sections 14-21 / 42 -- the state machine, case by case
# --------------------------------------------------------------------------
class StateMachine(unittest.TestCase):

    def test_case_a_resolved_to_same_passes(self):
        self.assertEqual(ib.classify_pair("00-1", "00-1"), ("A", ib.PASS))

    def test_case_b_resolved_to_unresolved_fails(self):
        """The T4-regression class. No fill-rate percentage may excuse it."""
        self.assertEqual(ib.classify_pair("00-1", None), ("B", ib.FAIL))

    def test_case_c_resolved_to_different_person_fails(self):
        """Wrong-person corruption. NOT merely review-required because the new
        value happens to be a syntactically valid gsis_id."""
        self.assertEqual(ib.classify_pair("00-1", "00-2"), ("C", ib.FAIL))

    def test_case_d_unresolved_to_unresolved_passes(self):
        self.assertEqual(ib.classify_pair(None, None), ("D", ib.PASS))

    def test_case_e_unresolved_to_resolved_is_review_required(self):
        """Not FAIL, not silent PASS, and never auto-accepted because coverage
        went up."""
        self.assertEqual(ib.classify_pair(None, "00-1"), ("E", ib.REVIEW_REQUIRED))

    def test_case_g_accepted_identity_absent_fails(self):
        self.assertEqual(ib.classify_pair("00-1", None, present=False),
                         ("G", ib.FAIL))

    def test_no_case_is_inferred_from_another(self):
        """Every case reaches a distinct (case, verdict) pair."""
        seen = {ib.classify_pair("00-1", "00-1"), ib.classify_pair("00-1", None),
                ib.classify_pair("00-1", "00-2"), ib.classify_pair(None, None),
                ib.classify_pair(None, "00-1"),
                ib.classify_pair("00-1", "00-1", present=False)}
        self.assertEqual(len(seen), 6)

    def test_case_f_new_derived_identity_is_review_required(self):
        v, f = ib.classify({}, {}, set(), derived_keys={"999"})
        self.assertEqual(v, ib.REVIEW_REQUIRED)
        self.assertEqual(f[0]["case"], "F")

    def test_case_h_mixed_current_state_fails(self):
        v, f = ib.classify({"1": "00-1"}, {"1": None}, {"1"},
                           mixed=[{"espn_id": "1", "gsis": ["00-1", "00-2"]}])
        self.assertEqual(v, ib.FAIL)
        self.assertIn("H", [x["case"] for x in f])

    def test_a_single_fail_dominates_many_reviews(self):
        v, _ = ib.classify({"1": "00-1", "2": None, "3": None},
                           {"1": None, "2": "00-2", "3": "00-3"},
                           {"1", "2", "3"})
        self.assertEqual(v, ib.FAIL)


# --------------------------------------------------------------------------
# Section 41 -- validator matrix I7-1 .. I7-10
# --------------------------------------------------------------------------
class ValidatorMatrix(unittest.TestCase):

    def test_i7_1_missing_baseline_fails(self):
        with self.assertRaises(ib.BaselineError):
            ib.load_baseline(path="/nonexistent/accepted-identities.json")

    def test_i7_2_malformed_json_fails(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = os.path.join(tmp, "accepted-identities.json")
            open(p, "w").write("{BROKEN")
            with self.assertRaises(ib.BaselineError):
                ib.load_baseline(path=p)

    def test_i7_3_wrong_schema_or_root_fails(self):
        with self.assertRaises(ib.BaselineError):
            ib.validate_document(doc([entry("1", "00-1")], schema="something-else"))
        with self.assertRaises(ib.BaselineError):
            ib.validate_document([entry("1", "00-1")])

    def test_i7_4_duplicate_espn_id_fails(self):
        with self.assertRaises(ib.BaselineError):
            ib.validate_document(doc([entry("1", "00-1"), entry("1", "00-2")]))

    def test_i7_5_malformed_resolved_state_fails(self):
        with self.assertRaises(ib.BaselineError):
            ib.validate_document(doc([{"espn_id": "1", "state": ib.RESOLVED,
                                       "gsis_id": None}]))

    def test_i7_6_malformed_unresolved_state_fails(self):
        """Contradictory: unresolved, yet carrying an identity."""
        with self.assertRaises(ib.BaselineError):
            ib.validate_document(doc([{"espn_id": "1", "state": ib.UNRESOLVED,
                                       "gsis_id": "00-1"}]))

    def test_i7_7_unknown_state_fails(self):
        with self.assertRaises(ib.BaselineError):
            ib.validate_document(doc([{"espn_id": "1", "state": "maybe",
                                       "gsis_id": "00-1"}]))

    def test_i7_8_two_sources_one_person_fails(self):
        with self.assertRaises(ib.BaselineError):
            ib.validate_document(doc([entry("1", "00-1"), entry("2", "00-1")]))

    def test_i7_9_cache_copy_cannot_substitute(self):
        """§12: the reviewed tracked artifact is the only acceptable source. A
        stray generated copy elsewhere must not satisfy the contract."""
        with tempfile.TemporaryDirectory() as tmp:
            os.makedirs(os.path.join(tmp, "scripts/data/nfl-db/cache"))
            open(os.path.join(tmp, "scripts/data/nfl-db/cache",
                              "accepted-identities.json"), "w").write(
                json.dumps(doc([entry("1", "00-1")])))
            with self.assertRaises(ib.BaselineError):
                ib.load_baseline(root=tmp)

    def test_i7_10_the_real_accepted_baseline_validates(self):
        accepted, document = ib.load_baseline()
        self.assertEqual(len(accepted), 204)
        self.assertEqual(sum(1 for v in accepted.values() if v), 171)
        self.assertEqual(sum(1 for v in accepted.values() if not v), 33)
        self.assertEqual(document["schema"], ib.SCHEMA_VERSION)

    def test_malformed_espn_id_fails(self):
        for bad in (None, 123, "", "abc", "12x"):
            with self.assertRaises(ib.BaselineError):
                ib.validate_document(doc([{"espn_id": bad, "state": ib.UNRESOLVED,
                                           "gsis_id": None}]))


# --------------------------------------------------------------------------
# Sections 2 / 22 / 24 / 26 -- the admitted population
# --------------------------------------------------------------------------
class AdmittedBaseline(unittest.TestCase):

    def setUp(self):
        self.accepted, self.doc = ib.load_baseline()

    def test_population(self):
        self.assertEqual(len(self.doc["mappings"]), 204)
        self.assertEqual(len({m["espn_id"] for m in self.doc["mappings"]}), 204)

    def test_resolved_identities_are_one_to_one(self):
        gs = [m["gsis_id"] for m in self.doc["mappings"] if m["gsis_id"]]
        self.assertEqual(len(gs), len(set(gs)), "two source keys name one person")

    def test_accepted_unresolved_has_exactly_one_authority(self):
        """§24/§49: the 33 must be DERIVED from the baseline, never a second
        hand-maintained list that can drift from it."""
        self.assertEqual(len(ib.accepted_unresolved(self.accepted)), 33)

    def test_roc_taylor_is_accepted_resolved(self):
        self.assertEqual(self.accepted[ROC], ROC_GSIS)

    def test_roc_taylor_acceptance_history_is_preserved(self):
        """§26: the baseline must not present every entry as though it had always
        held its current state. This one was admitted through review."""
        log = self.doc.get("_acceptance_log", [])
        roc = [e for e in log if e["espn_id"] == ROC]
        self.assertTrue(roc, "Roc Taylor's acceptance history was erased")
        self.assertEqual(roc[0]["from_state"], ib.UNRESOLVED)
        self.assertEqual(roc[0]["to_state"], ib.RESOLVED)
        self.assertEqual(roc[0]["gsis_id"], ROC_GSIS)

    def test_admission_provenance_is_recorded(self):
        """§4: it must be visible that this was ADMITTED from reviewed evidence,
        not generated from the build it polices."""
        p = self.doc["_provenance"]
        self.assertIs(p["auto_generated_from_current_output"], False)
        self.assertIn("Phase 0R", p["admitted_from"])

    def test_provenance_tier_is_evidence_only_not_identity_authority(self):
        """§6: gsis_source must not participate in identity acceptance."""
        src = open(os.path.join(HERE, "lib", "identity_baseline.py")).read()
        body = "\n".join(l for l in src.splitlines()
                         if not l.lstrip().startswith("#"))
        decision = body[body.index("def classify_pair"):body.index("def collisions")]
        for token in ("gsis_source", "tier", "feed"):
            self.assertNotIn(token, decision,
                             f"{token!r} reaches the identity decision")


# --------------------------------------------------------------------------
# Sections 8 / 10 / 53 -- the build-input contract
# --------------------------------------------------------------------------
class BuildInputContract(unittest.TestCase):

    def test_the_baseline_is_a_declared_required_repository_input(self):
        spec = build_inputs.BUILD_INPUTS["accepted_identities"]
        self.assertTrue(spec.required)
        self.assertEqual(spec.owner, "repository")
        self.assertFalse(spec.regenerable)
        self.assertEqual(spec.mutability, "reviewed")

    def test_declared_input_count_grew_deliberately(self):
        """13 -> 14. Not a regression: Layer C became a required control, so its
        reviewed evidence is now a build input."""
        self.assertEqual(len(build_inputs.BUILD_INPUTS), 14)

    def test_there_is_one_path_authority(self):
        self.assertEqual(ib.baseline_path(),
                         build_inputs.path("accepted_identities"))

    def test_no_module_hard_codes_a_second_path(self):
        for fname in ("lib/identity_baseline.py", "accept_identity.py",
                      "lib/observational_integrity.py", "build_db.py"):
            src = open(os.path.join(HERE, fname)).read()
            body = "\n".join(l for l in src.splitlines()
                             if not l.lstrip().startswith("#"))
            self.assertNotIn('"accepted-identities.json"', body, fname)


# --------------------------------------------------------------------------
# Sections 7 / 34 / 35 / 36 / 37 / 38 / 39 / 40 -- behaviour on real data
# --------------------------------------------------------------------------
class AgainstTheAcceptedBuild(unittest.TestCase):

    @unittest.skipUnless(DB and os.path.exists(DB), "needs NFLDB_TEST_DB")
    def setUp(self):
        self.conn = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
        self.accepted, _ = ib.load_baseline()

    def tearDown(self):
        if hasattr(self, "conn"):
            self.conn.close()

    @unittest.skipUnless(DB and os.path.exists(DB), "needs NFLDB_TEST_DB")
    def test_the_accepted_build_passes_layer_c(self):
        verdict, findings, stats = ib.check(self.conn)
        self.assertEqual(findings, [])
        self.assertEqual(verdict, ib.PASS)
        self.assertEqual((stats["accepted"], stats["resolved"], stats["unresolved"]),
                         (204, 171, 33))

    @unittest.skipUnless(DB and os.path.exists(DB), "needs NFLDB_TEST_DB")
    def test_scope_is_provenance_agnostic(self):
        """§7/§40: an accepted identity must not be able to leave governance by
        having its provenance relabelled. The observation scope therefore does
        NOT filter on gsis_source."""
        # Scan the EXECUTABLE region only. The docstring deliberately quotes the
        # old `gsis_source != 'feed'` filter to record why it was removed, so a
        # naive text search over the whole function reports the explanation as
        # the defect.
        code = executable_body(os.path.join(HERE, "lib", "identity_baseline.py"),
                               "def observe(", "CASE_WHY = {")
        self.assertNotIn("!= 'feed'", code)
        self.assertNotIn("IS NOT 'feed'", code)
        # The behavioural proof, which is the one that actually matters:
        current, present, derived, per_key, mixed = ib.observe(
            self.conn, set(self.accepted))
        self.assertEqual(len(present), 204, "an accepted identity fell out of scope")

    @unittest.skipUnless(DB and os.path.exists(DB), "needs NFLDB_TEST_DB")
    def test_shape_a_rows_do_not_forge_a_mixed_state(self):
        """Shape-A rows carry no espn_id. Grouping them together would put
        thousands of identities under one NULL key and report a false
        inconsistency."""
        _, _, _, _, mixed = ib.observe(self.conn, set(self.accepted))
        self.assertEqual(mixed, [])

    @unittest.skipUnless(DB and os.path.exists(DB), "needs NFLDB_TEST_DB")
    def test_live_season_identity_cannot_enter_the_frozen_baseline(self):
        """§39: 2026 growth must not manufacture Case F reviews."""
        where = sp.window("depth_chart").predicate
        live = sp.window("depth_chart").live_predicate
        n_live = self.conn.execute(
            f"SELECT COUNT(DISTINCT espn_id) FROM depth_chart WHERE {live} "
            f"AND espn_id IS NOT NULL AND espn_id NOT IN "
            f"(SELECT espn_id FROM depth_chart WHERE {where} AND espn_id IS NOT NULL)"
        ).fetchone()[0]
        self.assertGreater(n_live, 0, "no live-only identities to test with")
        _, _, derived, _, _ = ib.observe(self.conn, set(self.accepted))
        self.assertEqual(derived, set(),
                         "a live-only identity leaked into the frozen baseline scope")

    @unittest.skipUnless(DB and os.path.exists(DB), "needs NFLDB_TEST_DB")
    def test_no_collisions_in_the_current_population(self):
        current, _, _, _, _ = ib.observe(self.conn, set(self.accepted))
        self.assertEqual(ib.collisions(current), [])


# --------------------------------------------------------------------------
# Sections 35 / 36 / 37 -- negative controls against real accepted state
# --------------------------------------------------------------------------
class NegativeControls(unittest.TestCase):
    """Each mutates ACCEPTED state or CURRENT state and requires the right
    verdict. Coverage percentage is held constant where the point is that a
    percentage cannot see the defect."""

    def setUp(self):
        self.accepted, _ = ib.load_baseline()
        self.current = dict(self.accepted)       # a build that agrees exactly
        self.present = set(self.accepted)

    def verdict(self, **kw):
        return ib.classify(self.accepted, self.current, self.present, **kw)[0]

    def test_baseline_agreement_passes(self):
        self.assertEqual(self.verdict(), ib.PASS)

    def test_t4_regression_fails(self):
        """§36: the five T4 mappings disappear, affecting the known 316 rows. It
        must fail because SPECIFIC accepted identities vanished -- not because a
        percentage moved."""
        t4 = [m["espn_id"] for m in ib.load_baseline()[1]["mappings"]
              if m.get("evidence_tier_at_admission") == "T4"]
        self.assertTrue(t4, "no T4-admitted identities to regress")
        for e in t4:
            self.current[e] = None
        v, findings = ib.classify(self.accepted, self.current, self.present)
        self.assertEqual(v, ib.FAIL)
        self.assertEqual({f["case"] for f in findings}, {"B"})
        self.assertEqual(len([f for f in findings if f["case"] == "B"]), len(t4))

    def test_wrong_person_fails_at_identical_coverage(self):
        """§37: the defect the 85% gate can never detect. Row counts, key set and
        resolved coverage are all unchanged."""
        target = next(e for e, g in self.accepted.items() if g)
        before = sum(1 for v in self.current.values() if v)
        self.current[target] = "00-0099999"
        after = sum(1 for v in self.current.values() if v)
        self.assertEqual(before, after, "coverage must be identical")
        v, findings = ib.classify(self.accepted, self.current, self.present)
        self.assertEqual(v, ib.FAIL)
        self.assertEqual([f["case"] for f in findings], ["C"])

    def test_accepted_identity_disappearing_fails(self):
        target = next(iter(self.accepted))
        self.present.discard(target)
        v, findings = ib.classify(self.accepted, self.current, self.present)
        self.assertEqual(v, ib.FAIL)
        self.assertEqual([f["case"] for f in findings], ["G"])

    def test_new_frozen_source_identity_is_review_required(self):
        v, findings = ib.classify(self.accepted, self.current, self.present,
                                  derived_keys={"9999999"})
        self.assertEqual(v, ib.REVIEW_REQUIRED)
        self.assertEqual([f["case"] for f in findings], ["F"])

    def test_benign_provenance_relabel_does_not_touch_identity(self):
        """§34: the real 881 + 163 relabels. Identity PASSes; provenance is
        Phase 6's business."""
        self.assertEqual(self.verdict(), ib.PASS)


# --------------------------------------------------------------------------
# Section 35 -- the Roc Taylor closed loop
# --------------------------------------------------------------------------
class RocTaylorClosedLoop(unittest.TestCase):

    def test_pre_acceptance_is_review_required_then_passes_after_admission(self):
        accepted, document = ib.load_baseline()
        pre = dict(accepted)
        pre[ROC] = None                      # the state BEFORE Phase 0R admitted it
        current = dict(accepted)             # the build derives the person
        v, findings = ib.classify(pre, current, set(pre))
        self.assertEqual(v, ib.REVIEW_REQUIRED)
        self.assertEqual([f["case"] for f in findings], ["E"])
        self.assertEqual(findings[0]["observed"], ROC_GSIS)
        # ... and after the accepted delta is applied, the same build passes
        v2, findings2 = ib.classify(accepted, current, set(accepted))
        self.assertEqual((v2, findings2), (ib.PASS, []))


# --------------------------------------------------------------------------
# Sections 13 / 33 / 50 -- one authority
# --------------------------------------------------------------------------
class OneAuthority(unittest.TestCase):

    def test_phase6_delegates_the_identity_decision(self):
        """§33: Phase 6 may report provenance; it may not decide identity."""
        src = open(os.path.join(HERE, "lib", "observational_integrity.py")).read()
        self.assertIn("identity_baseline.classify_pair", src)
        body = src[src.index("def observe_provenance"):]
        code = "\n".join(l for l in body.splitlines()
                         if not l.lstrip().startswith("#"))
        self.assertNotIn("old_id is None and new_id is not None", code,
                         "Phase 6 still implements its own identity ladder")

    def test_phase6_and_layer_c_agree_on_every_case(self):
        import observational_integrity as oi
        cases = [(None, "00-1", "improved"), ("00-1", None, "regressed"),
                 ("00-1", "00-2", "changed"), ("00-1", "00-1", "benign")]
        for old, new, kind in cases:
            p = oi.observe_provenance([("T1",)], [("T0",)],
                                      baseline_identity=[old], current_identity=[new])
            got = ("improved" if p.identity_improved else
                   "regressed" if p.identity_regressed else
                   "changed" if p.identity_changed else "benign")
            self.assertEqual(got, kind, f"{old} -> {new}")

    def test_accepted_unresolved_is_derived_not_a_second_list(self):
        src = open(os.path.join(HERE, "lib", "identity_baseline.py")).read()
        self.assertIn("def accepted_unresolved", src)
        self.assertNotIn("UNRESOLVED_ESPN_IDS = ", src)


# --------------------------------------------------------------------------
# Sections 28 / 29 / 30 / 31 -- acceptance tooling
# --------------------------------------------------------------------------
class AcceptanceWorkflow(unittest.TestCase):

    def setUp(self):
        import importlib.util
        spec = importlib.util.spec_from_file_location(
            "accept_identity", os.path.join(HERE, "accept_identity.py"))
        self.cli = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.cli)

    def test_no_bulk_or_auto_accept_flag_exists(self):
        src = open(os.path.join(HERE, "accept_identity.py")).read()
        declared = [l for l in src.splitlines() if "add_argument(" in l]
        for l in declared:
            for bad in ("accept-all", "accept_all", "--all", "--bulk"):
                self.assertNotIn(bad, l)
        self.assertTrue(any("--reason" in l for l in declared))

    def test_no_build_path_rewrites_accepted_identity(self):
        """§27: an ordinary build must never write the baseline."""
        build = open(os.path.join(HERE, "build_db.py")).read()
        self.assertIn("identity_baseline", build)          # it READS it
        for writer in ("dump_document", "accepted-identities.json\", \"w\"",
                       "write_baseline"):
            self.assertNotIn(writer, build)

    def test_case_c_is_refused_by_the_generic_command(self):
        """§29: a wrong-person reassignment may not be laundered as a new
        resolution. Verified against the command's own refusal logic."""
        src = open(os.path.join(HERE, "accept_identity.py")).read()
        self.assertIn('if f["case"] == "C"', src)
        self.assertIn("REFUSED", src)
        self.assertIn('f["case"] != "E"', src)

    def test_blocking_integrity_is_a_prerequisite(self):
        conn = sqlite3.connect(":memory:")
        for t in sp.all_frozen_tables():
            conn.execute(f"CREATE TABLE {t} ({', '.join(sp.FIELD_CLASSES[t])})")
        try:
            ok, _ = self.cli.blocking_integrity(conn)
            self.assertFalse(ok)
        finally:
            conn.close()

    def sandbox_root(self, tmp):
        """A repository root holding a COPY of the accepted baseline.

        Every test that drives the WRITE path must resolve against this, never
        the tracked artifact. The Phase 7 mutation matrix proved why: with the
        refusal branches mutated away, these tests ran the acceptance command
        for real and wrote `4361444: None -> 00-0099999` into the reviewed
        evidence, with the reason "test". The tests correctly went red -- and
        corrupted the very file the phase exists to protect while doing it.
        A test for a refusal must not depend on the refusal working.
        """
        root = os.path.join(tmp, "root")
        os.makedirs(os.path.join(root, "scripts/data/nfl-db"))
        dst = os.path.join(root, "scripts/data/nfl-db/accepted-identities.json")
        open(dst, "w").write(read(ib.baseline_path()))
        return root, dst

    def pending_case_e_database(self, tmp):
        """A database where one accepted-unresolved identity is now resolved --
        a genuine Case E -- but whose blocking digests do NOT reproduce.

        Built deliberately: testing the refusal through the predicate alone
        leaves the branch in main() undefended, which is exactly the gap Phase
        6's mutation matrix exposed."""
        accepted, _ = ib.load_baseline()
        target = sorted(e for e, g in accepted.items() if not g)[0]
        db = os.path.join(tmp, "pending.db")
        c = sqlite3.connect(db)
        # all_frozen_tables(), not governed_tables(): Phase 8 retired depth_chart's
        # monolithic digest, so it is no longer an ACTIVE blocking gate -- but this
        # fixture still needs the table, because Layer C reads depth_chart rows.
        for t in sp.all_frozen_tables():
            c.execute(f"CREATE TABLE {t} ({', '.join(sp.FIELD_CLASSES[t])})")
        cols = list(sp.FIELD_CLASSES["depth_chart"])
        for e, g in list(accepted.items()):
            row = {k: None for k in cols}
            row.update({"source_shape": "B",
                        "snapshot_ts": "2026-01-01T00:00:00Z",
                        "source_ordinal": 1, "season": 2025,
                        "espn_id": e, "gsis_source": "T3",
                        "gsis_id": g if g else (
                            "00-0099999" if e == target else None)})
            c.execute(f"INSERT INTO depth_chart ({','.join(cols)}) "
                      f"VALUES ({','.join('?' * len(cols))})",
                      [row[k] for k in cols])
        c.commit()
        c.close()
        return db, target

    def drive(self, espn, db, root):
        argv = sys.argv
        try:
            sys.argv = ["accept_identity.py", espn, "--reason", "test",
                        "--root", root, db]
            return self.cli.main()
        finally:
            sys.argv = argv

    def test_acceptance_refuses_through_main_when_blocking_integrity_fails(self):
        """§30 end to end. A refusal that still writes the file is no refusal."""
        with tempfile.TemporaryDirectory() as tmp:
            db, target = self.pending_case_e_database(tmp)
            root, sandbox = self.sandbox_root(tmp)
            tracked_before = read(ib.baseline_path())
            before = read(sandbox)
            rc = self.drive(target, db, root)
            self.assertEqual(rc, 4, "accepted an identity on a broken build")
            self.assertEqual(read(sandbox), before,
                             "refused, yet the baseline was modified")
            self.assertEqual(read(ib.baseline_path()), tracked_before,
                             "the test reached the TRACKED artifact")

    def test_acceptance_refuses_case_c_through_main(self):
        """§29: the wrong-person path must not be reachable by this command."""
        with tempfile.TemporaryDirectory() as tmp:
            db, _ = self.pending_case_e_database(tmp)
            root, sandbox = self.sandbox_root(tmp)
            accepted, _ = ib.load_baseline()
            victim = sorted(e for e, g in accepted.items() if g)[0]
            tracked_before = read(ib.baseline_path())
            before = read(sandbox)
            rc = self.drive(victim, db, root)
            self.assertEqual(rc, 4)
            self.assertEqual(read(sandbox), before)
            self.assertEqual(read(ib.baseline_path()), tracked_before,
                             "the test reached the TRACKED artifact")

    def test_no_test_can_write_the_tracked_artifact(self):
        """The guard the mutation matrix taught me to write. Every acceptance
        test must redirect the write path; a bare drive against the real root is
        a latent corruption of reviewed evidence."""
        src = read(os.path.join(HERE, "test_identity_baseline.py"))
        body = src[src.index("class AcceptanceWorkflow"):]
        # Scan STATEMENTS, not lines: the argv list wraps, so a line-based check
        # misses the flag on the continuation and fails for the wrong reason.
        statements, current = [], ""
        for line in body.splitlines():
            current += " " + line.strip()
            if current.count("[") == current.count("]"):
                statements.append(current)
                current = ""
        # Match the ASSIGNMENT, not the substrings: this test's own predicate
        # mentions both "sys.argv" and "accept_identity.py" as literals, so a
        # substring match makes the guard flag itself.
        drives = [s for s in statements
                  if "sys.argv = [" in s and "accept_identity.py" in s]
        self.assertTrue(drives, "no acceptance-command drive found to check")
        for s in drives:
            self.assertIn("--root", s,
                          "an acceptance test drives main() without --root, so a "
                          "regressed refusal would write the tracked artifact")


if __name__ == "__main__":
    unittest.main(verbosity=2)
