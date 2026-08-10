"""The canonical build-input contract for the NFL database.

WHY THIS EXISTS. The T4 defect happened because a mandatory build input lived in a
gitignored `cache/` directory and the loader skipped it silently, so no clone ever
had it and 316 audited identities disappeared without a single gate going red. The
root cause was not the file's location -- it was that NOTHING in the codebase could
answer "what does this build depend on?" `preflight_raw()` listed five CSVs; an
audit-hook trace of a real build opens TWELVE data files.

    declared before this module   5 of 12   (42%)
    undeclared                    7         (58%)

The seven undeclared inputs were not obscure: they include schema.sql, the T4
identity evidence, and four repository-owned datasets carrying every game, team and
venue the build joins against. Any of them could have gone missing or stale the
same way T4 did, with the same silence.

WHAT THIS MODULE GUARANTEES. Every byte capable of materially affecting canonical
database output has exactly one declared identity, path authority, ownership model,
requiredness classification, acquisition story, and failure semantics -- and that
declaration is programmatically consumable, not prose.

WHAT IT DOES NOT DO. It checks PRESENCE and classification, not semantic validity.
Deep validation of any individual input belongs to that input's own validator
(T4's lands in the next phase). Presence is this module's boundary, deliberately.
"""
from __future__ import annotations

import os
from dataclasses import dataclass, field

_LIB = os.path.dirname(os.path.abspath(__file__))
NFLDB = os.path.dirname(_LIB)
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(NFLDB)))

# ---- categories -----------------------------------------------------------
UPSTREAM_SOURCE = "upstream_source"      # fetched from nflverse; regenerable
REPO_SEMANTIC = "repo_semantic"          # tracked knowledge; NOT regenerable from the sources
GENERATED = "generated"                  # safe to rebuild from repo + declared sources
DIAGNOSTIC = "diagnostic"                # absence provably cannot change canonical output
EXTERNAL_TOOL = "external_tool"          # an executable, not a file; may gate validation


@dataclass(frozen=True)
class BuildInput:
    name: str
    relpath: str                  # repo-root-relative; the single path authority
    category: str
    required: bool
    owner: str                    # "upstream" | "repository"
    regenerable: bool
    mutability: str               # "live" | "reviewed" | "immutable"
    acquisition: str
    consumers: tuple
    why: str
    remediation: str
    raw_relative: bool = False    # lives under the (overridable) raw/ directory
    validator: str = "presence"   # deepened per-input in later phases
    on_path: bool = False         # resolved via PATH rather than a repo-relative path
    tags: tuple = field(default_factory=tuple)


def _raw(name, opens, why):
    return BuildInput(
        name=name, relpath=f"scripts/data/nfl-db/raw/{name}.csv",
        category=UPSTREAM_SOURCE, required=True, owner="upstream",
        regenerable=True, mutability="live",
        acquisition="python3 scripts/data/nfl-db/fetch_raw.py",
        consumers=opens, why=why, raw_relative=True,
        remediation="run the declared acquisition process (fetch_raw.py); "
                    "these are regenerable and are NOT tracked in git by design "
                    "(~316 MB)")


