/**
 * Tests for the executable rollback path (Phase L).
 *
 * A rollback artifact that has never been executed is not a recovery path. The
 * production canary must not exist without these guarantees.
 */
import { describe, it, expect } from "vitest";
import {
  buildRollbackManifest,
  sealManifest,
  diffBrier,
  type BrierMap,
  type ManifestRow,
  type RepairManifest,
} from "./repairManifest";
import { applyRepairManifest, type RepairRowGateway } from "./applyManifest";
import { applyRollbackManifest } from "./applyRollback";
import { BRIER_MARKETS } from "./brierOracle";

const NULL_BRIER: BrierMap = {
  brierFgTotal: null,
  brierF5Total: null,
  brierNrfi: null,
  brierFgMl: null,
  brierF5Ml: null,
};

const IDENT = {
  actualCodeSha: "abc1234",
  actualSchemaVersion: "0134_widen_unit_probability_precision",
  log: () => {},
};

function row(over: Partial<ManifestRow> = {}): ManifestRow {
  const previous = over.previousBrier ?? { ...NULL_BRIER, brierNrfi: 0.989559 };
  const proposed = over.proposedBrier ?? { ...NULL_BRIER, brierNrfi: 0.227148 };
  return {
    gameRowId: 1,
    mlbGamePk: 700001,
    gameDate: "2026-05-01",
    matchup: "CLE@CWS",
    matchMethod: "mlbGamePk",
    outcomeIngestedAt: 1_700_000_000_000,
    sourcePayloadHash: "h",
    previousBrier: previous,
    previousActualFgTotal: "9.0",
    inputs: {
      modelOverRate: null,
      modelF5OverRate: null,
      modelPNrfi: "0.5234",
      modelHomeWinPct: null,
      modelF5HomeWinPct: null,
      bookTotal: null,
      f5Total: null,
    },
    computedOutcomes: {
      actualFgTotal: 9,
      actualF5Total: 5,
      actualNrfiBinary: 1,
      outcomeFgOver: null,
      outcomeF5Over: null,
      outcomeNrfi: 1,
      outcomeHomeWin: null,
      outcomeF5HomeWin: null,
    },
    proposedBrier: proposed,
    changeFields: diffBrier(previous, proposed),
    classification: "CORRECTION_REQUIRED",
    reason: null,
    ...over,
  };
}

function manifest(rows: ManifestRow[]): RepairManifest {
  return {
    repairRunId: "m203-rb",
    generatedAt: 1,
    codeSha: "abc1234",
    schemaVersion: "0134_widen_unit_probability_precision",
    defectWindowStart: "2026-04-15T06:15:17.000Z",
    defectWindowEnd: "2026-08-07T19:28:23.000Z",
    dates: Array.from(new Set(rows.map(r => r.gameDate))).sort(),
    rows,
  };
}

function gateway(
  store: Map<number, BrierMap>,
  opts: { dropField?: string; failWriteOnRow?: number } = {}
) {
  const gw: RepairRowGateway = {
    readForUpdate: async id => (store.has(id) ? { ...store.get(id)! } : null),
    writeBrier: async (id, values) => {
      if (opts.failWriteOnRow === id)
        throw new Error("simulated write failure");
      const cur = store.get(id);
      if (!cur) return;
      const next = { ...cur };
      for (const m of BRIER_MARKETS) {
        if (opts.dropField === m.field) continue;
        next[m.field] = values[m.field];
      }
      store.set(id, next);
    },
    readBack: async id => (store.has(id) ? { ...store.get(id)! } : null),
  };
  const runInTransaction = async <T>(
    work: (g: RepairRowGateway) => Promise<T>
  ) => {
    const snap = new Map(
      Array.from(store.entries()).map(
        ([k, v]) => [k, { ...v }] as [number, BrierMap]
      )
    );
    try {
      return await work(gw);
    } catch (e) {
      store.clear();
      for (const [k, v] of snap) store.set(k, v);
      throw e;
    }
  };
  return { runInTransaction };
}

/** Repair then roll back, asserting the exact original state returns. */
async function roundTrip(prev: number | null, next: number | null) {
  const previous = { ...NULL_BRIER, brierNrfi: prev };
  const proposed = { ...NULL_BRIER, brierNrfi: next };
  const store = new Map<number, BrierMap>([[1, { ...previous }]]);
  const original = JSON.parse(JSON.stringify(store.get(1))) as BrierMap;

  const base = row({ previousBrier: previous, proposedBrier: proposed });
  const consistent: ManifestRow =
    next === null
      ? { ...base, inputs: { ...base.inputs, modelPNrfi: null } }
      : base;
  const sealed = sealManifest(manifest([consistent]));
  const rollback = buildRollbackManifest(sealed, 1);

  const applied = await applyRepairManifest({
    ...IDENT,
    sealed,
    rollback,
    runInTransaction: gateway(store).runInTransaction,
  });
  expect(applied.aborted).toBeNull();
  expect(applied.applied).toBe(1);
  expect(store.get(1)!.brierNrfi).toBe(next);

  const rolled = await applyRollbackManifest({
    ...IDENT,
    sealed,
    rollback,
    runInTransaction: gateway(store).runInTransaction,
  });
  expect(rolled.aborted).toBeNull();
  expect(rolled.restored).toBe(1);
  expect(store.get(1)).toEqual(original);
  return { sealed, rollback, store };
}

