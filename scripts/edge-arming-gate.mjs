/**
 * edge-arming-gate.mjs — the mechanism that makes the soak verdict BINDING.
 *
 * ── Why this file exists ──────────────────────────────────────────────────────
 * scripts/edge-soak-report.mjs already computes a correct, non-waivable verdict
 * on soak evidence. Nothing invoked it. A correct verdict nobody is required to
 * obtain is indistinguishable, operationally, from the paragraph it replaced:
 * on 2026-08-06 the origin lock was armed on 23 requests over ~4 minutes and
 * real users were 403'd for ~7 hours.
 *
 * This file turns that verdict into a control with two legs:
 *
 *   1. `authorize` — the ARMING PRECONDITION. It re-runs the soak gate over an
 *      evidence bundle, binds the result to the live deployment and to the edge
 *      configuration that produced it, checks the evidence is FRESH, confirms
 *      production is not already armed, and only then emits a machine-readable
 *      AUTHORIZATION RECORD. There is no path to a record that does not pass.
 *
 *   2. `enforce` — the STANDING CONTROL. It observes live production posture. If
 *      production is ARMED, a valid, unexpired, correctly-bound authorization
 *      record must exist or the check FAILS. The stored verdict inside that
 *      record is NEVER trusted: `enforce` re-runs `evaluateSoak()` over the
 *      evidence the record embeds, so a hand-written record has to carry
 *      evidence that genuinely clears all eight soak conditions.
 *
 * `validate` is leg 2 without the network — the offline shape/integrity/soak
 * re-run used as a pull-request check on the record file itself.
 *
 * ── THE ANTI-DEADLOCK INVARIANT (read this before changing anything) ──────────
 * Dropping to `EDGE_MODE=log` is the production recovery path (runbook §5). It
 * MUST always be available. This gate guarantees that three ways, and each one
 * alone is sufficient:
 *
 *   a. THE GATE IS ONE-DIRECTIONAL BY CONSTRUCTION. `evaluateEnforcement()`
 *      inspects the record ONLY on the ARMED branch. When posture is NOT_ARMED
 *      it returns PASS immediately, without reading the record at all — a
 *      missing, expired, corrupt, or absent-entirely record cannot produce a
 *      failure against a disarmed production. De-arming therefore always CLEARS
 *      this gate; it can never be blocked by it. Pinned by the test block
 *      "edgeArmingGate — the anti-deadlock invariant: de-arming is never gated",
 *      which drives five separately-broken records past it.
 *   b. THE GATE HAS NO WRITE PATH TO PRODUCTION. It runs in GitHub Actions and
 *      in an operator shell. It cannot set a Railway variable, cannot redeploy,
 *      cannot hold a lock, and is not a Railway healthcheck. Nothing it does can
 *      delay or prevent `EDGE_MODE=log` taking effect.
 *   c. IT IS NOT A DEPLOY GATE. It is not wired into the deploy pipeline and is
 *      not a required status check on merges to main — Railway deploys on push
 *      regardless of its state. A red arming gate stops nothing from shipping,
 *      including the fix.
 *
 * The consequence, stated plainly: this gate constrains ARMING (off/log -> on).
 * It does not constrain DE-ARMING (on -> log/off) and structurally cannot.
 *
 * ── NO OVERRIDE ──────────────────────────────────────────────────────────────
 * There is deliberately no `--force`, no `--skip`, no env escape, and no
 * threshold argument anywhere in this file. An emergency does not need one: the
 * emergency action is to DROP TO LOG, which this gate does not gate. An override
 * would exist only to arm the lock in a hurry on evidence that did not qualify —
 * which is a verbatim description of the 2026-08-06 incident. `edgeArmingGate —
 * offers no override seam` pins its absence.
 *
 * ── What binding means here ──────────────────────────────────────────────────
 * A record is bound to the EDGE CONFIGURATION STATE (a fingerprint over the
 * three files that decide whether a request is refused: edgeProxy.ts,
 * originLock.ts, edgeCircuitBreaker.ts) and to the ORIGIN HOST — not to every
 * app commit. Binding to the commit would invalidate the authorization on every
 * unrelated merge and create standing pressure to disarm, which is the opposite
 * of the goal. The deployment identity (`/health`'s `commit`) IS bound at ISSUE
 * time: the evidence must come from the deployment that was actually live.
 *
 * ── Honest limits (do not upgrade these claims) ──────────────────────────────
 *  - `recordSha256` is an INTEGRITY checksum, not a signature. It catches
 *    truncation, partial edits, and merge damage. It is not authentication: a
 *    determined editor can recompute it. Authentication comes from the record
 *    living in git under review, plus the fact that `enforce` re-derives the
 *    verdict from the embedded evidence rather than reading it.
 *  - `enforce` is DETECTIVE for the Railway-dashboard arming path. Nothing in
 *    this repository can prevent an owner from typing `on` into Railway; no
 *    repo-side artifact is consulted by the running server. What this gate
 *    guarantees is that arming without qualifying evidence becomes a RED,
 *    machine-readable, dated CI failure rather than an undetected state.
 *  - Posture is inferred from BEHAVIOUR (a raw-origin probe), never from an
 *    environment variable. Environment variables are not readable from here.
 *
 * ── Usage ────────────────────────────────────────────────────────────────────
 *   node scripts/edge-arming-gate.mjs authorize --evidence=soak.json \
 *        --origin=https://<raw-railway-origin> --actor=<who> --reason=<why> \
 *        [--out=docs/runbooks/edge-arming-authorization.json] [--json]
 *
 *   node scripts/edge-arming-gate.mjs enforce --origin=https://<raw-railway-origin> \
 *        [--record=docs/runbooks/edge-arming-authorization.json] [--json]
 *
 *   node scripts/edge-arming-gate.mjs validate \
 *        [--record=docs/runbooks/edge-arming-authorization.json] [--json]
 *
 * Exit codes: 0 = PASS/AUTHORIZED, 1 = FAIL (every fail-closed path), 2 = usage.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { evaluateSoak, sanitizeForOutput } from "./edge-soak-report.mjs";

// ─── Constants (non-waivable; read, never written) ───────────────────────────

export const RECORD_KIND = "edge-arming-authorization";
export const RECORD_VERSION = 1;

/** Canonical committed location of the authorization record. */
export const DEFAULT_RECORD_PATH =
  "docs/runbooks/edge-arming-authorization.json";

