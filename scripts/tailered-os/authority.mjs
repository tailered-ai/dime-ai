// TOS-009 — trusted authority evidence adapter (OG-006 Round 2).
//
// WHY THIS MODULE EXISTS
//
// Round 1 shipped a lifecycle writer that re-checked human authority by reading
// `actor: "human"` and `evidence.observed_via` off the caller's plan. Three
// independent verification rounds failed it, and round 3 named the reason
// (NEW3-OG6-0024): those are strings the caller types. A policy layer cannot
// prove a human acted by reading a field its own caller filled in. Every
// "human-only transition" guarantee in the runbook was, at that layer, a
// guarantee that the caller had spelled a word correctly.
//
// The rule now is inverted:
//
//   The caller may name an EVIDENCE LOCATOR. This module independently fetches
//   the source-system object over an authenticated transport and DERIVES the
//   authority fact. The caller never supplies the verdict.
//
// So `reviewer`, `review_state`, `merged`, `merge_sha` and friends are OUTPUTS
// of an authenticated fetch here, never trusted inputs. A plan that disagrees
// with the derived fact is refused; it cannot overrule it.
//
// WHY GITHUB IS THE ROOT OF TRUST, AND NOTION IS NOT
//
// The obvious reading of the Tailered OS authority model is "GitHub owns code
// truth, Notion owns organizational decisions". For MACHINE-VERIFIABLE human
// authority that split does not hold, and the reason is concrete rather than
// theoretical: actor AI-10 holds a Notion connector that can create and edit
// pages in the Decisions database. The Round 1 "owner decision" record
// (3b99673313e781229b85f35a0b9f2966) was in fact created by the machine, as a
// transcription of a decision the owner made in conversation. A record the
// machine can write is not evidence about the machine's permissions — deriving
// authority from it would be a self-grant with extra steps.
//
// GitHub review authority is different in kind. Reviews are attributed by the
// forge to the credential that submits them; this agent holds exactly one
// credential (`tailered-ai`, which is also the PR author account), and GitHub
// refuses self-approval besides. An APPROVED review by `prez-tailered-ai` is
// therefore an artifact this process cannot manufacture, no matter what it
// passes to this module. That is the whole security argument, and it rests on
// account separation rather than on anything in this file.
//
// Consequence, recorded rather than hidden: an owner decision that lives ONLY
// in Notion is not machine-authenticable in this system. Such transitions fail
// closed here (`authority_source_unavailable`) instead of being waved through.
// The Notion decision URL stays in the manifest grant as the human-readable
// cross-reference it always was — not as the root of trust.
//
// THE TRANSPORT HAS NO CALLER SEAM
//
// Resolvers construct their own transport (the `gh` CLI, already authenticated
// on the operator's machine) through a module-private helper. There is no
// transport parameter, no manifest path parameter, and no environment override.
// Tests drive real derivation code by mocking `node:child_process` — i.e. by
// controlling the bytes the forge returned, which is the thing a test is
// entitled to control. Production exposes no equivalent.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

export const AUTHORITY_SCHEMA_VERSION = 1;

// Hard cap on how old a derived fact may be when it is consumed. The writer
// applies its own, tighter bound; this is the ceiling neither can exceed.
export const AUTHORITY_FACT_TTL_MS = 300_000;

export const CANONICAL_REPOSITORY = "tailered-ai/dime-ai";
export const CANONICAL_BASE_BRANCH = "main";

// The only identities whose acts count as human authority in this system.
// Adding to this list is an owner-reviewed change to this file, and it is the
// single most security-relevant line in the module.
export const ALLOWED_HUMAN_REVIEWERS = Object.freeze(["prez-tailered-ai"]);

// Identities that are this agent, or automation acting for it. An act by any of
// these is NEVER human authority — including on a PR they did not author.
export const MACHINE_IDENTITIES = Object.freeze([
  "tailered-ai",
  "aisportsbettingcontact",
]);

export const AUTHORITY_KINDS = Object.freeze([
  "github_approval",
  "github_merge",
  "github_head",
  "github_human_act",
  "github_proof",
  "owner_grant",
]);

const SHA40 = /^[0-9a-f]{40}$/;
const REPO_SLUG = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
const REPO_ROOT = resolvePath(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  ".."
);
const MANIFEST_REPO_PATH = "config/tailered-os-control-plane.v1.json";
const CONTROL_PLANE_MANIFEST_PATH = resolvePath(REPO_ROOT, MANIFEST_REPO_PATH);

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function refuse(failureClass, detail) {
  return { ok: false, failure_class: failureClass, detail };
}

function isBotLogin(login) {
  return /\[bot\]$/.test(String(login));
}

