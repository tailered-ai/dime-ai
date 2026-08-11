// TOS-009 live writer — OG-006 activation battery. Same standard as the
// kernel suites: drive the real deriveWrites/authorizeWrite/executeMutation
// path and prove every gate can FAIL. A writer that cannot refuse is the
// bypass the policy layer exists to prevent.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import assert from "node:assert/strict";
import { beforeEach, describe, it, vi } from "vitest";

// OG-006 Round 2. The writer no longer takes a manifest path, and human
// authority is no longer a caller string, so the two things a test is entitled
// to control are (a) what the canonical manifest says and (b) what the forge
// returned. Both are mocked at the MODULE boundary — below the authority
// boundary — and neither has a production equivalent: `authorizeWrite` has no
// manifest option and no transport option to pass.
const mocks = vi.hoisted(() => ({
  manifest: null as any,
  // A1: the grant check compares the bytes the LOADER read against the bytes at
  // the reviewed merge. Those are two independent facts about the world, so the
  // test drives them independently — the earlier fixture called the HEAD blob
  // "manifestOnDisk" and thereby encoded the same conflation the production bug
  // had, which is why 145 tests and 14 mutants all missed it.
  manifestFileBytes: null as any,
  tool: (_file: string, _args: string[]): string => "",
}));

vi.mock("../tailered-os-control-plane.mjs", async importActual => {
  const actual: any = await importActual();
  return { ...actual, loadControlPlaneManifest: () => mocks.manifest };
});
vi.mock("node:child_process", () => ({
  execFileSync: (file: string, args: string[]) => mocks.tool(file, args),
}));
vi.mock("node:fs", async importActual => {
  const actual: any = await importActual();
  return {
    ...actual,
    readFileSync: (path: any, ...rest: any[]) =>
      String(path).endsWith("tailered-os-control-plane.v1.json") &&
      mocks.manifestFileBytes !== null
        ? mocks.manifestFileBytes
        : actual.readFileSync(path, ...rest),
  };
});

import {
  CAPABILITY_TTL_MS,
  MAX_SNAPSHOT_AGE_MS,
  WHY_BLOCKED_PROPERTY,
  WRITE_ALLOWLIST,
  authorizeWrite,
  buildUndoPlan,
  deriveWrites,
  executeMutation,
} from "./lifecycle-writer.mjs";
import {
  TRANSITIONS,
  applyEvent,
  foldLifecycle,
  initialState,
} from "./lifecycle.mjs";
import { CONTROL_PLANE_MANIFEST_PATH } from "../tailered-os-control-plane.mjs";
import {
  ALLOWED_HUMAN_REVIEWERS,
  MACHINE_IDENTITIES,
  isAuthorityFact,
  resolveApprovalAuthority,
  resolveHeadAuthority,
  resolveHumanActAuthority,
  resolveMergeAuthority,
  resolveProofEvidence,
} from "./authority.mjs";

const TASK = "3b89673313e7815aafcaeaebc32ea8ff";
const HEAD = "a".repeat(40);
const MERGE = "b".repeat(40);
const PR = 507;
// The PR whose reviewed merge introduces the grant. The writer authenticates
// this against the forge on every authorization, so a grant is only ever as
// good as a real approved merge.
const ACTIVATION_PR = 512;
const ACTIVATION_MERGE = "c".repeat(40);
const ACTIVATION_HEAD = "e".repeat(40);
const HUMAN = ALLOWED_HUMAN_REVIEWERS[0];
const MACHINE = MACHINE_IDENTITIES[0];
const REVIEW_ID = "4910681985";
const REVIEW_URL = `https://github.com/tailered-ai/dime-ai/pull/${PR}#pullrequestreview-${REVIEW_ID}`;
const MERGE_URL = `https://github.com/tailered-ai/dime-ai/pull/${PR}`;

const REPO_ROOT = join(__dirname, "..", "..");
const REAL_MANIFEST = JSON.parse(
  readFileSync(
    join(REPO_ROOT, "config/tailered-os-control-plane.v1.json"),
    "utf8"
  )
);
const PROJECT_ID = REAL_MANIFEST.notion.taileredOsProject.id;

const GRANT = Object.freeze({
  decision: "https://app.notion.com/p/3b99673313e781229b85f35a0b9f2966",
  grantedBy: "PREZ",
  grantedOn: "2026-08-11",
  actor: "AI-10",
  scope: "TOS-* Tasks, four properties",
  activationPullRequest: ACTIVATION_PR,
});

function manifestWith(safety: any) {
  return {
    ...REAL_MANIFEST,
    safety: { ...REAL_MANIFEST.safety, ...safety },
  };
}
const ARMED_MANIFEST = manifestWith({
  notionWriteOperationsAuthorized: true,
  notionWriteAuthorization: { ...GRANT },
});
const DISARMED_MANIFEST = manifestWith({
  notionWriteOperationsAuthorized: false,
  notionWriteAuthorization: undefined,
});
const SELF_GRANT_MANIFEST = manifestWith({
  notionWriteOperationsAuthorized: true,
  notionWriteAuthorization: undefined,
});

// The bytes the forge returned. Overriding a slice of this is how a test says
// "GitHub says the review was dismissed" — it never says "pretend it was
// approved", because that verdict is derived here, in production code.
type World = {
  pr?: any;
  reviews?: any[];
  reviewDecision?: string;
  rollup?: string;
  activation?: any;
  activationReviews?: any[];
  activationDecision?: string;
  manifestAtMerge?: string;
  manifestOnDisk?: string;
  ancestor?: boolean;
  comment?: any;
  resource?: any;
};

function installWorld(world: World = {}) {
  const manifestText = JSON.stringify(ARMED_MANIFEST);
  const pr = {
    number: PR,
    state: "closed",
    merged: true,
    merge_commit_sha: MERGE,
    merged_at: "2026-08-11T20:56:29Z",
    merged_by: { login: HUMAN },
    head: { sha: HEAD },
    base: { ref: "main" },
    user: { login: MACHINE },
    ...world.pr,
  };
  const reviews = world.reviews ?? [
    {
      id: REVIEW_ID,
      state: "APPROVED",
      commit_id: HEAD,
      user: { login: HUMAN },
      submitted_at: "2026-08-11T20:56:23Z",
    },
  ];
  const activation = {
    number: ACTIVATION_PR,
    state: "closed",
    merged: true,
    merge_commit_sha: ACTIVATION_MERGE,
    merged_at: "2026-08-11T21:30:00Z",
    merged_by: { login: HUMAN },
    head: { sha: ACTIVATION_HEAD },
    base: { ref: "main" },
    user: { login: MACHINE },
    ...world.activation,
  };
  const activationReviews = world.activationReviews ?? [
    {
      id: "9001",
      state: "APPROVED",
      commit_id: ACTIVATION_HEAD,
      user: { login: HUMAN },
      submitted_at: "2026-08-11T21:29:00Z",
    },
  ];

  mocks.tool = (file: string, args: string[]) => {
    const line = args.join(" ");
    if (file === "git") {
      if (line.includes("merge-base")) {
        if (world.ancestor === false) throw new Error("not an ancestor");
        return "";
      }
      if (line.includes("cat-file"))
        return world.manifestAtMerge ?? manifestText;
      if (line.includes("show")) return world.manifestOnDisk ?? manifestText;
      throw new Error(`unexpected git call: ${line}`);
    }
    if (file !== "gh") throw new Error(`unexpected tool: ${file}`);
    if (line.includes("graphql")) {
      const forActivation = line.includes(`number=${ACTIVATION_PR}`);
      if (line.includes("statusCheckRollup"))
        return JSON.stringify({
          data: {
            repository: {
              pullRequest: {
                commits: {
                  nodes: [
                    {
                      commit: {
                        statusCheckRollup: { state: world.rollup ?? "SUCCESS" },
                      },
                    },
                  ],
                },
              },
            },
          },
        });
      return JSON.stringify({
        data: {
          repository: {
            pullRequest: {
              reviewDecision: forActivation
                ? (world.activationDecision ?? "APPROVED")
                : (world.reviewDecision ?? "APPROVED"),
            },
          },
        },
      });
    }
    if (line.includes(`/pulls/${ACTIVATION_PR}/reviews`))
      return JSON.stringify(activationReviews);
    if (line.includes(`/pulls/${ACTIVATION_PR}`))
      return JSON.stringify(activation);
    if (line.includes("/reviews")) return JSON.stringify(reviews);
    if (line.includes("/issues/comments/"))
      return JSON.stringify(world.comment ?? {});
    if (line.includes("/actions/runs/") || line.includes("/commits/"))
      return JSON.stringify(world.resource ?? {});
    if (line.includes("/pulls/")) return JSON.stringify(world.resource ?? pr);
    throw new Error(`unexpected gh call: ${line}`);
  };
}

beforeEach(() => {
  mocks.manifest = ARMED_MANIFEST;
  mocks.manifestFileBytes = JSON.stringify(ARMED_MANIFEST);
  installWorld();
});

// Harness-only markers. The writer has no manifest option; these tell the TEST
// which canonical manifest to put on disk before calling it.
const ARMED: any = {};
const DISARMED: any = { __manifest: "disarmed" };
const SELF_GRANTED: any = { __manifest: "selfgrant" };

function applyManifestMarker(opts: any) {
  const { __manifest, ...rest } = opts ?? {};
  if (__manifest === "disarmed") {
    mocks.manifest = DISARMED_MANIFEST;
    mocks.manifestFileBytes = JSON.stringify(DISARMED_MANIFEST);
  } else if (__manifest === "selfgrant") {
    mocks.manifest = SELF_GRANT_MANIFEST;
    mocks.manifestFileBytes = JSON.stringify(SELF_GRANT_MANIFEST);
  }
  return rest;
}