/**
 * How old the soak evidence may be, at the moment a record is ISSUED.
 *
 * This is requirement "stale evidence must not authorise arming". A soak proves
 * that Cloudflare was injecting the origin secret for the traffic observed
 * DURING the soak. Six hours later a Transform Rule may have been edited, a
 * zone setting flipped, or DNS re-pointed — none of which the old evidence can
 * speak to. Six hours is long enough to collect, review, and land a record
 * through a pull request, and short enough that the edge configuration it
 * describes is still the one in front of production.
 *
 * `enforce` RE-CHECKS this against the record's own `issuedAtMs`; it is never
 * taken on trust from the issuing run.
 */
export const MAX_EVIDENCE_AGE_MS = 6 * 60 * 60 * 1000;

/**
 * How long an issued authorization remains valid before the soak must be
 * repeated. This is a RE-ATTESTATION cadence, not a kill switch: when it lapses
 * the standing check goes red and asks for a fresh soak. It never forces
 * disarming, and disarming clears the check regardless (invariant (a) above).
 */
export const AUTHORIZATION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** Tolerance for clock skew between the evidence collector and this run. */
export const CLOCK_SKEW_TOLERANCE_MS = 5 * 60 * 1000;

/**
 * The files whose content decides whether a request is refused. A change to any
 * of them invalidates an existing authorization, because the thing the soak
 * observed is no longer the thing that will run. Unrelated app commits do not
 * appear here on purpose — see "What binding means here" above.
 */
export const EDGE_CONFIG_FILES = Object.freeze([
  "server/_core/edgeProxy.ts",
  "server/_core/originLock.ts",
  "server/_core/edgeCircuitBreaker.ts",
]);

/** Default raw-origin path probed for the lock. `/health` is lock-exempt. */
export const DEFAULT_PROBE_PATH = "/";

export const POSTURE = Object.freeze({
  ARMED: "ARMED",
  NOT_ARMED: "NOT_ARMED",
  INDETERMINATE: "INDETERMINATE",
});

// ─── Small helpers ───────────────────────────────────────────────────────────

