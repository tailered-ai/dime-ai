// TOS-009 — trusted authority evidence adapter (OG-006 Round 2).
//
// The theorem under test, stated once so every case below can be read as an
// attempt to falsify it:
//
//   A caller cannot manufacture a human-authority fact.
//
// Round 1 failed because `actor: "human"` was a string the caller typed. The
// only thing a test may control here is WHAT THE FORGE RETURNED — the bytes of
// a GitHub API response — which is exactly what an attacker cannot control.
// Every verdict (approved? merged? by whom? still current?) is derived by
// production code from those bytes.
import assert from "node:assert/strict";
import { beforeEach, describe, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  tool: (_file: string, _args: string[]): string => "",
  calls: [] as string[],
}));
vi.mock("node:child_process", () => ({
  execFileSync: (file: string, args: string[]) => {
    mocks.calls.push(`${file} ${args.join(" ")}`);
    return mocks.tool(file, args);
  },
}));

import {
  ALLOWED_HUMAN_REVIEWERS,
  AUTHORITY_FACT_TTL_MS,
  CANONICAL_REPOSITORY,
  MACHINE_IDENTITIES,
  TRIGGER_AUTHORITY_SOURCE,
  classifyProofUrl,
  consumeAuthorityFact,
  deriveApprovalFact,
  deriveHumanActFact,
  deriveMergeFact,
  deriveOwnerGrantFact,
  deriveProofFact,
  isAuthorityFact,
  readAuthorityFact,
  resolveApprovalAuthority,
  resolveMergeAuthority,
  resolveOwnerGrantAuthority,
  resolveProofEvidence,
} from "./authority.mjs";

const PR = 509;
const HEAD = "c05fa67cb4ed6bf8f834400f19aea1cee6aee96f";
const OLD_HEAD = "c2d7855bd0000000000000000000000000000000";
const MERGE = "44c1374233a46f68ef75d87e737f9358209ba61e";
const HUMAN = ALLOWED_HUMAN_REVIEWERS[0];
const MACHINE = MACHINE_IDENTITIES[0];
const REVIEW_ID = "4910681985";
const LOC = {
  repository: CANONICAL_REPOSITORY,
  pr_number: PR,
  review_id: REVIEW_ID,
};

// Shaped after the REAL responses from tailered-ai/dime-ai PR #509, including
// the genuinely dismissed review at an older commit and the GHAS bot review.
function pull(over: any = {}) {
  return {
    number: PR,
    state: "closed",
    merged: true,
    merge_commit_sha: MERGE,
    merged_at: "2026-08-11T20:56:29Z",
    merged_by: { login: HUMAN },
    head: { sha: HEAD },
    base: { ref: "main" },
    user: { login: MACHINE },
    ...over,
  };
}
function reviews(over: any[] = []) {
  return [
    {
      id: "4910036501",
      state: "DISMISSED",
      commit_id: OLD_HEAD,
      user: { login: HUMAN },
      submitted_at: "2026-08-11T19:34:53Z",
    },
    {
      id: "4910047465",
      state: "COMMENTED",
      commit_id: OLD_HEAD,
      user: { login: "github-advanced-security[bot]" },
      submitted_at: "2026-08-11T19:36:22Z",
    },
    {
      id: REVIEW_ID,
      state: "APPROVED",
      commit_id: HEAD,
      user: { login: HUMAN },
      submitted_at: "2026-08-11T20:56:23Z",
    },
    ...over,
  ];
}
const world = (over: any = {}) => ({
  pr: pull(over.pr),
  reviews: over.reviews ?? reviews(),
  review_decision: over.review_decision ?? "APPROVED",
});

beforeEach(() => {
  mocks.calls = [];
  mocks.tool = () => {
    throw new Error("no transport configured for this test");
  };
});

