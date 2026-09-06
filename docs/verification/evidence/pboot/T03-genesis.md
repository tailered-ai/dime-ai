# PB.T03 — evidence record (immutable observation)

Self-attesting genesis record GEN-000 as written at bootstrap:

```json
{
  "blueprint_sha256": "c6fedcf41a842f55786737e2f8cd64c938b2cd626ba3dfb0b5518dcbeb6d139d",
  "blueprint_version": "1.0.0",
  "created_at": "2026-08-10T08:18:18.478Z",
  "git_head_at_bootstrap": "unknown",
  "ledger_impl_sha256": "690ba34fb1e40871ea1a7d29f0c3afc28ed4ba2b05f81432a11cd9f96687873d",
  "note": "Trust root. Cannot be evidence-enforced by a writer that does not yet exist at bootstrap; verified retroactively by P03.NEG04 and bound into the P10 execution-history hash.",
  "record_id": "GEN-000",
  "schema_version": "1.0.0",
  "self_attesting": true
}
```

All five mandated fields present and non-empty: schema_version,
ledger_impl_sha256, blueprint_sha256, git_head_at_bootstrap, created_at.

`ledger_impl_sha256` equals the on-disk SHA-256 of `scripts/ci/ledger.mjs`
at bootstrap (`690ba34fb1e40871ea1a7d29f0c3afc28ed4ba2b05f81432a11cd9f96687873d`); `blueprint_sha256` equals that of
`scripts/ci/blueprint.mjs` (`c6fedcf41a842f55786737e2f8cd64c938b2cd626ba3dfb0b5518dcbeb6d139d`). `ledger.mjs verify` re-derives both
and reports LEDGER_IMPL_DRIFT / BLUEPRINT_IMPL_DRIFT on any later change.

TRUST-ROOT LIMITATION (recorded deliberately, per the frozen architecture):
GEN-000 cannot be evidence-enforced by a writer that does not yet exist at
bootstrap. It is self-attesting. Its integrity is verified retroactively by
P03.NEG04 and again at P10 via the execution-history binding.