export function sha256Hex(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

const HEX64 = /^[0-9a-f]{64}$/;
const GIT_SHA = /^[0-9a-f]{7,40}$/;

/**
 * Deterministic JSON: object keys sorted, so the same logical record always
 * hashes to the same digest regardless of key insertion order. Without this the
 * integrity hash would depend on how the JSON happened to be written and would
 * fire spuriously after any reserialization.
 */
export function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  const keys = Object.keys(value).sort();
  const parts = [];
  for (const key of keys) {
    if (value[key] === undefined) continue;
    parts.push(`${JSON.stringify(key)}:${canonicalJson(value[key])}`);
  }
  return `{${parts.join(",")}}`;
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function iso(ms) {
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function condition(id, description, pass, detail) {
  return { id, description, pass: pass === true, detail: String(detail ?? "") };
}

// ─── Configuration fingerprint ───────────────────────────────────────────────

/**
 * Hashes the edge-enforcement source files into one fingerprint. A read failure
 * is returned as a problem, never thrown and never skipped: a fingerprint
 * computed over "the files we happened to be able to read" would silently stop
 * binding to the ones that failed.
 */
export function computeConfigFingerprint(
  readFile = readFileSync,
  files = EDGE_CONFIG_FILES
) {
  const entries = [];
  const problems = [];
  for (const path of files) {
    try {
      const text = readFile(path, "utf8");
      if (typeof text !== "string") {
        problems.push(`${path}: reader returned ${typeof text}, not a string`);
        continue;
      }
      entries.push({ path, sha256: sha256Hex(text) });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      problems.push(`${path}: ${msg}`);
    }
  }
  if (problems.length > 0 || entries.length !== files.length) {
    return { fingerprint: null, files: entries, problems };
  }
  return {
    fingerprint: sha256Hex(canonicalJson(entries)),
    files: entries,
    problems: [],
  };
}

// ─── Live posture ────────────────────────────────────────────────────────────

/**
 * Turns raw probe observations into a posture. Every ambiguity resolves to
 * INDETERMINATE, and INDETERMINATE fails both legs (fail-closed on query
 * errors). "We could not tell" is never "it is fine".
 *
 * The discriminator is POSITIVE, not an absence:
 *   ARMED     = /health is 200 AND names a commit (so the origin is up and
 *               serving OUR build) AND the non-exempt path returns 403 with a
 *               ZERO-length body — originLock's signature is `res.status(403).end()`,
 *               which sends no body. A 403 carrying a body is somebody else's
 *               403 (a WAF, a proxy) and is reported as INDETERMINATE.
 *   NOT_ARMED = /health is 200 AND names a commit AND the non-exempt path
 *               returns a non-403 status the origin actually served.
 */
export function classifyPosture(observation) {
  const notes = [];
  if (!observation || typeof observation !== "object") {
    return {
      posture: POSTURE.INDETERMINATE,
      servingCommit: null,
      notes: ["no probe observation was produced"],
    };
  }
  if (isNonEmptyString(observation.error)) {
    return {
      posture: POSTURE.INDETERMINATE,
      servingCommit: null,
      notes: [`probe error: ${sanitizeForOutput(observation.error, 160)}`],
    };
  }
  if (observation.healthStatus !== 200) {
    return {
      posture: POSTURE.INDETERMINATE,
      servingCommit: null,
      notes: [
        `/health returned ${Number(observation.healthStatus)} on the raw origin — the origin is not serving, so its lock posture cannot be read`,
      ],
    };
  }
  const commit = isNonEmptyString(observation.healthCommit)
    ? observation.healthCommit.trim()
    : null;
  if (!commit || !GIT_SHA.test(commit)) {
    return {
      posture: POSTURE.INDETERMINATE,
      servingCommit: null,
      notes: [
        `/health did not identify the build it is serving (commit=${sanitizeForOutput(String(observation.healthCommit ?? "null"), 48)}) — the probe cannot bind to a deployment`,
      ],
    };
  }
  if (!Number.isFinite(observation.probeStatus)) {
    return {
      posture: POSTURE.INDETERMINATE,
      servingCommit: commit,
      notes: ["the lock probe returned no HTTP status"],
    };
  }
  if (observation.probeStatus === 403) {
    if (observation.probeBodyBytes !== 0) {
      return {
        posture: POSTURE.INDETERMINATE,
        servingCommit: commit,
        notes: [
          `the raw origin returned 403 with a ${Number(observation.probeBodyBytes)}-byte body; originLock answers with an EMPTY body, so this 403 came from something else`,
        ],
      };
    }
    notes.push(
      "raw origin: /health 200 plus non-exempt path 403 with an empty body -> originLock is enforcing"
    );
    return { posture: POSTURE.ARMED, servingCommit: commit, notes };
  }
  notes.push(
    `raw origin: /health 200 plus non-exempt path ${Number(observation.probeStatus)} -> the origin is serving the request itself, so the lock is not enforcing`
  );
  return { posture: POSTURE.NOT_ARMED, servingCommit: commit, notes };
}

/**
 * Performs the two raw-origin requests. Returns observations; NEVER throws — a
 * thrown probe would abort the gate instead of failing it closed.
 */
export async function probeProduction({
  origin,
  probePath = DEFAULT_PROBE_PATH,
  fetchImpl = globalThis.fetch,
  timeoutMs = 20000,
} = {}) {
  if (!isNonEmptyString(origin)) {
    return { error: "no --origin supplied; posture cannot be observed" };
  }
  if (typeof fetchImpl !== "function") {
    return { error: "no fetch implementation available" };
  }
  const base = origin.trim().replace(/\/+$/, "");
  const get = async url => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchImpl(url, {
        redirect: "manual",
        signal: controller.signal,
        headers: { "user-agent": "dime-edge-arming-gate" },
      });
      const text = await res.text();
      return { status: res.status, text };
    } finally {
      clearTimeout(timer);
    }
  };
  try {
    const health = await get(`${base}/health`);
    let healthCommit = null;
    try {
      const parsed = JSON.parse(health.text);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        healthCommit =
          typeof parsed.commit === "string" ? parsed.commit.trim() : null;
      }
    } catch {
      healthCommit = null;
    }
    const probe = await get(`${base}${probePath}`);
    return {
      origin: base,
      probePath,
      healthStatus: health.status,
      healthCommit,
      probeStatus: probe.status,
      probeBodyBytes: Buffer.byteLength(probe.text ?? "", "utf8"),
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { origin: base, probePath, error: msg };
  }
}

// ─── Evidence handling ───────────────────────────────────────────────────────

/** Reads an evidence bundle. Every failure becomes a problem, never a throw. */
export function loadEvidence(path, readFile = readFileSync) {
  try {
    const parsed = JSON.parse(readFile(path, "utf8"));
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      Array.isArray(parsed)
    ) {
      return { evidence: null, problem: `${path} is not a JSON object` };
    }
    return { evidence: parsed, problem: null };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { evidence: null, problem: `could not read ${path}: ${msg}` };
  }
}

/** The window end an evidence bundle claims, or null if it states none. */
export function evidenceWindowEndMs(evidence) {
  if (evidence && Number.isFinite(evidence.windowEndMs)) {
    return evidence.windowEndMs;
  }
  return null;
}

// ─── Leg 1: authorize ────────────────────────────────────────────────────────

