# One-Shot Execution Event Ledger

Durable, machine-readable record of evidence-gated execution campaigns. Each run under
`runs/<run_id>/` holds an immutable `run-manifest.json` (what the campaign believed it was
authorized to do) and an append-only, hash-chained `events.jsonl` (what actually happened).

This is **not** a transcript: no chain-of-thought, no secrets, no per-command noise. It records
material state transitions — scope starts, gate evaluations, test and negative-test results,
review findings and their closure, external writes and their re-read verification, PR/CI
transitions, owner gates, deployments.

## Three layers

- **Layer A — events.jsonl**: append-only history. What happened.
- **Layer B — status**: derived projection (`ledger.mjs status <run_id>`). What is true now.
  Never hand-maintained; always reconstructed from Layer A.
- **Layer C — evidence refs**: each event points at durable proof (CI runs, PRs, Notion
  fetches, test output). Large payloads live at their source, not in the ledger.

## Single-writer rule

Only the orchestrating session appends events, on the run's designated ledger branch. Lanes and
subagents report facts to the orchestrator; they never append. Parallel writers would fork the
linear hash chain, and renumbering to repair a fork is indistinguishable from tampering.

## Tooling

```bash
node scripts/one-shot/ledger.mjs init  <run_id> '<manifest json>'   # once per run; manifest is immutable
node scripts/one-shot/ledger.mjs append <run_id> '<event json>'     # validates, sequences, hash-chains
node scripts/one-shot/ledger.mjs verify <run_id>                    # deterministic integrity pass (exit 1 on any violation)
node scripts/one-shot/ledger.mjs status <run_id>                    # derived heartbeat snapshot
```

`append` and `init` read the JSON from stdin when the argument is omitted — use that (heredoc)
for any payload containing quotes or apostrophes. Minimal event (id/sequence/timestamp/hashes
are assigned by the tool):

```json
{
  "scope_id": "TOS-006",
  "event_type": "TEST_RESULT",
  "actor": { "type": "agent", "name": "Fable 5", "role": "implementation-owner" },
  "summary": "Validator suite: 18 passed / 0 failed.",
  "evidence": [{ "type": "test", "ref": "npx vitest run scripts/ci/tos-notion-context.test.ts" }],
  "next_action": "Open the TOS-006 PR."
}
```

`verify` proves: schema validity, monotonic sequence, unique event ids, controlled event
vocabulary, declared scope membership, timestamp order, hash-chain integrity (any edit,
interior deletion, or reorder is detected), duplicate idempotency keys, owner-gate and
finding lifecycle consistency, and absence of credential-shaped content.
**Known limits (tamper-EVIDENT, not tamper-proof):** deleting the FINAL line(s) leaves a
valid shorter chain — verify has no internal length anchor. The external anchor is
`closeout.mjs closeout`'s `tail_anchor` (events_total + final_event_hash), quoted in the
run's PR body and final handoff; tail truncation then contradicts the out-of-band record.
And a write-capable actor who edits an event AND recomputes every downstream hash produces
a chain verify passes — the hash chain forces tampering to be a large, reviewable diff; the
actual integrity anchor is git history + branch protection + CI re-derivation, not the
chain alone. Do not cite the ledger as cryptographic proof outside that assumption.
`scripts/one-shot/ledger.test.ts` and `closeout.test.ts` demonstrate each control failing
under deliberate violation.

## Notion pre-image bounding rule

Snapshot-before-mutate pre-images committed under `runs/<run_id>/notion-preimages/` may
contain ONLY the specific properties/structure being mutated — never full body dumps of
records outside the mutation, never Decisions/Risks/People/customer free-text bodies, and
never secrets (CI scans every committed pre-image with the ledger's credential tripwire via
`scripts/ci/tos-ledger-verify.mjs`). This content is committable only while the repo is
private; a visibility flip triggers a pre-image purge review.

`closeout.mjs` derives the run metrics and the closeout gate:

