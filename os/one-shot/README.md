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

## Assurance-layer honest boundaries (Campaign Three, refutation-driven)

The v3 kernel machine-checks **reported** progress-claims for structural completeness,
chain integrity, and — for `repo`/`run-artifact`/`event` proofs — existence. It does NOT
derive progress-truth from raw agent behavior. Specifically:

- **Stall / loop / DRIFT are orchestrator-self-reported, not kernel-derived.** The kernel
  guarantees a `STALL_SUSPECTED` / `DRIFT` event is well-formed (names its threshold /
  digest) *if emitted*; it cannot guarantee one is emitted when a stall or drift occurs. A
  silently-stalled agent that never emits the signal passes. Thresholds live in the manifest
  as declared intent, evaluated by the orchestrator.
- **CONFLICT is partly derived.** Closeout now flags two dispatches that declare the SAME
  write scope even with no self-reported CONFLICT (Law 18 derivation); a self-reported
  CONFLICT remains available for cases the string-equality derivation misses (aliased paths).
- **`url` proofs are shape-checked, not liveness-checked.** A well-formed github/notion URL
  to a nonexistent target resolves as shape-valid — so `delivered:true` now REQUIRES an
  existence-checked `repo`/`run-artifact`/`event` proof; a `url` may accompany but never
  suffices. URL-backed *context* is trust, not proof.
- **A REFUTED claim is cleared only by a PROVEN/SUPPORTED correlated correction**, never by
  an INFERRED/UNKNOWN one.

The honest one-line guarantee: *"machine-verified structure, chain integrity, and
existence-checked non-URL proofs for what the orchestrator reports"* — not "machine-verified
progress-truth."

## Envelope contract v4 (Campaign Four: universal execution memory)

Appends stamp `schema_version: 4`; v1/v2/v3 events in historical runs keep their original
rules (backward verification against all three prior campaign runs is a hard requirement,
tested). v4 adds, enforced at append/verify/closeout:

- **Artifact Manifest is derived, never hand-maintained.** `ledger.mjs artifacts <run_id>`
  folds the artifact lifecycle events into the registry: every artifact carries a stable
  `ART-<slug>` identity, canonical `uri`, `artifact_type`, and a `storage_class` from the
  §8 hierarchy (`committed` = in-repo, `external` = out-of-git run artifacts, `canonical` =
  Notion/GitHub-resident, `generated` = derived, `ephemeral` = scratch that must be RETIRED
  before closeout). Registration is once-per-identity; lifecycle events on unregistered ids,
  consumption after retirement, and supersession by an unregistered successor are verify
  violations.
- **§13 dependency invalidation cascade.** `depends_on` records upstream inputs by identity
  (`ART-` ids or `ext:`-prefixed external identities). A content-hash change, supersession,
  retirement, or explicit `DEPENDENCY_INVALIDATED` marks every transitive consumer
  STALE-DEPENDENCY. Staleness clears ONLY through `DEPENDENCY_REVALIDATED` citing the NEW
  upstream identity — per consumer, no transitive forgiveness. Any stale artifact at
  closeout blocks COMPLETE.
- **§47 memory reconciliation gate.** `MEMORY_RECONCILED` carries `clean: true|false`; a
  `clean:true` is re-derived against the registry at that point in the stream (false
  cleanliness is a verify violation), and closeout requires the LAST memory-mutating event
  to be followed by a clean reconcile.
- **§16 composition gap.** `COMPOSITION_EVALUATED` names an `integration_id`, its
  `components`, and one of the nine controlled verdicts (`NO_GAP` … `UNKNOWN_GAP`). Any
  boundary whose latest verdict is not `NO_GAP` blocks COMPLETE — individually green
  components never certify the composed system.