/**
 * Decides whether an arming authorization may be issued, and builds the record
 * when it may. Pure: no clock, no filesystem, no network — everything is passed
 * in, so the same inputs always produce the same verdict.
 *
 * Deliberately takes NO threshold argument of any kind. The soak thresholds live
 * in edge-soak-report.mjs and the time limits are module constants above; there
 * is no parameter through which a caller can relax either.
 */
export function evaluateAuthorization({
  evidence,
  evidenceProblem = null,
  nowMs,
  actor,
  reason,
  posture,
  servingCommit = null,
  configFingerprint = null,
  configFiles = [],
  configProblems = [],
  originHost,
  deploymentId = null,
  soakEnv,
} = {}) {
  const conditions = [];

  // 1. The soak gate itself — the whole of edge-soak-report's eight conditions,
  //    re-run here rather than quoted from a previous run.
  const soakReport =
    evidenceProblem === null && evidence
      ? evaluateSoak(evidence, soakEnv ? { env: soakEnv } : {})
      : null;
  conditions.push(
    condition(
      "evidence_readable",
      "the soak evidence bundle is readable JSON",
      evidenceProblem === null && evidence !== null && evidence !== undefined,
      evidenceProblem ?? "read"
    )
  );
  conditions.push(
    condition(
      "soak_gate_pass",
      "scripts/edge-soak-report.mjs returns PASS on this evidence (window, volume, distinct sources, concentration, real-source would-denies, classifiability, data errors)",
      soakReport !== null && soakReport.verdict === "PASS",
      soakReport === null
        ? "not evaluated — the evidence could not be read"
        : `soak verdict=${soakReport.verdict} failed=[${soakReport.failedConditions.join(", ")}]`
    )
  );

  // 2. Freshness. Both directions: too old cannot authorize, and evidence dated
  //    in the future is a clock or fabrication problem, not a fresher soak.
  const windowEnd = evidenceWindowEndMs(evidence);
  const ageMs =
    windowEnd === null || !Number.isFinite(nowMs) ? null : nowMs - windowEnd;
  conditions.push(
    condition(
      "evidence_states_window_end",
      "the evidence states when the soak window ended",
      windowEnd !== null,
      windowEnd === null ? "windowEndMs missing or not finite" : iso(windowEnd)
    )
  );
  conditions.push(
    condition(
      "evidence_fresh",
      `the soak ended no more than ${Math.round(MAX_EVIDENCE_AGE_MS / 3600000)}h before this authorization is issued`,
      ageMs !== null && ageMs <= MAX_EVIDENCE_AGE_MS,
      ageMs === null
        ? "not computable"
        : `evidence age ${Math.round(ageMs / 60000)} min (limit ${Math.round(MAX_EVIDENCE_AGE_MS / 60000)} min)`
    )
  );
  conditions.push(
    condition(
      "evidence_not_future_dated",
      "the soak window does not end in the future",
      ageMs !== null && ageMs >= -CLOCK_SKEW_TOLERANCE_MS,
      ageMs === null
        ? "not computable"
        : `evidence age ${Math.round(ageMs / 60000)} min`
    )
  );

  // 3. Live posture. An authorization authorizes a TRANSITION, so production
  //    must currently be un-armed; and if the probe could not tell, we stop.
  conditions.push(
    condition(
      "posture_observed",
      "live production posture was observed on the raw origin (a probe failure is never a pass)",
      posture === POSTURE.ARMED || posture === POSTURE.NOT_ARMED,
      `posture=${posture ?? "<none>"}`
    )
  );
  conditions.push(
    condition(
      "posture_not_already_armed",
      "production is currently NOT armed — this authorizes the off/log -> on transition",
      posture === POSTURE.NOT_ARMED,
      `posture=${posture ?? "<none>"}`
    )
  );

  // 4. Binding.
  const fingerprintOk =
    isNonEmptyString(configFingerprint) && HEX64.test(configFingerprint);
  conditions.push(
    condition(
      "config_fingerprint_computed",
      `the edge-enforcement configuration fingerprint was computed over ${EDGE_CONFIG_FILES.length} files`,
      fingerprintOk && configProblems.length === 0,
      configProblems.length > 0
        ? configProblems.map(p => sanitizeForOutput(p, 120)).join("; ")
        : (configFingerprint ?? "<none>")
    )
  );
  conditions.push(
    condition(
      "deployment_identified",
      "the deployment that produced the evidence identifies itself (/health names a commit)",
      isNonEmptyString(servingCommit) &&
        GIT_SHA.test(String(servingCommit).trim()),
      `servingCommit=${sanitizeForOutput(String(servingCommit ?? "<none>"), 48)}`
    )
  );
  conditions.push(
    condition(
      "origin_host_stated",
      "the origin host this authorization applies to is stated",
      isNonEmptyString(originHost),
      sanitizeForOutput(String(originHost ?? "<none>"), 120)
    )
  );

  // 5. Attribution — the audit trail requirement. A record with no human and no
  //    stated reason is not an audit trail, it is a file.
  conditions.push(
    condition(
      "attribution_present",
      "the record names the actor issuing it and the reason for arming",
      isNonEmptyString(actor) && isNonEmptyString(reason),
      `actor=${sanitizeForOutput(String(actor ?? "<none>"), 60)} reason=${sanitizeForOutput(String(reason ?? "<none>"), 80)}`
    )
  );

  const failed = conditions.filter(c => !c.pass).map(c => c.id);
  const verdict = failed.length === 0 ? "AUTHORIZED" : "REFUSED";

  let record = null;
  if (verdict === "AUTHORIZED") {
    const base = {
      kind: RECORD_KIND,
      version: RECORD_VERSION,
      verdict: "AUTHORIZED",
      issuedAtMs: nowMs,
      issuedAtIso: iso(nowMs),
      expiresAtMs: nowMs + AUTHORIZATION_TTL_MS,
      expiresAtIso: iso(nowMs + AUTHORIZATION_TTL_MS),
      binding: {
        originHost: String(originHost).trim(),
        configFingerprint,
        configFiles: Array.isArray(configFiles) ? configFiles : [],
        servingCommit: String(servingCommit).trim(),
        deploymentId: isNonEmptyString(deploymentId)
          ? String(deploymentId).trim()
          : null,
        edgeModeDuringSoak: soakReport.edgeMode,
        postureAtIssue: posture,
      },
      audit: {
        actor: String(actor).trim(),
        reason: String(reason).trim(),
        evidenceWindowStartMs: evidence.windowStartMs ?? null,
        evidenceWindowEndMs: windowEnd,
        evidenceAgeAtIssueMs: ageMs,
      },
      soakSummary: {
        verdict: soakReport.verdict,
        effectiveMinutes: soakReport.window.effectiveMinutes,
        realRequests: soakReport.totals.realRequests,
        distinctRealSources: soakReport.totals.distinctRealSources,
        topRealSourceRequests: soakReport.totals.topRealSourceRequests,
        wouldDenyFromRealSources: soakReport.totals.wouldDenyFromRealSources,
      },
      // The evidence travels WITH the record so `enforce` can re-derive the
      // verdict instead of believing `soakSummary`. Removing this field is a
      // downgrade from "re-derived" to "asserted" — do not.
      evidence,
      evidenceSha256: sha256Hex(canonicalJson(evidence)),
    };
    record = { ...base, recordSha256: recordIntegrityHash(base) };
  }

  return { verdict, conditions, failedConditions: failed, soakReport, record };
}