describe("authority — GitHub approval is DERIVED, never asserted", () => {
  it("derives reviewer identity and state from the forge on a real-shaped response", () => {
    const derived: any = deriveApprovalFact(world(), LOC);
    assert.equal(derived.ok, true);
    assert.equal(derived.payload.human_identity, HUMAN);
    assert.equal(derived.payload.review_state, "APPROVED");
    assert.equal(derived.payload.head_sha, HEAD);
    assert.equal(derived.payload.author, MACHINE);
    assert.match(
      derived.payload.evidence_url,
      /#pullrequestreview-4910681985$/
    );
  });

  it("a caller naming the DISMISSED review gets a refusal, not an approval", () => {
    const derived: any = deriveApprovalFact(world(), {
      ...LOC,
      review_id: "4910036501",
    });
    assert.equal(derived.ok, false);
    assert.equal(derived.failure_class, "authority_violation");
    assert.match(derived.detail, /DISMISSED|dismissed/);
  });

  it("an approval of an older commit is stale — approving what would merge is the point", () => {
    const derived: any = deriveApprovalFact(
      world({ reviews: [{ ...reviews()[2], commit_id: OLD_HEAD }] }),
      LOC
    );
    assert.equal(derived.ok, false);
    assert.equal(derived.failure_class, "stale_sha");
    assert.match(derived.detail, /stale/);
  });

  it("a review id that exists on another PR is not authority here", () => {
    const derived: any = deriveApprovalFact(world(), {
      ...LOC,
      review_id: "999999999",
    });
    assert.equal(derived.ok, false);
    assert.equal(derived.failure_class, "missing_evidence");
  });

  it("the fetched PR must be the requested PR — substitution refuses", () => {
    const derived: any = deriveApprovalFact(world({ pr: { number: 42 } }), LOC);
    assert.equal(derived.ok, false);
    assert.equal(derived.failure_class, "missing_pr");
  });

  it("cross-repository authority is refused before any fetch", () => {
    const derived: any = deriveApprovalFact(world(), {
      ...LOC,
      repository: "attacker/dime-ai",
    });
    assert.equal(derived.ok, false);
    assert.equal(derived.failure_class, "malformed_input");
    assert.match(derived.detail, /canonical repository/);
  });

  it("approval on a non-main base is not authority over main", () => {
    const derived: any = deriveApprovalFact(
      world({ pr: { base: { ref: "staging" } } }),
      LOC
    );
    assert.equal(derived.ok, false);
    assert.match(derived.detail, /not main/);
  });

  it("identity substitution fails four ways: bot, this agent, unlisted human, self-approval", () => {
    const cases: Array<[string, any, RegExp]> = [
      ["bot", { login: "copilot-pull-request-reviewer[bot]" }, /is a bot/],
      ["this agent", { login: MACHINE }, /own identity|self-approval/],
      ["unlisted human", { login: "some-contractor" }, /not an allowed human/],
    ];
    for (const [label, user, expected] of cases) {
      const derived: any = deriveApprovalFact(
        world({ reviews: [{ ...reviews()[2], user }] }),
        LOC
      );
      assert.equal(derived.ok, false, label);
      assert.equal(derived.failure_class, "authority_violation", label);
      assert.match(derived.detail, expected, label);
    }
    // Self-approval by an ALLOWED human who happens to be the author is still
    // refused — the allowlist is not a bypass for the author check.
    const selfApproved: any = deriveApprovalFact(
      world({ pr: { user: { login: HUMAN } } }),
      LOC
    );
    assert.equal(selfApproved.ok, false);
    assert.match(selfApproved.detail, /self-approval/);
  });

  it("the forge's own current verdict must agree — a later dismissal refuses", () => {
    for (const decision of ["REVIEW_REQUIRED", "CHANGES_REQUESTED", null]) {
      const derived: any = deriveApprovalFact(
        { pr: pull(), reviews: reviews(), review_decision: decision },
        LOC
      );
      assert.equal(derived.ok, false, String(decision));
      assert.match(derived.detail, /branch protection/);
    }
  });

  it("an empty or malformed forge response refuses rather than defaulting open", () => {
    for (const raw of [{}, { pr: null }, { pr: pull(), reviews: null }, null]) {
      const derived: any = deriveApprovalFact(raw, LOC);
      assert.equal(derived.ok, false);
      assert.equal(derived.failure_class, "missing_evidence");
    }
  });
});

