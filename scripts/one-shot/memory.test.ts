// Universal Execution Memory + Agent Observatory enforcement (Campaign Four,
// directive §6/§7/§10-§11/§13/§14/§16/§24/§47). Same standard as the sibling
// batteries: exercise the real append/verify/closeout path in a temp run, then
// prove every new control can actually FAIL — a gate that cannot fail is
// ceremony, not assurance.
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "vitest";

import * as ledger from "./ledger.mjs";
import { closeout } from "./closeout.mjs";

const RUN = "ONE-20990101-MEM";
const MANIFEST = {
  schema_version: 1,
  run_id: RUN,
  program: "Tailered OS",
  scope_id: "TOS-PROGRAM",
  canonical_task: "https://app.notion.com/p/3b89673313e781eb8382e16d156d0ced",
  repository: "tailered-ai/dime-ai",
  base_sha: "5a9b657579c62df004b47980dd14ead7108d7577",
  started_at: "2099-01-01T00:00:00Z",
  human_owner: "PREZ",
  risk_class: "high",
  authorization_profile: "test",
  deployment_policy: "none",
  heartbeat_cadence: "per transition",
  stall_threshold_actions_without_new_evidence: 4,
  loop_threshold_repeated_action_signature: 3,
  required_gates: ["G0"],
  required_gstack: ["review"],
  definition_of_done: ["memory battery proven"],
  non_goals: ["false COMPLETE"],
  scopes: ["TOS-PROGRAM", "TOS-006", "LANE-0"],
};

const ACTOR = { type: "agent", name: "Fable 5", role: "integration-owner" };
let tmpRoot: string;
beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "one-shot-memory-"));
  process.env.ONE_SHOT_RUNS_ROOT = tmpRoot;
  mkdirSync(join(tmpRoot, RUN), { recursive: true });
  writeFileSync(
    join(tmpRoot, RUN, "run-manifest.json"),
    JSON.stringify(MANIFEST)
  );
});

const add = (partial: any) =>
  ledger.appendEvent(RUN, { actor: ACTOR, label: "SUPPORTED", ...partial });

// Fidelity (refutation R7): external URIs inside the run dir are existence-
// checked, so the fixture creates real bytes for every registered artifact.
const register = (id: string, extra: any = {}) => {
  const uri = extra.uri ?? `reports/${id}.md`;
  const target = join(tmpRoot, RUN, uri);
  mkdirSync(join(tmpRoot, RUN, "reports"), { recursive: true });
  if (!extra.__skip_file) writeFileSync(target, `bytes of ${id}\n`);
  const { __skip_file, ...artifactExtra } = extra;
  return add({
    scope_id: "TOS-006",
    event_type: "ARTIFACT_REGISTERED",
    summary: `register ${id}`,
    artifact: {
      id,
      uri,
      artifact_type: "report",
      storage_class: "external",
      ...artifactExtra,
    },
  });
};

// Verify-side coverage: appendEvent now REFUSES memory-contract violations
// (refuse-before-record), so proving verify still detects them requires
// forging the line the way a hand-editor would — chained with the exported
// hashEvent, bypassing appendEvent.
const forgeAppend = (partial: any) => {
  const eventsPath = join(tmpRoot, RUN, "events.jsonl");
  const existing = ledger.readEvents(RUN);
  const previous = existing[existing.length - 1] ?? null;
  const sequence = (previous?.sequence ?? 0) + 1;
  const event: any = {
    schema_version: ledger.EVENT_SCHEMA_VERSION,
    event_id: `evt_${String(sequence).padStart(5, "0")}`,
    run_id: RUN,
    sequence,
    timestamp: previous?.timestamp ?? "2099-01-01T00:00:00Z",
    actor: ACTOR,
    label: "SUPPORTED",
    ...partial,
  };
  event.previous_event_hash = previous?.event_hash ?? null;
  event.event_hash = ledger.hashEvent(event, event.previous_event_hash);
  writeFileSync(eventsPath, `${JSON.stringify(event)}\n`, { flag: "a" });
  return event;
};

// A run that satisfies every PRE-v4 closeout condition, so each v4 blocker can
// be shown to be the ONLY thing standing between the run and COMPLETE.
function happyBase() {
  add({ scope_id: "TOS-PROGRAM", event_type: "RUN_STARTED", summary: "start" });
  add({ scope_id: "TOS-006", event_type: "SCOPE_STARTED", summary: "s" });
  add({
    scope_id: "TOS-006",
    event_type: "SCOPE_COMPLETED",
    summary: "done",
    delivered: true,
    authority_plane: "candidate",
    dod_ref: "memory battery proven",
    proof: { type: "event", ref: "evt_00001" },
  });
  add({
    scope_id: "TOS-PROGRAM",
    event_type: "GATE_EVALUATED",
    gate: "G0",
    gate_status: "PASS",
    summary: "G0",
  });
  add({
    scope_id: "TOS-PROGRAM",
    event_type: "GSTACK_STARTED",
    workflow: "review",
    summary: "review started",
  });
  add({
    scope_id: "TOS-PROGRAM",
    event_type: "GSTACK_COMPLETED",
    workflow: "review",
    summary: "review complete",
  });
}
const terminal = () =>
  add({ scope_id: "TOS-PROGRAM", event_type: "RUN_COMPLETED", summary: "end" });