function approvalFact(world: World = {}) {
  installWorld(world);
  const resolved: any = resolveApprovalAuthority({
    repository: "tailered-ai/dime-ai",
    pr_number: PR,
    review_id: REVIEW_ID,
  });
  return resolved;
}
function mergeFact(world: World = {}) {
  installWorld(world);
  return resolveMergeAuthority({
    repository: "tailered-ai/dime-ai",
    pr_number: PR,
  }) as any;
}
function headFact(world: World = {}) {
  installWorld(world);
  return resolveHeadAuthority({
    repository: "tailered-ai/dime-ai",
    pr_number: PR,
  }) as any;
}

const fresh = () => Date.now() - 1_000;

const ev = (type: string, evidence: any = {}, extra: any = {}) => ({
  event_key: extra.event_key ?? `${type}-k`,
  task_id: TASK,
  type,
  actor: extra.actor ?? "machine",
  at: "2026-08-11T00:00:00Z",
  evidence,
});

// Fold up to a state + take the last applied record — plans always come from
// the kernel, never hand-built (mirrors production use).
function recordFor(events: any[]) {
  const { state, records, refusals } = foldLifecycle(events, TASK);
  assert.equal(refusals.length, 0, JSON.stringify(refusals));
  return { state, record: records[records.length - 1] };
}

const START = [
  ev("work_started", {
    packet_ref: "packet-1",
    work_link: "https://github.com/tailered-ai/dime-ai/tree/feat/x",
  }),
];

function snapshotFor(plan: any, over: any = {}) {
  return {
    page_id: plan.task_id,
    data_source_id: WRITE_ALLOWLIST.data_source_id,
    scope_id: "TOS-TEST",
    project_ids: [PROJECT_ID],
    execution_state: plan.expected_from_state,
    pending_partial_write: false,
    fetched_at: fresh(),
    properties: {
      "Execution State": plan.expected_from_state,
      "Work Link": "",
      "Proof / Result": "",
      [WHY_BLOCKED_PROPERTY]: "",
    },
    ...over,
  };
}

function authorize(plan: any, over: any = {}, opts: any = {}) {
  return authorizeWrite(
    plan,
    snapshotFor(plan, over),
    applyManifestMarker(opts)
  );
}

// A well-behaved fake transport backed by a mutable record.
function fakeTransport(initial: any, identity: any = {}) {
  const record = { ...initial };
  return {
    record,
    calls: { update: 0, fetch: 0 },
    async updatePage(_pageId: string, props: any) {
      this.calls.update += 1;
      Object.assign(record, props);
    },
    // R2-04: the writer re-verifies confinement against what the transport
    // reports BEFORE writing, so a fake must answer for the page's identity —
    // not just its properties.
    async fetchTask(pageId: string) {
      this.calls.fetch += 1;
      return {
        page_id: pageId,
        data_source_id: WRITE_ALLOWLIST.data_source_id,
        scope_id: "TOS-TEST",
        project_ids: [PROJECT_ID],
        properties: { ...record },
        fetched_at: Date.now(),
        ...identity,
      };
    },
  };
}

