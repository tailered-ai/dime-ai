/**
 * Tests for the real Drizzle/TiDB gateway (Phase M).
 *
 * Kept in its own file because applyApproved.test.ts mocks ./drizzleGateway —
 * mocking the module under test would prove nothing.
 */
import { describe, it, expect } from "vitest";
import { makeRepairRowGateway } from "./drizzleGateway";

// ─── Gateway ─────────────────────────────────────────────────────────────────

describe("drizzle gateway", () => {
  function fakeTx() {
    const setCalls: Record<string, string | null>[] = [];
    const forCalls: string[] = [];
    let stored: Record<string, string | null> | null = {
      brierFgTotal: "0.160000",
      brierF5Total: null,
      brierNrfi: "0.989559",
      brierFgMl: null,
      brierF5Ml: null,
    };
    const tx = {
      select: () => ({
        from: () => {
          const p = Promise.resolve(stored ? [stored] : []);
          return Object.assign(p, {
            where: () =>
              Object.assign(Promise.resolve(stored ? [stored] : []), {
                for: (mode: string) => {
                  forCalls.push(mode);
                  return Promise.resolve(stored ? [stored] : []);
                },
              }),
          });
        },
      }),
      update: () => ({
        set: (values: Record<string, string | null>) => {
          setCalls.push(values);
          return { where: async () => undefined };
        },
      }),
    };
    return {
      tx,
      setCalls,
      forCalls,
      setStored: (v: Record<string, string | null> | null) => {
        stored = v;
      },
    };
  }

  it("locks the row on read", async () => {
    const f = fakeTx();
    const gw = makeRepairRowGateway(f.tx as never);
    const got = await gw.readForUpdate(1);
    expect(f.forCalls).toEqual(["update"]);
    expect(got?.brierNrfi).toBeCloseTo(0.989559, 6);
    expect(got?.brierF5Total).toBeNull();
  });

  it("returns null for a missing row", async () => {
    const f = fakeTx();
    f.setStored(null);
    const gw = makeRepairRowGateway(f.tx as never);
    expect(await gw.readForUpdate(1)).toBeNull();
    expect(await gw.readBack(1)).toBeNull();
  });

  it("writes ONLY the five Brier columns, with explicit NULL", async () => {
    const f = fakeTx();
    const gw = makeRepairRowGateway(f.tx as never);
    await gw.writeBrier(1, {
      brierFgTotal: 0.16,
      brierF5Total: null,
      brierNrfi: 0.227148,
      brierFgMl: null,
      brierF5Ml: null,
    });

    const payload = f.setCalls[0];
    expect(Object.keys(payload).sort()).toEqual([
      "brierF5Ml",
      "brierF5Total",
      "brierFgMl",
      "brierFgTotal",
      "brierNrfi",
    ]);
    // Never actual*, outcomeIngestedAt, model probabilities or calibration.
    expect(payload).not.toHaveProperty("actualFgTotal");
    expect(payload).not.toHaveProperty("outcomeIngestedAt");
    // Explicit null, not undefined — undefined would be omitted by Drizzle and
    // a stale value would survive a correction.
    expect(payload.brierF5Total).toBeNull();
    expect(payload.brierNrfi).toBe("0.227148");
  });

  it("reads back without locking", async () => {
    const f = fakeTx();
    const gw = makeRepairRowGateway(f.tx as never);
    await gw.readBack(1);
    expect(f.forCalls).toEqual([]);
  });
});
