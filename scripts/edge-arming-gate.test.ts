/**
 * edge-arming-gate.test.ts — tests for the mechanism that makes the soak
 * verdict BINDING.
 *
 * These drive the REAL decision functions from scripts/edge-arming-gate.mjs
 * (`evaluateAuthorization`, `validateRecord`, `evaluateEnforcement`) and the
 * REAL CLI `main()`. Nothing about a verdict is stubbed: there is no mock that
 * returns a canned PASS, and no seam through which a test can move a threshold.
 * The only injected things are data, a clock, a filesystem double and a probe
 * double.
 *
 * The two load-bearing cases:
 *   - `the 2026-08-06 regression`: the exact evidence accepted as arming proof
 *     must REFUSE an authorization, end to end through the CLI.
 *   - `the anti-deadlock invariant`: a disarmed production must PASS the
 *     standing check no matter how broken, absent, stale or forged the
 *     authorization record is. Dropping to EDGE_MODE=log can never be blocked.
 *
 * NOTE ON TYPES: tsconfig excludes **\/*.test.ts, so `npx tsc --noEmit` never
 * reads this file. Every fixture field below is therefore set EXPLICITLY — an
 * omitted field would read as `undefined` at runtime and silently disable the
 * branch under test rather than failing a typecheck.
 */

import { describe, expect, it } from "vitest";

// @ts-expect-error — plain .mjs module without type declarations
import {
  AUTHORIZATION_TTL_MS,
  CLOCK_SKEW_TOLERANCE_MS,
  DEFAULT_RECORD_PATH,
  EDGE_CONFIG_FILES,
  MAX_EVIDENCE_AGE_MS,
  POSTURE,
  RECORD_KIND,
  RECORD_VERSION,
  canonicalJson,
  classifyPosture,
  computeConfigFingerprint,
  evaluateAuthorization,
  evaluateEnforcement,
  main,
  parseArgs,
  probeProduction,
  recordIntegrityHash,
  renderReport,
  sha256Hex,
  validateRecord,
} from "./edge-arming-gate.mjs";

// ─── Fixtures ────────────────────────────────────────────────────────────────

const MIN = 60_000;
/** 2026-08-06T00:00:00Z — the incident date, used as the fixture epoch. */
const START = Date.UTC(2026, 7, 6, 0, 0, 0);

const FINGERPRINT = "a".repeat(64);
const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const ORIGIN = "https://ai-sports-betting-dime-ai-production.up.railway.app";

interface SoakRow {
  ip: string | null;
  occurredAt: number;
  edgeVerdict?: string;
  eventType?: string;
  context?: string;
}

interface Evidence {
  edgeMode: string | null;
  windowStartMs: number;
  windowEndMs: number;
  label: string;
  requests: SoakRow[];
  errors: string[] | string;
}

/** `count` real requests over `spanMinutes`, spread across `sources` client IPs. */
function realTraffic(
  count: number,
  sources: number,
  spanMinutes: number,
  startMs = START
): SoakRow[] {
  const rows: SoakRow[] = [];
  const step = count > 1 ? (spanMinutes * MIN) / (count - 1) : 0;
  for (let i = 0; i < count; i++) {
    rows.push({
      ip: `203.0.113.${(i % sources) + 1}`,
      occurredAt: Math.round(startMs + i * step),
      edgeVerdict: "allow",
    });
  }
  return rows;
}

function row(ip: string, offsetMinutes: number, edgeVerdict: string): SoakRow {
  return {
    ip,
    occurredAt: START + Math.round(offsetMinutes * MIN),
    edgeVerdict,
  };
}

/** A soak that clears all eight soak conditions: 75 min, 520 real, 40 sources. */
function qualifyingEvidence(): Evidence {
  return {
    edgeMode: "log",
    windowStartMs: START,
    windowEndMs: START + 75 * MIN,
    label: "qualifying soak",
    requests: [
      ...realTraffic(520, 40, 75),
      // CI + operator noise a real soak always carries — legitimately excluded.
      row("40.81.6.244", 5, "would_deny"),
      row("172.182.201.162", 12, "would_deny"),
      row("47.152.160.175", 22, "would_deny"),
    ],
    errors: [],
  };
}

/** Default "now": 30 minutes after the qualifying soak closed. */
const FRESH_NOW = START + 75 * MIN + 30 * MIN;

function authorizeWith(overrides: Record<string, unknown> = {}) {
  return evaluateAuthorization({
    evidence: qualifyingEvidence(),
    evidenceProblem: null,
    nowMs: FRESH_NOW,
    actor: "owner@aisportsbettingmodels.com",
    reason: "arm the origin lock after the Cloudflare Transform Rule soak",
    posture: POSTURE.NOT_ARMED,
    servingCommit: COMMIT,
    configFingerprint: FINGERPRINT,
    configFiles: EDGE_CONFIG_FILES.map((p: string) => ({
      path: p,
      sha256: "b".repeat(64),
    })),
    configProblems: [],
    originHost: ORIGIN,
    deploymentId: "bf5cc270-443f-4906-b07e-a9d14999e639",
    soakEnv: {},
    ...overrides,
  });
}

/** A record produced by the real issuer, so tests never hand-build one. */
function issuedRecord(overrides: Record<string, unknown> = {}) {
  const result = authorizeWith(overrides);
  expect(result.verdict).toBe("AUTHORIZED");
  return result.record;
}

