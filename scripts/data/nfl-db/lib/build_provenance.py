"""Build provenance: binding a database to the bytes that produced it.

WHY THIS EXISTS. Phase 9 ran the row-loss reconciliation against the accepted
build and reported `unexplained = -964,646`. A database cannot contain more rows
than its source produced, so that number was not a measurement -- it was proof
that the two things being compared did not belong together. The extracts on disk
predated the build. Nothing in the tooling could tell, because nothing bound an
input to the build that consumed it: `raw/` held files with the right NAMES, and
a name is not provenance. Neither is an mtime, a row count, a URL, or sitting in
the same directory.

So this module defines three identities and makes them computable.

    INPUT IDENTITY    the exact bytes of every declared semantic input
    BUILD IDENTITY    code revision + input identity + specs + semantic tools
    OUTPUT IDENTITY   the canonical LOGICAL content of the resulting database

and the invariant that makes reproducibility a claim rather than a hope:

    same BUILD IDENTITY  ->  same OUTPUT IDENTITY

CANONICAL VERSUS DIAGNOSTIC. A fingerprint that moves when nothing semantic
moved is a fingerprint nobody can use. Absolute paths, temporary directories,
wall-clock times, hostnames and PIDs are therefore recorded as DIAGNOSTICS and
excluded from every canonical body. Inputs are keyed by LOGICAL NAME, so the
same bytes under a different root fingerprint identically -- which is exactly
what the clean-room phases need.

WHAT COUNTS AS A SEMANTIC TOOL. Only tools that can change the output given
fixed inputs, and each is justified rather than assumed:

  * sqlite3 IS semantic. Every digest in this tree orders rows with SQL
    ORDER BY, so the library that defines that ordering participates in the
    result.
  * Python is NOT semantic. The one place an interpreter could leak into a hash
    is float encoding, and `season_pins.encode_value` uses `struct.pack(">d")` --
    IEEE-754 big-endian -- specifically to avoid `repr()`. Recorded as a
    diagnostic.
  * R / nflreadr are NOT build-semantic. They ACQUIRE the raw extracts; the
    extracts themselves are hashed. R's version can change what bytes you fetch,
    which is acquisition provenance, not build provenance.

WHY THE MANIFEST CARRIES THE OUTPUT FINGERPRINT. Otherwise a valid manifest
placed beside an unrelated database would certify it. A consumer must recompute
the database's canonical fingerprint and match it against the manifest BEFORE
trusting any input hash the manifest carries. `verify_db_input_binding` does
that, and it is the gate Phase 9 sits behind.
"""
from __future__ import annotations

import hashlib
import json
import os
import sqlite3
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import build_inputs as bi  # noqa: E402
import identity_baseline as ib  # noqa: E402
import observational_integrity as oi  # noqa: E402
import season_pins as sp  # noqa: E402

SCHEMA_VERSION = "nfldb-build-provenance-1"

#: Sidecar name. Derived from the database path so the two travel together, and
#: bound by output fingerprint so travelling together is not what makes it valid.
MANIFEST_SUFFIX = ".provenance.json"

# Binding outcomes. A row-loss verdict may only be computed under BOUND.
BOUND = "BOUND"
INPUT_MISMATCH = "INPUT_MISMATCH"
OUTPUT_MISMATCH = "OUTPUT_MISMATCH"
MANIFEST_MISSING = "MANIFEST_MISSING"
MANIFEST_INVALID = "MANIFEST_INVALID"

#: Columns excluded from OUTPUT identity: technical surrogates whose values are
#: assigned by insertion order rather than by content. Two builds of identical
#: logical content may legitimately number them differently.
#:
#: For the four registered tables this is DERIVED from the Phase 5 field
#: registry rather than restated -- one authority. The remaining tables have no
#: registry entry, so their exclusions are declared here and asserted complete
#: by the test suite, which fails when a new table appears undeclared.
#:
#: team.franchise_id is deliberately NOT excluded. It is an INTEGER PRIMARY KEY,
#: but it carries the ESPN franchise id -- content, not a surrogate. Excluding
#: every INTEGER PRIMARY KEY would have silently dropped it.
_DECLARED_SURROGATES = {
    "data_correction": ("correction_id",),
    "game": (),
    "game_line": (),
    "player": (),
    "team": (),
    "team_alias": (),
    "team_game": (),
}