// A login is a human authority candidate only by explicit allowlist. Default
// deny: an unknown collaborator is not authority, and neither is a bot.
function humanAuthorityProblem(login) {
  const name = String(login ?? "");
  if (name === "") return "review carries no reviewer identity";
  if (isBotLogin(name)) return `reviewer "${name}" is a bot, not a human`;
  if (MACHINE_IDENTITIES.includes(name))
    return `reviewer "${name}" is this agent's own identity — self-approval is not human authority`;
  if (!ALLOWED_HUMAN_REVIEWERS.includes(name))
    return `reviewer "${name}" is not an allowed human reviewer under current governance`;
  return null;
}

// ---------------------------------------------------------------------------
// FACT REGISTRY — authenticity is membership, not shape.
//
// A derived fact is a frozen object registered in a module-private WeakMap.
// Nothing outside this module can add an entry, so a structurally identical
// object built by a caller is not a fact and every consumer can tell.
// ---------------------------------------------------------------------------
const FACTS = new WeakMap();

function mint(kind, payload, fetchedAt) {
  const fact = Object.freeze({
    schema_version: AUTHORITY_SCHEMA_VERSION,
    kind,
    ...payload,
    fetched_at: fetchedAt,
  });
  FACTS.set(fact, { kind, minted_at: fetchedAt, consumed: false });
  return fact;
}

export function isAuthorityFact(candidate) {
  return isPlainObject(candidate) && FACTS.has(candidate);
}

// Read without consuming. Returns null for anything this module did not mint,
// so a caller cannot smuggle a look-alike past a `?.kind` check.
export function readAuthorityFact(candidate) {
  if (!isAuthorityFact(candidate)) return null;
  const meta = FACTS.get(candidate);
  return {
    kind: meta.kind,
    minted_at: meta.minted_at,
    consumed: meta.consumed,
    age_ms: Date.now() - meta.minted_at,
  };
}

// Single use, kind-bound, freshness-bound. Consuming is what makes an authority
// fact permission for ONE transition rather than a reusable bearer token: round
// 2 caught the writer's own capability executing twice (NEW2-OG6-0017) and the
// same class applies here.
export function consumeAuthorityFact(candidate, expectation = {}) {
  if (!isAuthorityFact(candidate))
    return refuse(
      "authority_violation",
      "the supplied authority evidence was not derived by the authority adapter — a structurally identical object is not a fact."
    );
  const meta = FACTS.get(candidate);
  if (meta.consumed)
    return refuse(
      "authority_violation",
      `this ${meta.kind} fact was already consumed — an authority fact authorizes exactly one transition.`
    );
  if (expectation.kind !== undefined && meta.kind !== expectation.kind)
    return refuse(
      "authority_violation",
      `authority evidence is a ${meta.kind} fact, but this transition requires ${expectation.kind}.`
    );
  const age = Date.now() - meta.minted_at;
  const maxAge = Math.min(
    Number.isFinite(expectation.max_age_ms)
      ? expectation.max_age_ms
      : AUTHORITY_FACT_TTL_MS,
    AUTHORITY_FACT_TTL_MS
  );
  if (age > maxAge || age < 0)
    return refuse(
      "stale_task",
      `authority evidence is ${age}ms old (max ${maxAge}ms) — re-resolve it against the source system.`
    );
  FACTS.set(candidate, { ...meta, consumed: true });
  return { ok: true, fact: candidate };
}

// ---------------------------------------------------------------------------
// TRANSPORT — module-private. No parameter reaches this from a caller.
// ---------------------------------------------------------------------------
function runTool(file, args) {
  try {
    return {
      ok: true,
      stdout: execFileSync(file, args, {
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
        timeout: 30_000,
        cwd: REPO_ROOT,
      }),
    };
  } catch (error) {
    const stderr = String(error?.stderr ?? "");
    const message = `${error?.message ?? "unknown"} ${stderr}`.trim();
    if (/401|authentication|not logged|credential/i.test(message))
      return {
        ok: false,
        failure_class: "expired_credentials",
        detail: message,
      };
    if (/403|permission|forbidden|rate limit/i.test(message))
      return { ok: false, failure_class: "permission_denial", detail: message };
    if (/404|not found/i.test(message))
      return { ok: false, failure_class: "missing_evidence", detail: message };
    if (/ETIMEDOUT|timed? ?out|ECONN|ENOTFOUND|network/i.test(message))
      return { ok: false, failure_class: "api_timeout", detail: message };
    return { ok: false, failure_class: "api_timeout", detail: message };
  }
}

function ghApi(endpoint) {
  const run = runTool("gh", [
    "api",
    "-H",
    "Accept: application/vnd.github+json",
    endpoint,
  ]);
  if (!run.ok)
    return refuse(
      run.failure_class,
      `GitHub API ${endpoint} failed: ${run.detail}`
    );
  try {
    return { ok: true, body: JSON.parse(run.stdout) };
  } catch (error) {
    return refuse(
      "api_timeout",
      `GitHub API ${endpoint} returned unparseable JSON: ${error.message}`
    );
  }
}