describe("artifact lifecycle contract (§6/§7)", () => {
  it("ARTIFACT_REGISTERED demands stable identity, uri, type, storage class", () => {
    assert.throws(
      () =>
        add({
          scope_id: "TOS-006",
          event_type: "ARTIFACT_REGISTERED",
          summary: "bad id",
          artifact: {
            id: "not-an-artifact-id",
            uri: "x",
            artifact_type: "t",
            storage_class: "external",
          },
        }),
      /artifact\.id matching ART-/
    );
    assert.throws(
      () =>
        add({
          scope_id: "TOS-006",
          event_type: "ARTIFACT_REGISTERED",
          summary: "no uri",
          artifact: {
            id: "ART-x1",
            artifact_type: "t",
            storage_class: "external",
          },
        }),
      /requires artifact\.uri/
    );
    assert.throws(
      () =>
        add({
          scope_id: "TOS-006",
          event_type: "ARTIFACT_REGISTERED",
          summary: "bad class",
          artifact: {
            id: "ART-x1",
            uri: "x",
            artifact_type: "t",
            storage_class: "somewhere",
          },
        }),
      /storage_class/
    );
  });

  it("depends_on entries must be artifact ids or ext: identities — no freeform strings", () => {
    assert.throws(
      () => register("ART-a1", { depends_on: ["some random thing"] }),
      /depends_on entries/
    );
    register("ART-a2", { depends_on: ["ext:github:pr:496@6c00a6df"] });
  });

  it("lifecycle events on an unregistered artifact are REFUSED at append, and a forged line is a verify violation", () => {
    happyBase();
    assert.throws(
      () =>
        add({
          scope_id: "TOS-006",
          event_type: "ARTIFACT_CONSUMED",
          summary: "consume ghost",
          artifact: { id: "ART-ghost" },
        }),
      /memory contract violation refused at append.*never registered/
    );
    // Hand-edited history still cannot hide: verify re-derives the same rule.
    forgeAppend({
      scope_id: "TOS-006",
      event_type: "ARTIFACT_CONSUMED",
      summary: "forged ghost consumption",
      artifact: { id: "ART-ghost" },
    });
    const result = ledger.verifyRun(RUN);
    assert.equal(result.ok, false);
    assert.match(result.errors.join("\n"), /never registered/);
  });

  it("double registration of one identity is refused at append and detected by verify on a forged line", () => {
    happyBase();
    register("ART-a1");
    assert.throws(() => register("ART-a1"), /registered twice/);
    forgeAppend({
      scope_id: "TOS-006",
      event_type: "ARTIFACT_REGISTERED",
      summary: "forged double registration",
      artifact: {
        id: "ART-a1",
        uri: "reports/ART-a1.md",
        artifact_type: "report",
        storage_class: "external",
      },
    });
    assert.match(ledger.verifyRun(RUN).errors.join("\n"), /registered twice/);
  });

  it("consumption after retirement is refused — retired means retired", () => {
    happyBase();
    register("ART-a1");
    add({
      scope_id: "TOS-006",
      event_type: "ARTIFACT_RETIRED",
      summary: "retire",
      artifact: { id: "ART-a1" },
    });
    assert.throws(
      () =>
        add({
          scope_id: "TOS-006",
          event_type: "ARTIFACT_CONSUMED",
          summary: "consume the corpse",
          artifact: { id: "ART-a1" },
        }),
      /consumed after retirement/
    );
  });

  it("supersession must name an ALREADY-registered successor (register successor first)", () => {
    happyBase();
    register("ART-a1");
    assert.throws(
      () =>
        add({
          scope_id: "TOS-006",
          event_type: "ARTIFACT_SUPERSEDED",
          summary: "superseded by vapor",
          artifact: { id: "ART-a1", superseded_by: "ART-vapor" },
        }),
      /unregistered ART-vapor/
    );
    // The sanctioned order works: successor first, then supersession.
    register("ART-a2");
    add({
      scope_id: "TOS-006",
      event_type: "ARTIFACT_SUPERSEDED",
      summary: "superseded by the registered successor",
      artifact: { id: "ART-a1", superseded_by: "ART-a2" },
    });
    assert.equal(ledger.verifyRun(RUN).ok, true);
  });

  it("updating a retired or superseded artifact is refused — no silent resurrection", () => {
    happyBase();
    register("ART-a1");
    add({
      scope_id: "TOS-006",
      event_type: "ARTIFACT_RETIRED",
      summary: "retire",
      artifact: { id: "ART-a1" },
    });
    assert.throws(
      () =>
        add({
          scope_id: "TOS-006",
          event_type: "ARTIFACT_UPDATED",
          summary: "necromancy",
          artifact: { id: "ART-a1", content_hash: "fff" },
        }),
      /updated after retired/
    );
  });

  it("ARTIFACT_VALIDATED without evidence is refused at append", () => {
    register("ART-a1");
    assert.throws(
      () =>
        add({
          scope_id: "TOS-006",
          event_type: "ARTIFACT_VALIDATED",
          summary: "trust me",
          artifact: { id: "ART-a1" },
        }),
      /must attach the evidence/
    );
  });
});