describe("authority — GitHub merge is DERIVED", () => {
  it("derives merged state, merge sha and the human who merged", () => {
    const derived: any = deriveMergeFact(
      { pr: pull() },
      { repository: CANONICAL_REPOSITORY, pr_number: PR }
    );
    assert.equal(derived.ok, true);
    assert.equal(derived.payload.merge_sha, MERGE);
    assert.equal(derived.payload.human_identity, HUMAN);
  });

  it("caller-asserted merged=true is worthless: the forge's own state decides", () => {
    const derived: any = deriveMergeFact(
      { pr: pull({ merged: false, state: "open", merge_commit_sha: null }) },
      { repository: CANONICAL_REPOSITORY, pr_number: PR }
    );
    assert.equal(derived.ok, false);
    assert.equal(derived.failure_class, "authority_violation");
    assert.match(derived.detail, /not merged/);
  });

  it("a merge performed by this agent is not a human merge", () => {
    const derived: any = deriveMergeFact(
      { pr: pull({ merged_by: { login: MACHINE } }) },
      { repository: CANONICAL_REPOSITORY, pr_number: PR }
    );
    assert.equal(derived.ok, false);
    assert.match(derived.detail, /own identity|self-approval/);
  });

  it("a merge into a branch other than main is refused", () => {
    const derived: any = deriveMergeFact(
      { pr: pull({ base: { ref: "release" } }) },
      { repository: CANONICAL_REPOSITORY, pr_number: PR }
    );
    assert.equal(derived.ok, false);
  });
});

describe("authority — unblock evidence is an authored human act", () => {
  const loc = {
    repository: CANONICAL_REPOSITORY,
    pr_number: PR,
    comment_id: "77",
  };
  const comment = (over: any = {}) => ({
    id: "77",
    user: { login: HUMAN },
    issue_url: `https://api.github.com/repos/${CANONICAL_REPOSITORY}/issues/${PR}`,
    html_url: `https://github.com/${CANONICAL_REPOSITORY}/pull/${PR}#issuecomment-77`,
    created_at: "2026-08-11T22:00:00Z",
    body: "Unblocking: the migration ran.",
    ...over,
  });

  it("derives the author from the forge", () => {
    const derived: any = deriveHumanActFact({ comment: comment() }, loc);
    assert.equal(derived.ok, true);
    assert.equal(derived.payload.human_identity, HUMAN);
  });

  it("a comment from a different PR cannot unblock this one", () => {
    const derived: any = deriveHumanActFact(
      {
        comment: comment({
          issue_url: `https://api.github.com/repos/${CANONICAL_REPOSITORY}/issues/1`,
        }),
      },
      loc
    );
    assert.equal(derived.ok, false);
    assert.equal(derived.failure_class, "authority_violation");
  });

  it("a comment by this agent is not a human unblock", () => {
    const derived: any = deriveHumanActFact(
      { comment: comment({ user: { login: MACHINE } }) },
      loc
    );
    assert.equal(derived.ok, false);
  });
});