describe("writer PLAN — derivation is a closed table", () => {
  it("derives Execution State + Work Link for work_started", () => {
    const { state, record } = recordFor(START);
    const derived: any = deriveWrites(record, state);
    assert.equal(derived.ok, true);
    assert.equal(derived.plan.writes["Execution State"], "Executing");
    assert.match(derived.plan.writes["Work Link"], /^https:\/\/github\.com\//);
    assert.equal(derived.plan.expected_from_state, "Ready");
    assert.equal(derived.plan.event_key, record.event_key);
  });

  it("post_merge_verified requires a resolvable https proof for the live write", () => {
    const { state, record } = recordFor(START);
    const fake = {
      ...record,
      trigger: "post_merge_verified",
      evidence: { evidence_ref: "not-a-url" },
    };
    const derived: any = deriveWrites(fake, state);
    assert.equal(derived.ok, false);
    assert.equal(derived.failure_class, "malformed_input");
  });

  it("blocked routing writes the failure class into Why It's Blocked; unblock clears it", () => {
    const blockedEvents = [
      ...START,
      ev("failure_observed", {
        failure_class: "ci_failure",
        detail_ref: "run-123",
      }),
    ];
    const { state, record } = recordFor(blockedEvents);
    const derived: any = deriveWrites(record, state);
    assert.equal(derived.ok, true);
    assert.equal(derived.plan.writes["Execution State"], "Blocked");
    assert.match(
      derived.plan.writes[WHY_BLOCKED_PROPERTY],
      /^ci_failure: run-123/
    );

    const unblocked = [
      ...blockedEvents,
      ev(
        "unblocked",
        { resolution_ref: "fixed", observed_via: "owner note" },
        { actor: "human" }
      ),
    ];
    const after = recordFor(unblocked);
    const cleared: any = deriveWrites(after.record, after.state);
    assert.equal(cleared.ok, true);
    assert.equal(cleared.plan.writes[WHY_BLOCKED_PROPERTY], "");
  });

  it("writer-bookkeeping events never imply a live write", () => {
    const { state, record } = recordFor(START);
    const derived: any = deriveWrites(
      { ...record, trigger: "mutation_result" },
      state
    );
    assert.equal(derived.ok, false);
  });
});

describe("writer AUTHORIZE — the sixteen pre-write gates fail closed", () => {
  const planFor = (events = START) => {
    const { state, record } = recordFor(events);
    const derived: any = deriveWrites(record, state);
    assert.equal(derived.ok, true);
    return derived.plan;
  };

  it("authorizes the valid Ready → Executing mutation (happy path)", () => {
    const result: any = authorize(planFor());
    assert.equal(result.ok, true);
    assert.equal(result.duplicate, false);
    assert.equal(result.authorized_plan.prior["Execution State"], "Ready");
    assert.equal(
      result.authorized_plan.target.data_source_id,
      WRITE_ALLOWLIST.data_source_id
    );
  });

  it("kill switch: the COMMITTED manifest is disarmed, so the default path refuses every write", () => {
    // The REAL committed manifest — not a fixture. This is what a caller gets,
    // and it is the proof that nothing ships armed.
    assert.equal(REAL_MANIFEST.safety.notionWriteOperationsAuthorized, false);
    mocks.manifest = REAL_MANIFEST;
    mocks.manifestFileBytes = JSON.stringify(REAL_MANIFEST);
    const shipped: any = authorizeWrite(planFor(), snapshotFor(planFor()), {});
    assert.equal(shipped.ok, false);
    assert.equal(shipped.failure_class, "permission_denial");
    assert.match(shipped.detail, /notion-write-unauthorized/);

    const result: any = authorize(planFor(), {}, DISARMED);
    assert.equal(result.ok, false);
    assert.equal(result.failure_class, "permission_denial");
    assert.match(result.detail, /notion-write-unauthorized/);
  });

  it("duplicate event_key is a visible idempotent no-op — never a second mutation", () => {
    const plan = planFor();
    const result: any = authorize(
      plan,
      {},
      {
        attested_event_keys: new Set([plan.event_key]),
      }
    );
    assert.equal(result.ok, true);
    assert.equal(result.duplicate, true);
    assert.equal(result.failure_class, "duplicate_event");
    assert.equal(result.authorized_plan, undefined);
  });

  it("stale snapshot age refuses (reread before acting)", () => {
    const result: any = authorize(planFor(), {
      fetched_at: Date.now() - MAX_SNAPSHOT_AGE_MS - 5_000,
    });
    assert.equal(result.ok, false);
    assert.equal(result.failure_class, "stale_task");
  });

  it("unprovable freshness refuses — missing fetched_at is stale, not fresh", () => {
    const result: any = authorize(planFor(), { fetched_at: undefined });
    assert.equal(result.ok, false);
    assert.equal(result.failure_class, "stale_task");
  });

  it("live state drift refuses: snapshot state ≠ expected from-state", () => {
    const result: any = authorize(planFor(), {
      execution_state: "PR Open",
      properties: {
        "Execution State": "PR Open",
        "Work Link": "",
        "Proof / Result": "",
        [WHY_BLOCKED_PROPERTY]: "",
      },
    });
    assert.equal(result.ok, false);
    assert.equal(result.failure_class, "stale_task");
    assert.match(result.detail, /the record moved/);
  });

  it("NEW3-OG6-0023: a snapshot that disagrees with itself is refused — priors cannot be captured from a lie", () => {
    // execution_state says Ready (passing the from-state gate) while the
    // property the priors are captured from says Merged. Two ordinary machine
    // calls used to turn that into a live "Merged" via the undo path.
    const result: any = authorize(planFor(), {
      execution_state: "Ready",
      properties: {
        "Execution State": "Merged",
        "Work Link": "",
        "Proof / Result": "",
        [WHY_BLOCKED_PROPERTY]: "",
      },
    });
    assert.equal(result.ok, false);
    assert.equal(result.failure_class, "stale_task");
    assert.match(result.detail, /internally inconsistent/);
  });

  it("cross-database write refuses (wrong data source)", () => {
    const result: any = authorize(planFor(), { data_source_id: "deadbeef" });
    assert.equal(result.ok, false);
    assert.equal(result.failure_class, "permission_denial");
  });

  it("cross-task write refuses (non-TOS scope id)", () => {
    const result: any = authorize(planFor(), { scope_id: "DIME-42" });
    assert.equal(result.ok, false);
    assert.equal(result.failure_class, "permission_denial");
  });

  it("cross-project write refuses (task outside the canonical project)", () => {
    const result: any = authorize(planFor(), { project_ids: ["f".repeat(32)] });
    assert.equal(result.ok, false);
    assert.equal(result.failure_class, "permission_denial");
  });

  it("human-authority transitions demand an observed human act — machine actor hard-fails", () => {
    const events = [
      ...START,
      ev("pr_opened", { pr_number: 507, head_sha: HEAD }),
      ev("checks_observed", { head_sha: HEAD, check_rollup: "success" }),
      ev("review_requested", { review_ref: "rr-1" }),
      ev(
        "approval_observed",
        {
          reviewer: "PREZ",
          review_id: "R-1",
          review_state: "APPROVED",
          observed_via: "gh api pulls/507/reviews",
        },
        { actor: "human" }
      ),
    ];
    const plan = planFor(events);
    // Tamper: claim the approval was machine-actored (spoofed observation).
    const spoofed = { ...plan, actor: "machine" };
    const result: any = authorize(spoofed);
    assert.equal(result.ok, false);
    assert.equal(result.failure_class, "authority_violation");

    // Tamper: strip the observed_via evidence.
    const unobserved = {
      ...plan,
      evidence: { ...plan.evidence, observed_via: "" },
    };
    const result2: any = authorize(unobserved);
    assert.equal(result2.ok, false);
    assert.equal(result2.failure_class, "authority_violation");
  });

  it("plans cannot reinterpret authority — a human row claimed as machine refuses", () => {
    const events = [
      ...START,
      ev("pr_opened", { pr_number: 507, head_sha: HEAD }),
      ev("checks_observed", { head_sha: HEAD, check_rollup: "success" }),
      ev("review_requested", { review_ref: "rr-1" }),
      ev(
        "approval_observed",
        {
          reviewer: "PREZ",
          review_id: "R-1",
          review_state: "APPROVED",
          observed_via: "gh api pulls/507/reviews",
        },
        { actor: "human" }
      ),
    ];
    const plan = planFor(events);
    const tampered = { ...plan, authority: "machine" };
    const result: any = authorize(tampered);
    assert.equal(result.ok, false);
    assert.equal(result.failure_class, "authority_violation");
  });

  it("pr/merge-evidence writes demand a LIVE GitHub cross-check; stale SHA refuses", () => {
    const events = [
      ...START,
      ev("pr_opened", { pr_number: 507, head_sha: HEAD }),
    ];
    const plan = planFor(events);
    // No live cross-check provided at all → refuse.
    const missing: any = authorize(plan);
    assert.equal(missing.ok, false);
    assert.equal(missing.failure_class, "authority_violation");
    // Live head moved → stale_sha. The "live" head is what the forge returned,
    // not what the caller said it was.
    const moved: any = headFact({ pr: { head: { sha: "c".repeat(40) } } });
    assert.equal(moved.ok, true);
    const stale: any = authorize(plan, {}, { github_fact: moved.fact });
    assert.equal(stale.ok, false);
    assert.equal(stale.failure_class, "stale_sha");
    // Matching live head → authorized.
    const current: any = headFact();
    const ok: any = authorize(plan, {}, { github_fact: current.fact });
    assert.equal(ok.ok, true);
  });

  it("superseded merge evidence refuses against live GitHub", () => {
    const events = [
      ...START,
      ev("pr_opened", { pr_number: 507, head_sha: HEAD }),
      ev("checks_observed", { head_sha: HEAD, check_rollup: "success" }),
      ev("review_requested", { review_ref: "rr-1" }),
      ev(
        "approval_observed",
        {
          reviewer: "PREZ",
          review_id: "R-1",
          review_state: "APPROVED",
          observed_via: "gh api pulls/507/reviews",
        },
        { actor: "human" }
      ),
      ev(
        "merge_observed",
        { merge_sha: MERGE, observed_via: "gh pr view 507" },
        { actor: "human" }
      ),
    ];
    const plan = planFor(events);
    // The forge reports a DIFFERENT merge commit than the plan claims. The
    // authenticated fact wins; the plan's merge_sha is not evidence.
    const other: any = mergeFact({ pr: { merge_commit_sha: "d".repeat(40) } });
    assert.equal(other.ok, true);
    const stale: any = authorize(plan, {}, { authority_fact: other.fact });
    assert.equal(stale.ok, false);
    assert.equal(stale.failure_class, "authority_violation");
    assert.match(stale.detail, /the source system decides/);
  });

  it("non-allowlisted property refuses — the writer cannot be steered off-allowlist", () => {
    const plan = planFor();
    const tampered = {
      ...plan,
      writes: { ...plan.writes, Owner: "attacker" },
    };
    const result: any = authorize(tampered);
    assert.equal(result.ok, false);
    assert.equal(result.failure_class, "permission_denial");
    assert.match(result.detail, /not allowlisted/);
  });

  it("off-vocabulary Execution State and credential-shaped values refuse", () => {
    const plan = planFor();
    const badState: any = authorize({
      ...plan,
      writes: { "Execution State": "Approved-by-bot" },
    });
    assert.equal(badState.ok, false);

    const secretish: any = authorize({
      ...plan,
      writes: { ...plan.writes, "Work Link": "https://x.test/sk_live_abcdef" },
    });
    assert.equal(secretish.ok, false);
  });

  it("unresolved partial-write freeze blocks all writes until reverified", () => {
    const result: any = authorize(
      planFor(),
      {},
      { pending_partial_write: true }
    );
    assert.equal(result.ok, false);
    assert.equal(result.failure_class, "partial_write");
  });

  it("unresolved connector failure (expired credentials) blocks all writes", () => {
    const result: any = authorize(
      planFor(),
      {},
      {
        connector_failure: {
          failure_class: "expired_credentials",
          detail: "OAuth token expired at 12:00Z",
        },
      }
    );
    assert.equal(result.ok, false);
    assert.equal(result.failure_class, "expired_credentials");
  });
});

describe("writer EXECUTE — write / reread / compare / attest", () => {
  const authorizedPlan = (events = START, opts: any = {}) => {
    const { state, record } = recordFor(events);
    const derived: any = deriveWrites(record, state);
    const result: any = authorize(derived.plan, opts.snapshot ?? {}, opts);
    assert.equal(result.ok, true, JSON.stringify(result));
    return result.authorized_plan;
  };

  it("refuses to execute a plan that never passed authorizeWrite", async () => {
    const { state, record } = recordFor(START);
    const derived: any = deriveWrites(record, state);
    await assert.rejects(
      () => executeMutation(derived.plan, fakeTransport({})),
      /writer-unauthorized-plan/
    );
  });

  it("full write: transport lands every property, reread matches, attestation says full", async () => {
    const plan = authorizedPlan();
    const transport = fakeTransport({
      "Execution State": "Ready",
      "Work Link": "",
      "Proof / Result": "",
      [WHY_BLOCKED_PROPERTY]: "",
    });
    const result = await executeMutation(plan, transport);
    assert.equal(result.applied, "full");
    assert.equal(transport.calls.update, 1);
    assert.equal(transport.calls.fetch, 2); // R2-04: confinement re-verify + reread
    assert.equal(
      result.attestation.observed_after["Execution State"],
      "Executing"
    );
    assert.equal(result.attestation.prior_values["Execution State"], "Ready");
    assert.equal(result.attestation.event_key, plan.event_key);
  });

  it("partial write: reread mismatch freezes — applied partial, mismatches named", async () => {
    const plan = authorizedPlan();
    const transport = fakeTransport({ "Execution State": "Ready" });
    // Sabotage: the transport silently drops the Work Link write.
    const realUpdate = transport.updatePage.bind(transport);
    transport.updatePage = async (pageId: string, props: any) => {
      const { "Work Link": _dropped, ...rest } = props;
      await realUpdate(pageId, rest);
    };
    const result = await executeMutation(plan, transport);
    assert.equal(result.applied, "partial");
    assert.equal(result.failure_class, "partial_write");
    assert.equal(result.attestation.mismatches.length, 1);
    assert.equal(result.attestation.mismatches[0].property, "Work Link");
  });

  it("permission denial before any byte lands: applied none, record verified unchanged", async () => {
    const plan = authorizedPlan();
    const transport = fakeTransport({
      "Execution State": "Ready",
      "Work Link": "",
    });
    transport.updatePage = async () => {
      const err: any = new Error("permission denied by connector");
      err.code = "permission_denied_403";
      throw err;
    };
    const result = await executeMutation(plan, transport);
    assert.equal(result.applied, "none");
    assert.equal(result.failure_class, "permission_denial");
    assert.equal(transport.record["Execution State"], "Ready");
  });

  it("timeout with unreadable outcome fails closed — never assumed success", async () => {
    // Two distinct timings, and R2-04 made the difference between them visible.
    // (a) the transport is unreachable BEFORE the write: the confinement
    //     re-verify cannot run, so nothing is written at all — "none".
    const plan = authorizedPlan();
    const dead = fakeTransport({});
    const timeout = () => {
      const err: any = new Error("ETIMEDOUT");
      err.code = "ETIMEDOUT";
      throw err;
    };
    dead.updatePage = async () => timeout();
    dead.fetchTask = async () => timeout();
    const before: any = await executeMutation(plan, dead);
    assert.equal(before.applied, "none");
    assert.equal(before.failure_class, "api_timeout");
    assert.match(before.attestation.detail, /could not be read before writing/);
    assert.equal(dead.calls.update, 0, "no write may be attempted");

    // (b) the reread fails AFTER the bytes may have landed: the outcome is
    //     unreadable, so it freezes as a partial write.
    const plan2 = authorizedPlan();
    const flaky = fakeTransport({});
    const inner = flaky.fetchTask.bind(flaky);
    let fetches = 0;
    flaky.fetchTask = async (pageId: string) => {
      fetches += 1;
      if (fetches === 1) return inner(pageId);
      return timeout();
    };
    flaky.updatePage = async () => timeout();
    const after: any = await executeMutation(plan2, flaky);
    assert.equal(after.applied, "partial");
    assert.equal(after.failure_class, "partial_write");
    assert.equal(after.attestation.reread_error, "api_timeout");
  });

  it("expired credentials are classified and visible", async () => {
    const plan = authorizedPlan();
    const transport = fakeTransport({
      "Execution State": "Ready",
      "Work Link": "",
    });
    transport.updatePage = async () => {
      const err: any = new Error("credential expired (401)");
      err.code = "401_expired_credentials";
      throw err;
    };
    const result = await executeMutation(plan, transport);
    assert.equal(result.applied, "none");
    assert.equal(result.failure_class, "expired_credentials");
  });

  it("undo plan writes the captured priors back (reversibility is concrete)", async () => {
    const plan = authorizedPlan();
    const undo: any = buildUndoPlan(plan);
    assert.equal(undo.ok, true);
    assert.equal(undo.plan.writes["Execution State"], "Ready");
    assert.equal(undo.plan.writes["Work Link"], "");
    assert.equal(undo.plan.expected_from_state, "Executing");
  });
});

// Adversarial-review regressions (independent refutation, 2026-08-11). Each of
// these FAILED against the pre-remediation writer; they are the proof the
// findings are closed, not the claim.
describe("writer v1.1 — adversarial regressions", () => {
  const planFor = (events = START) => {
    const { state, record } = recordFor(events);
    const derived: any = deriveWrites(record, state);
    assert.equal(derived.ok, true);
    return derived.plan;
  };

  it("FIND-OG6-0001: the authorized plan is DEEP-frozen and un-aliased — post-authorization tampering cannot reach the transport", async () => {
    const plan = planFor();
    const result: any = authorize(plan);
    const ap = result.authorized_plan;
    assert.equal(Object.isFrozen(ap), true);
    assert.equal(Object.isFrozen(ap.writes), true, "writes must be frozen");
    assert.equal(Object.isFrozen(ap.evidence), true, "evidence must be frozen");
    assert.equal(Object.isFrozen(ap.prior), true);
    // Un-aliased: mutating the ORIGINAL plan's writes must not touch the
    // authorized capability.
    plan.writes["Owner"] = "attacker";
    assert.equal(ap.writes.Owner, undefined);
    // And the frozen copy silently ignores (non-strict) or throws (strict) —
    // either way the value never appears.
    try {
      (ap.writes as any)["Owner"] = "attacker";
    } catch {
      /* strict-mode TypeError is the stronger outcome */
    }
    assert.equal(ap.writes.Owner, undefined);
    // End-to-end: the transport only ever sees allowlisted properties.
    const transport = fakeTransport({
      "Execution State": "Ready",
      "Work Link": "",
    });
    const sent: any[] = [];
    const inner = transport.updatePage.bind(transport);
    transport.updatePage = async (pageId: string, props: any) => {
      sent.push(props);
      await inner(pageId, props);
    };
    await executeMutation(ap, transport);
    assert.deepEqual(Object.keys(sent[0]).sort(), [
      "Execution State",
      "Work Link",
    ]);
  });

  it("FIND-OG6-0001b: a tampered plan reaching executeMutation throws writer-plan-tampered (trust-boundary re-validation)", async () => {
    const plan = planFor();
    const result: any = authorize(plan);
    // Simulate a serialize/queue/handoff that reconstitutes a mutable plan —
    // exactly the phased PLAN → AUTHORIZE → WRITE pattern the design implies.
    const rehydrated = {
      ...JSON.parse(JSON.stringify(result.authorized_plan)),
      prior: { ...result.authorized_plan.prior },
    };
    rehydrated.writes["Owner"] = "attacker";
    const transport = fakeTransport({ "Execution State": "Ready" });
    // Since v1.2 this is caught even earlier: a rehydrated plan is not the
    // registered capability, so authenticity fails before the tamper check
    // (which remains as belt-and-braces for a mutated capability).
    await assert.rejects(
      () => executeMutation(rehydrated, transport),
      /writer-unauthorized-plan|writer-plan-tampered/
    );
    assert.equal(transport.calls.update, 0, "nothing may be sent");
  });

  it("FIND-OG6-0002: prototype-chain property names are NOT allowlisted (own-property check)", () => {
    const plan = planFor();
    for (const name of [
      "__proto__",
      "constructor",
      "toString",
      "hasOwnProperty",
    ]) {
      const tampered = {
        ...plan,
        writes: JSON.parse(
          JSON.stringify({ ...plan.writes, [name]: "attacker" })
        ),
      };
      const result: any = authorize(tampered);
      assert.equal(result.ok, false, `${name} must refuse`);
      assert.equal(result.failure_class, "permission_denial");
    }
  });

  it("FIND-OG6-0003 / NEW-OG6-0007: authority comes from DISK — a caller cannot assert its own permission", () => {
    const plan = planFor();
    // There is no manifest parameter at all: the writer loads and validates the
    // control-plane manifest itself on every write. A self-granted file (bare
    // true, no owner grant) is refused because the loader rejects it.
    const selfGrant: any = authorize(plan, {}, SELF_GRANTED);
    assert.equal(selfGrant.ok, false);
    assert.equal(selfGrant.failure_class, "permission_denial");
    assert.match(selfGrant.detail, /self-grant|owner grant/);

    // NEW3-OG6-0027 / entry-bar item 2: the seam is GONE, not narrowed. Round 1
    // hardened `manifest_path` into "realpath, then confine to two directories";
    // it is now not an option at all, and naming it is a VISIBLE refusal rather
    // than a silent ignore — a silently-dropped option is how a seam comes back.
    for (const path of [
      "../../../tmp/forged-manifest.json",
      "/tmp/forged-manifest.json",
      "scripts/tailered-os/fixtures/control-plane-armed.v1.json",
      "config/tailered-os-control-plane.v1.json",
    ]) {
      const escaped: any = authorize(plan, {}, { manifest_path: path });
      assert.equal(escaped.ok, false, `${path} must refuse`);
      assert.equal(escaped.failure_class, "malformed_input");
      assert.match(escaped.detail, /unknown writer option/);
      assert.match(escaped.detail, /never caller-selectable/);
    }
    // Every other invented option is refused the same way, so the closure is a
    // rule about the option surface rather than a blocklist of one name.
    for (const key of [
      "manifest",
      "authority",
      "github",
      "transport",
      "force",
    ]) {
      const invented: any = authorize(plan, {}, { [key]: "anything" });
      assert.equal(invented.ok, false, `${key} must refuse`);
      assert.equal(invented.failure_class, "malformed_input");
    }
  });

  it("FIND-OG6-0004: the undo plan AUTHORIZES and executes through the same contract (reversibility is real)", async () => {
    // Do the forward write.
    const plan = planFor();
    const forward: any = authorize(plan);
    const transport = fakeTransport({
      "Execution State": "Ready",
      "Work Link": "",
      "Proof / Result": "",
      [WHY_BLOCKED_PROPERTY]: "",
    });
    const applied = await executeMutation(forward.authorized_plan, transport);
    assert.equal(applied.applied, "full");
    assert.equal(transport.record["Execution State"], "Executing");

    // Now undo it — same authorize gauntlet, no special path.
    const undo: any = buildUndoPlan(forward.authorized_plan);
    assert.equal(undo.ok, true);
    const undoAuth: any = authorizeWrite(
      undo.plan,
      {
        page_id: TASK,
        data_source_id: WRITE_ALLOWLIST.data_source_id,
        scope_id: "TOS-TEST",
        project_ids: [PROJECT_ID],
        execution_state: "Executing", // the state the forward write produced
        pending_partial_write: false,
        fetched_at: fresh(),
        properties: { ...transport.record },
      },
      { ...ARMED, undo_of: forward.authorized_plan }
    );
    assert.equal(undoAuth.ok, true, JSON.stringify(undoAuth));
    const undone = await executeMutation(undoAuth.authorized_plan, transport);
    assert.equal(undone.applied, "full");
    assert.equal(transport.record["Execution State"], "Ready");
    assert.equal(transport.record["Work Link"], "");
  });

  it("undo must be BOUND to a real prior authorization — write_reverified cannot launder arbitrary state", () => {
    const plan = planFor();
    const forward: any = authorize(plan);
    const liveSnapshot = {
      page_id: TASK,
      data_source_id: WRITE_ALLOWLIST.data_source_id,
      scope_id: "TOS-TEST",
      project_ids: [PROJECT_ID],
      execution_state: "Executing",
      pending_partial_write: false,
      fetched_at: fresh(),
      properties: {
        "Execution State": "Executing",
        "Work Link": "https://github.com/tailered-ai/dime-ai/tree/feat/x",
      },
    };

    // (a) An unbound undo — no opts.undo_of — refuses.
    const undo: any = buildUndoPlan(forward.authorized_plan);
    const unbound: any = authorizeWrite(undo.plan, liveSnapshot, ARMED);
    assert.equal(unbound.ok, false);
    assert.equal(unbound.failure_class, "permission_denial");

    // (b) A FORGED write_reverified that jumps the record straight to
    //     "Verified" — the sequencing-laundering attack — refuses even when it
    //     names a real prior authorization.
    const forged = {
      ...undo.plan,
      writes: { "Execution State": "Verified" },
    };
    const laundering: any = authorizeWrite(forged, liveSnapshot, {
      ...ARMED,
      undo_of: forward.authorized_plan,
    });
    assert.equal(laundering.ok, false);
    assert.equal(laundering.failure_class, "permission_denial");
    assert.match(laundering.detail, /restore EXACTLY the prior values/);

    // (c) A write_reverified that is not an undo at all refuses.
    const notAnUndo: any = authorizeWrite(
      { ...undo.plan, plan_id: "plan:sneaky" },
      liveSnapshot,
      { ...ARMED, undo_of: forward.authorized_plan }
    );
    assert.equal(notAnUndo.ok, false);

    // (d) The genuine bound undo still authorizes.
    const bound: any = authorizeWrite(undo.plan, liveSnapshot, {
      ...ARMED,
      undo_of: forward.authorized_plan,
    });
    assert.equal(bound.ok, true, JSON.stringify(bound));
  });
});

// Second independent-verification round (verdict FAIL) found the CLASS behind
// the HIGH was still open. These regressions cover its findings; each fails
// against the module the verifier attacked.
describe("writer v1.2 — independent-verification regressions", () => {
  const planFor = (events = START) => {
    const { state, record } = recordFor(events);
    const derived: any = deriveWrites(record, state);
    assert.equal(derived.ok, true);
    return derived.plan;
  };

  it("NEW-OG6-0005: a FORGED capability cannot execute — authenticity is registry membership, not object shape", async () => {
    const transport = fakeTransport({ "Execution State": "Ready" });
    // The exact shape the old check accepted: any object with a `prior` key.
    const forged = {
      schema_version: 1,
      plan_id: "plan:forged",
      event_key: "forged",
      task_id: TASK,
      trigger: "post_merge_verified",
      authority: "machine",
      actor: "machine",
      evidence: {},
      expected_from_state: "Merged",
      writes: {
        "Execution State": "Verified",
        "Proof / Result": "https://attacker.example/fake-proof",
      },
      prior: {},
      target: {
        data_source_id: WRITE_ALLOWLIST.data_source_id,
        page_id: "SOME-OTHER-PAGE",
      },
    };
    await assert.rejects(
      () => executeMutation(forged as any, transport),
      /writer-unauthorized-plan/
    );
    assert.equal(transport.calls.update, 0, "no byte may be sent");
    // A structural clone of a REAL capability is also not the capability.
    const real: any = authorize(planFor());
    const cloned = JSON.parse(JSON.stringify(real.authorized_plan));
    await assert.rejects(
      () => executeMutation(cloned, transport),
      /writer-unauthorized-plan/
    );
    assert.equal(transport.calls.update, 0);
  });

  it("NEW-OG6-0006: a getter/Proxy write map is read ONCE — it cannot show the validator one thing and the transport another", async () => {
    const plan = planFor();
    let reads = 0;
    const twoFaced: any = {};
    Object.defineProperty(twoFaced, "Execution State", {
      enumerable: true,
      get() {
        reads += 1;
        return reads === 1 ? "Executing" : "Verified";
      },
    });
    const result: any = authorize({ ...plan, writes: twoFaced });
    // Whatever the verdict, the capability must hold the value that was
    // validated — never a second, unvalidated read.
    if (result.ok) {
      assert.equal(
        result.authorized_plan.writes["Execution State"],
        "Executing"
      );
      const transport = fakeTransport({ "Execution State": "Ready" });
      const sent: any[] = [];
      const inner = transport.updatePage.bind(transport);
      transport.updatePage = async (pageId: string, props: any) => {
        sent.push({ ...props });
        await inner(pageId, props);
      };
      await executeMutation(result.authorized_plan, transport);
      assert.equal(sent[0]["Execution State"], "Executing");
    } else {
      assert.equal(result.failure_class, "permission_denial");
    }

    // A Proxy that adds a key only on the second ownKeys() cannot smuggle it.
    const sneaky = new Proxy(
      { "Execution State": "Executing" },
      {
        ownKeys(target) {
          reads += 1;
          return reads > 2
            ? [...Reflect.ownKeys(target), "Owner"]
            : Reflect.ownKeys(target);
        },
        getOwnPropertyDescriptor(target, key) {
          return key === "Owner"
            ? { value: "attacker", enumerable: true, configurable: true }
            : Reflect.getOwnPropertyDescriptor(target, key);
        },
        get(target, key) {
          return key === "Owner" ? "attacker" : (target as any)[key];
        },
      }
    );
    const proxied: any = authorize({ ...plan, writes: sneaky });
    if (proxied.ok) {
      assert.equal(
        Object.hasOwn(proxied.authorized_plan.writes, "Owner"),
        false,
        "a late-appearing key must never reach the capability"
      );
      const transport2 = fakeTransport({ "Execution State": "Ready" });
      const sent2: any[] = [];
      const inner2 = transport2.updatePage.bind(transport2);
      transport2.updatePage = async (pageId: string, props: any) => {
        sent2.push({ ...props });
        await inner2(pageId, props);
      };
      await executeMutation(proxied.authorized_plan, transport2);
      assert.equal(Object.hasOwn(sent2[0], "Owner"), false);
    }
  });

  it("NEW-OG6-0008: write_reverified is not a general write primitive — it cannot launder a record to Merged or Verified", () => {
    const plan = planFor();
    const forward: any = authorize(plan);
    for (const target of ["Verified", "Merged", "Approval"]) {
      const laundering = {
        ...plan,
        plan_id: "undo:plan:laundering",
        trigger: "write_reverified",
        authority: "machine",
        actor: "machine",
        evidence: { verification_ref: "x" },
        expected_from_state: "Ready",
        writes: { "Execution State": target },
      };
      const result: any = authorize(
        laundering,
        {},
        {
          undo_of: forward.authorized_plan,
        }
      );
      assert.equal(result.ok, false, `${target} must refuse`);
    }
  });

  it("NEW-OG6-0009: deepFreeze survives cycles and never freezes caller-owned graphs", () => {
    const plan = planFor();
    const shared: any = { keepMutable: true };
    shared.self = shared; // cycle
    const result: any = authorize({
      ...plan,
      evidence: { ...plan.evidence, shared },
    });
    assert.equal(result.ok, true);
    // No stack overflow, and the caller's object stays mutable.
    shared.keepMutable = false;
    assert.equal(shared.keepMutable, false);
    assert.equal(Object.isFrozen(shared), false);
  });

  it("NEW-OG6-0010: symbol-keyed writes are refused outright", () => {
    const plan = planFor();
    const withSymbol: any = { ...plan.writes };
    withSymbol[Symbol("Owner")] = "attacker";
    const result: any = authorize({ ...plan, writes: withSymbol });
    assert.equal(result.ok, false);
    assert.equal(result.failure_class, "malformed_input");
    assert.match(result.detail, /symbol-keyed/);
  });

  it("NEW-OG6-0011: an undo can restore a previously EMPTY select value", async () => {
    const plan = planFor();
    // Live record whose Execution State is empty (a fresh row).
    const emptySnapshot = {
      page_id: TASK,
      data_source_id: WRITE_ALLOWLIST.data_source_id,
      scope_id: "TOS-TEST",
      project_ids: [PROJECT_ID],
      execution_state: "Ready",
      pending_partial_write: false,
      fetched_at: fresh(),
      properties: { "Execution State": "", "Work Link": "" },
    };
    const forward: any = authorizeWrite(plan, emptySnapshot, ARMED);
    assert.equal(forward.ok, true, JSON.stringify(forward));
    assert.equal(forward.authorized_plan.prior["Execution State"], "");
    const undo: any = buildUndoPlan(forward.authorized_plan);
    const undoAuth: any = authorizeWrite(
      undo.plan,
      {
        ...emptySnapshot,
        execution_state: "Executing",
        fetched_at: fresh(),
        properties: {
          "Execution State": "Executing",
          "Work Link": plan.writes["Work Link"],
        },
      },
      { ...ARMED, undo_of: forward.authorized_plan }
    );
    assert.equal(undoAuth.ok, true, JSON.stringify(undoAuth));
    assert.equal(undoAuth.authorized_plan.writes["Execution State"], "");
  });

  it("NEW2-OG6-0014: the TRANSITION TABLE decides the target state — a machine plan cannot write Approval, Merged or Verified", async () => {
    const plan = planFor();
    // No Proxy, no forged capability: a plain machine work_started plan from
    // Ready that simply declares a different target state.
    for (const target of ["Merged", "Approval", "Verified", "Review", "CI"]) {
      const laundering = {
        ...plan,
        writes: { ...plan.writes, "Execution State": target },
      };
      const result: any = authorize(laundering);
      assert.equal(result.ok, false, `${target} must refuse`);
      assert.equal(result.failure_class, "authority_violation");
      assert.match(result.detail, /may only produce "Executing"/);
    }
    // The honest target still authorizes.
    assert.equal(authorize(plan).ok, true);
  });

  it("NEW2-OG6-0013: the plan is read ONCE — a getter cannot pass the gates for one page and write to another", async () => {
    const plan = planFor();
    let reads = 0;
    const twoFaced: any = { ...plan };
    Object.defineProperty(twoFaced, "task_id", {
      enumerable: true,
      get() {
        reads += 1;
        return reads === 1 ? TASK : "ffffffffffffffffffffffffffffffff";
      },
    });
    const result: any = authorize(twoFaced, {}, {});
    if (result.ok) {
      // Whatever happened, the capability must target the page the gates saw.
      assert.equal(result.authorized_plan.target.page_id, TASK);
      assert.equal(result.authorized_plan.task_id, TASK);
      const pages: string[] = [];
      const transport = {
        async updatePage(pageId: string) {
          pages.push(pageId);
        },
        async fetchTask() {
          return {
            properties: { ...result.authorized_plan.writes },
            fetched_at: Date.now(),
          };
        },
      };
      await executeMutation(result.authorized_plan, transport);
      assert.deepEqual(pages, [TASK], "the write must land on the gated page");
    } else {
      assert.equal(result.ok, false);
    }
  });

  it("NEW2-OG6-0015: a NaN freshness value or NaN bound cannot defeat the age gate", () => {
    const plan = planFor();
    const nanBound: any = authorize(
      plan,
      { fetched_at: Date.now() - 10 * 24 * 3600 * 1000 },
      { max_snapshot_age_ms: Number.NaN }
    );
    assert.equal(nanBound.ok, false);
    const nanFetched: any = authorize(plan, { fetched_at: Number.NaN });
    assert.equal(nanFetched.ok, false);
    assert.equal(nanFetched.failure_class, "stale_task");
  });

  it("NEW2-OG6-0017: a capability is SINGLE USE, time-bounded, and dies when the kill switch engages", async () => {
    const plan = planFor();
    const result: any = authorize(plan);
    const transport = fakeTransport({
      "Execution State": "Ready",
      "Work Link": "",
    });
    const first = await executeMutation(result.authorized_plan, transport);
    assert.equal(first.applied, "full");
    // Replay of the same capability is refused, not silently repeated.
    await assert.rejects(
      () => executeMutation(result.authorized_plan, transport),
      /writer-capability-spent/
    );
    assert.equal(transport.calls.update, 1, "exactly one write");

    // A capability minted while armed must die if authority is withdrawn
    // before it executes.
    const armedCap: any = authorize(planFor());
    assert.equal(armedCap.ok, true);
    const disarmedCap: any = authorize(planFor(), {}, DISARMED);
    assert.equal(disarmedCap.ok, false);
  });

  it("NEW2-OG6-0022: a null live value is captured as an empty prior and stays restorable", () => {
    const plan = planFor();
    const result: any = authorizeWrite(
      plan,
      {
        page_id: TASK,
        data_source_id: WRITE_ALLOWLIST.data_source_id,
        scope_id: "TOS-TEST",
        project_ids: [PROJECT_ID],
        execution_state: "Ready",
        pending_partial_write: false,
        fetched_at: fresh(),
        properties: { "Execution State": "Ready", "Work Link": null },
      },
      ARMED
    );
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.authorized_plan.prior["Work Link"], "");
    const undo: any = buildUndoPlan(result.authorized_plan);
    assert.equal(undo.ok, true);
    assert.equal(undo.plan.writes["Work Link"], "");
  });

  it("NEW-OG6-0012: the freshness bound cannot be widened by the caller, and attested keys must be a real Set", () => {
    const plan = planFor();
    const ancient: any = authorize(
      plan,
      { fetched_at: 0 },
      { max_snapshot_age_ms: Number.MAX_SAFE_INTEGER }
    );
    assert.equal(ancient.ok, false);
    assert.equal(ancient.failure_class, "stale_task");

    const duckTyped: any = authorize(
      plan,
      {},
      {
        attested_event_keys: { has: () => false },
      }
    );
    assert.equal(duckTyped.ok, false);
    assert.equal(duckTyped.failure_class, "malformed_input");
  });
});