describe("dependency invalidation cascade (§13)", () => {
  it("a content-hash change cascades staleness through transitive consumers", () => {
    happyBase();
    register("ART-src", { content_hash: "aaa" });
    register("ART-mid", { depends_on: ["ART-src"] });
    register("ART-leaf", { depends_on: ["ART-mid"] });
    add({
      scope_id: "TOS-006",
      event_type: "ARTIFACT_UPDATED",
      summary: "src changed",
      artifact: { id: "ART-src", content_hash: "bbb" },
    });
    const manifest = ledger.deriveArtifacts(RUN);
    const staleIds = manifest.stale.map((s: any) => s.id).sort();
    assert.deepEqual(staleIds, ["ART-leaf", "ART-mid"]);
  });

  it("DEPENDENCY_INVALIDATED on an ext: identity marks its consumers stale", () => {
    happyBase();
    register("ART-packet", { depends_on: ["ext:github:main@3c5a31c7"] });
    add({
      scope_id: "TOS-006",
      event_type: "DEPENDENCY_INVALIDATED",
      summary: "main moved",
      upstream: "ext:github:main@3c5a31c7",
    });
    assert.deepEqual(
      ledger.deriveArtifacts(RUN).stale.map((s: any) => s.id),
      ["ART-packet"]
    );
  });

  it("revalidation clears ONLY the artifact that cites the new upstream — no transitive forgiveness", () => {
    happyBase();
    register("ART-src", { content_hash: "aaa" });
    register("ART-mid", { depends_on: ["ART-src"] });
    register("ART-leaf", { depends_on: ["ART-mid"] });
    add({
      scope_id: "TOS-006",
      event_type: "ARTIFACT_UPDATED",
      summary: "src changed",
      artifact: { id: "ART-src", content_hash: "bbb" },
    });
    add({
      scope_id: "TOS-006",
      event_type: "DEPENDENCY_REVALIDATED",
      summary: "mid rechecked against new src",
      artifact: { id: "ART-mid" },
      upstream_identity: "ART-src@bbb",
    });
    const staleIds = ledger.deriveArtifacts(RUN).stale.map((s: any) => s.id);
    assert.deepEqual(staleIds, ["ART-leaf"]);
  });

  it("DEPENDENCY_REVALIDATED must cite the new upstream identity", () => {
    register("ART-a1");
    assert.throws(
      () =>
        add({
          scope_id: "TOS-006",
          event_type: "DEPENDENCY_REVALIDATED",
          summary: "vibes",
          artifact: { id: "ART-a1" },
        }),
      /explicitly cite the NEW upstream identity/
    );
  });

  it("a stale artifact blocks closeout until revalidated (§13: nothing stale integrates)", () => {
    happyBase();
    register("ART-src", { content_hash: "aaa" });
    register("ART-consumer", { depends_on: ["ART-src"] });
    add({
      scope_id: "TOS-006",
      event_type: "ARTIFACT_UPDATED",
      summary: "src changed",
      artifact: { id: "ART-src", content_hash: "bbb" },
    });
    add({
      scope_id: "TOS-PROGRAM",
      event_type: "MEMORY_RECONCILED",
      summary: "attempted reconcile",
      clean: false,
    });
    terminal();
    const result = closeout(RUN);
    assert.equal(result.complete, false);
    assert.match(result.blockers.join("\n"), /stale-dependency artifact/);
    assert.match(result.blockers.join("\n"), /ART-consumer/);
  });
});