describe("authority — terminal proof must RESOLVE (Phase 10)", () => {
  const loc = (proof_url: string, extra: any = {}) => ({
    repository: CANONICAL_REPOSITORY,
    proof_url,
    ...extra,
  });

  it("classifies only runs, PRs and commits — everything else is unresolvable", () => {
    assert.equal(
      classifyProofUrl(
        `https://github.com/${CANONICAL_REPOSITORY}/actions/runs/12`
      )?.kind,
      "actions_run"
    );
    assert.equal(
      classifyProofUrl(`https://github.com/${CANONICAL_REPOSITORY}/pull/9`)
        ?.kind,
      "pull_request"
    );
    assert.equal(
      classifyProofUrl(
        `https://github.com/${CANONICAL_REPOSITORY}/commit/${MERGE}`
      )?.kind,
      "commit"
    );
    for (const url of [
      "https://example.com/proof",
      "https://app.notion.com/p/abc",
      `https://github.com/${CANONICAL_REPOSITORY}/actions/runs/12/attempts/2`,
      "not-a-url",
      "",
    ])
      assert.equal(classifyProofUrl(url), null, url);
  });

  it("an https string nobody can resolve does not reach Verified", () => {
    const derived: any = deriveProofFact(
      {},
      loc("https://example.com/looks-official")
    );
    assert.equal(derived.ok, false);
    assert.equal(derived.failure_class, "missing_evidence");
    assert.match(derived.detail, /fails closed/);
  });

  it("a well-formed URL whose object does not exist refuses", () => {
    const derived: any = deriveProofFact(
      { resource: null },
      loc(`https://github.com/${CANONICAL_REPOSITORY}/actions/runs/12`)
    );
    assert.equal(derived.ok, false);
    assert.equal(derived.failure_class, "missing_evidence");
  });

  it("a FAILED run is not verification evidence", () => {
    const derived: any = deriveProofFact(
      { resource: { id: "12", conclusion: "failure", head_sha: MERGE } },
      loc(`https://github.com/${CANONICAL_REPOSITORY}/actions/runs/12`)
    );
    assert.equal(derived.ok, false);
    assert.match(derived.detail, /concluded "failure"/);
  });

  it("proof about a different commit than the one being verified refuses", () => {
    const derived: any = deriveProofFact(
      {
        resource: { id: "12", conclusion: "success", head_sha: "f".repeat(40) },
      },
      loc(`https://github.com/${CANONICAL_REPOSITORY}/actions/runs/12`, {
        expected_sha: MERGE,
      })
    );
    assert.equal(derived.ok, false);
    assert.equal(derived.failure_class, "stale_sha");
  });

  it("proof pointing at another repository refuses", () => {
    const derived: any = deriveProofFact(
      { resource: { id: "12", conclusion: "success" } },
      loc("https://github.com/attacker/dime-ai/actions/runs/12")
    );
    assert.equal(derived.ok, false);
  });

  it("a successful run for the expected commit resolves", () => {
    const derived: any = deriveProofFact(
      { resource: { id: "12", conclusion: "success", head_sha: MERGE } },
      loc(`https://github.com/${CANONICAL_REPOSITORY}/actions/runs/12`, {
        expected_sha: MERGE,
      })
    );
    assert.equal(derived.ok, true);
    assert.equal(derived.payload.subject_sha, MERGE);
  });
});