#: THE CONTRACT. Derived from an audit-hook trace of a real build -- every non-.py
#: file the executing path opened -- not from expected filenames.
BUILD_INPUTS = {
    # ---- upstream, regenerable -------------------------------------------
    "players": _raw("players", ("player_dimension", "snap_crosswalk", "depth_charts"),
                    "the player dimension's base rows and the pfr/espn id maps"),
    "rosters": _raw("rosters", ("player_dimension", "snap_crosswalk", "depth_charts"),
                    "roster-derived dimension additions and crosswalk tiers"),
    "snap_counts": _raw("snap_counts", ("build_db", "snap_crosswalk", "rowloss"),
                        "the snap_count fact table"),
    "player_stats": _raw("player_stats", ("build_db", "snap_crosswalk", "rowloss"),
                         "the player_game_stats fact table"),
    "depth_charts": _raw("depth_charts", ("build_db", "depth_charts", "rowloss"),
                         "the depth_chart fact table, both source shapes"),

    # ---- repository-owned semantic inputs --------------------------------
    "schema": BuildInput(
        name="schema", relpath="scripts/data/nfl-db/schema.sql",
        category=REPO_SEMANTIC, required=True, owner="repository",
        regenerable=False, mutability="reviewed",
        acquisition="tracked in git",
        consumers=("build_db",),
        why="table definitions, CHECK constraints and foreign keys; the database "
            "cannot be created without it",
        remediation="repository checkout is incomplete; restore from git"),

    # Phase 7 raised the declared count from 13 to 14. That is a deliberate
    # contract evolution, not a regression: Layer C became a required integrity
    # control, so the reviewed acceptance evidence it decides against is now a
    # build input in exactly the sense this registry means -- required, tracked,
    # repository-owned, and NOT regenerable from the five upstream extracts.
    #
    # Regenerating it from the build it governs would be the purest form of the
    # laundering defect this project keeps finding: the artifact that decides
    # whether an identity change is legitimate must not be written by the process
    # whose output it judges.
    "accepted_identities": BuildInput(
        name="accepted_identities",
        relpath="scripts/data/nfl-db/accepted-identities.json",
        category=REPO_SEMANTIC, required=True, owner="repository",
        regenerable=False, mutability="reviewed",
        acquisition="tracked in git; changed only through targeted, reasoned acceptance",
        consumers=("build_db", "identity_baseline", "observe_nonblocking"),
        why="the accepted Layer C identity baseline: 204 source identities, 171 "
            "resolved and 33 unresolved. It is what makes a lost identity "
            "distinguishable from a legitimate new resolution. A fill-rate "
            "percentage cannot make that distinction and never could",
        remediation="repository checkout is incomplete or corrupt. Do NOT "
                    "regenerate it from the current crosswalk: that would accept "
                    "whatever the build produced, including a regression. Restore "
                    "the reviewed artifact from git"),

    "espn_identities": BuildInput(
        name="espn_identities", relpath="scripts/data/nfl-db/espn-identities.json",
        category=REPO_SEMANTIC, required=True, owner="repository",
        regenerable=False, mutability="reviewed",
        acquisition="tracked in git",
        consumers=("build_db", "depth_charts"),
        why="identity evidence the ESPN->gsis crosswalk's T4 tier requires. Not a "
            "cache: it cannot be regenerated from the five nflverse extracts. "
            "Without it 316 audited depth_chart rows silently lose their gsis_id",
        remediation="repository checkout is incomplete or corrupt. Do NOT "
                    "substitute a copy from scripts/data/nfl-db/cache/ -- that "
                    "directory is gitignored, so any copy there is untracked "
                    "developer residue and is exactly the defect this contract "
                    "exists to prevent",
        tags=("t4", "identity")),

    "teams_2026": BuildInput(
        name="teams_2026", relpath="scripts/data/nfl-2026/teams.json",
        category=REPO_SEMANTIC, required=True, owner="repository",
        regenerable=False, mutability="reviewed",
        acquisition="tracked in git (ESPN-sourced, PR #202)",
        consumers=("build_db", "depth_charts", "rowloss", "team_aliases"),
        why="abbreviation -> ESPN franchise id map; every fact table's franchise_id "
            "resolves through it. Also allowlisted into the server image by "
            ".dockerignore, so it is shared with the application bundle",
        remediation="repository checkout is incomplete; restore from git"),

    "games_2026": BuildInput(
        name="games_2026", relpath="scripts/data/nfl-2026/games.json",
        category=REPO_SEMANTIC, required=True, owner="repository",
        regenerable=False, mutability="reviewed",
        acquisition="tracked in git (ESPN-sourced, PR #202)",
        consumers=("build_db", "rowloss"),
        why="the 2026 schedule rows merged into the game table",
        remediation="repository checkout is incomplete; restore from git"),

    "venues_2026": BuildInput(
        name="venues_2026", relpath="scripts/data/nfl-2026/venues.json",
        category=REPO_SEMANTIC, required=True, owner="repository",
        regenerable=False, mutability="reviewed",
        acquisition="tracked in git (ESPN-sourced, PR #202)",
        consumers=("build_db",),
        why="venue attributes joined onto game rows",
        remediation="repository checkout is incomplete; restore from git"),

    "lines_2010_2025": BuildInput(
        name="lines_2010_2025", relpath="scripts/data/nfl-lines-2010-2025/games.json",
        category=REPO_SEMANTIC, required=True, owner="repository",
        regenerable=False, mutability="immutable",
        acquisition="tracked in git",
        consumers=("build_db", "rowloss"),
        why="settled historical betting lines; the game_line fact table",
        remediation="repository checkout is incomplete; restore from git"),

    # ---- external toolchain ----------------------------------------------
    # Found by asking what the trace could NOT see: the audit-hook run used
    # --no-external, so PASS 3 never executed. It shells out to Rscript with
    # nflreadr to re-fetch upstream and cross-check the built database. That is an
    # input to VALIDATION RESULTS, which §4 scopes, even though it is an
    # executable rather than a file.
    #
    # Classified optional, and the proof required for that: its absence cannot
    # change canonical database CONTENT. PASS 3 runs after construction, reads the
    # connection only, and writes nothing to the database. When it is absent the
    # build does NOT silently skip -- pass_external records a failed check, which
    # exits 1 and unlinks the artifact. `--no-external` is the supported explicit
    # waiver.
    "r_toolchain": BuildInput(
        name="r_toolchain", relpath="Rscript",
        category=EXTERNAL_TOOL, required=False, owner="environment",
        regenerable=True, mutability="live",
        acquisition="install R + nflreadr (see references/local-r-toolchain notes)",
        consumers=("build_db.pass_external",),
        why="PASS 3 re-fetches nflverse via nflreadr and cross-checks the built "
            "database against it; without it that cross-check cannot run",
        remediation="install Rscript with nflreadr, or run build_db.py "
                    "--no-external to waive PASS 3 explicitly",
        on_path=True, validator="presence_on_path",
        tags=("validation", "external")),

    "unified_2010_2026": BuildInput(
        name="unified_2010_2026",
        relpath="scripts/data/nfl-unified-2010-2026/games.json",
        category=REPO_SEMANTIC, required=True, owner="repository",
        regenerable=False, mutability="reviewed",
        acquisition="tracked in git",
        consumers=("build_db", "rowloss", "team_aliases"),
        why="the canonical game spine every fact table's game_id resolves against",
        remediation="repository checkout is incomplete; restore from git"),
}