function enforceWith(overrides: Record<string, unknown> = {}) {
  return evaluateEnforcement({
    posture: POSTURE.ARMED,
    postureNotes: ["fixture"],
    record: issuedRecord(),
    recordProblem: null,
    nowMs: FRESH_NOW + 60 * MIN,
    liveConfigFingerprint: FINGERPRINT,
    configProblems: [],
    originHost: ORIGIN,
    soakEnv: {},
    ...overrides,
  });
}

// ─── The happy path: valid evidence CAN pass ─────────────────────────────────

describe("edgeArmingGate — valid evidence CAN authorize", () => {
  it("issues an AUTHORIZED record on a qualifying soak with fresh evidence and an un-armed origin", () => {
    const result = authorizeWith();
    expect(result.failedConditions).toEqual([]);
    expect(result.verdict).toBe("AUTHORIZED");
    expect(result.record).not.toBeNull();
    expect(result.record.kind).toBe(RECORD_KIND);
    expect(result.record.version).toBe(RECORD_VERSION);
    expect(result.soakReport.verdict).toBe("PASS");
  });

  it("the record is machine-readable, self-describing and carries an audit trail", () => {
    const record = issuedRecord();
    expect(JSON.parse(JSON.stringify(record))).toEqual(record);
    expect(record.binding.configFingerprint).toBe(FINGERPRINT);
    expect(record.binding.originHost).toBe(ORIGIN);
    expect(record.binding.servingCommit).toBe(COMMIT);
    expect(record.binding.deploymentId).toBe(
      "bf5cc270-443f-4906-b07e-a9d14999e639"
    );
    expect(record.binding.edgeModeDuringSoak).toBe("log");
    expect(record.audit.actor).toContain("owner@");
    expect(record.audit.reason.length).toBeGreaterThan(0);
    expect(record.issuedAtMs).toBe(FRESH_NOW);
    expect(record.expiresAtMs).toBe(FRESH_NOW + AUTHORIZATION_TTL_MS);
    expect(record.soakSummary.realRequests).toBe(520);
    expect(record.soakSummary.wouldDenyFromRealSources).toBe(0);
  });

  it("a freshly issued record satisfies the standing enforcement check", () => {
    const result = enforceWith();
    expect(result.failedConditions).toEqual([]);
    expect(result.verdict).toBe("PASS");
  });
});

// ─── THE ANTI-DEADLOCK INVARIANT ─────────────────────────────────────────────

describe("edgeArmingGate — the anti-deadlock invariant: de-arming is never gated", () => {
  const brokenRecords: Array<[string, Record<string, unknown>]> = [
    ["no record at all", { record: null, recordProblem: "ENOENT" }],
    ["a record that is not an object", { record: "nope", recordProblem: null }],
    ["an expired record", { nowMs: FRESH_NOW + AUTHORIZATION_TTL_MS + 1 }],
    [
      "a record whose evidence would FAIL the soak gate",
      { record: forgedRecordWithFailingEvidence() },
    ],
    [
      "a config fingerprint that no longer matches",
      { liveConfigFingerprint: "c".repeat(64) },
    ],
  ];

  for (const [label, override] of brokenRecords) {
    it(`PASSes with ${label}, because production is NOT armed`, () => {
      const result = enforceWith({ posture: POSTURE.NOT_ARMED, ...override });
      expect(result.verdict).toBe("PASS");
      expect(result.requiresAuthorization).toBe(false);
      expect(result.conditions).toEqual([]);
      expect(result.reason).toContain("de-arming is never gated");
    });
  }

  it("the same broken record FAILS the moment production is armed — so the PASS above is the posture, not a vacuous check", () => {
    const armed = enforceWith({
      posture: POSTURE.ARMED,
      record: null,
      recordProblem: "ENOENT",
    });
    expect(armed.verdict).toBe("FAIL");
    expect(armed.requiresAuthorization).toBe(true);
    expect(armed.failedConditions).toContain("record_present");
  });

  it("the FAIL message names EDGE_MODE=log as the always-available remedy", () => {
    const armed = enforceWith({ record: null, recordProblem: "ENOENT" });
    expect(armed.reason).toContain("EDGE_MODE=log");
    expect(armed.reason).toContain("needs no authorization");
  });
});

// ─── Fail-closed: posture ────────────────────────────────────────────────────