describe("authority — the owner grant is only as good as its reviewed merge", () => {
  const grant = (over: any = {}) => ({
    decision: "https://app.notion.com/p/3b99673313e781229b85f35a0b9f2966",
    grantedBy: "PREZ",
    grantedOn: "2026-08-11",
    actor: "AI-10",
    scope: "TOS-* Tasks",
    activationPullRequest: PR,
    ...over,
  });
  // A2: the compared blob must CONTAIN this grant. Two equal copies of `{}` used
  // to authenticate, so the fixture is now a real manifest shape.
  const manifestText = (g: any = grant()) =>
    JSON.stringify({
      safety: {
        notionWriteOperationsAuthorized: true,
        notionWriteAuthorization: g,
      },
    });
  const raw = (over: any = {}) => ({
    ...world(),
    approving_review_id: REVIEW_ID,
    merge_is_ancestor: true,
    manifest_at_merge: manifestText(),
    // A1: the bytes the LOADER read, not a git blob.
    manifest_loaded: manifestText(),
    ...over,
  });

  it("authenticates a grant backed by an approved, merged, contained PR", () => {
    const derived: any = deriveOwnerGrantFact(raw(), grant());
    assert.equal(derived.ok, true);
    assert.equal(derived.payload.human_identity, HUMAN);
    assert.equal(derived.payload.merge_sha, MERGE);
  });

  it("a grant with no activation PR is a self-grant", () => {
    const derived: any = deriveOwnerGrantFact(
      raw(),
      grant({ activationPullRequest: undefined })
    );
    assert.equal(derived.ok, false);
    assert.equal(derived.failure_class, "permission_denial");
    assert.match(derived.detail, /self-grant/);
  });

  it("a grant whose PR was never approved by a human is refused", () => {
    const derived: any = deriveOwnerGrantFact(
      raw({ reviews: [{ ...reviews()[2], user: { login: MACHINE } }] }),
      grant()
    );
    assert.equal(derived.ok, false);
    assert.match(derived.detail, /not authentic/);
  });

  it("a grant whose PR is not merged is refused", () => {
    const derived: any = deriveOwnerGrantFact(
      raw({ pr: pull({ merged: false, merge_commit_sha: null }) }),
      grant()
    );
    assert.equal(derived.ok, false);
    assert.match(derived.detail, /not authentic/);
  });

  it("A1 — an UNCOMMITTED edit cannot arm: loaded bytes must equal merged bytes", () => {
    // The Round-2 adversarial pass armed the writer with an unstaged one-line
    // edit, because this check compared `git show HEAD:` to
    // `git cat-file <merge>:` — two committed blobs, neither of which is the
    // file the loader obeys. The comparison is now against the loaded bytes.
    const derived: any = deriveOwnerGrantFact(
      raw({
        manifest_loaded: manifestText({ ...grant(), scope: "everything" }),
      }),
      grant()
    );
    assert.equal(derived.ok, false);
    assert.equal(derived.failure_class, "authority_violation");
    assert.match(
      derived.detail,
      /uncommitted edit|not the grant a human reviewed/
    );
  });

  it("A2 — blob equality is not enough: the merged manifest must CONTAIN this grant", () => {
    // Two equal blobs used to authenticate anything, so activationPullRequest
    // could name any merged, human-approved PR that never touched the manifest.
    const empty: any = deriveOwnerGrantFact(
      raw({ manifest_at_merge: "{}\n", manifest_loaded: "{}\n" }),
      grant()
    );
    assert.equal(empty.ok, false);
    assert.equal(empty.failure_class, "authority_violation");

    // A merge that did not arm anything cannot authenticate a grant.
    const unarmed = JSON.stringify({
      safety: { notionWriteOperationsAuthorized: false },
    });
    const disarmedMerge: any = deriveOwnerGrantFact(
      raw({ manifest_at_merge: unarmed, manifest_loaded: unarmed }),
      grant()
    );
    assert.equal(disarmedMerge.ok, false);
    assert.match(disarmedMerge.detail, /did not grant write authority/);

    // M15: the grant merged by this PR must name THIS PR. Without it,
    // activationPullRequest could ride on any approved merge whose manifest
    // happens to match.
    const foreign = { ...grant(), activationPullRequest: 4242 };
    const rides: any = deriveOwnerGrantFact(
      raw({
        manifest_at_merge: manifestText(foreign),
        manifest_loaded: manifestText(foreign),
      }),
      grant()
    );
    assert.equal(rides.ok, false);
    assert.match(rides.detail, /introduced IT|not the grant merged by PR/);

    // A grant naming a DIFFERENT activation PR than the merge it rides on.
    const wrongPr = { ...grant(), activationPullRequest: 1 };
    const mismatched: any = deriveOwnerGrantFact(
      raw({
        manifest_at_merge: manifestText(wrongPr),
        manifest_loaded: manifestText(wrongPr),
      }),
      wrongPr
    );
    assert.equal(mismatched.ok, false);
    assert.match(mismatched.detail, /introduced IT|is not the requested PR/);

    // Field-level drift between the merged grant and the in-memory grant, with
    // the loaded bytes matching the merge so A1 is not what fires.
    const widened = manifestText({ ...grant(), scope: "wider" });
    const drifted: any = deriveOwnerGrantFact(
      raw({ manifest_at_merge: widened, manifest_loaded: widened }),
      grant()
    );
    assert.equal(drifted.ok, false);
    assert.match(drifted.detail, /not the grant merged by PR/);
  });

  it("a checkout that does not contain the approved activation cannot be armed by it", () => {
    const derived: any = deriveOwnerGrantFact(
      raw({ merge_is_ancestor: false }),
      grant()
    );
    assert.equal(derived.ok, false);
    assert.match(derived.detail, /not an ancestor/);
  });

  it("unreadable manifest bytes fail closed", () => {
    for (const over of [
      { manifest_at_merge: null },
      { manifest_loaded: null },
    ]) {
      const derived: any = deriveOwnerGrantFact(raw(over), grant());
      assert.equal(derived.ok, false, JSON.stringify(over));
      assert.equal(derived.failure_class, "missing_evidence");
    }
    // Unparseable bytes: the byte-equality gate fires first (the loaded file and
    // the merged blob genuinely differ), and if a caller makes them equal, the
    // parse refuses. Both are fail-closed; neither authenticates.
    const bothGarbage: any = deriveOwnerGrantFact(
      raw({ manifest_at_merge: "not json", manifest_loaded: "not json" }),
      grant()
    );
    assert.equal(bothGarbage.ok, false);
    assert.equal(bothGarbage.failure_class, "missing_evidence");
    assert.match(bothGarbage.detail, /not parseable JSON/);
  });
});

