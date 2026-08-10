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
vocabulary, declared scope membership, timestamp order, hash-chain integrity (edit / delete /
reorder all detected), duplicate idempotency keys, owner-gate and finding lifecycle
consistency, and absence of credential-shaped content. `scripts/one-shot/ledger.test.ts`
demonstrates each control failing under deliberate violation.

## Storage authority

Notion holds organizational truth, GitHub holds engineering truth, this ledger holds execution
history — it replaces neither. Run artifacts are committed here because the repo's convention
is committed evidence bundles. `os/ledger/` is the separate token-cost ledger (ISSUE-008);
the two are unrelated.

## Event vocabulary

The controlled vocabulary lives in `scripts/one-shot/ledger.mjs` (`EVENT_TYPES`). Two repo
extensions beyond the campaign-contract minimum: `GATE_EVALUATED` (structured G0–G10 gate
ledger) and `DECISION_RECORDED` (storage/strategy decisions). Do not add synonyms of existing
types; extend the frozen list deliberately and document why.