/** Integrity hash over everything in the record except the hash field itself. */
export function recordIntegrityHash(record) {
  if (record === null || typeof record !== "object") return null;
  const { recordSha256: _ignored, ...rest } = record;
  return sha256Hex(canonicalJson(rest));
}

// ─── Record validation (leg 2, offline half) ─────────────────────────────────

/**
 * Re-derives everything about a record. Nothing stored inside it is believed:
 * the soak verdict is recomputed from the embedded evidence, the evidence hash
 * is recomputed from the evidence, the integrity hash is recomputed from the
 * record, and the freshness rule is re-applied to the record's own issuedAtMs.
 */
export function validateRecord({
  record,
  recordProblem = null,
  nowMs,
  liveConfigFingerprint = null,
  configProblems = [],
  originHost = null,
  soakEnv,
} = {}) {
  const conditions = [];
  const isObject =
    recordProblem === null &&
    record !== null &&
    typeof record === "object" &&
    !Array.isArray(record);

  conditions.push(
    condition(
      "record_present",
      "an authorization record exists and parses as a JSON object",
      isObject,
      recordProblem ?? (isObject ? "parsed" : "not an object")
    )
  );
  if (!isObject) {
    return {
      verdict: "FAIL",
      conditions,
      failedConditions: conditions.filter(c => !c.pass).map(c => c.id),
      soakReport: null,
    };
  }

  conditions.push(
    condition(
      "record_shape",
      `record declares kind="${RECORD_KIND}", version=${RECORD_VERSION}, verdict="AUTHORIZED"`,
      record.kind === RECORD_KIND &&
        record.version === RECORD_VERSION &&
        record.verdict === "AUTHORIZED",
      `kind=${sanitizeForOutput(String(record.kind), 40)} version=${sanitizeForOutput(String(record.version), 10)} verdict=${sanitizeForOutput(String(record.verdict), 20)}`
    )
  );

  const recomputed = recordIntegrityHash(record);
  conditions.push(
    condition(
      "record_integrity",
      "recordSha256 matches the record's own content (catches truncation and partial edits; it is not a signature)",
      isNonEmptyString(record.recordSha256) &&
        record.recordSha256 === recomputed,
      `stored=${sanitizeForOutput(String(record.recordSha256 ?? "<none>"), 20)} recomputed=${String(recomputed ?? "").slice(0, 20)}`
    )
  );

  const evidence = record.evidence;
  const evidenceIsObject =
    evidence !== null &&
    typeof evidence === "object" &&
    !Array.isArray(evidence);
  conditions.push(
    condition(
      "evidence_embedded",
      "the record embeds the evidence bundle its verdict was derived from",
      evidenceIsObject,
      evidenceIsObject ? "present" : "missing or not an object"
    )
  );

  conditions.push(
    condition(
      "evidence_hash_matches",
      "the embedded evidence hashes to the record's evidenceSha256",
      evidenceIsObject &&
        isNonEmptyString(record.evidenceSha256) &&
        record.evidenceSha256 === sha256Hex(canonicalJson(evidence)),
      evidenceIsObject
        ? `stored=${sanitizeForOutput(String(record.evidenceSha256 ?? "<none>"), 20)}`
        : "not computable"
    )
  );

  // THE re-derivation. A stored "verdict": "AUTHORIZED" buys nothing here.
  const soakReport = evidenceIsObject
    ? evaluateSoak(evidence, soakEnv ? { env: soakEnv } : {})
    : null;
  conditions.push(
    condition(
      "soak_gate_repasses",
      "re-running the soak gate over the embedded evidence returns PASS (the stored verdict is never trusted)",
      soakReport !== null && soakReport.verdict === "PASS",
      soakReport === null
        ? "not evaluated"
        : `soak verdict=${soakReport.verdict} failed=[${soakReport.failedConditions.join(", ")}]`
    )
  );

  const windowEnd = evidenceIsObject ? evidenceWindowEndMs(evidence) : null;
  const ageAtIssue =
    windowEnd !== null && Number.isFinite(record.issuedAtMs)
      ? record.issuedAtMs - windowEnd
      : null;
  conditions.push(
    condition(
      "evidence_was_fresh_at_issue",
      `the embedded evidence was <= ${Math.round(MAX_EVIDENCE_AGE_MS / 3600000)}h old when the record was issued (re-checked, not taken from the issuing run)`,
      ageAtIssue !== null &&
        ageAtIssue <= MAX_EVIDENCE_AGE_MS &&
        ageAtIssue >= -CLOCK_SKEW_TOLERANCE_MS,
      ageAtIssue === null
        ? "not computable"
        : `${Math.round(ageAtIssue / 60000)} min at issue`
    )
  );

  const expiresAt = Number.isFinite(record.issuedAtMs)
    ? record.issuedAtMs + AUTHORIZATION_TTL_MS
    : null;
  conditions.push(
    condition(
      "authorization_not_expired",
      `the authorization is younger than its ${Math.round(AUTHORIZATION_TTL_MS / 86400000)}-day validity period`,
      expiresAt !== null && Number.isFinite(nowMs) && nowMs <= expiresAt,
      expiresAt === null
        ? "issuedAtMs missing or not finite"
        : `expires ${iso(expiresAt)}, now ${iso(nowMs)}`
    )
  );

  const binding = record.binding;
  const bindingIsObject =
    binding !== null && typeof binding === "object" && !Array.isArray(binding);
  conditions.push(
    condition(
      "binding_present",
      "the record binds to an edge configuration fingerprint and an origin host",
      bindingIsObject &&
        isNonEmptyString(binding.configFingerprint) &&
        HEX64.test(binding.configFingerprint) &&
        isNonEmptyString(binding.originHost),
      bindingIsObject
        ? `fingerprint=${sanitizeForOutput(String(binding.configFingerprint ?? "<none>"), 20)} host=${sanitizeForOutput(String(binding.originHost ?? "<none>"), 80)}`
        : "binding missing"
    )
  );

  conditions.push(
    condition(
      "config_fingerprint_matches_tree",
      "the edge-enforcement files in this checkout still hash to the fingerprint the soak was conducted against",
      configProblems.length === 0 &&
        isNonEmptyString(liveConfigFingerprint) &&
        bindingIsObject &&
        binding.configFingerprint === liveConfigFingerprint,
      configProblems.length > 0
        ? configProblems.map(p => sanitizeForOutput(p, 120)).join("; ")
        : `tree=${String(liveConfigFingerprint ?? "<none>").slice(0, 20)} record=${sanitizeForOutput(String(bindingIsObject ? (binding.configFingerprint ?? "<none>") : "<none>"), 20)}`
    )
  );

  if (isNonEmptyString(originHost)) {
    conditions.push(
      condition(
        "origin_host_matches",
        "the record was issued for the origin being checked",
        bindingIsObject &&
          normalizeHost(binding.originHost) === normalizeHost(originHost),
        `record=${sanitizeForOutput(String(bindingIsObject ? (binding.originHost ?? "<none>") : "<none>"), 80)} checked=${sanitizeForOutput(originHost, 80)}`
      )
    );
  }

  conditions.push(
    condition(
      "attribution_present",
      "the record names the actor and the reason (audit trail)",
      record.audit !== null &&
        typeof record.audit === "object" &&
        isNonEmptyString(record.audit.actor) &&
        isNonEmptyString(record.audit.reason),
      record.audit && typeof record.audit === "object"
        ? `actor=${sanitizeForOutput(String(record.audit.actor ?? "<none>"), 60)}`
        : "audit block missing"
    )
  );

  const failed = conditions.filter(c => !c.pass).map(c => c.id);
  return {
    verdict: failed.length === 0 ? "PASS" : "FAIL",
    conditions,
    failedConditions: failed,
    soakReport,
  };
}

