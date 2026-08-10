"""The one authoritative loader and semantic validator for T4 identity evidence.

WHAT T4 ACTUALLY IS. `espn-identities.json` is repository-owned identity EVIDENCE,
not a mapping. Derived from the tracked artifact rather than assumed: each record
carries an `espn_id` plus descriptive fields, and carries NO gsis_id. The crosswalk's
T4 tier uses the (name, college) pair to find exactly one matching player when the
cheaper tiers cannot -- see build_espn_gsis_crosswalk. So "validate the mapping" is
the wrong frame: there is no mapping here to validate, and inventing a gsis_id field
would be inventing schema.

    root                list
    records             39, all dict
    espn_id             REQUIRED, str, exactly 7 digits, unique      <- canonical key
    espn_full           REQUIRED, str, non-empty                     <- T4 match input
    college             REQUIRED key, str or null                    <- T4 match input
    dc_name/rows/teams/dob/pos/active/jersey   present on every record; retained as
                        audit evidence, not consumed by the build

    T4 fires only when BOTH normalised name and college are non-empty AND match
    exactly one player. 38 of 39 records are T4-capable; espn_id 5278091 has a null
    college and therefore can never fire -- that is legitimate evidence, classified
    rather than rejected.

    5 records actually produce a T4 resolution (489 rows, 316 of them inside the
    audited frozen window). The other 34 are evidence for ids in
    UNRESOLVED_ESPN_IDS -- exact overlap, 5 + 34 = 39.

WHY THIS MODULE EXISTS. Before it there were two independent parsers: build_db.py
and depth_charts._self_check, each resolving its own path and building its own dict
with `{r["espn_id"]: ...}` -- a comprehension that silently resolves duplicates by
last-one-wins. Identity correctness depended on a file whose authority was ambiguous,
whose parser was duplicated, and whose absence was tolerated. One canonical artifact,
one validator, one representation, every consumer.

Ownership contract, stated once so it cannot be mistaken again:
  * espn-identities.json is repository-owned identity evidence.
  * It is a mandatory semantic build input, NOT a cache.
  * A copy under the gitignored cache/ must never substitute for it.
  * All consumers use this loader.
"""
from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass

import build_inputs

INPUT_NAME = "espn_identities"

#: Observed format in the governed population: exactly 7 digits, no leading zero,
#: always a JSON string. Derived from the artifact, not chosen to be permissive.
ESPN_ID_RE = re.compile(r"^[1-9][0-9]{6}$")

#: Fields the build consumes. Everything else is retained audit evidence.
CONSUMED_FIELDS = ("espn_id", "espn_full", "college")


class T4InputError(RuntimeError):
    """Invalid T4 identity evidence. Always fatal: a build that silently drops T4
    produces a materially different database (316 audited rows lose identity)."""


def _err(reason, path, *, record=None, index=None, observed=None, expected=None,
         action=None):
    lines = ["", "T4 INPUT INVALID",
             f"  input          : {INPUT_NAME}",
             f"  path           : {path}",
             f"  failure class  : {reason}"]
    if index is not None:
        lines.append(f"  record index   : {index}")
    if record is not None:
        lines.append(f"  record key     : {record}")
    if observed is not None:
        lines.append(f"  observed       : {observed!r}")
    if expected is not None:
        lines.append(f"  expected       : {expected}")
    lines += [
        "  why mandatory  : the crosswalk's T4 tier resolves identities no cheaper "
        "tier can; without valid evidence 316 audited depth_chart rows silently "
        "lose their gsis_id",
        f"  remediation    : {action or 'repair the tracked, reviewed identity evidence at the path above'}",
        "  NOTE           : never regenerate this from scripts/data/nfl-db/cache/ "
        "-- that directory is gitignored and any copy there is untracked residue.",
    ]
    return T4InputError("\n".join(lines))


@dataclass(frozen=True)
class EspnIdentity:
    espn_id: str
    full_name: str
    college: str | None
    evidence: dict          # the untouched record, kept for audit
    t4_capable: bool        # both match inputs usable -> this record can fire T4


@dataclass(frozen=True)
class ValidatedIdentities:
    path: str
    by_espn_id: dict        # {espn_id: EspnIdentity}
    t4_capable: tuple       # espn_ids that can produce a match
    evidence_only: tuple    # present and valid, but can never fire

    def __len__(self):
        return len(self.by_espn_id)

    def as_crosswalk_map(self):
        """Exactly the shape build_espn_gsis_crosswalk expects. One representation,
        produced here, so build and self-check cannot interpret a record differently."""
        return {e.espn_id: {"fullName": e.full_name, "college": e.college}
                for e in self.by_espn_id.values()}