describe("memory reconciliation gate (§47)", () => {
  it("MEMORY_RECONCILED requires a boolean verdict", () => {
    assert.throws(
      () =>
        add({
          scope_id: "TOS-PROGRAM",
          event_type: "MEMORY_RECONCILED",
          summary: "ceremony",
        }),
      /clean: true\|false/
    );
  });

  it("claiming clean:true with stale artifacts outstanding is REFUSED at append; a forged claim is a verify violation", () => {
    happyBase();
    register("ART-src", { content_hash: "aaa" });
    register("ART-consumer", { depends_on: ["ART-src"] });
    add({
      scope_id: "TOS-006",
      event_type: "ARTIFACT_UPDATED",
      summary: "src changed",
      artifact: { id: "ART-src", content_hash: "bbb" },
    });
    assert.throws(
      () =>
        add({
          scope_id: "TOS-PROGRAM",
          event_type: "MEMORY_RECONCILED",
          summary: "false cleanliness",
          clean: true,
        }),
      /clean:true refused: 1 stale artifact/
    );
    forgeAppend({
      scope_id: "TOS-PROGRAM",
      event_type: "MEMORY_RECONCILED",
      summary: "forged cleanliness",
      clean: true,
    });
    const result = ledger.verifyRun(RUN);
    assert.equal(result.ok, false);
    assert.match(
      result.errors.join("\n"),
      /claims clean:true with 1 stale artifact/
    );
  });

  it("claiming clean:true over a forged registry defect is a verify violation (problems branch)", () => {
    happyBase();
    register("ART-a1");
    // Forge a double registration (zero staleness, pure registry problem)…
    forgeAppend({
      scope_id: "TOS-006",
      event_type: "ARTIFACT_REGISTERED",
      summary: "forged duplicate",
      artifact: {
        id: "ART-a1",
        uri: "reports/ART-a1.md",
        artifact_type: "report",
        storage_class: "external",
      },
    });
    // …then a forged clean:true over it.
    forgeAppend({
      scope_id: "TOS-PROGRAM",
      event_type: "MEMORY_RECONCILED",
      summary: "forged cleanliness over a defect",
      clean: true,
    });
    const result = ledger.verifyRun(RUN);
    assert.equal(result.ok, false);
    assert.match(
      result.errors.join("\n"),
      /claims clean:true with registry defect/
    );
  });

  it("memory mutated AFTER the last clean reconcile blocks closeout", () => {
    happyBase();
    register("ART-a1");
    add({
      scope_id: "TOS-PROGRAM",
      event_type: "MEMORY_RECONCILED",
      summary: "clean point",
      clean: true,
    });
    register("ART-a2"); // mutation after the reconcile
    terminal();
    const result = closeout(RUN);
    assert.equal(result.complete, false);
    assert.match(
      result.blockers.join("\n"),
      /memory mutated after the last clean MEMORY_RECONCILED/
    );
  });

  it("COMPLETE is reachable with registered artifacts once reconciled clean at the end", () => {
    happyBase();
    register("ART-a1");
    add({
      scope_id: "TOS-PROGRAM",
      event_type: "MEMORY_RECONCILED",
      summary: "clean",
      clean: true,
    });
    terminal();
    const result = closeout(RUN);
    assert.deepEqual(result.blockers, []);
    assert.equal(result.complete, true);
    assert.equal(result.claims.artifacts.total, 1);
  });
});

describe("ephemeral hygiene (§6)", () => {
  it("ephemeral artifacts must be RETIRED before COMPLETE", () => {
    happyBase();
    add({
      scope_id: "TOS-006",
      event_type: "ARTIFACT_REGISTERED",
      summary: "scratch",
      artifact: {
        id: "ART-scratch",
        uri: "tmp/scratch.txt",
        artifact_type: "scratch",
        storage_class: "ephemeral",
      },
    });
    add({
      scope_id: "TOS-PROGRAM",
      event_type: "MEMORY_RECONCILED",
      summary: "clean of staleness but scratch alive",
      clean: true,
    });
    terminal();
    assert.match(
      closeout(RUN).blockers.join("\n"),
      /ephemeral artifact\(s\) not RETIRED/
    );
  });
});