function normalizeHost(value) {
  return String(value ?? "")
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/+$/, "")
    .toLowerCase();
}

// ─── Leg 2: enforce ──────────────────────────────────────────────────────────

/**
 * THE STANDING CONTROL.
 *
 * ANTI-DEADLOCK INVARIANT (a): the NOT_ARMED branch returns PASS before the
 * record is looked at. Do not move record handling above it, do not add a
 * record condition to that branch, and do not "helpfully" warn-and-fail on a
 * stale record while disarmed — any of those would make de-arming blockable,
 * which is the one thing this gate must never do.
 */
export function evaluateEnforcement({
  posture,
  postureNotes = [],
  record,
  recordProblem = null,
  nowMs,
  liveConfigFingerprint = null,
  configProblems = [],
  originHost = null,
  soakEnv,
} = {}) {
  if (posture === POSTURE.NOT_ARMED) {
    return {
      verdict: "PASS",
      posture,
      postureNotes,
      requiresAuthorization: false,
      reason:
        "production is NOT armed. This gate constrains arming (off/log -> on) only; " +
        "de-arming is never gated, so no authorization record is required or consulted.",
      conditions: [],
      failedConditions: [],
      soakReport: null,
    };
  }

  if (posture !== POSTURE.ARMED) {
    return {
      verdict: "FAIL",
      posture: posture ?? POSTURE.INDETERMINATE,
      postureNotes,
      requiresAuthorization: true,
      reason:
        "production posture could not be determined. Fail-closed: an unreadable posture " +
        "is never treated as disarmed.",
      conditions: [
        condition(
          "posture_observed",
          "live production posture was observed on the raw origin",
          false,
          postureNotes.join("; ") || "no observation"
        ),
      ],
      failedConditions: ["posture_observed"],
      soakReport: null,
    };
  }

  const validation = validateRecord({
    record,
    recordProblem,
    nowMs,
    liveConfigFingerprint,
    configProblems,
    originHost,
    soakEnv,
  });
  return {
    verdict: validation.verdict,
    posture,
    postureNotes,
    requiresAuthorization: true,
    reason:
      validation.verdict === "PASS"
        ? "production is ARMED and a valid, unexpired, correctly-bound authorization record backs it."
        : "production is ARMED without a valid authorization record. Either issue one from a qualifying soak, or set EDGE_MODE=log (which needs no authorization and clears this gate immediately).",
    conditions: validation.conditions,
    failedConditions: validation.failedConditions,
    soakReport: validation.soakReport,
  };
}