describe("executable rollback — round trips", () => {
  it("NULL -> value -> NULL", async () => {
    await roundTrip(null, 0.227148);
  });
  it("value -> NULL -> value", async () => {
    await roundTrip(0.989559, null);
  });
  it("valueA -> valueB -> valueA", async () => {
    await roundTrip(0.989559, 0.227148);
  });
});

describe("executable rollback — fails closed", () => {
  it("refuses when the row no longer holds the repaired state", async () => {
    const { sealed, rollback, store } = await roundTrip(0.989559, 0.227148);
    // Re-apply, then let something else move the row.
    await applyRepairManifest({
      ...IDENT,
      sealed,
      rollback,
      runInTransaction: gateway(store).runInTransaction,
    });
    store.set(1, { ...NULL_BRIER, brierNrfi: 0.5 });

    const res = await applyRollbackManifest({
      ...IDENT,
      sealed,
      rollback,
      runInTransaction: gateway(store).runInTransaction,
    });
    expect(res.rows[0].outcome).toBe("CURRENT_STATE_MISMATCH");
    expect(res.restored).toBe(0);
    expect(store.get(1)!.brierNrfi).toBe(0.5); // untouched
  });

  it("rejects a rollback whose source manifest checksum does not match", async () => {
    const sealed = sealManifest(manifest([row()]));
    const rollback = buildRollbackManifest(sealed, 1);
    const store = new Map<number, BrierMap>([
      [1, { ...NULL_BRIER, brierNrfi: 0.227148 }],
    ]);
    const res = await applyRollbackManifest({
      ...IDENT,
      sealed,
      rollback: { ...rollback, sourceManifestSha256: "wrong" },
      runInTransaction: gateway(store).runInTransaction,
    });
    expect(res.aborted).toBe("ROLLBACK_INVALID");
    expect(res.restored).toBe(0);
  });

  it("rejects a rollback whose repairRunId does not match", async () => {
    const sealed = sealManifest(manifest([row()]));
    const rollback = buildRollbackManifest(sealed, 1);
    const store = new Map<number, BrierMap>([
      [1, { ...NULL_BRIER, brierNrfi: 0.227148 }],
    ]);
    const res = await applyRollbackManifest({
      ...IDENT,
      sealed,
      rollback: { ...rollback, repairRunId: "someone-elses-run" },
      runInTransaction: gateway(store).runInTransaction,
    });
    expect(res.aborted).toBe("ROLLBACK_INVALID");
  });

  it("rejects on code SHA and schema mismatch", async () => {
    const sealed = sealManifest(manifest([row()]));
    const rollback = buildRollbackManifest(sealed, 1);
    const store = new Map<number, BrierMap>([
      [1, { ...NULL_BRIER, brierNrfi: 0.227148 }],
    ]);
    const a = await applyRollbackManifest({
      ...IDENT,
      actualCodeSha: "other",
      sealed,
      rollback,
      runInTransaction: gateway(store).runInTransaction,
    });
    expect(a.aborted).toBe("CODE_SHA_MISMATCH");
    const b = await applyRollbackManifest({
      ...IDENT,
      actualSchemaVersion: "0133_account_lockout",
      sealed,
      rollback,
      runInTransaction: gateway(store).runInTransaction,
    });
    expect(b.aborted).toBe("SCHEMA_VERSION_MISMATCH");
  });

  it("reverts the whole date when a restore does not persist", async () => {
    const prev = { ...NULL_BRIER, brierNrfi: 0.989559 };
    const next = { ...NULL_BRIER, brierNrfi: 0.227148 };
    const rows = [1, 2].map(id =>
      row({
        gameRowId: id,
        previousBrier: { ...prev },
        proposedBrier: { ...next },
      })
    );
    const sealed = sealManifest(manifest(rows));
    const rollback = buildRollbackManifest(sealed, 1);
    const store = new Map<number, BrierMap>([
      [1, { ...next }],
      [2, { ...next }],
    ]);

    const res = await applyRollbackManifest({
      ...IDENT,
      sealed,
      rollback,
      // brierNrfi silently refuses to persist -> verification must catch it
      runInTransaction: gateway(store, { dropField: "brierNrfi" })
        .runInTransaction,
    });
    expect(res.rows.some(r => r.outcome === "VERIFY_FAILED")).toBe(true);
    expect(res.restored).toBe(0);
    expect(res.datesCompleted).toEqual([]);
    // Both rows remain in the repaired state — nothing partially restored.
    expect(store.get(1)!.brierNrfi).toBe(next.brierNrfi);
    expect(store.get(2)!.brierNrfi).toBe(next.brierNrfi);
  });

  it("accounts for every row on an aborted date", async () => {
    const prev = { ...NULL_BRIER, brierNrfi: 0.989559 };
    const next = { ...NULL_BRIER, brierNrfi: 0.227148 };
    const rows = [1, 2, 3].map(id =>
      row({
        gameRowId: id,
        previousBrier: { ...prev },
        proposedBrier: { ...next },
      })
    );
    const sealed = sealManifest(manifest(rows));
    const rollback = buildRollbackManifest(sealed, 1);
    const store = new Map<number, BrierMap>([
      [1, { ...next }],
      [2, { ...next }],
      [3, { ...next }],
    ]);

    const res = await applyRollbackManifest({
      ...IDENT,
      sealed,
      rollback,
      runInTransaction: gateway(store, { failWriteOnRow: 2 }).runInTransaction,
    });
    // 3 rows in, 3 rows accounted for.
    expect(res.rows).toHaveLength(3);
    expect(res.restored).toBe(0);
    expect(res.datesCompleted).toEqual([]);
  });
});