describe("edgeArmingGate — fail-closed on an unreadable posture", () => {
  it("an INDETERMINATE posture FAILS enforcement; it is never read as disarmed", () => {
    const result = enforceWith({ posture: POSTURE.INDETERMINATE });
    expect(result.verdict).toBe("FAIL");
    expect(result.failedConditions).toEqual(["posture_observed"]);
    expect(result.reason).toContain("never treated as disarmed");
  });

  it("a missing posture (undefined) also FAILS rather than defaulting", () => {
    const result = enforceWith({ posture: undefined });
    expect(result.verdict).toBe("FAIL");
  });

  it("a probe network error classifies as INDETERMINATE, not NOT_ARMED", () => {
    const p = classifyPosture({ error: "ECONNREFUSED 10.0.0.1:443" });
    expect(p.posture).toBe(POSTURE.INDETERMINATE);
    expect(p.notes.join(" ")).toContain("ECONNREFUSED");
  });

  it("a non-200 /health is INDETERMINATE — a dead origin is not a disarmed one", () => {
    expect(
      classifyPosture({
        healthStatus: 503,
        healthCommit: COMMIT,
        probeStatus: 200,
        probeBodyBytes: 12,
      }).posture
    ).toBe(POSTURE.INDETERMINATE);
  });

  it("a /health that does not name its commit is INDETERMINATE — the probe cannot bind to a deployment", () => {
    expect(
      classifyPosture({
        healthStatus: 200,
        healthCommit: null,
        probeStatus: 403,
        probeBodyBytes: 0,
      }).posture
    ).toBe(POSTURE.INDETERMINATE);
  });

  it("a 403 WITH a body is INDETERMINATE — originLock answers `res.status(403).end()`, i.e. empty", () => {
    const p = classifyPosture({
      healthStatus: 200,
      healthCommit: COMMIT,
      probeStatus: 403,
      probeBodyBytes: 4096,
    });
    expect(p.posture).toBe(POSTURE.INDETERMINATE);
    expect(p.notes.join(" ")).toContain("came from something else");
  });

  it("ARMED requires the positive discriminator: /health 200 + named commit + empty-bodied 403", () => {
    const p = classifyPosture({
      healthStatus: 200,
      healthCommit: COMMIT,
      probeStatus: 403,
      probeBodyBytes: 0,
    });
    expect(p.posture).toBe(POSTURE.ARMED);
    expect(p.servingCommit).toBe(COMMIT);
  });

  it("NOT_ARMED is also a positive observation: the origin served the locked path itself", () => {
    const p = classifyPosture({
      healthStatus: 200,
      healthCommit: COMMIT,
      probeStatus: 200,
      probeBodyBytes: 5120,
    });
    expect(p.posture).toBe(POSTURE.NOT_ARMED);
  });

  it("probeProduction never throws — a rejecting fetch becomes an error observation", async () => {
    const observation = await probeProduction({
      origin: ORIGIN,
      fetchImpl: () => Promise.reject(new Error("getaddrinfo ENOTFOUND")),
    });
    expect(observation.error).toContain("ENOTFOUND");
    expect(classifyPosture(observation).posture).toBe(POSTURE.INDETERMINATE);
  });

  it("authorization REFUSES when posture is INDETERMINATE (a probe failure cannot buy a record)", () => {
    const result = authorizeWith({ posture: POSTURE.INDETERMINATE });
    expect(result.verdict).toBe("REFUSED");
    expect(result.record).toBeNull();
    expect(result.failedConditions).toContain("posture_observed");
  });

  it("authorization REFUSES when production is ALREADY armed — there is no transition to authorize", () => {
    const result = authorizeWith({ posture: POSTURE.ARMED });
    expect(result.verdict).toBe("REFUSED");
    expect(result.failedConditions).toContain("posture_not_already_armed");
  });
});

// ─── The soak conditions are inherited, not re-implemented ───────────────────

describe("edgeArmingGate — the soak conditions gate authorization", () => {
  it("insufficient WINDOW cannot authorize (4 minutes against the 60-minute floor)", () => {
    const evidence = qualifyingEvidence();
    evidence.requests = realTraffic(520, 40, 4);
    evidence.windowEndMs = START + 4 * MIN;
    const result = authorizeWith({
      evidence,
      nowMs: START + 4 * MIN + 10 * MIN,
    });
    expect(result.verdict).toBe("REFUSED");
    expect(result.failedConditions).toContain("soak_gate_pass");
    expect(result.soakReport.failedConditions).toContain("soak_window_minutes");
  });

  it("insufficient VOLUME cannot authorize (499 real requests)", () => {
    const evidence = qualifyingEvidence();
    evidence.requests = realTraffic(499, 40, 75);
    const result = authorizeWith({ evidence });
    expect(result.verdict).toBe("REFUSED");
    expect(result.soakReport.failedConditions).toContain("real_requests");
  });

  it("ONE source cannot satisfy the volume requirement — 900 requests from a single IP is REFUSED", () => {
    const evidence = qualifyingEvidence();
    evidence.requests = realTraffic(900, 1, 75);
    const result = authorizeWith({ evidence });
    expect(result.verdict).toBe("REFUSED");
    expect(result.soakReport.totals.realRequests).toBe(900);
    expect(result.soakReport.failedConditions).toContain(
      "distinct_real_sources"
    );
    expect(result.soakReport.failedConditions).toContain(
      "real_source_concentration"
    );
  });

  it("the CONCENTRATION cap cannot be bypassed by padding the source count", () => {
    // 30 distinct sources clears the distinct floor, but one box contributes
    // 400 of the 520 requests — in substance still one machine's traffic.
    const evidence = qualifyingEvidence();
    const padded: SoakRow[] = [];
    for (let i = 0; i < 400; i++) {
      padded.push({
        ip: "198.51.100.7",
        occurredAt: START + Math.round((i * 75 * MIN) / 519),
        edgeVerdict: "allow",
      });
    }
    for (let i = 0; i < 120; i++) {
      padded.push({
        ip: `203.0.113.${(i % 30) + 1}`,
        occurredAt: START + Math.round(((400 + i) * 75 * MIN) / 519),
        edgeVerdict: "allow",
      });
    }
    evidence.requests = padded;
    const result = authorizeWith({ evidence });
    expect(result.verdict).toBe("REFUSED");
    expect(result.soakReport.totals.distinctRealSources).toBe(31);
    expect(result.soakReport.failedConditions).toEqual([
      "real_source_concentration",
    ]);
  });

  it("a LEGITIMATE would-deny cannot authorize — one real-user refusal REFUSES the whole soak", () => {
    const evidence = qualifyingEvidence();
    evidence.requests.push(row("198.51.100.77", 30, "would_deny"));
    const result = authorizeWith({ evidence });
    expect(result.verdict).toBe("REFUSED");
    expect(result.soakReport.failedConditions).toEqual([
      "would_deny_from_real_sources_zero",
    ]);
    expect(result.soakReport.offendingSources[0].ip).toBe("198.51.100.77");
  });

  it("a QUERY FAILURE reported in the bundle cannot authorize", () => {
    const evidence = qualifyingEvidence();
    evidence.errors = ["security_events query failed: ECONNREFUSED"];
    const result = authorizeWith({ evidence });
    expect(result.verdict).toBe("REFUSED");
    expect(result.soakReport.failedConditions).toEqual(["no_data_errors"]);
  });

  it("a MALFORMED `errors` field cannot become [] — a collector failure in the wrong shape still REFUSES", () => {
    const evidence = qualifyingEvidence();
    evidence.errors = "security_events query failed: ER_ACCESS_DENIED_ERROR";
    const result = authorizeWith({ evidence });
    expect(result.verdict).toBe("REFUSED");
    expect(result.soakReport.verdict).toBe("FAIL");
    expect(result.soakReport.failedConditions).toContain("no_data_errors");
  });

  it("unreadable evidence REFUSES rather than authorizing an empty soak", () => {
    const result = authorizeWith({
      evidence: null,
      evidenceProblem: "could not read soak.json: ENOENT",
    });
    expect(result.verdict).toBe("REFUSED");
    expect(result.failedConditions).toContain("evidence_readable");
    expect(result.failedConditions).toContain("soak_gate_pass");
    expect(result.record).toBeNull();
  });
});