function ghGraphql(query, variables) {
  const args = ["api", "graphql", "-f", `query=${query}`];
  for (const [key, value] of Object.entries(variables))
    args.push("-F", `${key}=${value}`);
  const run = runTool("gh", args);
  if (!run.ok)
    return refuse(run.failure_class, `GitHub GraphQL failed: ${run.detail}`);
  try {
    return { ok: true, body: JSON.parse(run.stdout) };
  } catch (error) {
    return refuse(
      "api_timeout",
      `GitHub GraphQL returned unparseable JSON: ${error.message}`
    );
  }
}

// ---------------------------------------------------------------------------
// LOCATORS — what a caller IS allowed to say: which object to go look at.
// ---------------------------------------------------------------------------
function validateLocator(locator, required) {
  if (!isPlainObject(locator))
    return "evidence locator must be an object naming the source-system object to fetch";
  const repository = String(locator.repository ?? "");
  if (!REPO_SLUG.test(repository))
    return `locator.repository "${repository}" is not an owner/name slug`;
  if (repository !== CANONICAL_REPOSITORY)
    return `locator.repository "${repository}" is not the canonical repository ${CANONICAL_REPOSITORY} — cross-repository authority is refused`;
  for (const field of required) {
    if (field === "pr_number") {
      if (!Number.isInteger(locator.pr_number) || locator.pr_number <= 0)
        return "locator.pr_number must be a positive integer";
    } else if (field === "review_id" || field === "comment_id") {
      // A14: these are interpolated into a `gh api` path. Unvalidated, a
      // traversal string performed an arbitrary authenticated GET with the
      // operator's credentials before the identity echo-check refused it.
      if (!/^\d+$/.test(String(locator[field] ?? "")))
        return `locator.${field} must be a numeric GitHub id`;
    } else if (
      typeof locator[field] !== "string" ||
      locator[field].length === 0
    ) {
      return `locator.${field} must be a non-empty string`;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// PURE DERIVATIONS — every authority rule lives here, applied to bytes the
// forge returned. Exported so the rules are directly testable; they do NOT
// mint, so calling them cannot produce a usable fact.
// ---------------------------------------------------------------------------

export function deriveApprovalFact(raw, locator) {
  const bad = validateLocator(locator, ["pr_number", "review_id"]);
  if (bad) return refuse("malformed_input", bad);
  const { pr, reviews, review_decision: reviewDecision } = raw ?? {};
  if (!isPlainObject(pr))
    return refuse("missing_evidence", "no pull request payload was fetched");
  if (!Array.isArray(reviews))
    return refuse("missing_evidence", "no review list was fetched");

  if (Number(pr.number) !== Number(locator.pr_number))
    return refuse(
      "missing_pr",
      `fetched PR #${pr.number} is not the requested PR #${locator.pr_number}`
    );
  if (String(pr.base?.ref) !== CANONICAL_BASE_BRANCH)
    return refuse(
      "authority_violation",
      `PR #${pr.number} targets "${pr.base?.ref}", not ${CANONICAL_BASE_BRANCH} — approval on a non-canonical base is not authority over main`
    );
  const headSha = String(pr.head?.sha ?? "");
  if (!SHA40.test(headSha))
    return refuse("missing_evidence", "fetched PR carries no head sha");

  // The caller names WHICH review; identity and state come from the forge.
  const review = reviews.find(
    candidate => String(candidate?.id) === String(locator.review_id)
  );
  if (!isPlainObject(review))
    return refuse(
      "missing_evidence",
      `review ${locator.review_id} does not exist on PR #${pr.number} — a review id from another PR is not authority here`
    );
  if (String(review.state) !== "APPROVED")
    return refuse(
      "authority_violation",
      `review ${review.id} is in state "${review.state}", not APPROVED${String(review.state) === "DISMISSED" ? " (it was dismissed)" : ""}`
    );

  const reviewer = String(review.user?.login ?? "");
  const problem = humanAuthorityProblem(reviewer);
  if (problem) return refuse("authority_violation", problem);

  // Freshness against the CURRENT reviewable head: an approval of an older
  // commit is not an approval of what would merge.
  if (String(review.commit_id) !== headSha)
    return refuse(
      "stale_sha",
      `review ${review.id} approved ${String(review.commit_id).slice(0, 9)} but the PR head is now ${headSha.slice(0, 9)} — the approval is stale`
    );

  // And against the branch protection's own current verdict, so a rule change
  // or a later dismissal is not something this adapter has to model itself.
  if (String(reviewDecision) !== "APPROVED")
    return refuse(
      "authority_violation",
      `branch protection currently reports reviewDecision "${reviewDecision}" — the forge does not consider this PR approved`
    );

  if (String(pr.user?.login ?? "") === reviewer)
    return refuse(
      "authority_violation",
      `reviewer "${reviewer}" is the PR author — self-approval is never authority`
    );

  return {
    ok: true,
    payload: {
      repository: CANONICAL_REPOSITORY,
      pr_number: Number(pr.number),
      head_sha: headSha,
      base_ref: CANONICAL_BASE_BRANCH,
      review_id: String(review.id),
      human_identity: reviewer,
      review_state: "APPROVED",
      review_decision: "APPROVED",
      submitted_at: String(review.submitted_at ?? ""),
      author: String(pr.user?.login ?? ""),
      evidence_url: `https://github.com/${CANONICAL_REPOSITORY}/pull/${pr.number}#pullrequestreview-${review.id}`,
    },
  };
}

export function deriveMergeFact(raw, locator) {
  const bad = validateLocator(locator, ["pr_number"]);
  if (bad) return refuse("malformed_input", bad);
  const { pr } = raw ?? {};
  if (!isPlainObject(pr))
    return refuse("missing_evidence", "no pull request payload was fetched");
  if (Number(pr.number) !== Number(locator.pr_number))
    return refuse(
      "missing_pr",
      `fetched PR #${pr.number} is not the requested PR #${locator.pr_number}`
    );
  if (pr.merged !== true)
    return refuse(
      "authority_violation",
      `PR #${pr.number} is not merged (state "${pr.state}") — a caller asserting merged=true is not evidence`
    );
  const mergeSha = String(pr.merge_commit_sha ?? "");
  if (!SHA40.test(mergeSha))
    return refuse(
      "missing_evidence",
      `PR #${pr.number} carries no merge commit sha`
    );
  if (String(pr.base?.ref) !== CANONICAL_BASE_BRANCH)
    return refuse(
      "authority_violation",
      `PR #${pr.number} merged into "${pr.base?.ref}", not ${CANONICAL_BASE_BRANCH}`
    );
  const mergedBy = String(pr.merged_by?.login ?? "");
  const problem = humanAuthorityProblem(mergedBy);
  if (problem)
    return refuse(
      "authority_violation",
      `merge of PR #${pr.number} was performed by "${mergedBy || "(unknown)"}": ${problem}`
    );
  return {
    ok: true,
    payload: {
      repository: CANONICAL_REPOSITORY,
      pr_number: Number(pr.number),
      merge_sha: mergeSha,
      head_sha: String(pr.head?.sha ?? ""),
      base_ref: CANONICAL_BASE_BRANCH,
      human_identity: mergedBy,
      merged_at: String(pr.merged_at ?? ""),
      author: String(pr.user?.login ?? ""),
      evidence_url: `https://github.com/${CANONICAL_REPOSITORY}/pull/${pr.number}`,
    },
  };
}

// Machine-authority rows still need their SHA claims checked against the forge
// rather than against `opts.github`, which was itself a caller-supplied object.
export function deriveHeadFact(raw, locator) {
  const bad = validateLocator(locator, ["pr_number"]);
  if (bad) return refuse("malformed_input", bad);
  const { pr, check_rollup: checkRollup } = raw ?? {};
  if (!isPlainObject(pr))
    return refuse("missing_evidence", "no pull request payload was fetched");
  if (Number(pr.number) !== Number(locator.pr_number))
    return refuse(
      "missing_pr",
      `fetched PR #${pr.number} is not the requested PR #${locator.pr_number}`
    );
  const headSha = String(pr.head?.sha ?? "");
  if (!SHA40.test(headSha))
    return refuse("missing_evidence", "fetched PR carries no head sha");
  const rollup = checkRollup === undefined ? null : String(checkRollup);
  if (rollup !== null && !["pending", "success", "failure"].includes(rollup))
    return refuse(
      "malformed_input",
      `check rollup "${rollup}" is not one of pending/success/failure`
    );
  return {
    ok: true,
    payload: {
      repository: CANONICAL_REPOSITORY,
      pr_number: Number(pr.number),
      head_sha: headSha,
      base_ref: String(pr.base?.ref ?? ""),
      merge_sha: pr.merged === true ? String(pr.merge_commit_sha ?? "") : null,
      check_rollup: rollup,
      evidence_url: `https://github.com/${CANONICAL_REPOSITORY}/pull/${pr.number}`,
    },
  };
}

// A human act that is not a review or a merge — the unblock decision. The only
// machine-authenticable channel available is an authored GitHub comment, whose
// author the forge attributes the same way it attributes reviews.
export function deriveHumanActFact(raw, locator) {
  const bad = validateLocator(locator, ["pr_number", "comment_id"]);
  if (bad) return refuse("malformed_input", bad);
  const { comment, pr } = raw ?? {};
  if (!isPlainObject(comment))
    return refuse("missing_evidence", "no comment payload was fetched");
  if (String(comment.id) !== String(locator.comment_id))
    return refuse(
      "missing_evidence",
      `fetched comment ${comment.id} is not the requested comment ${locator.comment_id}`
    );
  // An issue comment's own payload names the issue it belongs to; a comment
  // from a different PR must not authorize a transition on this one.
  const issueUrl = String(comment.issue_url ?? "");
  const belongs = issueUrl.endsWith(`/issues/${locator.pr_number}`);
  if (!belongs)
    return refuse(
      "authority_violation",
      `comment ${comment.id} belongs to ${issueUrl || "(unknown issue)"}, not PR #${locator.pr_number}`
    );
  const author = String(comment.user?.login ?? "");
  const problem = humanAuthorityProblem(author);
  if (problem) return refuse("authority_violation", problem);
  return {
    ok: true,
    payload: {
      repository: CANONICAL_REPOSITORY,
      pr_number: Number(locator.pr_number),
      comment_id: String(comment.id),
      human_identity: author,
      created_at: String(comment.created_at ?? ""),
      head_sha: isPlainObject(pr) ? String(pr.head?.sha ?? "") : null,
      evidence_url: String(
        comment.html_url ??
          `https://github.com/${CANONICAL_REPOSITORY}/pull/${locator.pr_number}`
      ),
      body_excerpt: String(comment.body ?? "").slice(0, 280),
      // R2-02: WHICH task the human was talking about, derived from the fetched
      // body. Without this, any comment by an allowed human authorized an
      // unblock on any task — a 2026-07-24 note about a CVE moved an unrelated
      // record out of Blocked.
      mentioned_task_ids: Object.freeze([
        ...new Set(String(comment.body ?? "").match(/\b[0-9a-f]{32}\b/g) ?? []),
      ]),
      mentioned_scope_ids: Object.freeze([
        ...new Set(String(comment.body ?? "").match(/\bTOS-\d+\b/g) ?? []),
      ]),
    },
  };
}

// Phase 10: terminal verification evidence must be FETCHED. A proof URL that
// nobody resolved is a caller string with a scheme on the front.
const PROOF_PATTERNS = Object.freeze([
  {
    kind: "actions_run",
    pattern:
      /^https:\/\/github\.com\/([A-Za-z0-9._-]+\/[A-Za-z0-9._-]+)\/actions\/runs\/(\d+)$/,
  },
  {
    kind: "pull_request",
    pattern:
      /^https:\/\/github\.com\/([A-Za-z0-9._-]+\/[A-Za-z0-9._-]+)\/pull\/(\d+)$/,
  },
  {
    kind: "commit",
    pattern:
      /^https:\/\/github\.com\/([A-Za-z0-9._-]+\/[A-Za-z0-9._-]+)\/commit\/([0-9a-f]{40})$/,
  },
]);

export function classifyProofUrl(url) {
  const value = String(url ?? "");
  for (const { kind, pattern } of PROOF_PATTERNS) {
    const match = pattern.exec(value);
    if (match) return { kind, repository: match[1], id: match[2] };
  }
  return null;
}

export function deriveProofFact(raw, locator) {
  const bad = validateLocator(locator, ["proof_url"]);
  if (bad) return refuse("malformed_input", bad);
  const classified = classifyProofUrl(locator.proof_url);
  if (!classified)
    return refuse(
      "missing_evidence",
      `proof "${locator.proof_url}" is not a resolvable GitHub run/PR/commit URL — unresolvable proof fails closed rather than being taken at face value`
    );
  if (classified.repository !== CANONICAL_REPOSITORY)
    return refuse(
      "authority_violation",
      `proof points at ${classified.repository}, not ${CANONICAL_REPOSITORY}`
    );
  const { resource } = raw ?? {};
  if (!isPlainObject(resource))
    return refuse(
      "missing_evidence",
      `proof ${locator.proof_url} did not resolve — the object does not exist or is unreadable`
    );

  let subject = null;
  if (classified.kind === "actions_run") {
    if (String(resource.id) !== classified.id)
      return refuse(
        "missing_evidence",
        `resolved run ${resource.id} is not run ${classified.id}`
      );
    if (String(resource.conclusion) !== "success")
      return refuse(
        "authority_violation",
        `run ${resource.id} concluded "${resource.conclusion}" — a failed or incomplete run is not verification evidence`
      );
    subject = String(resource.head_sha ?? "");
  } else if (classified.kind === "pull_request") {
    if (String(resource.number) !== classified.id)
      return refuse(
        "missing_evidence",
        `resolved PR #${resource.number} is not PR #${classified.id}`
      );
    if (resource.merged !== true)
      return refuse(
        "authority_violation",
        `PR #${resource.number} is not merged — an open PR is not post-merge verification`
      );
    subject = String(resource.merge_commit_sha ?? "");
  } else {
    if (String(resource.sha) !== classified.id)
      return refuse(
        "missing_evidence",
        `resolved commit ${resource.sha} is not ${classified.id}`
      );
    subject = String(resource.sha);
  }

  // If the caller stated which merge this proof is supposed to be about, the
  // fetched object has to agree. Ambiguity refuses.
  if (locator.expected_sha !== undefined) {
    if (!SHA40.test(String(locator.expected_sha)))
      return refuse(
        "malformed_input",
        "locator.expected_sha must be a 40-hex sha"
      );
    if (subject !== String(locator.expected_sha))
      return refuse(
        "stale_sha",
        `proof ${locator.proof_url} is about ${subject.slice(0, 9)}, not the expected ${String(locator.expected_sha).slice(0, 9)}`
      );
  }

  return {
    ok: true,
    payload: {
      repository: CANONICAL_REPOSITORY,
      proof_kind: classified.kind,
      proof_id: classified.id,
      subject_sha: subject,
      evidence_url: String(locator.proof_url),
    },
  };
}

// The owner grant that arms the writer. Its authenticity is NOT the JSON saying
// PREZ — that is a string in a file the machine can edit. It is:
//   1. the activation PR is merged,
//   2. an allowed human approved it at its final head,
//   3. that human is not the author,
//   4. the merge commit is an ancestor of the running tree, and
//   5. the manifest bytes at that merge commit are IDENTICAL to the bytes on
//      disk now — so the grant that is armed is exactly the grant a human read.
// (5) is what makes post-approval editing of the grant detectable.
export function deriveOwnerGrantFact(raw, grant) {
  if (!isPlainObject(grant))
    return refuse("permission_denial", "manifest carries no owner grant");
  const prNumber = grant.activationPullRequest;
  if (!Number.isInteger(prNumber) || prNumber <= 0)
    return refuse(
      "permission_denial",
      "owner grant carries no activationPullRequest — a grant with no reviewable merge behind it is a self-grant"
    );
  const approval = deriveApprovalFact(raw, {
    repository: CANONICAL_REPOSITORY,
    pr_number: prNumber,
    review_id: String(raw?.approving_review_id ?? ""),
  });
  if (!approval.ok)
    return refuse(
      approval.failure_class,
      `activation PR #${prNumber} approval is not authentic: ${approval.detail}`
    );
  const merge = deriveMergeFact(raw, {
    repository: CANONICAL_REPOSITORY,
    pr_number: prNumber,
  });
  if (!merge.ok)
    return refuse(
      merge.failure_class,
      `activation PR #${prNumber} merge is not authentic: ${merge.detail}`
    );
  if (raw?.merge_is_ancestor !== true)
    return refuse(
      "authority_violation",
      `activation merge ${merge.payload.merge_sha.slice(0, 9)} is not an ancestor of the running tree — this checkout does not contain the approved activation`
    );
  if (
    typeof raw?.manifest_at_merge !== "string" ||
    raw.manifest_at_merge === ""
  )
    return refuse(
      "missing_evidence",
      "could not read the manifest as it existed at the activation merge commit"
    );
  // A1 (CRITICAL, adversarial pass 1): the bytes compared here MUST be the bytes
  // the loader actually read. The first version compared `git show HEAD:` with
  // `git cat-file -p <merge>:` — two git blobs, neither of which is the
  // working-tree file `loadControlPlaneManifest` reads. An UNCOMMITTED
  // one-character edit therefore armed the writer while both blobs agreed it was
  // disarmed: precisely the act this check exists to detect.
  if (typeof raw?.manifest_loaded !== "string" || raw.manifest_loaded === "")
    return refuse(
      "missing_evidence",
      "could not read the control-plane manifest file that authority was loaded from"
    );
  if (raw.manifest_at_merge !== raw.manifest_loaded)
    return refuse(
      "authority_violation",
      `the control-plane manifest this process loaded differs from the version approved and merged in PR #${prNumber} — the armed grant is not the grant a human reviewed (an uncommitted edit is exactly this)`
    );
  // A2 (CRITICAL, adversarial pass 1): equality of two blobs proves nothing
  // unless the blob CONTAINS this grant. Without this, two copies of `{}`
  // authenticated, and activationPullRequest could name any merged,
  // human-approved PR that never touched the manifest.
  let merged;
  try {
    merged = JSON.parse(raw.manifest_at_merge);
  } catch (error) {
    return refuse(
      "missing_evidence",
      `the manifest at the activation merge is not parseable JSON: ${error.message}`
    );
  }
  const mergedGrant = merged?.safety?.notionWriteAuthorization;
  if (merged?.safety?.notionWriteOperationsAuthorized !== true)
    return refuse(
      "authority_violation",
      `PR #${prNumber} did not grant write authority — the manifest at its merge has notionWriteOperationsAuthorized ${JSON.stringify(merged?.safety?.notionWriteOperationsAuthorized)}. A grant must name the PR that INTRODUCED it.`
    );
  if (!isPlainObject(mergedGrant))
    return refuse(
      "authority_violation",
      `the manifest merged by PR #${prNumber} carries no owner grant to authenticate`
    );
  if (Number(mergedGrant.activationPullRequest) !== prNumber)
    return refuse(
      "authority_violation",
      `the grant merged by PR #${prNumber} names activationPullRequest ${mergedGrant.activationPullRequest} — a grant must be authenticated by the merge that introduced IT, not by an unrelated approved merge`
    );
  const canonicalise = value =>
    JSON.stringify(
      Object.fromEntries(
        Object.entries(value).sort(([a], [b]) => (a < b ? -1 : 1))
      )
    );
  if (canonicalise(mergedGrant) !== canonicalise(grant))
    return refuse(
      "authority_violation",
      `the grant in memory is not the grant merged by PR #${prNumber} — every field of an owner grant must survive unchanged from the reviewed merge to the write`
    );
  return {
    ok: true,
    payload: {
      repository: CANONICAL_REPOSITORY,
      activation_pr: prNumber,
      merge_sha: merge.payload.merge_sha,
      human_identity: approval.payload.human_identity,
      approved_head_sha: approval.payload.head_sha,
      merged_by: merge.payload.human_identity,
      decision_ref: String(grant.decision ?? ""),
      granted_on: String(grant.grantedOn ?? ""),
      actor: String(grant.actor ?? ""),
      scope: String(grant.scope ?? ""),
      evidence_url: approval.payload.evidence_url,
    },
  };
}

// ---------------------------------------------------------------------------
// RESOLVERS — production entrypoints. Fetch, derive, mint. No injection.
// ---------------------------------------------------------------------------
function fetchPullRequest(prNumber) {
  return ghApi(`repos/${CANONICAL_REPOSITORY}/pulls/${prNumber}`);
}

function fetchReviewDecision(prNumber) {
  const query =
    "query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){reviewDecision}}}";
  const [owner, name] = CANONICAL_REPOSITORY.split("/");
  const result = ghGraphql(query, { owner, name, number: prNumber });
  if (!result.ok) return result;
  return {
    ok: true,
    value: result.body?.data?.repository?.pullRequest?.reviewDecision ?? null,
  };
}

export function resolveApprovalAuthority(locator) {
  const bad = validateLocator(locator, ["pr_number", "review_id"]);
  if (bad) return refuse("malformed_input", bad);
  const pr = fetchPullRequest(locator.pr_number);
  if (!pr.ok) return pr;
  const reviews = ghApi(
    `repos/${CANONICAL_REPOSITORY}/pulls/${locator.pr_number}/reviews?per_page=100`
  );
  if (!reviews.ok) return reviews;
  const decision = fetchReviewDecision(locator.pr_number);
  if (!decision.ok) return decision;
  const derived = deriveApprovalFact(
    { pr: pr.body, reviews: reviews.body, review_decision: decision.value },
    locator
  );
  if (!derived.ok) return derived;
  return {
    ok: true,
    fact: mint("github_approval", derived.payload, Date.now()),
  };
}

export function resolveMergeAuthority(locator) {
  const bad = validateLocator(locator, ["pr_number"]);
  if (bad) return refuse("malformed_input", bad);
  const pr = fetchPullRequest(locator.pr_number);
  if (!pr.ok) return pr;
  const derived = deriveMergeFact({ pr: pr.body }, locator);
  if (!derived.ok) return derived;
  return { ok: true, fact: mint("github_merge", derived.payload, Date.now()) };
}

export function resolveHeadAuthority(locator) {
  const bad = validateLocator(locator, ["pr_number"]);
  if (bad) return refuse("malformed_input", bad);
  const pr = fetchPullRequest(locator.pr_number);
  if (!pr.ok) return pr;
  // A10: the rollup fetch used to be opt-in via locator.want_check_rollup, so a
  // caller could turn the CI cross-check off by omitting one boolean and record
  // a FAILING build as `CI` instead of routing it to Blocked. It is now
  // unconditional; the writer additionally refuses a checks_observed plan whose
  // fact carries a null rollup.
  let rollup;
  {
    const query =
      "query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){commits(last:1){nodes{commit{statusCheckRollup{state}}}}}}}";
    const [owner, name] = CANONICAL_REPOSITORY.split("/");
    const result = ghGraphql(query, { owner, name, number: locator.pr_number });
    if (!result.ok) return result;
    const state =
      result.body?.data?.repository?.pullRequest?.commits?.nodes?.[0]?.commit
        ?.statusCheckRollup?.state ?? null;
    rollup =
      state === "SUCCESS"
        ? "success"
        : state === "FAILURE" || state === "ERROR"
          ? "failure"
          : "pending";
  }
  const derived = deriveHeadFact(
    { pr: pr.body, check_rollup: rollup },
    locator
  );
  if (!derived.ok) return derived;
  return { ok: true, fact: mint("github_head", derived.payload, Date.now()) };
}

export function resolveHumanActAuthority(locator) {
  const bad = validateLocator(locator, ["pr_number", "comment_id"]);
  if (bad) return refuse("malformed_input", bad);
  const comment = ghApi(
    `repos/${CANONICAL_REPOSITORY}/issues/comments/${locator.comment_id}`
  );
  if (!comment.ok) return comment;
  const pr = fetchPullRequest(locator.pr_number);
  if (!pr.ok) return pr;
  const derived = deriveHumanActFact(
    { comment: comment.body, pr: pr.body },
    locator
  );
  if (!derived.ok) return derived;
  return {
    ok: true,
    fact: mint("github_human_act", derived.payload, Date.now()),
  };
}

export function resolveProofEvidence(locator) {
  const bad = validateLocator(locator, ["proof_url"]);
  if (bad) return refuse("malformed_input", bad);
  const classified = classifyProofUrl(locator.proof_url);
  if (!classified)
    return refuse(
      "missing_evidence",
      `proof "${locator.proof_url}" is not a resolvable GitHub run/PR/commit URL — unresolvable proof fails closed.`
    );
  const endpoint =
    classified.kind === "actions_run"
      ? `repos/${CANONICAL_REPOSITORY}/actions/runs/${classified.id}`
      : classified.kind === "pull_request"
        ? `repos/${CANONICAL_REPOSITORY}/pulls/${classified.id}`
        : `repos/${CANONICAL_REPOSITORY}/commits/${classified.id}`;
  const resource = ghApi(endpoint);
  if (!resource.ok) return resource;
  const derived = deriveProofFact({ resource: resource.body }, locator);
  if (!derived.ok) return derived;
  return { ok: true, fact: mint("github_proof", derived.payload, Date.now()) };
}

// Reads the CANONICAL manifest itself — there is deliberately no path
// parameter here or anywhere else in the production authority path.
export function resolveOwnerGrantAuthority(grant) {
  if (!isPlainObject(grant))
    return refuse(
      "permission_denial",
      "manifest carries no owner grant to authenticate"
    );
  const prNumber = grant.activationPullRequest;
  if (!Number.isInteger(prNumber) || prNumber <= 0)
    return refuse(
      "permission_denial",
      "owner grant carries no activationPullRequest — a grant with no reviewable merge behind it is a self-grant"
    );
  const pr = fetchPullRequest(prNumber);
  if (!pr.ok) return pr;
  const reviews = ghApi(
    `repos/${CANONICAL_REPOSITORY}/pulls/${prNumber}/reviews?per_page=100`
  );
  if (!reviews.ok) return reviews;
  const decision = fetchReviewDecision(prNumber);
  if (!decision.ok) return decision;

  const headSha = String(pr.body?.head?.sha ?? "");
  const approving = (Array.isArray(reviews.body) ? reviews.body : []).find(
    review =>
      String(review?.state) === "APPROVED" &&
      String(review?.commit_id) === headSha &&
      humanAuthorityProblem(review?.user?.login) === null
  );
  if (!approving)
    return refuse(
      "authority_violation",
      `activation PR #${prNumber} carries no APPROVED review by an allowed human at its final head ${headSha.slice(0, 9)}`
    );

  const mergeSha = String(pr.body?.merge_commit_sha ?? "");
  const ancestry = SHA40.test(mergeSha)
    ? runTool("git", ["merge-base", "--is-ancestor", mergeSha, "HEAD"])
    : { ok: false };
  const atMerge = SHA40.test(mergeSha)
    ? runTool("git", ["cat-file", "-p", `${mergeSha}:${MANIFEST_REPO_PATH}`])
    : { ok: false };
  // THE BYTES THAT ARMED THIS PROCESS — read from the same file the manifest
  // loader reads, not from git. See A1 in deriveOwnerGrantFact.
  let loaded;
  try {
    loaded = readFileSync(CONTROL_PLANE_MANIFEST_PATH, "utf8");
  } catch (error) {
    return refuse(
      "missing_evidence",
      `could not read the canonical control-plane manifest: ${error.message}`
    );
  }

  const derived = deriveOwnerGrantFact(
    {
      pr: pr.body,
      reviews: reviews.body,
      review_decision: decision.value,
      approving_review_id: String(approving.id),
      merge_is_ancestor: ancestry.ok === true,
      manifest_at_merge: atMerge.ok ? atMerge.stdout : null,
      manifest_loaded: loaded,
    },
    grant
  );
  if (!derived.ok) return derived;
  return { ok: true, fact: mint("owner_grant", derived.payload, Date.now()) };
}

// Which authority kind each human-gated trigger requires. Closed table, like
// every other decision surface in this system: an unknown trigger has no
// authority source and therefore cannot be authorized.
export const TRIGGER_AUTHORITY_SOURCE = Object.freeze({
  approval_observed: Object.freeze({
    kind: "github_approval",
    source_system: "github",
    rationale:
      "an APPROVED review by an allowed human, attributed by the forge to a credential this agent does not hold",
  }),
  merge_observed: Object.freeze({
    kind: "github_merge",
    source_system: "github",
    rationale:
      "the forge's own merged/merge_commit_sha state, plus the human who merged",
  }),
  deploy_consequence_recorded: Object.freeze({
    kind: "github_merge",
    source_system: "github",
    rationale:
      "merging dime-ai main IS the production deploy (deploy law), so the deploy DECISION is the human merge act; the deploy RESULT is observed separately and is evidence, not authority",
  }),
  unblocked: Object.freeze({
    kind: "github_human_act",
    source_system: "github",
    rationale:
      "an authored comment by an allowed human on the canonical PR; a Notion-only unblock decision is not machine-authenticable and fails closed",
  }),
});