describe("authority — facts are unforgeable capabilities (Phase 6)", () => {
  function installForge() {
    mocks.tool = (file: string, args: string[]) => {
      const line = args.join(" ");
      if (file === "git") return "manifest-bytes";
      if (line.includes("graphql"))
        return JSON.stringify({
          data: { repository: { pullRequest: { reviewDecision: "APPROVED" } } },
        });
      if (line.includes("/reviews")) return JSON.stringify(reviews());
      return JSON.stringify(pull());
    };
  }

  it("a resolver mints a real fact; the shape of one is not one", () => {
    installForge();
    const resolved: any = resolveApprovalAuthority(LOC);
    assert.equal(resolved.ok, true);
    assert.equal(isAuthorityFact(resolved.fact), true);
    assert.equal(readAuthorityFact(resolved.fact)?.kind, "github_approval");

    // A structurally IDENTICAL object, built by a caller, is not a fact.
    const clone = { ...resolved.fact };
    assert.equal(isAuthorityFact(clone), false);
    assert.equal(readAuthorityFact(clone), null);
    assert.deepEqual(
      Object.keys(clone).sort(),
      Object.keys(resolved.fact).sort(),
      "the forgery must be indistinguishable by shape — that is the point"
    );
    // JSON round-trip, Object.create and a Proxy over a real fact are all
    // different objects, so none of them carry the registry identity.
    assert.equal(
      isAuthorityFact(JSON.parse(JSON.stringify(resolved.fact))),
      false
    );
    assert.equal(isAuthorityFact(Object.create(resolved.fact)), false);
    assert.equal(isAuthorityFact(new Proxy(resolved.fact, {})), false);
    for (const junk of [null, undefined, 0, "github_approval", [], () => {}])
      assert.equal(isAuthorityFact(junk as any), false);
  });

  it("derive functions do NOT mint — only a real fetch can produce a fact", () => {
    const derived: any = deriveApprovalFact(world(), LOC);
    assert.equal(derived.ok, true);
    assert.equal(isAuthorityFact(derived.payload), false);
  });

  it("a fact is single-use: consuming it twice refuses", () => {
    installForge();
    const { fact }: any = resolveApprovalAuthority(LOC);
    const first: any = consumeAuthorityFact(fact, { kind: "github_approval" });
    assert.equal(first.ok, true);
    const second: any = consumeAuthorityFact(fact, { kind: "github_approval" });
    assert.equal(second.ok, false);
    assert.match(second.detail, /already consumed/);
  });

  it("a fact is kind-bound: an approval cannot stand in for a merge", () => {
    installForge();
    const { fact }: any = resolveApprovalAuthority(LOC);
    const wrong: any = consumeAuthorityFact(fact, { kind: "github_merge" });
    assert.equal(wrong.ok, false);
    assert.match(wrong.detail, /requires github_merge/);
    // and it was not burned by the failed attempt
    assert.equal(readAuthorityFact(fact)?.consumed, false);
  });

  it("a fact expires — the caller cannot widen the freshness bound", () => {
    installForge();
    const { fact }: any = resolveMergeAuthority({
      repository: CANONICAL_REPOSITORY,
      pr_number: PR,
    });
    vi.useFakeTimers();
    try {
      vi.setSystemTime(Date.now() + AUTHORITY_FACT_TTL_MS + 1_000);
      const late: any = consumeAuthorityFact(fact, {
        kind: "github_merge",
        max_age_ms: Number.MAX_SAFE_INTEGER,
      });
      assert.equal(late.ok, false);
      assert.equal(late.failure_class, "stale_task");
    } finally {
      vi.useRealTimers();
    }
  });

  it("a forged look-alike is refused by the consumer, not merely by the reader", () => {
    const forged = Object.freeze({
      schema_version: 1,
      kind: "github_approval",
      repository: CANONICAL_REPOSITORY,
      pr_number: PR,
      human_identity: HUMAN,
      review_state: "APPROVED",
      fetched_at: Date.now(),
    });
    const result: any = consumeAuthorityFact(forged, {
      kind: "github_approval",
    });
    assert.equal(result.ok, false);
    assert.equal(result.failure_class, "authority_violation");
    assert.match(result.detail, /not derived by the authority adapter/);
  });
});

