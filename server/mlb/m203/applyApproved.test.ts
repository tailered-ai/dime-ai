/**
 * Tests for the owner-only single-date apply surface and the Drizzle gateway.
 *
 * The apply surface treats the submitted manifest as untrusted: it must be
 * reproducible by the server, single-date, and sealed. The gateway must write
 * ONLY the five Brier columns, and must write null as SQL NULL.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const ingestSpy = vi.fn();
const applySpy = vi.fn(async () => ({
  repairRunId: "r",
  aborted: null,
  abortDetail: null,
  applied: 1,
  skipped: 0,
  failed: 0,
  rows: [],
  datesCompleted: ["2026-05-01"],
}));
const runnerSpy = vi.fn(async () => async (w: unknown) => w);

vi.mock("../../mlbOutcomeIngestor", () => ({
  ingestMlbOutcomes: (...a: unknown[]) => ingestSpy(...(a as [])),
}));
vi.mock("./drizzleGateway", () => ({
  makeTransactionRunner: (...a: unknown[]) => runnerSpy(...(a as [])),
  makeRepairRowGateway: vi.fn(),
}));
vi.mock("./applyManifest", async () => {
  const actual =
    await vi.importActual<typeof import("./applyManifest")>("./applyManifest");
  return {
    ...actual,
    applyRepairManifest: (...a: unknown[]) => applySpy(...(a as [])),
  };
});

import { applyApprovedManifest, generateApprovalPacket } from "./applyApproved";
import {
  buildRepairManifest,
  type DefectWindow,
  type DryRunRow,
} from "./buildManifest";
import { buildRollbackManifest } from "./repairManifest";

const WINDOW: DefectWindow = {
  defectStartMs: Date.parse("2026-04-15T06:15:17Z"),
  fixDeployedAtMs: Date.parse("2026-08-07T19:28:23Z"),
};

const OPTS = {
  repairRunId: "run-1",
  generatedAt: 1_700_000_000_000,
  codeSha: "sha-1",
  schemaVersion: "0134_widen_unit_probability_precision",
  window: WINDOW,
};

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
      brierFgTotal: null,
      brierF5Total: null,
      brierNrfi: 0.989559,
      brierFgMl: null,
      brierF5Ml: null,
    },
    brierFgTotal: null,
    brierF5Total: null,
    brierNrfi: 0.227148,
    brierFgMl: null,
    brierF5Ml: null,
    actualFgTotal: 9,
    actualF5Total: 5,
    actualNrfiBinary: 1,
    inputs: {
      modelOverRate: null,
      modelF5OverRate: null,
      modelPNrfi: "0.5234",
      modelHomeWinPct: null,
      modelF5HomeWinPct: null,
      bookTotal: null,
      f5Total: null,
    },
    outcomes: {
      actualFgTotal: 9,
      actualF5Total: 5,
      actualNrfiBinary: 1,
      outcomeFgOver: null,
      outcomeF5Over: null,
      outcomeNrfi: 1,
      outcomeHomeWin: null,
      outcomeF5HomeWin: null,
    },
    previousActualFgTotal: "9.0",
    ...over,
  };
}

function packet(rows: DryRunRow[] = [dryRow()]) {
  const { sealed } = buildRepairManifest({ ...OPTS, rows });
  return { sealed, rollback: buildRollbackManifest(sealed, OPTS.generatedAt) };
}

const IDENT = {
  window: WINDOW,
  actualCodeSha: "sha-1",
  actualSchemaVersion: "0134_widen_unit_probability_precision",
};

beforeEach(() => {
  ingestSpy.mockReset();
  applySpy.mockClear();
  runnerSpy.mockClear();
});

describe("applyApprovedManifest", () => {
  it("applies when the server can reproduce the submitted manifest exactly", async () => {
    const { sealed, rollback } = packet();
    ingestSpy.mockResolvedValue({ results: [dryRow()] });

    const res = await applyApprovedManifest(
      { ...IDENT, sealed, rollback },
      () => {}
    );

    expect(res.rejected).toBeNull();
    expect(res.regeneratedSha256).toBe(sealed.manifestSha256);
    expect(applySpy).toHaveBeenCalledTimes(1);
    // failFast is hard-coded true on the production surface.
    expect((applySpy.mock.calls[0][0] as { failFast: boolean }).failFast).toBe(
      true
    );
  });

  it("REJECTS a manifest the server cannot reproduce — and writes nothing", async () => {
    const { sealed, rollback } = packet();
    // Production evidence has moved on since review.
    ingestSpy.mockResolvedValue({ results: [dryRow({ brierNrfi: 0.5 })] });

    const res = await applyApprovedManifest(
      { ...IDENT, sealed, rollback },
      () => {}
    );

    expect(res.rejected).toBe("NOT_REPRODUCIBLE");
    expect(res.apply).toBeNull();
    expect(applySpy).not.toHaveBeenCalled();
  });

  it("REJECTS a tampered seal before touching anything", async () => {
    const { sealed, rollback } = packet();
    sealed.manifest.rows[0].proposedBrier.brierNrfi = 0.9;

    const res = await applyApprovedManifest(
      { ...IDENT, sealed, rollback },
      () => {}
    );

    expect(res.rejected).toBe("SEAL_INVALID");
    expect(ingestSpy).not.toHaveBeenCalled();
    expect(applySpy).not.toHaveBeenCalled();
  });

  it("REJECTS a multi-date manifest — one approval authorizes one date", async () => {
    const { sealed, rollback } = packet([
      dryRow({ gameId: 1, gameDate: "2026-05-01" }),
      dryRow({ gameId: 2, gameDate: "2026-05-02" }),
    ]);

    const res = await applyApprovedManifest(
      { ...IDENT, sealed, rollback },
      () => {}
    );

    expect(res.rejected).toBe("NOT_SINGLE_DATE");
    expect(applySpy).not.toHaveBeenCalled();
  });
});

describe("generateApprovalPacket", () => {
  it("produces a sealed manifest + rollback from a historical dry run, mutating nothing", async () => {
    ingestSpy.mockResolvedValue({ results: [dryRow()] });

    const out = await generateApprovalPacket("2026-05-01", OPTS);

    expect(ingestSpy).toHaveBeenCalledWith("2026-05-01", true, {
      dryRun: true,
      historical: true,
    });
    expect(out.accounting.balanced).toBe(true);
    expect(out.accounting.writable).toBe(1);
    expect(out.rollback.rows).toHaveLength(1);
    expect(applySpy).not.toHaveBeenCalled();
  });
});