describe("writer + kernel — replay and freeze compose", () => {
  it("full event replay reconstructs the same final state, and duplicates never double-mutate", () => {
    const events = [
      ...START,
      ev("pr_opened", { pr_number: 507, head_sha: HEAD }),
      ev("checks_observed", { head_sha: HEAD, check_rollup: "success" }),
    ];
    const a = foldLifecycle(events, TASK);
    const b = foldLifecycle(events, TASK);
    assert.deepEqual(a.state, b.state);
    // Duplicate transport delivery of the same event: kernel says duplicate,
    // writer's attested-keys gate says duplicate — no second mutation either way.
    const dup = applyEvent(a.state, events[2]);
    assert.equal(dup.ok, true);
    assert.equal((dup as any).duplicate, true);
  });

  it("after a partial write the kernel freezes; write_reverified reopens; the writer honors both", () => {
    let state = initialState(TASK);
    for (const event of START) {
      const r: any = applyEvent(state, event);
      state = r.state;
    }
    const partial: any = applyEvent(
      state,
      ev("mutation_result", {
        plan_ref: "plan:work_started-k",
        applied: "partial",
      })
    );
    assert.equal(partial.ok, true);
    state = partial.state;
    assert.equal(state.pending_partial_write, true);
    // Kernel refuses further transitions.
    const advance: any = applyEvent(
      state,
      ev("pr_opened", { pr_number: 1, head_sha: HEAD })
    );
    assert.equal(advance.ok, false);
    assert.equal(advance.failure_class, "partial_write");
    // Writer refuses too (gate 15) — defense in depth.
    const { record } = recordFor(START);
    const derived: any = deriveWrites(record, {
      ...state,
      state: "Ready",
      task_id: TASK,
    });
    // (derivation is from the pre-partial record; authorization must still refuse)
    const auth: any = authorizeWrite(
      derived.ok ? derived.plan : record,
      {
        page_id: TASK,
        data_source_id: WRITE_ALLOWLIST.data_source_id,
        scope_id: "TOS-TEST",
        project_ids: [PROJECT_ID],
        execution_state: "Ready",
        pending_partial_write: true,
        fetched_at: fresh(),
        properties: { "Execution State": "Ready", "Work Link": "" },
      },
      ARMED
    );
    assert.equal(auth.ok, false);
    assert.equal(auth.failure_class, "partial_write");
    // Human-visible recovery: write_reverified reopens the kernel.
    const reopened: any = applyEvent(
      state,
      ev("write_reverified", {
        verification_ref: "reread-attestation-1",
      })
    );
    assert.equal(reopened.ok, true);
    assert.equal(reopened.state.pending_partial_write, false);
  });
});