class ProvenanceError(Exception):
    pass


# --------------------------------------------------------------- canonical
def _frame(b):
    return len(b).to_bytes(8, "big") + b


def _canon(pairs):
    """Canonical byte encoding of an ordered (key, value) mapping.

    Length-framed and prefix-free, matching season_pins.DIGEST_ALGORITHM's
    discipline: ("ab", "c") and ("a", "bc") must not collide.
    """
    out = _frame(SCHEMA_VERSION.encode())
    out += len(pairs).to_bytes(4, "big")
    for k, v in sorted(pairs):
        out += _frame(str(k).encode()) + _frame(str(v).encode())
    return out


def _hash(pairs):
    return hashlib.sha256(_canon(pairs)).hexdigest()


# ------------------------------------------------------------ input identity
def file_digest(path):
    """(sha256, bytes, lines) in ONE pass. Line count only where meaningful."""
    h = hashlib.sha256()
    size = lines = 0
    is_text = path.endswith((".csv", ".json"))
    with open(path, "rb") as fh:
        while chunk := fh.read(1 << 20):
            h.update(chunk)
            size += len(chunk)
            if is_text:
                lines += chunk.count(b"\n")
    return h.hexdigest(), size, (lines if is_text else None)


def semantic_inputs(root=None, raw_dir=None):
    """Every declared FILE input, keyed by logical name.

    Tools resolved through PATH are not file inputs and are recorded separately;
    a PATH lookup has no bytes to hash.
    """
    out = {}
    for name, spec in bi.BUILD_INPUTS.items():
        if getattr(spec, "on_path", False):
            continue
        path = bi.path(name, root=root, raw_dir=raw_dir)
        if not os.path.exists(path):
            if spec.required:
                raise ProvenanceError(
                    f"required input {name!r} is missing at {path!r}; provenance "
                    f"cannot be computed for a build whose inputs are absent")
            continue
        sha, size, lines = file_digest(path)
        out[name] = {
            "sha256": sha, "bytes": size, "lines": lines,
            "logical_path": spec.relpath, "owner": spec.owner,
            "required": spec.required, "mutability": spec.mutability,
            "regenerable": spec.regenerable, "acquisition": spec.acquisition,
            "consumers": list(spec.consumers),
        }
    return out


def input_fingerprint(inputs):
    """Over logical name and bytes ONLY. Not paths, not sizes, not mtimes."""
    return _hash([(f"input:{n}", d["sha256"]) for n, d in inputs.items()])


# ------------------------------------------------------------ build identity
def code_revision(code_root=None):
    """(sha, dirty) of the CODE, which is not where the inputs are.

    Deliberately a separate root from the input root. Inputs get relocated all
    the time -- a restored bundle, a clean-room checkout, a test sandbox -- and
    asking git about the directory the CSVs happen to sit in describes nothing.
    Defaults to the repository containing this module.
    """
    code_root = code_root or bi.ROOT

    def git(*args):
        return subprocess.run(["git", "-C", code_root, *args], capture_output=True,
                              text=True, check=True).stdout.strip()
    try:
        return git("rev-parse", "HEAD"), bool(git("status", "--porcelain"))
    except (subprocess.CalledProcessError, FileNotFoundError) as exc:
        raise ProvenanceError(f"cannot determine code revision: {exc}") from exc


def specifications():
    """The semantic contracts, DERIVED from their existing authorities.

    Redundant while `dirty` is false -- the code revision already pins them --
    and kept because a manifest should say what it means without requiring the
    reader to check out the code that produced it.
    """
    windows = _hash([(t, sp.window(t).predicate) for t in sp.all_frozen_tables()])
    fields = _hash([(f"{t}.{c}", f"{s.semantic_class}|{s.blocking}")
                    for t, cols in sp.FIELD_CLASSES.items()
                    for c, s in cols.items()])
    return {
        "canonical_serializer": sp.DIGEST_ALGORITHM,
        "frozen_window": windows,
        "field_classification": fields,
        "identity_baseline": ib.SCHEMA_VERSION,
        "observation_policy": oi.BASELINE_VERSION,
    }


