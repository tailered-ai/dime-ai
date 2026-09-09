# AMD-009 rationale — append-only evidence supersession

## Why

`P05.EV01`, `P05.EV02`, and `P05.GATE01` were closed in the previous turn
against `assurance.json` as it stood then: 3 gates PROVEN, 1 FINDING_CONFIRMED.
The authorized DEF-023/DEF-027 remediation legitimately produced a NEW run
(4/4 PROVEN, `ASSURANCE_GREEN`), regenerated at the same path. The ledger's
stale-evidence guard caught the change immediately and refused to verify —
correct behaviour, and exactly the "evidence cannot rot under a closed unit"
guarantee the architecture was built to provide.

Unit status `PASS` is terminal by design, so those units cannot be re-closed
against the new artifact, and the superseded bytes cannot be reconstructed.
The underlying mistake was recording a per-run artifact at a mutable path as
immutable unit evidence (DEF-028).

## What this authorizes

A new `supersede-evidence` subcommand on the sole ledger writer. It:

- does **not** touch unit status — terminal stays terminal;
- retains the superseded paths **and their original SHA-256 hashes** forever
  in an append-only `superseded_evidence` array on the unit;
- requires a reason, a defect id, and replacement evidence — all three;
- surfaces in the rendered ledger, so every use is visible.

Precedent: AMD-001 introduced exactly this shape for GEN-000 under DEF-005 —
an append-only correction that retains the superseded value "so the original
error stays auditable".

## Rejected alternatives

| Alternative | Why rejected |
| --- | --- |
| Retire the three units and declare replacements | `acceptPhase` requires every MANDATORY acceptance gate to be `PASS`; a RETIRED `P05.GATE01` would block acceptance permanently |
| Reconstruct the superseded artifact bytes | Impossible — the pre-remediation run no longer exists and its `observational` section carried run-specific values |
| Loosen or bypass the stale-evidence check | Destroys the guarantee that makes closed evidence meaningful |
| Leave the ledger unverifiable | Not an option; `verify` gates acceptance |

## Blast radius

One new writer subcommand and one optional per-unit field. No existing record
is rewritten; no status changes; no prior hash is discarded.