- **§14 interaction graph.** `ledger.mjs graph <run_id>` derives the multi-resource graph
  (scopes, agents, PRs, commits, artifacts, owner gates, declared write-resources; typed
  edges: produces/consumes/depends_on/writes/owns/supersedes/blocks/verified_by/deployed_as/
  invalidates/potential_conflict). String-identity equality still cannot see aliased paths —
  a self-reported CONFLICT remains the fallback for those.
- **§10-§11 derived progress.** `ledger.mjs progress <run_id>` classifies the REPORTED
  stream: dispatches are not progress, results/verifications are; repeated identical action
  signatures with no interleaved progress become loop candidates against the manifest's
  declared thresholds, and consecutive non-progress streaks are measured against
  `stall_threshold_actions_without_new_evidence`. Honest boundary unchanged in kind: this
  observes what the orchestrator reports, not raw agent behavior — it upgrades stall/loop
  detection from purely self-reported to stream-derived, and no further.
- **§24 owner-gate census.** Owner gates may carry a `classification`
  (`RUN_BLOCKING`/`PROGRAM_OPEN`/`SEQUENCED`/`STANDING`); closeout emits the census by state
  and class with exact gate ids under `denominators.owner_gate_census`.

`scripts/one-shot/memory.test.ts` proves each of these controls can fail (45-test battery
alongside the ledger/closeout suites).

### v4.1 (refutation-driven hardening)

A standing refutation agent reproduced six laundering paths against the v4 memory layer;
v4.1 closes them:

- **Authenticated revalidation (R1).** `DEPENDENCY_REVALIDATED` clears staleness only when
  its cited `upstream_identity` is rooted in the upstream recorded in the artifact's
  structured `stale_cause` AND differs from the dead identity. Revalidating a non-stale
  artifact is refused.
- **Invalidation has memory (R2).** Registering an artifact whose `depends_on` names an
  already-invalidated identity — or a currently stale/superseded/retired artifact — starts
  life STALE.
- **Fail-closed change cascade (R3).** An `ARTIFACT_UPDATED` invalidates consumers UNLESS
  both old and new `content_hash` are present and equal — omitting hashes is no longer an
  opt-out.
- **Refuse-before-record (review F4/F5).** Memory-contract violations (unregistered
  references, double registration, consume-after-retire, update-after-terminal,
  supersede-before-successor, unauthenticated revalidation, false `clean:true`) are refused
  at APPEND — they never enter the append-only chain, where they would block verify forever.
  verify re-derives the same rules purely as tamper evidence against hand-edited files.
  Consequence: register a successor BEFORE superseding into it.
- **Evidence-backed composition (R4).** Every `COMPOSITION_EVALUATED` must attach evidence —
  a bare `NO_GAP` cannot launder a prior gap. Manifests may declare
  `required_compositions`: each listed boundary must reach a terminal `NO_GAP` (R5's
  bypass-by-omission stays real for UNdeclared boundaries — that is now an explicit
  boundary, not an implication of safety).
- **Manifest fidelity (R7).** Where bytes are offline-checkable the kernel checks them at
  closeout: committed-class URIs must exist inside the repo; external URIs resolving inside
  the run directory must exist; sha256-shaped `content_hash` declarations must match the
  actual bytes; live artifacts must not share a URI. URIs outside both roots and
  non-sha256 hash formats remain a trust boundary.
- **Poisoned consumption blocks (R8).** A consumption recorded `while_stale` blocks
  COMPLETE until the SAME scope re-consumes the artifact after revalidation.
- **Progress-wash resistance (R6, partial).** Context/plan/read-class events count as
  progress only on their FIRST occurrence per (type, scope); repeats no longer reset the
  stall clock or shield loops. Residual honest boundary: an agent that fabricates varied
  STRONG-class events (e.g. artifact updates, which now at least trigger cascades) can
  still wash the derived detector — stream-derived detection bounds, but does not replace,
  orchestrator duty and human review.
- **Forged-version refusal (review F7).** Memory-typed events stamped `schema_version < 4`
  are refused as definitionally forged (the vocabulary did not exist earlier).