describe("composition gap (§16)", () => {
  it("COMPOSITION_EVALUATED demands integration identity, components, and a controlled verdict", () => {
    assert.throws(
      () =>
        add({
          scope_id: "TOS-PROGRAM",
          event_type: "COMPOSITION_EVALUATED",
          summary: "no id",
          components: ["a", "b"],
          composition_verdict: "NO_GAP",
        }),
      /integration_id/
    );
    assert.throws(
      () =>
        add({
          scope_id: "TOS-PROGRAM",
          event_type: "COMPOSITION_EVALUATED",
          summary: "bad verdict",
          integration_id: "INT-1",
          components: ["a", "b"],
          composition_verdict: "PROBABLY_FINE",
        }),
      /composition_verdict/
    );
  });

  it("a composition verdict without evidence is refused — a bare NO_GAP is an assertion (R4)", () => {
    assert.throws(
      () =>
        add({
          scope_id: "TOS-PROGRAM",
          event_type: "COMPOSITION_EVALUATED",
          summary: "trust me, it composes",
          integration_id: "INT-1",
          components: ["a", "b"],
          composition_verdict: "NO_GAP",
        }),
      /must attach the evidence behind its verdict/
    );
  });

  it("an open gap blocks COMPLETE; only an evidence-backed NO_GAP re-evaluation of the SAME boundary clears it", () => {
    happyBase();
    add({
      scope_id: "TOS-PROGRAM",
      event_type: "COMPOSITION_EVALUATED",
      summary: "components green, composed state wrong",
      integration_id: "INT-kernel-contract",
      components: ["ledger.mjs", "tos-notion-context.mjs"],
      composition_verdict: "STATE_GAP",
      evidence: [{ type: "event", ref: "evt_00001" }],
    });
    terminal();
    assert.match(
      closeout(RUN).blockers.join("\n"),
      /composition gap\(s\) not closed: INT-kernel-contract=STATE_GAP/
    );
    add({
      scope_id: "TOS-PROGRAM",
      event_type: "COMPOSITION_EVALUATED",
      summary: "remediated and re-evaluated",
      integration_id: "INT-kernel-contract",
      components: ["ledger.mjs", "tos-notion-context.mjs"],
      composition_verdict: "NO_GAP",
      evidence: [{ type: "event", ref: "evt_00002" }],
    });
    const result = closeout(RUN);
    assert.deepEqual(result.blockers, []);
    assert.equal(result.claims.composition["INT-kernel-contract"], "NO_GAP");
  });

  it("a manifest-declared composition boundary must reach a terminal NO_GAP (R5)", () => {
    const manifestWithBoundary = {
      ...MANIFEST,
      required_compositions: ["INT-declared-boundary"],
    };
    writeFileSync(
      join(tmpRoot, RUN, "run-manifest.json"),
      JSON.stringify(manifestWithBoundary)
    );
    happyBase();
    terminal();
    assert.match(
      closeout(RUN).blockers.join("\n"),
      /required composition boundaries without a terminal NO_GAP: INT-declared-boundary/
    );
  });
});

describe("interaction graph (§14)", () => {
  it("derives produces/consumes/depends_on edges with exact identities", () => {
    happyBase();
    register("ART-src");
    register("ART-out", { depends_on: ["ART-src"] });
    add({
      scope_id: "LANE-0",
      event_type: "ARTIFACT_CONSUMED",
      summary: "lane reads src",
      artifact: { id: "ART-src" },
    });
    const graph = ledger.deriveInteractionGraph(RUN);
    const kinds = (kind: string) =>
      graph.edges.filter((e: any) => e.kind === kind);
    assert.ok(
      kinds("produces").some(
        (e: any) => e.from === "TOS-006" && e.to === "ART-src"
      )
    );
    assert.ok(
      kinds("consumes").some(
        (e: any) => e.from === "LANE-0" && e.to === "ART-src"
      )
    );
    assert.ok(
      kinds("depends_on").some(
        (e: any) => e.from === "ART-out" && e.to === "ART-src"
      )
    );
  });

  it("derives potential_conflict from two agents declaring the same write resource", () => {
    happyBase();
    for (const name of ["agent-a", "agent-b"]) {
      add({
        scope_id: "LANE-0",
        event_type: "SUBAGENT_STARTED",
        actor: { type: "agent", name, role: "impl" },
        scope_declaration: "scripts/one-shot/ledger.mjs",
        summary: `${name} dispatched`,
      });
      add({
        scope_id: "LANE-0",
        event_type: "SUBAGENT_COMPLETED",
        actor: { type: "agent", name, role: "impl" },
        summary: `${name} done`,
      });
    }
    const graph = ledger.deriveInteractionGraph(RUN);
    assert.equal(graph.potential_conflicts.length, 1);
    assert.deepEqual(graph.potential_conflicts[0].agents.sort(), [
      "agent-a",
      "agent-b",
    ]);
  });
});

