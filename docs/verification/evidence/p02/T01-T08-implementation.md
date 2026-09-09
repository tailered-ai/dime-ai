# P02.T01 – P02.T08 — implementation record

| Unit | Deliverable |
| --- | --- |
| T01 | Census re-derived with `yaml@2.9.0` over the candidate worktree; corpus discovered from reality (40 files), never hardcoded. Deep per-file / per-JSON-path comparison against P00's js-yaml output: **zero semantic differences**. |
| T02 | Deterministic canonicalizer: mapping keys sorted, sequences order-preserved, scalar types preserved, expressions verbatim, multiline `run` preserved, CRLF→LF, comments dropped, anchors/aliases detected and required to be classified. |
| T03 | Per-workflow identity: repo-relative path + raw sha256 + canonical sha256 + parser identity. No absolute path, timestamp, username or run id participates. |
| T04 | `scripts/ci/contract.frozen.json` — schema/parser/canonicalizer versions, `generated_from`, full construct census, allowlist, CI-only action reasons, and 51 checks with ordered steps, commands, env, permissions, services, strategy, needs, conditions, runnability and CI-only reasons. |
| T05 | Allowlist derived from the census. Every construct is SUPPORTED / SUPPORTED_WITH_EXPLICIT_NORMALIZATION / CI_ONLY_BUT_REPRESENTED — no implicit ignored class. Unknown construct ⇒ `CONTRACT_GENERATION_FAILED`, atomic temp-then-rename so the prior artifact survives. |
| T06 | `scripts/ci/contract.sha256` computed over the exact emitted bytes; conformance never regenerates it to force agreement. |
| T07 | Conformance independently re-derives workflow hashes and checks both directions of corpus coverage, versions, the pin, required/graduating context mapping, and mandatory CI-only reasons. |
| T08 | `docs/verification/CONTRACT.md` rendered from the machine contract; byte-compared by P02.CONF02. |

## Runnability, defined
Can the LOCAL verifier reproduce this check's VERIFICATION VALUE?
`LOCAL` · `LOCAL+TOOL` · `CI-ONLY`. It is not "would every step succeed
locally" — reporting sinks (artifact upload, SARIF upload) are represented but
excluded from the verdict (DEF-017).

## Candidate root vs toolchain root
Extraction takes the prospective-merge worktree as the CANDIDATE (source) and
the repository as the TOOLCHAIN (node_modules). The candidate has no installed
dependencies, so parser identity is always read from the toolchain root.
