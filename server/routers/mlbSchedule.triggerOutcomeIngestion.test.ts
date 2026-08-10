/**
 * Wiring tests for the owner-only triggerOutcomeIngestion procedure.
 *
 * This is the ONLY surface that can reach the M-203 correction modes, so the
 * forwarding itself is safety-critical: if the resolver dropped `dryRun`, a run
 * the operator believed was a preview would write to production. These tests
 * assert the exact arguments handed to ingestMlbOutcomes.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const ingestSpy = vi.fn(async () => ({
  date: "2026-08-01",
  totalGames: 1,
  written: 0,
  wouldWrite: 1,
  brierChanged: 1,
  skippedAlreadyIngested: 0,
  skippedNotFinal: 0,
  skippedNoGamePk: 0,
  skippedNoApiMatch: 0,
  errors: 0,
  results: [],
  runAt: 0,
  dryRun: true,
  historical: true,
}));

vi.mock("../mlbOutcomeIngestor", () => ({
  ingestMlbOutcomes: (...a: unknown[]) => ingestSpy(...(a as [])),
}));

// ownerProcedure carries the real auth middleware; swap it for publicProcedure
// so these tests exercise the RESOLVER (argument forwarding), not the guard.
vi.mock("./appUsers", async () => {
  const t =
    await vi.importActual<typeof import("../_core/trpc")>("../_core/trpc");
  return {
    ownerProcedure: t.publicProcedure,
    appUserProcedure: t.publicProcedure,
  };
});

import { mlbScheduleRouter } from "./mlbSchedule";

/**
 * publicProcedure carries csrfOriginCheck, which short-circuits on GET before
 * any origin evaluation. These tests exercise the resolver's argument
 * forwarding, not CSRF, so a GET-shaped request is the honest minimal context.
 */
function caller() {
  const ctx = {
    req: {
      method: "GET",
      get: () => undefined,
      headers: {},
      ip: "127.0.0.1",
      socket: { remoteAddress: "127.0.0.1" },
    },
  };
  return mlbScheduleRouter.createCaller(ctx as never);
}

beforeEach(() => ingestSpy.mockClear());

describe("triggerOutcomeIngestion wiring", () => {
  it("forwards dryRun and historical verbatim to the ingestor", async () => {
    await caller().triggerOutcomeIngestion({
      dateStr: "2026-08-01",
      force: true,
      dryRun: true,
      historical: true,
    });

    expect(ingestSpy).toHaveBeenCalledWith("2026-08-01", true, {
      dryRun: true,
      historical: true,
    });
  });

  it("defaults every flag to false so an unflagged call is a normal live run", async () => {
    await caller().triggerOutcomeIngestion({ dateStr: "2026-08-02" });

    expect(ingestSpy).toHaveBeenCalledWith("2026-08-02", false, {
      dryRun: false,
      historical: false,
    });
  });

  it("returns the ingestor summary unchanged", async () => {
    const out = await caller().triggerOutcomeIngestion({
      dateStr: "2026-08-01",
      dryRun: true,
    });
    expect(out.wouldWrite).toBe(1);
    expect(out.written).toBe(0);
  });

  it("rejects a malformed date before reaching the ingestor", async () => {
    await expect(
      caller().triggerOutcomeIngestion({ dateStr: "08-01-2026" })
    ).rejects.toThrow();
    expect(ingestSpy).not.toHaveBeenCalled();
  });

  it("surfaces an ingestor failure as an INTERNAL_SERVER_ERROR", async () => {
    ingestSpy.mockImplementationOnce(async () => {
      throw new Error("boom");
    });
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(
      caller().triggerOutcomeIngestion({ dateStr: "2026-08-01" })
    ).rejects.toThrow(/Outcome ingestion failed: boom/);

    errSpy.mockRestore();
  });
});