// ---------------------------------------------------------------------------
// OG-006 Round 2 — the six mutants Round 1 left alive, plus the authenticated
// human-authority path that Round 1 had no positive test for at all.
//
// Round 1's mutation check found six protections whose deletion left the whole
// battery green: no test was load-bearing for them. Each test below was written
// against a deliberately broken build first and only kept once it FAILED there,
// so "the test exists" and "the test kills the mutant" are the same claim.
// ---------------------------------------------------------------------------
describe("writer v2 — derived human authority", () => {
  const planFor = (events: any[] = START) => {
    const { state, record } = recordFor(events);
    const derived: any = deriveWrites(record, state);
    assert.equal(derived.ok, true);
    return derived.plan;
  };

  const APPROVED_EVENTS = [
    ...START,
    ev("pr_opened", { pr_number: PR, head_sha: HEAD }),
    ev("checks_observed", { head_sha: HEAD, check_rollup: "success" }),
    ev("review_requested", { review_ref: "rr-1" }),
    ev(
      "approval_observed",
      {
        reviewer: HUMAN,
        review_id: REVIEW_ID,
        review_state: "APPROVED",
        observed_via: REVIEW_URL,
      },
      { actor: "human" }
    ),
  ];
  const MERGED_EVENTS = [
    ...APPROVED_EVENTS,
    ev(
      "merge_observed",
      { merge_sha: MERGE, observed_via: MERGE_URL },
      { actor: "human" }
    ),
  ];

  it("T7 — an APPROVED review fetched from the forge authorizes the human transition", () => {
    const resolved: any = approvalFact();
    assert.equal(resolved.ok, true);
    const result: any = authorize(
      planFor(APPROVED_EVENTS),
      {},
      {
        authority_fact: resolved.fact,
      }
    );
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.authorized_plan.writes["Execution State"], "Approval");
  });

  it("T8 — an authenticated merge authorizes Approval → Merged", () => {
    const resolved: any = mergeFact();
    assert.equal(resolved.ok, true);
    const result: any = authorize(
      planFor(MERGED_EVENTS),
      {},
      {
        authority_fact: resolved.fact,
      }
    );
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.authorized_plan.writes["Execution State"], "Merged");
  });

  it("NEW3-OG6-0024 — the caller cannot mint human authority: no fact, no transition", () => {
    // This is the finding that stopped Round 1. The plan below is byte-identical
    // to the one that used to be accepted: actor "human", a plausible
    // observed_via string, correct from-state, correct target state.
    const result: any = authorize(planFor(APPROVED_EVENTS));
    assert.equal(result.ok, false);
    assert.equal(result.failure_class, "authority_violation");
    assert.match(result.detail, /not a fact this system minted/);
  });

  it("NEW3-OG6-0024 — a forged look-alike fact is refused by the writer", () => {
    const real: any = approvalFact();
    const forged = { ...real.fact };
    assert.equal(isAuthorityFact(forged), false);
    const result: any = authorize(
      planFor(APPROVED_EVENTS),
      {},
      {
        authority_fact: forged,
      }
    );
    assert.equal(result.ok, false);
    assert.equal(result.failure_class, "authority_violation");
  });

  it("the plan may not overrule the fact: reviewer, review id and state must AGREE", () => {
    // review_state is absent here because the KERNEL already refuses anything
    // but "APPROVED" for this trigger — a defence the writer inherits rather
    // than duplicates.
    const disagreements = [
      { reviewer: "someone-else" },
      { review_id: "1" },
      { observed_via: "gh api pulls/509/reviews" },
    ];
    for (const over of disagreements) {
      const resolved: any = approvalFact();
      const events = [
        ...APPROVED_EVENTS.slice(0, -1),
        ev(
          "approval_observed",
          {
            reviewer: HUMAN,
            review_id: REVIEW_ID,
            review_state: "APPROVED",
            observed_via: REVIEW_URL,
            ...over,
          },
          { actor: "human" }
        ),
      ];
      const result: any = authorize(
        planFor(events),
        {},
        {
          authority_fact: resolved.fact,
        }
      );
      assert.equal(result.ok, false, JSON.stringify(over));
      assert.equal(result.failure_class, "authority_violation");
      assert.match(result.detail, /the source system decides/);
    }
  });

  it("a fact for the wrong transition kind cannot be substituted", () => {
    const resolved: any = mergeFact();
    const result: any = authorize(
      planFor(APPROVED_EVENTS),
      {},
      {
        authority_fact: resolved.fact,
      }
    );
    assert.equal(result.ok, false);
    assert.match(result.detail, /requires a github_approval fact/);
  });

  it("one authenticated human act authorizes ONE transition — replay refuses", () => {
    const resolved: any = approvalFact();
    const first: any = authorize(
      planFor(APPROVED_EVENTS),
      {},
      {
        authority_fact: resolved.fact,
      }
    );
    assert.equal(first.ok, true);
    const replay: any = authorize(
      planFor(APPROVED_EVENTS),
      {},
      {
        authority_fact: resolved.fact,
      }
    );
    assert.equal(replay.ok, false);
    assert.match(replay.detail, /already consumed/);
  });

  it("a refused plan does NOT burn the evidence — only a successful gate run does", () => {
    const resolved: any = approvalFact();
    // Fails a LATER gate (stale snapshot), so the fact must survive.
    const refused: any = authorize(
      planFor(APPROVED_EVENTS),
      { fetched_at: Date.now() - MAX_SNAPSHOT_AGE_MS - 5_000 },
      { authority_fact: resolved.fact }
    );
    assert.equal(refused.ok, false);
    assert.equal(refused.failure_class, "stale_task");
    const retried: any = authorize(
      planFor(APPROVED_EVENTS),
      {},
      {
        authority_fact: resolved.fact,
      }
    );
    assert.equal(retried.ok, true);
  });

  it("Phase 10 — Verified is unreachable on an unfetched proof URL", () => {
    const events = [
      ...MERGED_EVENTS,
      ev(
        "deploy_consequence_recorded",
        {
          deploy_decision: "deploy",
          consequence_ref: MERGE_URL,
          observed_via: MERGE_URL,
        },
        { actor: "human" }
      ),
      ev("post_merge_verified", {
        evidence_ref: `https://github.com/tailered-ai/dime-ai/actions/runs/12`,
      }),
    ];
    const plan = planFor(events);
    // No proof fact at all — the https-shaped string is not evidence.
    const bare: any = authorize(plan, {}, {});
    assert.equal(bare.ok, false);
    assert.equal(bare.failure_class, "authority_violation");
    assert.match(bare.detail, /not a fact this system minted/);

    // A resolved, SUCCESSFUL run for that URL authorizes.
    installWorld({
      resource: { id: "12", conclusion: "success", head_sha: MERGE },
    });
    const proof: any = resolveProofEvidence({
      repository: "tailered-ai/dime-ai",
      proof_url: `https://github.com/tailered-ai/dime-ai/actions/runs/12`,
    });
    assert.equal(proof.ok, true);
    const ok: any = authorize(plan, {}, { proof_fact: proof.fact });
    assert.equal(ok.ok, true, JSON.stringify(ok));
    assert.equal(ok.authorized_plan.writes["Execution State"], "Verified");
  });
});

