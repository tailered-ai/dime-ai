# AMD-007 rationale — declare P05.CP02

The DEF-023 remediation authorization requires a NEW append-only checkpoint
(§13): "Do not rewrite or delete the sealed P05.CP01. Create P05.CP02 ... It
must explicitly state that it supersedes CP01 for progression purposes while
preserving CP01 byte-for-byte."

`P05.CP02` is therefore declared as a new permanent MANDATORY checkpoint unit
depending on `P05.CP01`. Additive only: `P05.CP01` keeps its ID, status,
evidence, and recorded decision (`DO NOT PROCEED - Blocking IDs: DEF-023`)
unchanged, and its sealed evidence file is untouched.

Precedent: AMD-006 (P05 units), AMD-005 (P04), AMD-004 (P03).
