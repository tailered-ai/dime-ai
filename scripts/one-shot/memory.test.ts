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

const register = (id: string, extra: any = {}) =>
  add({
    scope_id: "TOS-006",
    event_type: "ARTIFACT_REGISTERED",
    summary: `register ${id}`,
    artifact: {
      id,
      uri: `reports/${id}.md`,
      artifact_type: "report",
      storage_class: "external",
      ...extra,
    },
  });

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

  it("lifecycle events on an unregistered artifact are verify violations", () => {
    happyBase();
    add({
      scope_id: "TOS-006",
      event_type: "ARTIFACT_CONSUMED",
      summary: "consume ghost",
      artifact: { id: "ART-ghost" },
    });
    const result = ledger.verifyRun(RUN);
    assert.equal(result.ok, false);
    assert.match(result.errors.join("\n"), /never registered/);
  });

  it("double registration of one identity is refused", () => {
    happyBase();
    register("ART-a1");
    register("ART-a1");
    const result = ledger.verifyRun(RUN);
    assert.match(result.errors.join("\n"), /registered twice/);
  });

  it("consumption after retirement is a violation — retired means retired", () => {
    happyBase();
    register("ART-a1");
    add({
      scope_id: "TOS-006",
      event_type: "ARTIFACT_RETIRED",
      summary: "retire",
      artifact: { id: "ART-a1" },
    });
    add({
      scope_id: "TOS-006",
      event_type: "ARTIFACT_CONSUMED",
      summary: "consume the corpse",
      artifact: { id: "ART-a1" },
    });
    assert.match(
      ledger.verifyRun(RUN).errors.join("\n"),
      /consumed after retirement/
    );
  });

  it("supersession must name a registered successor", () => {
    happyBase();
    register("ART-a1");
    add({
      scope_id: "TOS-006",
      event_type: "ARTIFACT_SUPERSEDED",
      summary: "superseded by vapor",
      artifact: { id: "ART-a1", superseded_by: "ART-vapor" },
    });
    assert.match(
      ledger.verifyRun(RUN).errors.join("\n"),
      /unregistered ART-vapor/
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

  it("claiming clean:true with stale artifacts outstanding is a verify violation", () => {
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
      summary: "false cleanliness",
      clean: true,
    });
    const result = ledger.verifyRun(RUN);
    assert.equal(result.ok, false);
    assert.match(
      result.errors.join("\n"),
      /claims clean:true with 1 stale artifact/
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

  it("an open gap blocks COMPLETE; only a NO_GAP re-evaluation of the SAME boundary clears it", () => {
    happyBase();
    add({
      scope_id: "TOS-PROGRAM",
      event_type: "COMPOSITION_EVALUATED",
      summary: "components green, composed state wrong",
      integration_id: "INT-kernel-contract",
      components: ["ledger.mjs", "tos-notion-context.mjs"],
      composition_verdict: "STATE_GAP",
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
    });
    const result = closeout(RUN);
    assert.deepEqual(result.blockers, []);
    assert.equal(result.claims.composition["INT-kernel-contract"], "NO_GAP");
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