// ─── Staleness ───────────────────────────────────────────────────────────────

describe("edgeArmingGate — STALE evidence cannot authorize", () => {
  it(`refuses evidence older than the ${Math.round(MAX_EVIDENCE_AGE_MS / 3600000)}h limit, even though the soak itself PASSES`, () => {
    const soakEnd = START + 75 * MIN;
    const result = authorizeWith({
      nowMs: soakEnd + MAX_EVIDENCE_AGE_MS + MIN,
    });
    expect(result.verdict).toBe("REFUSED");
    expect(result.failedConditions).toEqual(["evidence_fresh"]);
    // The soak itself is untouched — staleness is an independent condition.
    expect(result.soakReport.verdict).toBe("PASS");
  });

  it("accepts evidence exactly at the freshness limit and refuses one millisecond past it", () => {
    const soakEnd = START + 75 * MIN;
    expect(
      authorizeWith({ nowMs: soakEnd + MAX_EVIDENCE_AGE_MS }).verdict
    ).toBe("AUTHORIZED");
    expect(
      authorizeWith({ nowMs: soakEnd + MAX_EVIDENCE_AGE_MS + 1 }).verdict
    ).toBe("REFUSED");
  });

  it("refuses FUTURE-dated evidence beyond the clock-skew tolerance", () => {
    const soakEnd = START + 75 * MIN;
    const result = authorizeWith({
      nowMs: soakEnd - CLOCK_SKEW_TOLERANCE_MS - MIN,
    });
    expect(result.verdict).toBe("REFUSED");
    expect(result.failedConditions).toContain("evidence_not_future_dated");
  });

  it("refuses evidence that states no window end", () => {
    const evidence = qualifyingEvidence();
    // @ts-expect-error — deliberately removing a required field
    delete evidence.windowEndMs;
    const result = authorizeWith({ evidence });
    expect(result.verdict).toBe("REFUSED");
    expect(result.failedConditions).toContain("evidence_states_window_end");
  });

  it("an EXPIRED authorization fails the standing check while production is armed", () => {
    const result = enforceWith({
      nowMs: FRESH_NOW + AUTHORIZATION_TTL_MS + 1,
    });
    expect(result.verdict).toBe("FAIL");
    expect(result.failedConditions).toEqual(["authorization_not_expired"]);
  });

  it("the same authorization still passes one millisecond before it expires", () => {
    expect(
      enforceWith({ nowMs: FRESH_NOW + AUTHORIZATION_TTL_MS }).verdict
    ).toBe("PASS");
  });
});

// ─── Record forgery resistance ───────────────────────────────────────────────

/**
 * A record whose STORED verdict says AUTHORIZED but whose embedded evidence is
 * the 2026-08-06 shape. Built by taking a real record and swapping the evidence,
 * then re-sealing the integrity hash — i.e. the strongest forgery a hand editor
 * can produce, since the hash is a checksum and not a signature (the module says
 * so). `enforce` must still refuse it, because it re-derives the soak verdict.
 */
function forgedRecordWithFailingEvidence() {
  const record = issuedRecord();
  const evidence = qualifyingEvidence();
  evidence.requests = realTraffic(18, 18, 4);
  evidence.windowEndMs = START + 4 * MIN;
  const swapped = {
    ...record,
    evidence,
    evidenceSha256: sha256Hex(canonicalJson(evidence)),
  };
  delete swapped.recordSha256;
  return { ...swapped, recordSha256: recordIntegrityHash(swapped) };
}

