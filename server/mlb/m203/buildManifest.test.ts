/**
 * Tests for the dry-run → manifest bridge.
 */
import { describe, it, expect } from "vitest";
import {
  buildRepairManifest,
  isInDefectWindow,
  classifyWindowAdmission,
  assertValidDefectWindow,
  sourceEvidenceHash,
  type DefectWindow,
  type DryRunRow,
} from "./buildManifest";
import { verifyManifestSeal } from "./repairManifest";

const WINDOW: DefectWindow = {
  defectStartMs: Date.parse("2026-04-15T06:15:17Z"),
  fixDeployedAtMs: Date.parse("2026-08-07T19:28:23Z"),
};
const FIX_DEPLOYED_MS = WINDOW.fixDeployedAtMs;

function dryRow(over: Partial<DryRunRow> = {}): DryRunRow {
  return {
    gameId: 1,
    matchup: "CLE@CWS",
    gameDate: "2026-05-01",
    status: "would_write",
    matchMethod: "mlbGamePk",
    mlbGamePk: 700001,
    outcomeIngestedAt: Date.parse("2026-05-02T08:00:00Z"),
    previousBrier: {
      brierFgTotal: 0.16,
      brierF5Total: 0.00003,
      brierNrfi: 0.989559,
      brierFgMl: 0.2704,
      brierF5Ml: 0.2601,
    },
    brierFgTotal: 0.16,
    brierF5Total: 0.295066,
    brierNrfi: 0.227148,
    brierFgMl: 0.2704,
    brierF5Ml: 0.2601,
    actualFgTotal: 9,
    actualF5Total: 4,
    actualNrfiBinary: 1,
    inputs: {
      modelOverRate: "60.00",
      modelF5OverRate: "0.5432",
      modelPNrfi: "0.5234",
      modelHomeWinPct: "52.00",
      modelF5HomeWinPct: "51.00",
      bookTotal: "8.5",
      f5Total: "4.5",
    },
    outcomes: {
      actualFgTotal: 9,
      actualF5Total: 4,
      actualNrfiBinary: 1,
      outcomeFgOver: 1,
      outcomeF5Over: 0,
      outcomeNrfi: 1,
      outcomeHomeWin: 0,
      outcomeF5HomeWin: 0,
    },
    ...over,
  };
}

const OPTS = {
  repairRunId: "m203-2026-05-01",
  generatedAt: 1_700_000_000_000,
  codeSha: "abc1234",
  schemaVersion: "0134_widen_unit_probability_precision",
  window: WINDOW,
};

describe("buildRepairManifest", () => {
  it("seals a manifest that verifies", () => {
    const { sealed } = buildRepairManifest({ ...OPTS, rows: [dryRow()] });
    expect(verifyManifestSeal(sealed)).toBe(true);
    expect(sealed.rowCount).toBe(1);
  });

  it("is deterministic — identical dry-run input yields an identical checksum", () => {
    const a = buildRepairManifest({ ...OPTS, rows: [dryRow()] });
    const b = buildRepairManifest({ ...OPTS, rows: [dryRow()] });
    expect(a.sealed.manifestSha256).toBe(b.sealed.manifestSha256);
  });

  it("changes the checksum when a proposed value changes", () => {
    const a = buildRepairManifest({ ...OPTS, rows: [dryRow()] });
    const b = buildRepairManifest({
      ...OPTS,
      rows: [dryRow({ brierNrfi: 0.3 })],
    });
    expect(a.sealed.manifestSha256).not.toBe(b.sealed.manifestSha256);
  });

  it("classifies a genuine M-203 row as CORRECTION_REQUIRED with the two affected fields", () => {
    const { sealed, accounting } = buildRepairManifest({
      ...OPTS,
      rows: [dryRow()],
    });
    const row = sealed.manifest.rows[0];
    expect(row.classification).toBe("CORRECTION_REQUIRED");
    expect([...row.changeFields].sort()).toEqual(["brierF5Total", "brierNrfi"]);
    expect(accounting.writable).toBe(1);
  });

  it("balances the accounting identity across mixed rows", () => {
    const { accounting } = buildRepairManifest({
      ...OPTS,
      rows: [
        dryRow({ gameId: 1 }),
        dryRow({
          gameId: 2,
          status: "skipped_no_api_match",
          mlbGamePk: null,
          matchMethod: "none",
        }),
        dryRow({ gameId: 3, error: "HTTP 500" }),
      ],
    });
    expect(accounting.total).toBe(3);
    expect(accounting.balanced).toBe(true);
    expect(accounting.closureBlocking).toBeGreaterThanOrEqual(1);
  });

  it("records a provenance hash that moves with the source payload", () => {
    expect(sourceEvidenceHash(dryRow())).toBe(sourceEvidenceHash(dryRow()));
    expect(sourceEvidenceHash(dryRow())).not.toBe(
      sourceEvidenceHash(dryRow({ actualFgTotal: 10 }))
    );
  });
});

describe("defect window predicate", () => {
  it("selects on WHEN THE ROW WAS SCORED, not when the game was played", () => {
    // April game, scored before the fix → affected.
    expect(isInDefectWindow(Date.parse("2026-05-02T08:00:00Z"), WINDOW)).toBe(
      true
    );
    // April game, RE-ingested after the fix → already correct, not a candidate.
    expect(isInDefectWindow(Date.parse("2026-08-08T08:00:00Z"), WINDOW)).toBe(
      false
    );
  });

  it("treats a never-ingested row as outside the window", () => {
    expect(isInDefectWindow(null, WINDOW)).toBe(false);
    expect(isInDefectWindow(undefined, WINDOW)).toBe(false);
  });

  it("is exclusive at the fix boundary", () => {
    expect(isInDefectWindow(FIX_DEPLOYED_MS - 1, WINDOW)).toBe(true);
    expect(isInDefectWindow(FIX_DEPLOYED_MS, WINDOW)).toBe(false);
  });
});