def semantic_tools():
    """Tools that can change the output given fixed inputs. See the module
    docstring for why this list is short and why each entry is on it."""
    return {"sqlite3": sqlite3.sqlite_version}


def build_fingerprint(code_sha, inputs, specs, tools):
    return _hash(
        [("code", code_sha), ("inputs", input_fingerprint(inputs))]
        + [(f"spec:{k}", v) for k, v in specs.items()]
        + [(f"tool:{k}", v) for k, v in tools.items()])


# ----------------------------------------------------------- output identity
def tables(conn):
    return [r[0] for r in conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table' "
        "AND name NOT LIKE 'sqlite_%' ORDER BY name")]


def surrogate_columns(table):
    """Derived from the Phase 5 registry where the table is registered."""
    if table in sp.FIELD_CLASSES:
        return tuple(c for c, s in sp.FIELD_CLASSES[table].items()
                     if s.semantic_class == sp.SURROGATE_OR_TECHNICAL)
    if table not in _DECLARED_SURROGATES:
        raise ProvenanceError(
            f"table {table!r} has no surrogate declaration. A new table must be "
            f"classified deliberately -- silence would quietly decide whether "
            f"its keys participate in output identity.")
    return _DECLARED_SURROGATES[table]


def output_projection(conn, table):
    cols = [r[1] for r in conn.execute(f"PRAGMA table_info({table})")]
    skip = set(surrogate_columns(table))
    return [c for c in cols if c not in skip]


def table_digest(conn, table):
    """Canonical logical digest over the WHOLE table -- frozen and live alike.

    Deliberately not the four frozen blocking digests: those answer 'has settled
    history moved', which is a different question from 'did these bytes produce
    this database'.
    """
    cols = output_projection(conn, table)
    q = ", ".join(cols)
    h = hashlib.sha256()
    h.update(sp.canonical_header(table, "1=1", cols))
    n = 0
    for row in conn.execute(f"SELECT {q} FROM {table} ORDER BY {q}"):
        h.update(sp.canonical_row(row))
        n += 1
    h.update(sp.canonical_footer(n))
    return h.hexdigest(), n


def output_fingerprint(conn):
    """(fingerprint, {table: {digest, rows}}) over every table in the database."""
    per = {}
    for t in tables(conn):
        d, n = table_digest(conn, t)
        per[t] = {"digest": d, "rows": n}
    return _hash([(f"table:{t}", f"{v['digest']}:{v['rows']}")
                  for t, v in per.items()]), per


# ------------------------------------------------------------------ manifest
def manifest_path(db_path):
    return db_path + MANIFEST_SUFFIX


def build_manifest(conn, root=None, raw_dir=None, require_clean=True,
                   pre_inputs=None, code_root=None):
    """The canonical provenance body for a completed build.

    `pre_inputs` is the input identity captured BEFORE the build ran. Supplying
    it turns on the mutation check: an input that changed while it was being
    consumed makes the build's evidence invalid, and no amount of after-the-fact
    hashing can recover it.
    """
    code_sha, dirty = code_revision(code_root)
    if require_clean and dirty:
        raise ProvenanceError(
            "the worktree is dirty. Accepted reproducibility evidence may not be "
            "produced from uncommitted code: nothing else could ever check out "
            "the thing that built this database.")
    inputs = semantic_inputs(root, raw_dir)
    if pre_inputs is not None:
        moved = sorted(n for n in set(pre_inputs) | set(inputs)
                       if pre_inputs.get(n, {}).get("sha256")
                       != inputs.get(n, {}).get("sha256"))
        if moved:
            raise ProvenanceError(
                f"input(s) changed while the build was running: {moved}. The "
                f"database is not the product of any single set of bytes.")
    specs = specifications()
    tools = semantic_tools()
    out_fp, per_table = output_fingerprint(conn)
    return {
        "schema": SCHEMA_VERSION,
        "canonical": {
            "code_revision": code_sha,
            "dirty": dirty,
            "input_fingerprint": input_fingerprint(inputs),
            "build_fingerprint": build_fingerprint(code_sha, inputs, specs, tools),
            "output_fingerprint": out_fp,
            "inputs": inputs,
            "specifications": specs,
            "semantic_tools": tools,
            "tables": per_table,
        },
        # Never fingerprinted. Present because a human debugging a mismatch
        # wants them, and absent from the canonical body because a fingerprint
        # that moves when the machine moves is useless.
        "diagnostic": {
            "python": sys.version.split()[0],
            "acquisition_tools": {
                n: {"declared": s.acquisition}
                for n, s in bi.BUILD_INPUTS.items() if getattr(s, "on_path", False)
            },
        },
    }