describe("edgeArmingGate — the stored verdict is never trusted", () => {
  it("a re-sealed record carrying FAILING evidence is refused: the soak gate is re-run, not read", () => {
    const result = enforceWith({ record: forgedRecordWithFailingEvidence() });
    expect(result.verdict).toBe("FAIL");
    expect(result.failedConditions).toContain("soak_gate_repasses");
    // The forgery is internally consistent — integrity and hash both pass.
    expect(result.failedConditions).not.toContain("record_integrity");
    expect(result.failedConditions).not.toContain("evidence_hash_matches");
  });

  it("a record with the evidence stripped out is refused rather than trusted on its summary", () => {
    const record = issuedRecord();
    delete record.evidence;
    const result = enforceWith({ record });
    expect(result.verdict).toBe("FAIL");
    expect(result.failedConditions).toContain("evidence_embedded");
    expect(result.failedConditions).toContain("soak_gate_repasses");
  });

  it("a hand-edited record whose integrity hash was NOT recomputed is refused", () => {
    const record = issuedRecord();
    record.audit.reason = "trust me";
    const result = enforceWith({ record });
    expect(result.verdict).toBe("FAIL");
    expect(result.failedConditions).toContain("record_integrity");
  });

  it("swapping the evidence without updating evidenceSha256 is refused", () => {
    const record = issuedRecord();
    const evidence = qualifyingEvidence();
    evidence.label = "different soak";
    const tampered = { ...record, evidence };
    delete tampered.recordSha256;
    const resealed = {
      ...tampered,
      recordSha256: recordIntegrityHash(tampered),
    };
    const result = enforceWith({ record: resealed });
    expect(result.verdict).toBe("FAIL");
    expect(result.failedConditions).toContain("evidence_hash_matches");
  });

  it("a record declaring the wrong kind or version is refused", () => {
    const record = issuedRecord();
    const wrong = { ...record, kind: "something-else" };
    delete wrong.recordSha256;
    const sealed = { ...wrong, recordSha256: recordIntegrityHash(wrong) };
    expect(enforceWith({ record: sealed }).failedConditions).toContain(
      "record_shape"
    );
  });
});

// ─── Binding ─────────────────────────────────────────────────────────────────