describe("authority — transport failures fail closed", () => {
  it("an unauthenticated or unreachable forge refuses; it never assumes approval", () => {
    const cases: Array<[string, string]> = [
      ["gh: 401 Unauthorized", "expired_credentials"],
      ["gh: 403 Forbidden rate limit", "permission_denial"],
      ["gh: 404 Not Found", "missing_evidence"],
      ["connect ETIMEDOUT", "api_timeout"],
      ["something unexpected", "api_timeout"],
    ];
    for (const [message, expected] of cases) {
      mocks.tool = () => {
        throw new Error(message);
      };
      const result: any = resolveApprovalAuthority(LOC);
      assert.equal(result.ok, false, message);
      assert.equal(result.failure_class, expected, message);
    }
  });

  it("unparseable forge output refuses", () => {
    mocks.tool = () => "not json";
    const result: any = resolveMergeAuthority({
      repository: CANONICAL_REPOSITORY,
      pr_number: PR,
    });
    assert.equal(result.ok, false);
    assert.equal(result.failure_class, "api_timeout");
  });

  it("resolvers refuse a bad locator BEFORE touching the network", () => {
    mocks.tool = () => {
      throw new Error("the transport must not be reached");
    };
    for (const locator of [
      null,
      {},
      { repository: "other/repo", pr_number: 1, review_id: "1" },
      { repository: CANONICAL_REPOSITORY, pr_number: 0, review_id: "1" },
      { repository: CANONICAL_REPOSITORY, pr_number: 1 },
    ]) {
      const result: any = resolveApprovalAuthority(locator as any);
      assert.equal(result.ok, false);
      assert.equal(result.failure_class, "malformed_input");
    }
    assert.equal(mocks.calls.length, 0);
  });

  it("resolveProofEvidence and resolveOwnerGrantAuthority also fail closed", () => {
    mocks.tool = () => {
      throw new Error("gh: 404 Not Found");
    };
    const proof: any = resolveProofEvidence({
      repository: CANONICAL_REPOSITORY,
      proof_url: `https://github.com/${CANONICAL_REPOSITORY}/actions/runs/1`,
    });
    assert.equal(proof.ok, false);
    const grant: any = resolveOwnerGrantAuthority({
      activationPullRequest: PR,
    });
    assert.equal(grant.ok, false);
  });
});

describe("authority — the source table is closed and matches the law", () => {
  it("every human-gated trigger declares exactly one authority source", () => {
    assert.deepEqual(Object.keys(TRIGGER_AUTHORITY_SOURCE).sort(), [
      "approval_observed",
      "deploy_consequence_recorded",
      "merge_observed",
      "unblocked",
    ]);
    for (const [trigger, source] of Object.entries(TRIGGER_AUTHORITY_SOURCE)) {
      assert.equal(source.source_system, "github", trigger);
      assert.ok(source.rationale.length > 20, trigger);
    }
  });

  it("the deploy DECISION is the human merge; Notion is never an authority source", () => {
    assert.equal(
      TRIGGER_AUTHORITY_SOURCE.deploy_consequence_recorded.kind,
      "github_merge"
    );
    for (const source of Object.values(TRIGGER_AUTHORITY_SOURCE))
      assert.notEqual(source.source_system, "notion");
  });

  it("this agent's own identities are excluded from human authority by construction", () => {
    for (const identity of MACHINE_IDENTITIES)
      assert.equal(
        ALLOWED_HUMAN_REVIEWERS.includes(identity),
        false,
        `${identity} must never be an allowed human reviewer`
      );
  });
});