describe("derived progress + loop detection (§10-§11)", () => {
  it("flags a repeated identical signature with no progress between (loop candidate)", () => {
    happyBase();
    for (let i = 0; i < 3; i += 1) {
      add({
        scope_id: "LANE-0",
        event_type: "GSTACK_STARTED",
        workflow: "investigate",
        summary: "same investigation again",
      });
    }
    const progress = ledger.deriveProgress(RUN);
    assert.equal(progress.loop_candidates.length, 1);
    assert.equal(progress.loop_candidates[0].repetitions, 3);
  });

  it("does not flag repetition when real progress interleaves", () => {
    happyBase();
    add({
      scope_id: "LANE-0",
      event_type: "GSTACK_STARTED",
      workflow: "investigate",
      summary: "same investigation again",
    });
    register("ART-found-something");
    add({
      scope_id: "LANE-0",
      event_type: "GSTACK_STARTED",
      workflow: "investigate",
      summary: "same investigation again",
    });
    register("ART-found-more");
    add({
      scope_id: "LANE-0",
      event_type: "GSTACK_STARTED",
      workflow: "investigate",
      summary: "same investigation again",
    });
    assert.deepEqual(ledger.deriveProgress(RUN).loop_candidates, []);
  });

  it("stall streak counts consecutive non-progress events against the manifest threshold", () => {
    happyBase();
    for (let i = 0; i < 4; i += 1) {
      add({
        scope_id: "LANE-0",
        event_type: "TEST_STARTED",
        summary: `dispatch ${i}`,
      });
    }
    const progress = ledger.deriveProgress(RUN);
    assert.equal(progress.stall_breached, true);
    assert.equal(progress.longest_no_progress_streak.length, 4);
  });
});