```bash
node scripts/one-shot/closeout.mjs metrics  <run_id>   # §-metrics, mechanically derived
node scripts/one-shot/closeout.mjs closeout <run_id>   # exit 0 only when COMPLETE is honest
```

## Storage authority

Notion holds organizational truth, GitHub holds engineering truth, this ledger holds execution
history — it replaces neither. Run artifacts are committed here because the repo's convention
is committed evidence bundles. `os/ledger/` is the separate token-cost ledger (ISSUE-008);
the two are unrelated.

## Envelope contract v2 (delivery semantics)

Appends stamp `schema_version: 2`; version-1 events in historical runs stay valid under
their original rules (backward verification is a hard requirement, tested against the real
Campaign One run). v2 adds, enforced at append:

- **SCOPE_COMPLETED carries the delivery contract**: `delivered: true | "gated" |
  "not_applicable" | "superseded"`, `authority_plane` (candidate/main/staging/production/
  live-canonical/design), `dod_ref`, and for `delivered: true` a `proof {type, ref}` the
  closeout resolves **offline**: `repo` / `run-artifact` / `event` refs must exist and be
  contained within their root (dead or out-of-root refs block completion); **`url` proofs
  are validated for well-formedness against the systems-of-record host only and are never
  fetched — a well-formed but nonexistent URL resolves.** Proof strength beyond that is a
  git-history + review assumption, not a kernel guarantee. Non-delivery counts as terminal
  ONLY with a non-empty `decision_ref` string — the kernel checks **presence, not
  validity** (it does not resolve the reference against Notion; a reviewer confirms it names
  a real owner Decision record). A campaign never reclassifies its own definition of done.
- **Exact PR identity**: PR_OPENED/PR_UPDATED/PR_READY/CI_STATE_CHANGED require `pr` +
  40-hex `head_sha`; PR_MERGED additionally requires `merge_sha`.
- **Lifecycle completeness**: COMPLETED events (scope, gstack, subagent) require their
  STARTED counterpart earlier in the run.
- **Append-time idempotency**: a duplicate `idempotency_key` is refused before the effect
  is recorded, not flagged after.
- **Structured gstack accounting**: GSTACK_* events carry a `workflow` field; required-
  workflow accounting is exact-match (never substring); `GSTACK_UNAVAILABLE` requires a
  `reason` proving genuine uninvocability — a skill not invoked by choice is OMITTED.
- **DoD divergence detection**: when a `directive.md` **exists** in the run directory, every
  manifest `definition_of_done` line must appear in it verbatim, or closeout blocks.
  `directive.md` is author-placed and is **not** sha-pinned to any owner-held source, and the
  check is skipped if the file is absent — it detects manifest-vs-directive drift, not a
  directive weakened relative to owner intent. Pin the directive's sha against an owner source
  out of band.
- **Legacy (schema_version 1) grandfathering**: v1 events keep their original rules, but the
  v1 marker is author-assertable. A hand-built v1 run (chained with the exported `hashEvent`)
  verifies — so closeout only lets v1 SCOPE_COMPLETED events terminalize a scope when the run
  is in `HISTORICAL_V1_RUNS` **and** its tail anchor (event count + final hash) matches the
  committed pin. Unlisted legacy terminalizations are surfaced in
  `claims.legacy_terminalizations` AND block completion.

`closeout` additionally emits a machine-readable `claims` index (PR identities, terminal
scopes with delivery class + proof, owner gates, legacy v1 terminalizations surfaced
separately) that the final handoff must reference.

## Event vocabulary

The controlled vocabulary lives in `scripts/one-shot/ledger.mjs` (`EVENT_TYPES`). Two repo
extensions beyond the campaign-contract minimum: `GATE_EVALUATED` (structured G0–G10 gate
ledger) and `DECISION_RECORDED` (storage/strategy decisions). Do not add synonyms of existing
types; extend the frozen list deliberately and document why.