describe("writer v2 — the six Round-1 mutants, each with a killing test", () => {
  const planFor = (events: any[] = START) => {
    const { state, record } = recordFor(events);
    const derived: any = deriveWrites(record, state);
    assert.equal(derived.ok, true);
    return derived.plan;
  };
  const liveRecord = () => ({
    "Execution State": "Ready",
    "Work Link": "",
    "Proof / Result": "",
    [WHY_BLOCKED_PROPERTY]: "",
  });

  it("MUTANT 1 — deleting the execute-time authority re-read must break this test", async () => {
    const authorized: any = authorize(planFor());
    assert.equal(authorized.ok, true);
    // The kill switch is thrown AFTER the capability exists and BEFORE it runs.
    mocks.manifest = DISARMED_MANIFEST;
    mocks.manifestFileBytes = JSON.stringify(DISARMED_MANIFEST);
    const transport = fakeTransport(liveRecord());
    await assert.rejects(
      () => executeMutation(authorized.authorized_plan, transport),
      /notion-write-unauthorized/
    );
    assert.equal(
      transport.calls.update,
      0,
      "no bytes may move after the kill switch"
    );
  });

  it("MUTANT 1b — the re-read is of the CANONICAL manifest (NEW3-OG6-0027, per-path kill switch)", async () => {
    // Round 1 re-read the manifest the capability was minted against, so a
    // capability minted from a fixture kept writing while the canonical file was
    // disarmed. There is now one authority source and its path is fixed.
    const authorized: any = authorize(planFor());
    assert.match(
      authorized.authorized_plan.authority_source,
      /config\/tailered-os-control-plane\.v1\.json$/
    );
    // Same flag, DIFFERENT grant: still refuses, because a capability is
    // permission under one specific reviewed grant.
    const swapped = manifestWith({
      notionWriteOperationsAuthorized: true,
      notionWriteAuthorization: { ...GRANT, scope: "everything, actually" },
    });
    mocks.manifest = swapped;
    mocks.manifestFileBytes = JSON.stringify(swapped);
    const transport = fakeTransport(liveRecord());
    await assert.rejects(
      () => executeMutation(authorized.authorized_plan, transport),
      /grant on disk changed/
    );
    assert.equal(transport.calls.update, 0);
  });

  it("MUTANT 2 — deleting the capability TTL must break this test", async () => {
    const authorized: any = authorize(planFor());
    assert.equal(authorized.ok, true);
    const transport = fakeTransport(liveRecord());
    vi.useFakeTimers();
    try {
      vi.setSystemTime(Date.now() + CAPABILITY_TTL_MS + 1_000);
      await assert.rejects(
        () => executeMutation(authorized.authorized_plan, transport),
        /writer-capability-expired/
      );
    } finally {
      vi.useRealTimers();
    }
    assert.equal(transport.calls.update, 0);
  });

  it("MUTANT 3 — authority is pinned to the canonical manifest; no caller path exists", () => {
    // Round 1's third mutant was the realpath rule guarding `manifest_path`.
    // The seam is deleted rather than guarded, so the replacement invariant is
    // that no option can select an authority source at all.
    const authorized: any = authorize(planFor());
    assert.equal(
      authorized.authorized_plan.authority_source,
      CONTROL_PLANE_MANIFEST_PATH
    );
    // The production signature carries (plan, snapshot, opts) and opts is closed.
    for (const key of [
      "manifest_path",
      "manifest",
      "authority",
      "authority_source",
      "github",
    ]) {
      const attempt: any = authorizeWrite(planFor(), snapshotFor(planFor()), {
        [key]: "scripts/tailered-os/fixtures/control-plane-armed.v1.json",
      });
      assert.equal(attempt.ok, false, key);
      assert.equal(attempt.failure_class, "malformed_input", key);
    }
    // cwd cannot move the authority source: the path is absolute and derived
    // from the module's own location.
    assert.ok(CONTROL_PLANE_MANIFEST_PATH.startsWith("/"));
  });

  it("MUTANT 4 — deleting the once-read target derivation must break this test", async () => {
    const base = planFor();
    const snapshot = snapshotFor(base);
    const EVIL = "dead".repeat(8);
    let reads = 0;
    const proxied = new Proxy(base, {
      get(target, prop, receiver) {
        if (prop === "task_id") {
          reads += 1;
          return reads === 1 ? TASK : EVIL;
        }
        return Reflect.get(target, prop, receiver);
      },
    });
    const authorized: any = authorizeWrite(proxied, snapshot, {});
    assert.equal(authorized.ok, true);
    assert.equal(authorized.authorized_plan.target.page_id, TASK);
    const pages: string[] = [];
    const transport = fakeTransport(liveRecord());
    const inner = transport.updatePage.bind(transport);
    transport.updatePage = async (pageId: string, props: any) => {
      pages.push(pageId);
      await inner(pageId, props);
    };
    const innerFetch = transport.fetchTask.bind(transport);
    transport.fetchTask = async (pageId: string) => {
      pages.push(pageId);
      return innerFetch(pageId);
    };
    await executeMutation(authorized.authorized_plan, transport);
    assert.deepEqual(
      pages,
      [TASK, TASK, TASK],
      "every touch — the pre-write confinement fetch, the update, and the reread — must be the GATED page"
    );
    assert.ok(reads >= 1, "the proxy must have been read at least once");
  });

  it("MUTANT 5 — deleting the undo capability binding must break this test", async () => {
    const forward: any = authorize(planFor());
    assert.equal(forward.ok, true);
    const undo: any = buildUndoPlan(forward.authorized_plan);
    assert.equal(undo.ok, true);
    const liveSnapshot = snapshotFor(forward.authorized_plan, {
      execution_state: "Executing",
      properties: { ...liveRecord(), "Execution State": "Executing" },
    });
    // A hand-built origin carrying the right shape — including `prior` — is not
    // a capability this writer authorized.
    const impostor = {
      plan_id: forward.authorized_plan.plan_id,
      trigger: forward.authorized_plan.trigger,
      authority: "machine",
      expected_from_state: "Ready",
      writes: { ...forward.authorized_plan.writes },
      prior: { ...forward.authorized_plan.prior },
    };
    const forged: any = authorizeWrite(undo.plan, liveSnapshot, {
      undo_of: impostor,
    });
    assert.equal(forged.ok, false);
    assert.equal(forged.failure_class, "permission_denial");
    assert.match(forged.detail, /not a capability this writer authorized/);
    // JSON round-tripping a REAL capability also loses the registry identity.
    const rehydrated = JSON.parse(JSON.stringify(forward.authorized_plan));
    const roundTripped: any = authorizeWrite(undo.plan, liveSnapshot, {
      undo_of: rehydrated,
    });
    assert.equal(roundTripped.ok, false);
    // The genuine capability still works, so the test is about authenticity and
    // not about undo being broken.
    const genuine: any = authorizeWrite(undo.plan, liveSnapshot, {
      undo_of: forward.authorized_plan,
    });
    assert.equal(genuine.ok, true);
  });

  it("MUTANT 6 — flipping the deploy row back to machine authority must break this test", () => {
    const row = TRANSITIONS.find(
      (t: any) => t.trigger_event_type === "deploy_consequence_recorded"
    ) as any;
    assert.ok(row, "the deploy-consequence row must exist");
    assert.equal(
      row.authority,
      "human",
      "merging dime-ai main IS a production deploy — the deploy DECISION is permanently human"
    );
    assert.ok(row.required_evidence_fields.includes("observed_via"));
    // Behavioural half: a machine-actor deploy record is refused, and even a
    // human-actor one needs an authenticated fact.
    const events = [
      ...START,
      ev("pr_opened", { pr_number: PR, head_sha: HEAD }),
      ev("checks_observed", { head_sha: HEAD, check_rollup: "success" }),
      ev("review_requested", { review_ref: "rr-1" }),
      ev(
        "approval_observed",
        {
          reviewer: HUMAN,
          review_id: REVIEW_ID,
          review_state: "APPROVED",
          observed_via: REVIEW_URL,
        },
        { actor: "human" }
      ),
      ev(
        "merge_observed",
        { merge_sha: MERGE, observed_via: MERGE_URL },
        { actor: "human" }
      ),
      ev(
        "deploy_consequence_recorded",
        {
          deploy_decision: "deploy",
          consequence_ref: MERGE_URL,
          observed_via: MERGE_URL,
        },
        { actor: "human" }
      ),
    ];
    const plan = planFor(events);
    assert.equal(plan.authority, "human");
    const noFact: any = authorize(plan);
    assert.equal(noFact.ok, false);
    assert.equal(noFact.failure_class, "authority_violation");
    const withFact: any = authorize(
      plan,
      {},
      { authority_fact: mergeFact().fact }
    );
    assert.equal(withFact.ok, true, JSON.stringify(withFact));
  });
});

