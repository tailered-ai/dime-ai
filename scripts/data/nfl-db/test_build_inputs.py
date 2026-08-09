#!/usr/bin/env python3
"""Tests for the canonical build-input contract (lib/build_inputs.py).

    python3 scripts/data/nfl-db/test_build_inputs.py

The contract exists because a mandatory build input lived in a gitignored cache/
directory and the loader skipped it silently -- no clone had it, and 316 audited
identities vanished with every gate green. These tests pin the properties that
make that class of failure impossible, including the decisive one: untracked
developer residue must NEVER satisfy a missing tracked input.
"""
from __future__ import annotations

import json
import os
import shutil
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "lib"))

import build_inputs as bi  # noqa: E402

#: The executing-path inventory, captured by a CPython audit hook over a real
#: build (every non-.py file opened). This is the ground truth the contract must
#: cover -- not a list of files someone expected to matter.
TRACED = {
    "scripts/data/nfl-db/raw/players.csv",
    "scripts/data/nfl-db/raw/rosters.csv",
    "scripts/data/nfl-db/raw/snap_counts.csv",
    "scripts/data/nfl-db/raw/player_stats.csv",
    "scripts/data/nfl-db/raw/depth_charts.csv",
    "scripts/data/nfl-db/schema.sql",
    "scripts/data/nfl-db/espn-identities.json",
    "scripts/data/nfl-2026/teams.json",
    "scripts/data/nfl-2026/games.json",
    "scripts/data/nfl-2026/venues.json",
    "scripts/data/nfl-lines-2010-2025/games.json",
    "scripts/data/nfl-unified-2010-2026/games.json",
}


def _fake_tree(include=None, exclude=(), legacy_cache=False):
    """A throwaway repo-shaped tree containing the declared inputs."""
    root = tempfile.mkdtemp()
    names = include if include is not None else list(bi.BUILD_INPUTS)
    for name in names:
        if name in exclude:
            continue
        p = os.path.join(root, bi.BUILD_INPUTS[name].relpath)
        os.makedirs(os.path.dirname(p), exist_ok=True)
        with open(p, "w") as fh:
            fh.write("[]" if p.endswith(".json") else "x\n")
    if legacy_cache:
        p = os.path.join(root, "scripts/data/nfl-db/cache/b3/espn_identities.json")
        os.makedirs(os.path.dirname(p), exist_ok=True)
        with open(p, "w") as fh:
            json.dump([{"espn_id": "9999999", "espn_full": "Residue"}], fh)
    return root


class I1_Completeness(unittest.TestCase):
    def test_every_traced_input_is_declared(self):
        declared = {s.relpath for s in bi.BUILD_INPUTS.values()}
        undeclared = TRACED - declared
        self.assertEqual(undeclared, set(),
                         f"inputs the build opens but the contract does not declare: {undeclared}")

    def test_contract_declares_nothing_phantom(self):
        # File inputs must correspond to something the executing build opens.
        # PATH-resolved tools are exempt: the trace ran --no-external, so PASS 3
        # never executed and Rscript could not appear in it. That gap is exactly
        # how the toolchain dependency was found.
        declared = {s.relpath for s in bi.BUILD_INPUTS.values() if not s.on_path}
        self.assertEqual(declared - TRACED, set(),
                         "contract declares a file input the executing build never opens")

    def test_declared_counts(self):
        files = [s for s in bi.BUILD_INPUTS.values() if not s.on_path]
        tools = [s for s in bi.BUILD_INPUTS.values() if s.on_path]
        self.assertEqual(len(files), 12)
        self.assertEqual(len(tools), 1)
        self.assertEqual(len(bi.BUILD_INPUTS), 13)


class I2_T4Classification(unittest.TestCase):
    def test_t4_is_required_repository_owned_and_not_regenerable(self):
        s = bi.BUILD_INPUTS["espn_identities"]
        self.assertTrue(s.required)
        self.assertEqual(s.owner, "repository")
        self.assertEqual(s.category, bi.REPO_SEMANTIC)
        self.assertFalse(s.regenerable)

    def test_t4_is_not_classified_as_a_cache_or_diagnostic(self):
        s = bi.BUILD_INPUTS["espn_identities"]
        self.assertNotIn(s.category, (bi.GENERATED, bi.DIAGNOSTIC))

    def test_t4_path_is_outside_the_gitignored_cache_directory(self):
        self.assertNotIn("/cache/", "/" + bi.BUILD_INPUTS["espn_identities"].relpath)

    def test_t4_remediation_forbids_substituting_the_cache_copy(self):
        r = bi.BUILD_INPUTS["espn_identities"].remediation.lower()
        self.assertIn("cache", r)
        self.assertIn("not", r)


class I3_MissingUpstream(unittest.TestCase):
    def test_missing_upstream_csv_fails_preflight(self):
        root = _fake_tree(exclude=("snap_counts",))
        ok, fails = bi.preflight(root=root)
        self.assertFalse(ok)
        self.assertEqual([s.name for s, _ in fails], ["snap_counts"])

    def test_failure_message_is_actionable(self):
        root = _fake_tree(exclude=("snap_counts",))
        _, fails = bi.preflight(root=root)
        msg = bi.format_failure(*fails[0])
        for field in ("input", "path", "classification", "owner",
                      "regenerable", "acquisition", "why required", "remediation"):
            self.assertIn(field, msg)
        self.assertIn("fetch_raw.py", msg)