describe("refutation regressions (kernel v4.1)", () => {
  it("R1: revalidation citing the DEAD identity is refused — the citation authenticates against the recorded cause", () => {
    happyBase();
    register("ART-src", { content_hash: "aaa" });
    register("ART-consumer", { depends_on: ["ART-src"] });
    add({
      scope_id: "TOS-006",
      event_type: "ARTIFACT_UPDATED",
      summary: "src changed",
      artifact: { id: "ART-src", content_hash: "bbb" },
    });
    assert.throws(
      () =>
        add({
          scope_id: "TOS-006",
          event_type: "DEPENDENCY_REVALIDATED",
          summary: "laundering with the old identity",
          artifact: { id: "ART-consumer" },
          upstream_identity: "ART-src@aaa",
        }),
      /does not authenticate against its stale cause/
    );
    assert.throws(
      () =>
        add({
          scope_id: "TOS-006",
          event_type: "DEPENDENCY_REVALIDATED",
          summary: "laundering with an unrelated string",
          artifact: { id: "ART-consumer" },
          upstream_identity: "totally-unrelated-thing",
        }),
      /does not authenticate against its stale cause/
    );
    // The genuine new identity clears.
    add({
      scope_id: "TOS-006",
      event_type: "DEPENDENCY_REVALIDATED",
      summary: "rechecked against the new bytes",
      artifact: { id: "ART-consumer" },
      upstream_identity: "ART-src@bbb",
    });
    assert.deepEqual(ledger.deriveArtifacts(RUN).stale, []);
  });

  it("R1b: revalidating a non-stale artifact is refused", () => {
    happyBase();
    register("ART-a1");
    assert.throws(
      () =>
        add({
          scope_id: "TOS-006",
          event_type: "DEPENDENCY_REVALIDATED",
          summary: "pre-emptive absolution",
          artifact: { id: "ART-a1" },
          upstream_identity: "ART-a1@fresh",
        }),
      /which is not stale/
    );
  });

  it("R2: registering AFTER an invalidation of a depended-on identity starts stale", () => {
    happyBase();
    add({
      scope_id: "TOS-006",
      event_type: "DEPENDENCY_INVALIDATED",
      summary: "upstream went bad first",
      upstream: "ext:github:pr:496@deadbeef",
    });
    register("ART-late", { depends_on: ["ext:github:pr:496@deadbeef"] });
    const stale = ledger.deriveArtifacts(RUN).stale;
    assert.equal(stale.length, 1);
    assert.equal(stale[0].id, "ART-late");
  });

  it("R2b: depending on a currently-stale or superseded artifact starts stale", () => {
    happyBase();
    register("ART-old");
    register("ART-new");
    add({
      scope_id: "TOS-006",
      event_type: "ARTIFACT_SUPERSEDED",
      summary: "old superseded",
      artifact: { id: "ART-old", superseded_by: "ART-new" },
    });
    register("ART-builds-on-old", { depends_on: ["ART-old"] });
    assert.ok(
      ledger
        .deriveArtifacts(RUN)
        .stale.some((s: any) => s.id === "ART-builds-on-old")
    );
  });

  it("R3: an update WITHOUT hashes cascades — omitting content_hash is no longer an opt-out", () => {
    happyBase();
    register("ART-src"); // no content_hash
    register("ART-consumer", { depends_on: ["ART-src"] });
    add({
      scope_id: "TOS-006",
      event_type: "ARTIFACT_UPDATED",
      summary: "repointed with no hash evidence",
      artifact: { id: "ART-src", uri: "reports/ART-src.md" },
    });
    assert.ok(
      ledger
        .deriveArtifacts(RUN)
        .stale.some((s: any) => s.id === "ART-consumer")
    );
  });

  it("R3b: an update proving an UNCHANGED hash does not cascade", () => {
    happyBase();
    register("ART-src", { content_hash: "aaa" });
    register("ART-consumer", { depends_on: ["ART-src"] });
    add({
      scope_id: "TOS-006",
      event_type: "ARTIFACT_UPDATED",
      summary: "metadata-only update, bytes proven unchanged",
      artifact: { id: "ART-src", content_hash: "aaa" },
    });
    assert.deepEqual(ledger.deriveArtifacts(RUN).stale, []);
  });

  it("R9a: supersession cascades staleness to consumers of the superseded artifact", () => {
    happyBase();
    register("ART-old");
    register("ART-consumer", { depends_on: ["ART-old"] });
    register("ART-new");
    add({
      scope_id: "TOS-006",
      event_type: "ARTIFACT_SUPERSEDED",
      summary: "old superseded",
      artifact: { id: "ART-old", superseded_by: "ART-new" },
    });
    assert.ok(
      ledger
        .deriveArtifacts(RUN)
        .stale.some((s: any) => s.id === "ART-consumer")
    );
  });

  it("R9b: retirement cascades staleness to consumers of the retired artifact", () => {
    happyBase();
    register("ART-input");
    register("ART-consumer", { depends_on: ["ART-input"] });
    add({
      scope_id: "TOS-006",
      event_type: "ARTIFACT_RETIRED",
      summary: "input retired",
      artifact: { id: "ART-input" },
    });
    assert.ok(
      ledger
        .deriveArtifacts(RUN)
        .stale.some((s: any) => s.id === "ART-consumer")
    );
  });

  it("R9c: DEPENDENCY_INVALIDATED on an ART- id cascades to its consumers", () => {
    happyBase();
    register("ART-input");
    register("ART-consumer", { depends_on: ["ART-input"] });
    add({
      scope_id: "TOS-006",
      event_type: "DEPENDENCY_INVALIDATED",
      summary: "input formally invalidated",
      upstream: "ART-input",
    });
    assert.ok(
      ledger
        .deriveArtifacts(RUN)
        .stale.some((s: any) => s.id === "ART-consumer")
    );
  });

  it("R6: repeated weak-progress events stop resetting the stall clock (progress-wash)", () => {
    happyBase();
    // Wash pattern: dispatch + varied-evidence CONTEXT_VERIFIED, repeated.
    for (let i = 0; i < 4; i += 1) {
      add({
        scope_id: "LANE-0",
        event_type: "TEST_STARTED",
        summary: "same retry",
      });
      add({
        scope_id: "LANE-0",
        event_type: "CONTEXT_VERIFIED",
        summary: `probe ${i}`,
        evidence: [{ type: "url", ref: `https://github.com/x/y/pull/${i}` }],
      });
    }
    const progress = ledger.deriveProgress(RUN);
    // First CONTEXT_VERIFIED on LANE-0 counts; the repeats do not.
    assert.equal(progress.stall_breached, true);
  });

  it("R7a: a committed-class artifact with a fabricated content_hash blocks closeout", () => {
    happyBase();
    add({
      scope_id: "TOS-006",
      event_type: "ARTIFACT_REGISTERED",
      summary: "kernel copy with fabricated hash",
      artifact: {
        id: "ART-kernel-claim",
        uri: "scripts/one-shot/ledger.mjs",
        artifact_type: "kernel",
        storage_class: "committed",
        content_hash: "0".repeat(64),
      },
    });
    add({
      scope_id: "TOS-PROGRAM",
      event_type: "MEMORY_RECONCILED",
      summary: "reconciled (fidelity is a closeout gate, not staleness)",
      clean: true,
    });
    terminal();
    assert.match(
      closeout(RUN).blockers.join("\n"),
      /fidelity defect.*does not match actual/
    );
  });

  it("R7b: a ghost external uri inside the run dir blocks closeout", () => {
    happyBase();
    register("ART-ghost", { __skip_file: true });
    add({
      scope_id: "TOS-PROGRAM",
      event_type: "MEMORY_RECONCILED",
      summary: "reconciled",
      clean: true,
    });
    terminal();
    assert.match(
      closeout(RUN).blockers.join("\n"),
      /fidelity defect.*does not exist under its external root/
    );
  });

  it("R7c: two live artifacts claiming one uri block closeout", () => {
    happyBase();
    register("ART-one");
    register("ART-two", { uri: "reports/ART-one.md" });
    add({
      scope_id: "TOS-PROGRAM",
      event_type: "MEMORY_RECONCILED",
      summary: "reconciled",
      clean: true,
    });
    terminal();
    assert.match(
      closeout(RUN).blockers.join("\n"),
      /claimed by 2 live artifacts/
    );
  });

  it("R8: consuming while stale blocks closeout until the same scope re-consumes fresh bytes", () => {
    happyBase();
    register("ART-src", { content_hash: "aaa" });
    register("ART-consumer", { depends_on: ["ART-src"] });
    add({
      scope_id: "TOS-006",
      event_type: "ARTIFACT_UPDATED",
      summary: "src changed",
      artifact: { id: "ART-src", content_hash: "bbb" },
    });
    add({
      scope_id: "LANE-0",
      event_type: "ARTIFACT_CONSUMED",
      summary: "consumed the poisoned artifact",
      artifact: { id: "ART-consumer" },
    });
    add({
      scope_id: "TOS-006",
      event_type: "DEPENDENCY_REVALIDATED",
      summary: "revalidated against new src",
      artifact: { id: "ART-consumer" },
      upstream_identity: "ART-src@bbb",
    });
    add({
      scope_id: "TOS-PROGRAM",
      event_type: "MEMORY_RECONCILED",
      summary: "staleness cleared",
      clean: true,
    });
    terminal();
    assert.match(
      closeout(RUN).blockers.join("\n"),
      /stale consumption\(s\) never repeated on fresh bytes: ART-consumer by LANE-0/
    );
    // The same scope re-consumes after revalidation → cleared.
    add({
      scope_id: "LANE-0",
      event_type: "ARTIFACT_CONSUMED",
      summary: "re-consumed on fresh bytes",
      artifact: { id: "ART-consumer" },
    });
    add({
      scope_id: "TOS-PROGRAM",
      event_type: "MEMORY_RECONCILED",
      summary: "clean after re-consumption",
      clean: true,
    });
    const result = closeout(RUN);
    assert.deepEqual(result.blockers, []);
  });

  it("F7: a memory-typed event stamped below v4 is refused as forged", () => {
    // validateEvent path — hand-build the event to control schema_version.
    assert.throws(
      () =>
        ledger.validateEvent(
          {
            schema_version: 3,
            event_id: "evt_00001",
            run_id: RUN,
            sequence: 1,
            timestamp: "2099-01-01T00:00:00Z",
            scope_id: "TOS-006",
            event_type: "ARTIFACT_REGISTERED",
            actor: ACTOR,
            label: "SUPPORTED",
            summary: "forged v3 artifact event",
            artifact: {
              id: "ART-forged",
              uri: "x",
              artifact_type: "t",
              storage_class: "external",
            },
          },
          MANIFEST
        ),
      /requires schema_version >= 4/
    );
  });
});