def write_manifest(conn, db_path, root=None, raw_dir=None, require_clean=True,
                   pre_inputs=None, code_root=None):
    doc = build_manifest(conn, root, raw_dir, require_clean, pre_inputs,
                         code_root)
    path = manifest_path(db_path)
    with open(path, "w") as fh:
        json.dump(doc, fh, indent=2, sort_keys=True)
        fh.write("\n")
    return path, doc


def read_manifest(db_path):
    path = manifest_path(db_path)
    if not os.path.exists(path):
        raise ProvenanceError(f"no provenance manifest at {path!r}")
    try:
        with open(path) as fh:
            doc = json.load(fh)
    except json.JSONDecodeError as exc:
        raise ProvenanceError(f"{path}: malformed JSON -- {exc}") from exc
    if not isinstance(doc, dict) or doc.get("schema") != SCHEMA_VERSION:
        raise ProvenanceError(
            f"{path}: schema is {doc.get('schema') if isinstance(doc, dict) else '?'!r}, "
            f"expected {SCHEMA_VERSION!r}")
    canon = doc.get("canonical")
    if not isinstance(canon, dict):
        raise ProvenanceError(f"{path}: no canonical section")
    for required in ("code_revision", "input_fingerprint", "build_fingerprint",
                     "output_fingerprint", "inputs"):
        if required not in canon:
            raise ProvenanceError(f"{path}: canonical section lacks {required!r}")
    return doc


# ------------------------------------------------------------------- binding
def verify_db_input_binding(conn, db_path, root=None, raw_dir=None):
    """(status, detail). THE gate. No reconciliation verdict without BOUND.

    Order matters. The database is matched to the manifest FIRST, because the
    manifest's input hashes are only meaningful once it is established that the
    manifest describes this database and not some other one.
    """
    try:
        doc = read_manifest(db_path)
    except ProvenanceError as exc:
        missing = "no provenance manifest" in str(exc)
        return (MANIFEST_MISSING if missing else MANIFEST_INVALID), str(exc)

    canon = doc["canonical"]
    actual_out, _ = output_fingerprint(conn)
    if actual_out != canon["output_fingerprint"]:
        return OUTPUT_MISMATCH, {
            "why": "this database is not the one the manifest describes",
            "manifest_output_fingerprint": canon["output_fingerprint"],
            "actual_output_fingerprint": actual_out}

    try:
        current = semantic_inputs(root, raw_dir)
    except ProvenanceError as exc:
        return INPUT_MISMATCH, {"why": str(exc)}

    differing = []
    for name in sorted(set(canon["inputs"]) | set(current)):
        want = canon["inputs"].get(name, {}).get("sha256")
        got = current.get(name, {}).get("sha256")
        if want != got:
            differing.append({"input": name, "manifest_sha256": want,
                              "current_sha256": got,
                              "logical_path": (canon["inputs"].get(name)
                                               or current.get(name, {})
                                               ).get("logical_path")})
    if differing:
        return INPUT_MISMATCH, {
            "why": "the inputs on disk are not the inputs that built this database",
            "differing": differing}

    return BOUND, {"code_revision": canon["code_revision"],
                   "input_fingerprint": canon["input_fingerprint"],
                   "build_fingerprint": canon["build_fingerprint"],
                   "output_fingerprint": canon["output_fingerprint"]}