#: THE AUDITED CONTRACT (section 14/15). A count floor would let a substituted
#: player pass, so the invariant is set-based on the evidence CONTENT: every known
#: espn_id must still be present carrying the same match inputs. Additional records
#: are permitted -- they can only add resolutions, and any resulting new mapping is
#: governed downstream by the identity state machine -- but they are reported.
#: Regenerate deliberately with:  python3 lib/espn_identities.py --emit-contract
REQUIRED_EVIDENCE: dict = {
 "3043133": [
  "Jordan Davis",
  "Georgia"
 ],
 "4240033": [
  "Ontaria Wilson",
  "Florida State"
 ],
 "4244814": [
  "Jake Julien",
  "Eastern Michigan"
 ],
 "4339830": [
  "Chris Okoye",
  "Ferris State"
 ],
 "4361444": [
  "Toa Taua",
  "Nevada"
 ],
 "4362191": [
  "Jaylon Hutchings",
  "Texas Tech"
 ],
 "4362248": [
  "Anthony Torres",
  "Toledo"
 ],
 "4426398": [
  "David Gbenda",
  "Texas"
 ],
 "4426484": [
  "Marcus Major Jr.",
  "Minnesota"
 ],
 "4427243": [
  "Brett Gabbert",
  "Miami (OH)"
 ],
 "4427389": [
  "Hayden Harris",
  "Montana"
 ],
 "4427569": [
  "Giles Jackson",
  "Washington"
 ],
 "4428132": [
  "Tuasivi Nomura",
  "Fresno State"
 ],
 "4429488": [
  "Fentrell Cypress II",
  "Florida State"
 ],
 "4429932": [
  "Christian Johnstone",
  "App State"
 ],
 "4430804": [
  "Chris Tyree",
  "Virginia"
 ],
 "4431597": [
  "Roc Taylor",
  "Memphis"
 ],
 "4565535": [
  "DK Kaufman",
  "Northern Illinois"
 ],
 "4568671": [
  "Jonathan Kim",
  "Michigan State"
 ],
 "4569452": [
  "Winston Wright",
  "East Carolina"
 ],
 "4569496": [
  "Tank Booker",
  "SMU"
 ],
 "4570688": [
  "Caden Davis",
  "Ole Miss"
 ],
 "4572544": [
  "Eli Mostaert",
  "North Dakota State"
 ],
 "4574571": [
  "Brent Matiscik",
  "TCU"
 ],
 "4578080": [
  "Ozzie Hutchinson",
  "UAlbany"
 ],
 "4578233": [
  "Ryan Coe",
  "California"
 ],
 "4578857": [
  "Bruce Harmon",
  "Stephen F. Austin"
 ],
 "4579667": [
  "Pat Conroy",
  "Old Dominion"
 ],
 "4587977": [
  "Sam Brown Jr.",
  "Miami"
 ],
 "4596596": [
  "J.J. Jones",
  "North Carolina"
 ],
 "4605489": [
  "Damien Alford",
  "Utah"
 ],
 "4610703": [
  "Jalen White",
  "Georgia Southern"
 ],
 "4686338": [
  "Josh Minkins",
  "Cincinnati"
 ],
 "4690170": [
  "DJ Thomas-Jones",
  "South Alabama"
 ],
 "4695679": [
  "JB Brown",
  "Kansas"
 ],
 "4708127": [
  "Monaray Baldwin",
  "Baylor"
 ],
 "4749258": [
  "Boog Smith",
  "South Carolina State"
 ],
 "5082289": [
  "Kelly Akharaiyi",
  "Mississippi State"
 ],
 "5278091": [
  "Jordan Petaia",
  None
 ]
}