// ─── Rendering ───────────────────────────────────────────────────────────────

export function renderReport(report) {
  const bar = "─".repeat(72);
  const lines = [bar];
  lines.push(`EDGE ARMING GATE (${report.mode}) — VERDICT: ${report.verdict}`);
  lines.push(bar);
  if (report.posture) lines.push(`Live posture           : ${report.posture}`);
  for (const note of report.postureNotes ?? []) {
    // Notes are authored by classifyPosture(), which sanitizes every remote-
    // controlled scalar it interpolates (error text, healthCommit) and coerces
    // the rest with Number(). Re-running the IP sanitizer here would mangle
    // ordinary prose, so only control characters are stripped -- enough to stop
    // ANSI/CR log injection, which is the only thing prose can smuggle.
    lines.push(
      `  ${String(note)
        .replace(/[\x00-\x1f\x7f]/g, "?")
        .slice(0, 240)}`
    );
  }
  if (report.reason) {
    lines.push("");
    lines.push(report.reason);
  }
  if ((report.conditions ?? []).length > 0) {
    lines.push("");
    lines.push("Conditions (all non-waivable, no override exists):");
    for (const c of report.conditions) {
      lines.push(`  [${c.pass ? "PASS" : "FAIL"}] ${c.id} — ${c.description}`);
      if (c.detail) lines.push(`         ${sanitizeForOutput(c.detail, 240)}`);
    }
  }
  lines.push(bar);
  if (report.mode === "authorize") {
    lines.push(
      report.verdict === "AUTHORIZED"
        ? `AUTHORIZED — commit the record (${report.recordPath ?? DEFAULT_RECORD_PATH}) through a reviewed PR, then set EDGE_MODE=on.`
        : "REFUSED — DO NOT set EDGE_MODE=on. No record was written. There is no override."
    );
  } else {
    lines.push(
      report.verdict === "PASS"
        ? "PASS"
        : "FAIL — production is armed without qualifying evidence, OR posture is unreadable. Remedy: EDGE_MODE=log (never gated), or a fresh soak + authorization."
    );
  }
  lines.push(bar);
  return lines.join("\n");
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

const USAGE = `edge-arming-gate — makes the EDGE_MODE soak verdict binding

  node scripts/edge-arming-gate.mjs authorize --evidence=<path> --origin=<raw-origin-url> \\
       --actor=<who> --reason=<why> [--deployment=<id>] [--out=<path>] [--json]
  node scripts/edge-arming-gate.mjs enforce  --origin=<raw-origin-url> [--record=<path>] [--json]
  node scripts/edge-arming-gate.mjs validate [--record=<path>] [--json]

There is no --force, no --skip and no threshold flag. The emergency path is
EDGE_MODE=log, which this gate does not gate.

Exit: 0 PASS/AUTHORIZED, 1 FAIL/REFUSED, 2 usage error.`;

export function parseArgs(argv) {
  const rest = argv.slice(2);
  const mode = rest.find(a => !a.startsWith("--")) ?? null;
  const args = {
    mode,
    evidence: null,
    origin: null,
    record: null,
    out: null,
    actor: null,
    reason: null,
    deployment: null,
    probePath: DEFAULT_PROBE_PATH,
    json: false,
    help: false,
  };
  const take = (arg, name) =>
    arg.startsWith(`--${name}=`) ? arg.slice(name.length + 3) : null;
  for (const arg of rest) {
    if (arg === "--json") args.json = true;
    else if (arg === "--help" || arg === "-h") args.help = true;
    else {
      for (const name of [
        "evidence",
        "origin",
        "record",
        "out",
        "actor",
        "reason",
        "deployment",
      ]) {
        const v = take(arg, name);
        if (v !== null) args[name] = v;
      }
      const probe = take(arg, "probe-path");
      if (probe !== null) args.probePath = probe;
    }
  }
  return args;
}

/**
 * `deps` is a TEST seam for the filesystem, the clock and the network ONLY. It
 * carries no threshold and no verdict — every decision still comes from
 * evaluateAuthorization / evaluateEnforcement over data alone.
 */
export async function main(argv = process.argv, out = console, deps = {}) {
  const readFile = deps.readFile ?? readFileSync;
  const writeFile = deps.writeFile ?? null;
  const now = deps.now ?? Date.now;
  const probe = deps.probe ?? probeProduction;
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;

  const args = parseArgs(argv);
  if (args.help || args.mode === null) {
    out.log(USAGE);
    return 2;
  }
  if (!["authorize", "enforce", "validate"].includes(args.mode)) {
    out.error(
      `edge-arming-gate: unknown mode "${sanitizeForOutput(args.mode, 40)}"\n`
    );
    out.error(USAGE);
    return 2;
  }

  const cfg = computeConfigFingerprint(readFile);
  const nowMs = now();

  if (args.mode === "authorize") {
    if (!args.evidence || !args.origin) {
      out.error(
        "edge-arming-gate authorize: --evidence and --origin are required.\n"
      );
      out.error(USAGE);
      return 2;
    }
    const { evidence, problem } = loadEvidence(args.evidence, readFile);
    const observation = await probe({
      origin: args.origin,
      probePath: args.probePath,
      fetchImpl,
    });
    const { posture, servingCommit, notes } = classifyPosture(observation);
    const result = evaluateAuthorization({
      evidence,
      evidenceProblem: problem,
      nowMs,
      actor: args.actor,
      reason: args.reason,
      posture,
      servingCommit,
      configFingerprint: cfg.fingerprint,
      configFiles: cfg.files,
      configProblems: cfg.problems,
      originHost: args.origin,
      deploymentId: args.deployment,
    });

    const report = {
      mode: "authorize",
      verdict: result.verdict,
      posture,
      postureNotes: notes,
      reason: null,
      conditions: result.conditions,
      failedConditions: result.failedConditions,
      record: result.record,
      recordPath: args.out ?? null,
    };
    if (result.record && args.out && writeFile) {
      writeFile(
        args.out,
        `${JSON.stringify(result.record, null, 2)}\n`,
        "utf8"
      );
    }
    out.log(args.json ? JSON.stringify(report, null, 2) : renderReport(report));
    return result.verdict === "AUTHORIZED" ? 0 : 1;
  }

  const recordPath = args.record ?? DEFAULT_RECORD_PATH;
  let record = null;
  let recordProblem = null;
  try {
    const parsed = JSON.parse(readFile(recordPath, "utf8"));
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      Array.isArray(parsed)
    ) {
      recordProblem = `${recordPath} is not a JSON object`;
    } else {
      record = parsed;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    recordProblem = `could not read ${recordPath}: ${msg}`;
  }

  if (args.mode === "validate") {
    const result = validateRecord({
      record,
      recordProblem,
      nowMs,
      liveConfigFingerprint: cfg.fingerprint,
      configProblems: cfg.problems,
      originHost: args.origin,
    });
    const report = {
      mode: "validate",
      verdict: result.verdict,
      posture: null,
      postureNotes: [],
      reason: `offline validation of ${sanitizeForOutput(recordPath, 120)} — no production probe was performed`,
      conditions: result.conditions,
      failedConditions: result.failedConditions,
      recordPath,
    };
    out.log(args.json ? JSON.stringify(report, null, 2) : renderReport(report));
    return result.verdict === "PASS" ? 0 : 1;
  }

  // enforce
  if (!args.origin) {
    out.error("edge-arming-gate enforce: --origin is required.\n");
    out.error(USAGE);
    return 2;
  }
  const observation = await probe({
    origin: args.origin,
    probePath: args.probePath,
    fetchImpl,
  });
  const { posture, notes } = classifyPosture(observation);
  const result = evaluateEnforcement({
    posture,
    postureNotes: notes,
    record,
    recordProblem,
    nowMs,
    liveConfigFingerprint: cfg.fingerprint,
    configProblems: cfg.problems,
    originHost: args.origin,
  });
  const report = {
    mode: "enforce",
    verdict: result.verdict,
    posture: result.posture,
    postureNotes: result.postureNotes,
    reason: result.reason,
    requiresAuthorization: result.requiresAuthorization,
    conditions: result.conditions,
    failedConditions: result.failedConditions,
    recordPath,
    observedAtIso: iso(nowMs),
  };
  out.log(args.json ? JSON.stringify(report, null, 2) : renderReport(report));
  return result.verdict === "PASS" ? 0 : 1;
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  pathToFileURL(process.argv[1]).href === import.meta.url;
if (invokedDirectly) {
  const { writeFileSync } = await import("node:fs");
  main(process.argv, console, { writeFile: writeFileSync }).then(code => {
    process.exitCode = code;
  });
}