describe("owner-gate census (§24)", () => {
  it("classification vocabulary is controlled", () => {
    assert.throws(
      () =>
        add({
          scope_id: "TOS-PROGRAM",
          event_type: "OWNER_GATE_CREATED",
          summary: "gate",
          owner_gate: {
            id: "OG-001",
            decision: "d",
            owner: "PREZ",
            state: "OPEN",
            classification: "KINDA_BLOCKING",
          },
        }),
      /classification/
    );
  });

  it("closeout emits the census by class with exact ids — no prose reconstruction", () => {
    happyBase();
    add({
      scope_id: "TOS-PROGRAM",
      event_type: "OWNER_GATE_CREATED",
      summary: "blocking gate",
      owner_gate: {
        id: "OG-001",
        decision: "provision secrets",
        owner: "PREZ",
        state: "OPEN",
        classification: "RUN_BLOCKING",
      },
    });
    add({
      scope_id: "TOS-PROGRAM",
      event_type: "OWNER_GATE_CREATED",
      summary: "standing gate",
      owner_gate: {
        id: "OG-002",
        decision: "human merge approval stays human",
        owner: "PREZ",
        state: "OPEN",
        classification: "STANDING",
      },
    });
    add({
      scope_id: "TOS-PROGRAM",
      event_type: "OWNER_GATE_RESOLVED",
      summary: "resolved gate",
      owner_gate: {
        id: "OG-001",
        decision: "provisioned",
        owner: "PREZ",
        state: "ANSWERED",
      },
    });
    terminal();
    const census = closeout(RUN).denominators.owner_gate_census;
    assert.deepEqual(census.RESOLVED, ["OG-001"]);
    assert.deepEqual(census.STANDING, ["OG-002"]);
    assert.deepEqual(census.TOTAL_MINTED, ["OG-001", "OG-002"]);
    assert.deepEqual(census.RUN_BLOCKING, []);
  });
});