// ---------------------------------------------------------------------------
// Round-2 adversarial + independent-verification regressions. Every one of
// these was a live exploit against the first Round-2 build, and every one is
// paired with a mutant in mutation-check.mjs — the fixes are held to the same
// bar as the Round-1 fixes they follow.
// ---------------------------------------------------------------------------
describe("writer v2.1 — adversarial + verification regressions", () => {
  const planFor = (events: any[] = START) => {
    const { state, record } = recordFor(events);
    const derived: any = deriveWrites(record, state);
    assert.equal(derived.ok, true);
    return derived.plan;
  };
  const liveRecord = () => ({
    "Execution State": "Ready",
    "Work Link": "",
    "Proof / Result": "",
    [WHY_BLOCKED_PROPERTY]: "",
  });
  const APPROVED_EVENTS = [
    ...START,
    ev("pr_opened", { pr_number: PR, head_sha: HEAD }),
    ev("checks_observed", { head_sha: HEAD, check_rollup: "success" }),
    ev("review_requested", { review_ref: "rr-1" }),
    ev(
      "approval_observed",
      {
        reviewer: HUMAN,
        review_id: REVIEW_ID,
        review_state: "APPROVED",
        observed_via: REVIEW_URL,
      },
      { actor: "human" }
    ),
  ];

  it("R2-02: a genuine human approval of ANOTHER PR is not authority over this task", () => {
    // The independent verifier drove an unrelated task Review→Approval→Merged
    // with a real prez approval of an unrelated PR. A fact proved that a human
    // did SOMETHING; it never proved they did THIS.
    const other: any = approvalFact({ pr: { number: 4242 } });
    assert.equal(other.ok, false, "a mismatched PR should not even derive");
    // The realistic shape: the fact is genuine, but for a different PR number
    // than the one this task recorded.
    const genuine: any = approvalFact();
    const events = [
      ...START,
      ev("pr_opened", { pr_number: 4242, head_sha: HEAD }),
      ev("checks_observed", { head_sha: HEAD, check_rollup: "success" }),
      ev("review_requested", { review_ref: "rr-1" }),
      ev(
        "approval_observed",
        {
          reviewer: HUMAN,
          review_id: REVIEW_ID,
          review_state: "APPROVED",
          observed_via: REVIEW_URL,
        },
        { actor: "human" }
      ),
    ];
    const result: any = authorize(
      planFor(events),
      {},
      {
        authority_fact: genuine.fact,
      }
    );
    assert.equal(result.ok, false);
    assert.equal(result.failure_class, "authority_violation");
    assert.match(
      result.detail,
      /authenticated evidence must be about THIS task|about PR #/
    );
  });

  it("R2-02: an unblock must name this task — an unrelated human remark is not a decision", () => {
    const blocked = [
      ...START,
      ev("failure_observed", { failure_class: "ci_failure", detail_ref: "r" }),
      ev(
        "unblocked",
        {
          resolution_ref: "fixed",
          observed_via: `https://github.com/tailered-ai/dime-ai/pull/${PR}#issuecomment-77`,
        },
        { actor: "human" }
      ),
    ];
    const plan = planFor(blocked);
    const snap = { execution_state: "Blocked", blocked_from: "Executing" };
    // A real comment by the allowed human — about something else entirely.
    installWorld({
      comment: {
        id: "77",
        user: { login: HUMAN },
        issue_url: `https://api.github.com/repos/tailered-ai/dime-ai/issues/${PR}`,
        html_url: `https://github.com/tailered-ai/dime-ai/pull/${PR}#issuecomment-77`,
        created_at: "2026-08-11T22:00:00Z",
        body: "nit: typo in the comment above",
      },
    });
    const fact: any = resolveHumanActAuthority({
      repository: "tailered-ai/dime-ai",
      pr_number: PR,
      comment_id: "77",
    });
    assert.equal(fact.ok, true, JSON.stringify(fact));
    // This task recorded no PR of its own, so the comment must NAME it.
    const result: any = authorize(plan, snap, { authority_fact: fact.fact });
    assert.equal(result.ok, false, JSON.stringify(result));
    assert.match(
      result.detail,
      /an unblock must name this task|does not name task/
    );

    // The same comment, naming the task, is accepted.
    installWorld({
      comment: {
        id: "78",
        user: { login: HUMAN },
        issue_url: `https://api.github.com/repos/tailered-ai/dime-ai/issues/${PR}`,
        html_url: `https://github.com/tailered-ai/dime-ai/pull/${PR}#issuecomment-78`,
        created_at: "2026-08-11T22:00:00Z",
        body: `Unblocking ${TASK}: the migration ran.`,
      },
    });
    const named: any = resolveHumanActAuthority({
      repository: "tailered-ai/dime-ai",
      pr_number: PR,
      comment_id: "78",
    });
    const plan2 = {
      ...plan,
      evidence: {
        ...plan.evidence,
        observed_via: named.fact.evidence_url,
      },
    };
    const ok: any = authorize(plan2, snap, { authority_fact: named.fact });
    assert.equal(ok.ok, true, JSON.stringify(ok));
  });

  it("A3: a trigger may only write the properties it derives", () => {
    const plan = planFor();
    const overreach = {
      ...plan,
      writes: {
        ...plan.writes,
        "Proof / Result": "https://example.com/not-a-real-proof",
        [WHY_BLOCKED_PROPERTY]: "arbitrary machine-authored text",
      },
    };
    const result: any = authorize(overreach);
    assert.equal(result.ok, false);
    assert.equal(result.failure_class, "permission_denial");
    assert.match(result.detail, /may only write/);
  });

  it("A5: a captured prior is validated — an unvalidated prior is a future write", () => {
    const plan = planFor();
    const result: any = authorize(plan, {
      properties: {
        "Execution State": "",
        "Work Link": "javascript:alert(1)",
        "Proof / Result": "",
        [WHY_BLOCKED_PROPERTY]: "",
      },
    });
    assert.equal(result.ok, false);
    assert.equal(result.failure_class, "stale_task");
    assert.match(result.detail, /not a lawful value|unvalidated prior/);
  });

  it("A7: an undo may not land on a page other than the one it reverts", async () => {
    const forward: any = authorize(planFor());
    assert.equal(forward.ok, true);
    const undo: any = buildUndoPlan(forward.authorized_plan);
    const elsewhere = { ...undo.plan, task_id: "d".repeat(32) };
    const snap = snapshotFor(elsewhere, {
      execution_state: "Executing",
      properties: { ...liveRecord(), "Execution State": "Executing" },
    });
    const result: any = authorizeWrite(elsewhere, snap, {
      undo_of: forward.authorized_plan,
    });
    assert.equal(result.ok, false);
    assert.equal(result.failure_class, "permission_denial");
    assert.match(result.detail, /different page|reverts an authorization for/);
  });

  it("A6: a machine may not walk back a human decision with caller strings", () => {
    const merged = [
      ...APPROVED_EVENTS,
      ev(
        "merge_observed",
        { merge_sha: MERGE, observed_via: MERGE_URL },
        { actor: "human" }
      ),
    ];
    const forward: any = authorize(
      planFor(merged),
      {},
      {
        authority_fact: mergeFact().fact,
      }
    );
    assert.equal(forward.ok, true, JSON.stringify(forward));
    const undo: any = buildUndoPlan(forward.authorized_plan);
    // The Round-1 defect, alive in the undo path: `actor: "human"` plus a
    // plausible string used to be enough to reverse a human merge.
    const asserted = {
      ...undo.plan,
      actor: "human",
      evidence: { ...undo.plan.evidence, observed_via: "I said so" },
    };
    const snap = snapshotFor(asserted, {
      execution_state: "Merged",
      properties: { ...liveRecord(), "Execution State": "Merged" },
    });
    const result: any = authorizeWrite(asserted, snap, {
      undo_of: forward.authorized_plan,
    });
    assert.equal(result.ok, false);
    assert.equal(result.failure_class, "authority_violation");
    assert.match(result.detail, /not a fact this system minted|derived/);
  });

  it("R2-04: confinement is verified against the record the TRANSPORT returns", async () => {
    const authorized: any = authorize(planFor());
    assert.equal(authorized.ok, true);
    // The caller's snapshot claimed the allowlisted data source; the source
    // system says otherwise. Nothing may be written.
    const transport = fakeTransport(liveRecord(), {
      data_source_id: "deadbeef-0000-0000-0000-000000000000",
    });
    const result: any = await executeMutation(
      authorized.authorized_plan,
      transport
    );
    assert.equal(result.applied, "none");
    assert.equal(result.failure_class, "permission_denial");
    assert.equal(transport.calls.update, 0, "no byte may move");
    assert.match(result.attestation.detail, /refused before writing/);

    for (const identity of [
      { scope_id: "OPS-1" },
      { project_ids: ["ffffffffffffffffffffffffffffffff"] },
      { page_id: "e".repeat(32) },
    ]) {
      const again: any = authorize(planFor());
      const t = fakeTransport(liveRecord(), identity);
      const r: any = await executeMutation(again.authorized_plan, t);
      assert.equal(r.applied, "none", JSON.stringify(identity));
      assert.equal(t.calls.update, 0, JSON.stringify(identity));
    }
  });

  it("A5b: the SOURCE SYSTEM decides what state a record is in", async () => {
    // Both `expected_from_state` and `snapshot.execution_state` are caller
    // assertions, and agreeing with each other proved nothing: two ordinary
    // machine writes captured "Approval" as a prior and the undo wrote it back.
    const authorized: any = authorize(planFor());
    assert.equal(authorized.ok, true);
    const transport = fakeTransport({
      ...liveRecord(),
      "Execution State": "Merged",
    });
    const result: any = await executeMutation(
      authorized.authorized_plan,
      transport
    );
    assert.equal(result.applied, "none");
    assert.equal(result.failure_class, "permission_denial");
    assert.equal(transport.calls.update, 0);
    assert.match(result.attestation.detail, /actually at Execution State/);
  });
});