def load(path=None, root=None, require_audited=True):
    """Read, validate and canonicalise T4 evidence. Raises T4InputError.

    The path comes from the Phase 1 build-input contract, never from a literal
    recreated here, and never from the legacy cache.
    """
    path = path or build_inputs.path(INPUT_NAME, root=root)

    if not os.path.exists(path):                                        # T4-1
        spec = build_inputs.BUILD_INPUTS[INPUT_NAME]
        # Derive the legacy location from the SAME tree being validated. Using the
        # module-level repo path would report this machine's cache while validating
        # a different root -- a diagnostic that lies about which tree it inspected.
        legacy = os.path.join(os.path.dirname(path), "cache/b3/espn_identities.json")
        extra = (f" An untracked copy exists at {legacy}; it is NOT used."
                 if os.path.exists(legacy) else "")
        raise _err("tracked file missing", path,
                   action=spec.remediation + extra)
    try:                                                                # T4-2
        with open(path, encoding="utf-8") as fh:
            blob = fh.read()
    except OSError as exc:
        raise _err("file unreadable", path, observed=str(exc)) from exc
    try:                                                                # T4-3
        doc = json.loads(blob)
    except json.JSONDecodeError as exc:
        raise _err("malformed JSON", path, observed=str(exc),
                   action="restore the reviewed repository-owned identity evidence") from exc

    if not isinstance(doc, list):                                       # T4-4
        raise _err("wrong root type", path,
                   observed=type(doc).__name__, expected="list")

    by_id: dict = {}
    seen_at: dict = {}
    capable, evidence_only = [], []

    for i, rec in enumerate(doc):
        if not isinstance(rec, dict):                                   # T4-5
            raise _err("malformed record", path, index=i,
                       observed=type(rec).__name__, expected="object")

        eid = rec.get("espn_id")
        if eid is None:
            raise _err("missing required field 'espn_id'", path, index=i)
        if not isinstance(eid, str):
            # Numbers are refused rather than coerced: str(4362191) and
            # str(4362191.0) differ, and silent coercion is how ids drift.
            raise _err("espn_id is not a string", path, index=i,
                       observed=eid, expected="JSON string")
        if not ESPN_ID_RE.match(eid):
            raise _err("malformed espn_id", path, index=i, observed=eid,
                       expected="exactly 7 digits, no leading zero")
        if eid in by_id:                                                # duplicates
            raise _err("duplicate espn_id", path, record=eid,
                       observed=f"records {seen_at[eid]} and {i}",
                       expected="one record per espn_id",
                       action="remove or merge the duplicate; a dict comprehension "
                              "would silently keep only the last one")

        full = rec.get("espn_full")
        if full is None:
            raise _err("missing required field 'espn_full'", path, index=i, record=eid)
        if not isinstance(full, str) or not full.strip():
            raise _err("empty or non-string espn_full", path, index=i, record=eid,
                       observed=full, expected="non-empty string")

        if "college" not in rec:
            raise _err("missing required key 'college'", path, index=i, record=eid,
                       expected="present; may be null")
        college = rec.get("college")
        if college is not None and not isinstance(college, str):
            raise _err("college is neither string nor null", path, index=i,
                       record=eid, observed=college)

        can_fire = bool(full.strip()) and bool((college or "").strip())
        ident = EspnIdentity(espn_id=eid, full_name=full.strip(),
                             college=(college.strip() if isinstance(college, str) and college.strip() else None),
                             evidence=rec, t4_capable=can_fire)
        by_id[eid] = ident
        seen_at[eid] = i
        (capable if can_fire else evidence_only).append(eid)

    if not by_id:
        raise _err("no usable identity records", path, expected="at least one record")

    validated = ValidatedIdentities(path=path, by_espn_id=by_id,
                                    t4_capable=tuple(capable),
                                    evidence_only=tuple(evidence_only))

    if require_audited and REQUIRED_EVIDENCE:
        missing, changed = [], []
        for eid, want in REQUIRED_EVIDENCE.items():
            got = by_id.get(eid)
            if got is None:
                missing.append(eid)
            elif [got.full_name, got.college] != list(want):
                changed.append((eid, want, [got.full_name, got.college]))
        if missing or changed:
            raise _err(
                "audited T4 evidence altered", path,
                observed=f"{len(missing)} missing {missing[:5]}, "
                         f"{len(changed)} substituted {[c[0] for c in changed][:5]}",
                expected=f"all {len(REQUIRED_EVIDENCE)} audited records present and unchanged",
                action="a record was removed or replaced. Row COUNT is not the "
                       "contract -- the evidence content is. Investigate before "
                       "regenerating the contract.")
    return validated


def _norm_contract(validated):
    return {e.espn_id: [e.full_name, e.college]
            for e in sorted(validated.by_espn_id.values(), key=lambda x: x.espn_id)}


if __name__ == "__main__":
    import sys
    v = load(require_audited=False)
    if "--emit-contract" in sys.argv:
        print("REQUIRED_EVIDENCE: dict = " + repr(_norm_contract(v)))
    else:
        print(f"T4 identity evidence: {v.path}")
        print(f"  records        {len(v)}")
        print(f"  t4-capable     {len(v.t4_capable)}")
        print(f"  evidence-only  {len(v.evidence_only)}  {list(v.evidence_only)}")
        print(f"  audited pinned {len(REQUIRED_EVIDENCE)}")