class I4_MissingT4(unittest.TestCase):
    def test_missing_tracked_t4_fails_preflight(self):
        root = _fake_tree(exclude=("espn_identities",))
        ok, fails = bi.preflight(root=root)
        self.assertFalse(ok)
        self.assertIn("espn_identities", [s.name for s, _ in fails])

    def test_t4_failure_says_the_checkout_is_incomplete_not_that_t4_is_optional(self):
        root = _fake_tree(exclude=("espn_identities",))
        _, fails = bi.preflight(root=root)
        msg = bi.format_failure(*[f for f in fails if f[0].name == "espn_identities"][0])
        self.assertIn("incomplete", msg.lower())


class I5_CacheResidueCannotSatisfy(unittest.TestCase):
    """THE decisive control. The original defect was a gitignored file standing in
    for a tracked one. If residue can satisfy the contract, the bug is back."""

    def test_legacy_cache_does_not_satisfy_a_missing_tracked_t4(self):
        root = _fake_tree(exclude=("espn_identities",), legacy_cache=True)
        legacy = os.path.join(root, "scripts/data/nfl-db/cache/b3/espn_identities.json")
        self.assertTrue(os.path.exists(legacy), "fixture must contain the residue")
        ok, fails = bi.preflight(root=root)
        self.assertFalse(ok, "cache residue must NOT satisfy the contract")
        self.assertIn("espn_identities", [s.name for s, _ in fails])

    def test_resolved_path_never_points_into_cache(self):
        root = _fake_tree(exclude=("espn_identities",), legacy_cache=True)
        self.assertNotIn("/cache/", bi.path("espn_identities", root=root))


class I6_TrackedWinsDeterministically(unittest.TestCase):
    def test_cache_residue_cannot_override_the_tracked_input(self):
        root = _fake_tree(legacy_cache=True)          # both present
        p = bi.path("espn_identities", root=root)
        self.assertTrue(p.endswith("scripts/data/nfl-db/espn-identities.json"))
        self.assertNotIn("/cache/", p)
        ok, _ = bi.preflight(root=root)
        self.assertTrue(ok)

    def test_two_clones_differing_only_in_cache_resolve_identically(self):
        a = bi.path("espn_identities", root=_fake_tree(legacy_cache=True))
        b = bi.path("espn_identities", root=_fake_tree(legacy_cache=False))
        self.assertEqual(os.path.relpath(a, a.split("/scripts/")[0]),
                         os.path.relpath(b, b.split("/scripts/")[0]))


class I7_LegitimateEnvironmentPasses(unittest.TestCase):
    """Specificity: the contract must not fail merely because cache state differs."""

    def test_all_declared_inputs_present_passes(self):
        ok, fails = bi.preflight(root=_fake_tree())
        self.assertTrue(ok, f"unexpected failures: {[s.name for s, _ in fails]}")

    def test_tracked_present_and_no_cache_passes(self):
        ok, _ = bi.preflight(root=_fake_tree(legacy_cache=False))
        self.assertTrue(ok)


class I8_Classification(unittest.TestCase):
    def test_optional_inputs_prove_absence_cannot_change_content(self):
        # Section 5-D: anything optional must be justified. The R toolchain is the
        # only optional entry; PASS 3 runs after construction, reads the
        # connection only, and writes nothing to the database -- and its absence
        # is fail-closed (a recorded check failure), never a silent skip.
        for n, s in bi.BUILD_INPUTS.items():
            if not s.required:
                self.assertIn(s.category, (bi.DIAGNOSTIC, bi.EXTERNAL_TOOL), n)
                self.assertTrue(s.why.strip() and s.remediation.strip(), n)

    def test_external_tool_is_resolved_from_path_not_the_repo(self):
        s = bi.BUILD_INPUTS["r_toolchain"]
        self.assertTrue(s.on_path)
        self.assertEqual(s.category, bi.EXTERNAL_TOOL)
        self.assertNotIn("/", s.relpath)

    def test_no_required_input_is_marked_diagnostic(self):
        for n, s in bi.BUILD_INPUTS.items():
            if s.category == bi.DIAGNOSTIC:
                self.assertFalse(s.required, f"{n} is diagnostic yet required")

    def test_repo_semantic_inputs_are_non_regenerable(self):
        for n, s in bi.BUILD_INPUTS.items():
            if s.category == bi.REPO_SEMANTIC:
                self.assertFalse(s.regenerable,
                                 f"{n} claims to be regenerable from the sources")

    def test_upstream_inputs_declare_their_acquisition(self):
        for n, s in bi.BUILD_INPUTS.items():
            if s.category == bi.UPSTREAM_SOURCE:
                self.assertIn("fetch_raw", s.acquisition, n)

    def test_every_input_declares_consumers_and_reason(self):
        for n, s in bi.BUILD_INPUTS.items():
            self.assertTrue(s.consumers, f"{n} declares no consumer")
            self.assertTrue(s.why.strip(), f"{n} declares no reason")

    def test_raw_dir_override_applies_only_to_upstream_inputs(self):
        alt = "/tmp/elsewhere"
        self.assertTrue(bi.path("players", raw_dir=alt).startswith(alt))
        self.assertFalse(bi.path("schema", raw_dir=alt).startswith(alt))
        self.assertFalse(bi.path("espn_identities", raw_dir=alt).startswith(alt))

    def test_describe_is_machine_readable(self):
        d = bi.describe()
        self.assertEqual(len(d), len(bi.BUILD_INPUTS))
        json.dumps(d)


if __name__ == "__main__":
    unittest.main(verbosity=2)