describe("edgeArmingGate — the authorization is bound to a configuration state", () => {
  it("a change to the edge-enforcement files invalidates the authorization", () => {
    const result = enforceWith({ liveConfigFingerprint: "d".repeat(64) });
    expect(result.verdict).toBe("FAIL");
    expect(result.failedConditions).toEqual([
      "config_fingerprint_matches_tree",
    ]);
  });

  it("an UNREADABLE edge-enforcement file fails closed rather than skipping the binding", () => {
    const result = enforceWith({
      liveConfigFingerprint: null,
      configProblems: ["server/_core/originLock.ts: ENOENT"],
    });
    expect(result.verdict).toBe("FAIL");
    expect(result.failedConditions).toContain(
      "config_fingerprint_matches_tree"
    );
  });

  it("a record issued for a different origin does not authorize this one", () => {
    const result = enforceWith({
      originHost: "https://some-other-host.example",
    });
    expect(result.verdict).toBe("FAIL");
    expect(result.failedConditions).toEqual(["origin_host_matches"]);
  });

  it("origin comparison ignores scheme, trailing slash and case", () => {
    const result = enforceWith({
      originHost:
        "AI-Sports-Betting-Dime-AI-Production.up.railway.app/".toUpperCase(),
    });
    expect(result.verdict).toBe("PASS");
  });

  it("authorization is REFUSED when the edge configuration cannot be fingerprinted", () => {
    const result = authorizeWith({
      configFingerprint: null,
      configProblems: ["server/_core/edgeProxy.ts: EACCES"],
    });
    expect(result.verdict).toBe("REFUSED");
    expect(result.failedConditions).toContain("config_fingerprint_computed");
  });

  it("authorization is REFUSED when the live deployment does not identify itself", () => {
    const result = authorizeWith({ servingCommit: null });
    expect(result.verdict).toBe("REFUSED");
    expect(result.failedConditions).toContain("deployment_identified");
  });

  it("authorization is REFUSED without attribution — a record with no actor is not an audit trail", () => {
    expect(authorizeWith({ actor: "   " }).failedConditions).toContain(
      "attribution_present"
    );
    expect(authorizeWith({ reason: "" }).failedConditions).toContain(
      "attribution_present"
    );
  });

  it("computeConfigFingerprint hashes the real edge files and changes when one of them changes", () => {
    const files: Record<string, string> = {};
    for (const p of EDGE_CONFIG_FILES) files[p] = `content of ${p}`;
    const readA = (p: string) => {
      if (!(p in files)) throw new Error(`ENOENT: ${p}`);
      return files[p];
    };
    const a = computeConfigFingerprint(readA);
    expect(a.problems).toEqual([]);
    expect(a.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    files[EDGE_CONFIG_FILES[1]] = "MUTATED";
    const b = computeConfigFingerprint(readA);
    expect(b.fingerprint).not.toBe(a.fingerprint);
  });

  it("computeConfigFingerprint returns null (never a partial hash) when a file cannot be read", () => {
    const result = computeConfigFingerprint((p: string) => {
      if (p === EDGE_CONFIG_FILES[0]) throw new Error("EACCES");
      return "x";
    });
    expect(result.fingerprint).toBeNull();
    expect(result.problems.join(" ")).toContain("EACCES");
  });

  it("the real checkout fingerprints cleanly — the bound files exist at the paths the gate names", () => {
    const result = computeConfigFingerprint();
    expect(result.problems).toEqual([]);
    expect(result.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(result.files.map((f: { path: string }) => f.path)).toEqual([
      ...EDGE_CONFIG_FILES,
    ]);
  });
});

// ─── THE 2026-08-06 REGRESSION CASE ──────────────────────────────────────────

describe("edgeArmingGate — the 2026-08-06 regression case", () => {
  /**
   * The as-built record cited "18 requests through Cloudflare + 5 direct" as
   * proof that arming was safe. Arming followed; real users were 403'd for ~7
   * hours. This reproduces that evidence exactly.
   */
  function evidenceOf20260806(): Evidence {
    const requests: SoakRow[] = [];
    for (let i = 0; i < 18; i++) {
      requests.push({
        ip: `203.0.113.${i + 1}`,
        occurredAt: START + Math.round(i * 0.2 * MIN),
        edgeVerdict: "allow",
      });
    }
    for (let i = 0; i < 5; i++) {
      requests.push({
        ip: "47.152.160.175",
        occurredAt: START + Math.round((3.5 + i * 0.1) * MIN),
        edgeVerdict: "would_deny",
      });
    }
    return {
      edgeMode: "log",
      windowStartMs: START,
      windowEndMs: START + 4 * MIN,
      label: "2026-08-06 as-built arming evidence",
      requests,
      errors: [],
    };
  }

  it("REFUSES an authorization on the exact evidence that was accepted as proof", () => {
    const result = authorizeWith({
      evidence: evidenceOf20260806(),
      nowMs: START + 4 * MIN + 5 * MIN,
    });
    expect(result.verdict).toBe("REFUSED");
    expect(result.record).toBeNull();
    expect(result.soakReport.totals.requests).toBe(23);
    expect(result.soakReport.failedConditions).toEqual(
      expect.arrayContaining([
        "soak_window_minutes",
        "real_requests",
        "distinct_real_sources",
      ])
    );
  });

  it("is NOT rescued by the operator exclusion — every would-deny was excluded and it is still REFUSED", () => {
    const result = authorizeWith({
      evidence: evidenceOf20260806(),
      nowMs: START + 4 * MIN + 5 * MIN,
    });
    expect(result.soakReport.totals.wouldDenyFromRealSources).toBe(0);
    expect(result.soakReport.failedConditions).not.toContain(
      "would_deny_from_real_sources_zero"
    );
    expect(result.verdict).toBe("REFUSED");
  });

  it("and the arming that followed would now be a RED standing check, not an undetected state", () => {
    // Production armed, no record was ever issued (none could be).
    const result = enforceWith({ record: null, recordProblem: "ENOENT" });
    expect(result.verdict).toBe("FAIL");
    expect(result.posture).toBe(POSTURE.ARMED);
  });
});

// ─── No override ─────────────────────────────────────────────────────────────

describe("edgeArmingGate — offers no override seam", () => {
  it("neither decision function accepts a force/skip/override/threshold key", () => {
    const forbidden = [
      "force",
      "skip",
      "override",
      "allowStale",
      "minSoakMinutes",
      "minRealRequests",
      "bypass",
    ];
    for (const key of forbidden) {
      const refused = authorizeWith({
        evidence: (() => {
          const e = qualifyingEvidence();
          e.requests = realTraffic(10, 2, 1);
          e.windowEndMs = START + MIN;
          return e;
        })(),
        nowMs: START + 2 * MIN,
        [key]: true,
      });
      expect(refused.verdict).toBe("REFUSED");

      const enforced = evaluateEnforcement({
        posture: POSTURE.ARMED,
        postureNotes: [],
        record: null,
        recordProblem: "ENOENT",
        nowMs: FRESH_NOW,
        liveConfigFingerprint: FINGERPRINT,
        configProblems: [],
        originHost: ORIGIN,
        [key]: true,
      });
      expect(enforced.verdict).toBe("FAIL");
    }
  });

  it("the CLI's usage text offers no force/skip flag in any invocation line", async () => {
    const out: string[] = [];
    const code = (await main(
      ["node", "edge-arming-gate.mjs", "--help"],
      { log: (s: string) => out.push(s), error: () => {} },
      {}
    )) as number;
    expect(code).toBe(2);
    const usage = out.join("\n");
    const invocationLines = usage
      .split("\n")
      .filter(line => line.includes("edge-arming-gate.mjs"));
    expect(invocationLines.length).toBeGreaterThan(0);
    for (const line of invocationLines) {
      expect(line).not.toMatch(/--force|--skip|--override|--min|--allow/);
    }
    expect(usage).toContain("There is no --force");
  });

  it("parseArgs silently discards an override-shaped flag — it never becomes an option", () => {
    const parsed = parseArgs([
      "node",
      "edge-arming-gate.mjs",
      "enforce",
      "--force",
      "--force=1",
      "--skip-soak=true",
      "--min-real-requests=1",
      `--origin=${ORIGIN}`,
    ]);
    expect(parsed.mode).toBe("enforce");
    expect(parsed.origin).toBe(ORIGIN);
    for (const key of Object.keys(parsed)) {
      expect(key).not.toMatch(/force|skip|override|min|allow/i);
    }
  });
});

// ─── CLI wiring ──────────────────────────────────────────────────────────────

describe("edgeArmingGate — CLI", () => {
  const EVIDENCE_PATH = "/evidence/soak.json";
  const RECORD_PATH = "/evidence/record.json";

  function fs(files: Record<string, string>) {
    return (path: string) => {
      if (!(path in files)) {
        throw new Error(`ENOENT: no such file or directory, open '${path}'`);
      }
      return files[path];
    };
  }

  /** Real edge files, so computeConfigFingerprint works inside the CLI tests. */
  function withEdgeFiles(extra: Record<string, string>) {
    const files: Record<string, string> = { ...extra };
    for (const p of EDGE_CONFIG_FILES) files[p] = `stub for ${p}`;
    return files;
  }

  function fakeProbe(observation: Record<string, unknown>) {
    return () => Promise.resolve(observation);
  }

  const UNARMED = {
    healthStatus: 200,
    healthCommit: COMMIT,
    probeStatus: 200,
    probeBodyBytes: 4096,
  };
  const ARMED = {
    healthStatus: 200,
    healthCommit: COMMIT,
    probeStatus: 403,
    probeBodyBytes: 0,
  };

  async function run(
    argv: string[],
    files: Record<string, string>,
    probeObs: Record<string, unknown>,
    nowMs: number,
    written: Record<string, string> = {}
  ) {
    const out: string[] = [];
    const err: string[] = [];
    const code = (await main(
      ["node", "edge-arming-gate.mjs", ...argv],
      { log: (s: string) => out.push(s), error: (s: string) => err.push(s) },
      {
        readFile: fs(withEdgeFiles(files)),
        writeFile: (p: string, c: string) => {
          written[p] = c;
        },
        now: () => nowMs,
        probe: fakeProbe(probeObs),
      }
    )) as number;
    return { code, out, err, written, text: out.join("\n") };
  }

  it("authorize exits 0 and writes a record on qualifying evidence", async () => {
    const written: Record<string, string> = {};
    const { code, text } = await run(
      [
        "authorize",
        `--evidence=${EVIDENCE_PATH}`,
        `--origin=${ORIGIN}`,
        "--actor=owner",
        "--reason=post-soak arming",
        `--out=${RECORD_PATH}`,
      ],
      { [EVIDENCE_PATH]: JSON.stringify(qualifyingEvidence()) },
      UNARMED,
      FRESH_NOW,
      written
    );
    expect(code).toBe(0);
    expect(text).toContain("VERDICT: AUTHORIZED");
    const record = JSON.parse(written[RECORD_PATH]);
    expect(record.kind).toBe(RECORD_KIND);
    expect(record.recordSha256).toBe(recordIntegrityHash(record));
  });

  it("authorize exits 1 and writes NOTHING on the 2026-08-06 evidence", async () => {
    const evidence = qualifyingEvidence();
    evidence.requests = realTraffic(18, 18, 4);
    evidence.windowEndMs = START + 4 * MIN;
    const written: Record<string, string> = {};
    const { code, text } = await run(
      [
        "authorize",
        `--evidence=${EVIDENCE_PATH}`,
        `--origin=${ORIGIN}`,
        "--actor=owner",
        "--reason=arm it",
        `--out=${RECORD_PATH}`,
      ],
      { [EVIDENCE_PATH]: JSON.stringify(evidence) },
      UNARMED,
      START + 10 * MIN,
      written
    );
    expect(code).toBe(1);
    expect(text).toContain("VERDICT: REFUSED");
    expect(text).toContain("DO NOT set EDGE_MODE=on");
    expect(Object.keys(written)).toEqual([]);
  });

  it("authorize exits 1 when the evidence file is missing (fail-closed, no record)", async () => {
    const written: Record<string, string> = {};
    const { code, text } = await run(
      [
        "authorize",
        "--evidence=/nope.json",
        `--origin=${ORIGIN}`,
        "--actor=owner",
        "--reason=x",
        `--out=${RECORD_PATH}`,
      ],
      {},
      UNARMED,
      FRESH_NOW,
      written
    );
    expect(code).toBe(1);
    expect(text).toContain("REFUSED");
    expect(Object.keys(written)).toEqual([]);
  });

  it("enforce exits 0 against a DISARMED origin with no record file present at all", async () => {
    const { code, text } = await run(
      ["enforce", `--origin=${ORIGIN}`, `--record=${RECORD_PATH}`],
      {},
      UNARMED,
      FRESH_NOW
    );
    expect(code).toBe(0);
    expect(text).toContain("VERDICT: PASS");
    expect(text).toContain("de-arming is never gated");
  });

  it("enforce exits 1 against an ARMED origin with no record file present", async () => {
    const { code, text } = await run(
      ["enforce", `--origin=${ORIGIN}`, `--record=${RECORD_PATH}`],
      {},
      ARMED,
      FRESH_NOW
    );
    expect(code).toBe(1);
    expect(text).toContain("VERDICT: FAIL");
    expect(text).toContain("record_present");
  });

  it("authorize -> enforce round-trips through the real CLI on both legs", async () => {
    const written: Record<string, string> = {};
    const authorize = await run(
      [
        "authorize",
        `--evidence=${EVIDENCE_PATH}`,
        `--origin=${ORIGIN}`,
        "--actor=owner",
        "--reason=post-soak arming",
        `--out=${RECORD_PATH}`,
      ],
      { [EVIDENCE_PATH]: JSON.stringify(qualifyingEvidence()) },
      UNARMED,
      FRESH_NOW,
      written
    );
    expect(authorize.code).toBe(0);

    // Now production is armed, and the record issued above is presented.
    const enforce = await run(
      ["enforce", `--origin=${ORIGIN}`, `--record=${RECORD_PATH}`, "--json"],
      { [RECORD_PATH]: written[RECORD_PATH] },
      ARMED,
      FRESH_NOW + 60 * MIN
    );
    expect(enforce.code).toBe(0);
    const report = JSON.parse(enforce.text);
    expect(report.verdict).toBe("PASS");
    expect(report.posture).toBe("ARMED");
    expect(report.requiresAuthorization).toBe(true);
    expect(report.failedConditions).toEqual([]);
  });

  it("the round-tripped record goes STALE: the same CLI run fails past the validity period", async () => {
    const written: Record<string, string> = {};
    await run(
      [
        "authorize",
        `--evidence=${EVIDENCE_PATH}`,
        `--origin=${ORIGIN}`,
        "--actor=owner",
        "--reason=post-soak arming",
        `--out=${RECORD_PATH}`,
      ],
      { [EVIDENCE_PATH]: JSON.stringify(qualifyingEvidence()) },
      UNARMED,
      FRESH_NOW,
      written
    );
    const enforce = await run(
      ["enforce", `--origin=${ORIGIN}`, `--record=${RECORD_PATH}`, "--json"],
      { [RECORD_PATH]: written[RECORD_PATH] },
      ARMED,
      FRESH_NOW + AUTHORIZATION_TTL_MS + 1
    );
    expect(enforce.code).toBe(1);
    expect(JSON.parse(enforce.text).failedConditions).toEqual([
      "authorization_not_expired",
    ]);
  });

  it("enforce fails closed when the probe cannot determine posture", async () => {
    const { code, text } = await run(
      ["enforce", `--origin=${ORIGIN}`, `--record=${RECORD_PATH}`],
      {},
      { error: "ETIMEDOUT" },
      FRESH_NOW
    );
    expect(code).toBe(1);
    expect(text).toContain("INDETERMINATE");
  });

  it("validate runs offline (no probe) and refuses a corrupt record file", async () => {
    const { code, text } = await run(
      ["validate", `--record=${RECORD_PATH}`],
      { [RECORD_PATH]: "{not json" },
      UNARMED,
      FRESH_NOW
    );
    expect(code).toBe(1);
    expect(text).toContain("no production probe was performed");
    expect(text).toContain("record_present");
  });

  it("validate defaults to the canonical committed record path", async () => {
    const { text } = await run(["validate", "--json"], {}, UNARMED, FRESH_NOW);
    expect(JSON.parse(text).recordPath).toBe(DEFAULT_RECORD_PATH);
  });

  it("exits 2 on an unknown mode and on a missing mode, without emitting a verdict", async () => {
    const bad = await run(["frobnicate"], {}, UNARMED, FRESH_NOW);
    expect(bad.code).toBe(2);
    expect(bad.text).not.toContain("VERDICT");
    const none = await run([], {}, UNARMED, FRESH_NOW);
    expect(none.code).toBe(2);
  });

  it("enforce requires --origin: posture is never assumed when it cannot be observed", async () => {
    const { code } = await run(
      ["enforce", `--record=${RECORD_PATH}`],
      {},
      UNARMED,
      FRESH_NOW
    );
    expect(code).toBe(2);
  });
});

// ─── Canonicalization ────────────────────────────────────────────────────────

describe("edgeArmingGate — canonical JSON", () => {
  it("is key-order independent, so a reserialized record still verifies", () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }));
  });

  it("is not value-blind: changing any value changes the digest", () => {
    expect(sha256Hex(canonicalJson({ a: 1 }))).not.toBe(
      sha256Hex(canonicalJson({ a: 2 }))
    );
  });

  it("preserves array order (a reordered request stream is a different bundle)", () => {
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
  });
});

// --- Report rendering safety -----------------------------------------------

describe("edgeArmingGate - the pasted report cannot carry a control sequence", () => {
  it("strips CR/ANSI out of posture notes while leaving ordinary prose readable", () => {
    const text = renderReport({
      mode: "enforce",
      verdict: "FAIL",
      posture: POSTURE.INDETERMINATE,
      postureNotes: [
        "probe error: fetch failed\r\n::error::forged, so the lock is fine \x1b[31m",
      ],
      reason: "fixture",
      conditions: [],
      failedConditions: [],
      recordPath: "x",
    }) as string;
    expect(text).not.toContain("\r");
    expect(text).not.toContain("\x1b");
    // ...and the legible parts survive: this is a sanitizer, not a redactor.
    expect(text).toContain("probe error: fetch failed");
    expect(text).toContain("VERDICT: FAIL");
  });

  it("classifyPosture sanitizes the remote-controlled scalars it quotes", () => {
    const p = classifyPosture({ error: "boom\x1b[31m\r\nVERDICT: PASS" });
    expect(p.posture).toBe(POSTURE.INDETERMINATE);
    expect(p.notes.join("")).not.toContain("\x1b");
    expect(p.notes.join("")).not.toContain("\r");
  });
});