def path(name, root=None, raw_dir=None):
    """The ONE authority for a mandatory input's location.

    `raw_dir` overrides only the upstream extract directory, which build drivers
    and tests legitimately relocate. Repository-owned inputs are never relocatable
    -- that is what makes them repository-owned.
    """
    spec = BUILD_INPUTS[name]
    if spec.on_path:
        import shutil
        return shutil.which(spec.relpath) or spec.relpath
    if spec.raw_relative and raw_dir:
        return os.path.join(raw_dir, os.path.basename(spec.relpath))
    return os.path.join(root or ROOT, spec.relpath)


def required_names(category=None):
    return [n for n, s in BUILD_INPUTS.items()
            if s.required and (category is None or s.category == category)]


def preflight(root=None, raw_dir=None, names=None):
    """Presence check driven by the contract. Returns (ok, failures).

    Deliberately not a semantic validator -- see the module docstring.
    """
    failures = []
    for name in (names or required_names()):
        spec = BUILD_INPUTS[name]
        p = path(name, root=root, raw_dir=raw_dir)
        if not os.path.exists(p):
            failures.append((spec, p))
    return (not failures), failures


def format_failure(spec, resolved_path):
    """Actionable operator output. A bare FileNotFoundError is not a signal."""
    return "\n".join([
        "BUILD INPUT FAILURE",
        f"  input          : {spec.name}",
        f"  path           : {resolved_path}",
        f"  classification : {spec.category}",
        f"  required       : {spec.required}",
        f"  owner          : {spec.owner}",
        f"  regenerable    : {spec.regenerable}",
        f"  mutability     : {spec.mutability}",
        f"  acquisition    : {spec.acquisition}",
        f"  why required   : {spec.why}",
        f"  remediation    : {spec.remediation}",
    ])


def describe(root=None, raw_dir=None):
    """Machine-readable inventory. Phase 11's provenance manifest builds on this."""
    out = []
    for name, spec in BUILD_INPUTS.items():
        p = path(name, root=root, raw_dir=raw_dir)
        out.append({
            "name": name, "path": p, "relpath": spec.relpath,
            "category": spec.category, "required": spec.required,
            "owner": spec.owner, "regenerable": spec.regenerable,
            "mutability": spec.mutability, "acquisition": spec.acquisition,
            "consumers": list(spec.consumers), "validator": spec.validator,
            "tags": list(spec.tags), "present": os.path.exists(p),
        })
    return out


if __name__ == "__main__":
    import json
    import sys
    if "--json" in sys.argv:
        print(json.dumps(describe(), indent=1))
    else:
        print(f"NFL database build-input contract  ({len(BUILD_INPUTS)} declared)\n")
        for d in describe():
            mark = "ok " if d["present"] else "MISSING"
            print(f"  [{mark}] {d['name']:<18} {d['category']:<15} "
                  f"{'required' if d['required'] else 'optional':<9} "
                  f"{'regenerable' if d['regenerable'] else 'NON-regenerable':<15} "
                  f"{d['relpath']}")
        ok, fails = preflight()
        print(f"\n  preflight: {'PASS' if ok else f'{len(fails)} missing'}")
        sys.exit(0 if ok else 1)
