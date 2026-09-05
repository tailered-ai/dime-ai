import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  SOURCES,
  DATE,
  ncaafSeptember5Record,
  presentNcaafSeptember5,
} from "../shared/ncaafSeptember5";
import {
  EVENT,
  REPLACEMENT_PRICES_APPROVED,
  checkCorrection,
  correction,
  correctionStatement,
  planCorrection,
  runCorrection,
  verifyPreserved,
  type CorrectionStore,
} from "./correctNcaafSeptember5Okst.mts";

const game = SOURCES.find(game => game.event === EVENT)!;
const original = () => ({
  id: 991,
  sport: "NCAAF",
  gameDate: DATE,
  awayTeam: "OKST",
  homeTeam: "TLSA",
  ...ncaafSeptember5Record(game),
  awayModelSpread: "12.6",
  homeModelSpread: "-12.6",
  modelAwaySpreadOdds: "+1928",
  modelHomeSpreadOdds: "-1928",
  spreadEdge: "old edge",
  spreadDiff: "26.1",
  gameStatus: "live",
  awayScore: 7,
  homeScore: 0,
  gameClock: "1st 9:40",
  sortOrder: 30,
  createdAt: new Date("2026-09-05T16:00:00Z"),
});

function fake(rows: Record<string, unknown>[], fail?: "cas" | "preservation") {
  let current = structuredClone(rows);
  let before = structuredClone(rows);
  const calls: string[] = [];
  const store: CorrectionStore = {
    async beginTransaction() {
      before = structuredClone(current);
      calls.push("begin");
    },
    async read() {
      return structuredClone(current);
    },
    async execute(sql, values) {
      calls.push("update");
      const statement = correctionStatement(current[0]);
      expect(sql).toBe(statement.sql);
      expect(values).toEqual(statement.values);
      if (fail === "cas") return 0;
      current[0] = { ...current[0], ...correction };
      if (fail === "preservation") current[0].awayScore = 99;
      return 1;
    },
    async commit() {
      calls.push("commit");
    },
    async rollback() {
      calls.push("rollback");
      current = structuredClone(before);
    },
  };
  return { store, calls, rows: () => current };
}

describe("bounded Oklahoma State model direction correction", () => {
  it("corrects direction without changing the other 67 source records or any Book prices", () => {
    checkCorrection();
    expect(REPLACEMENT_PRICES_APPROVED).toBe(true);
    expect(game.model.awaySpread).toBe(-12.6);
    expect(game.model.homeSpread).toBe(12.6);
    const row = { ...original(), ...correction };
    expect(presentNcaafSeptember5(row).modelPriceBasis).toEqual(
      game.model.basis
    );
    expect(presentNcaafSeptember5(original()).modelPriceBasis).toBeNull();
    expect(row.awaySpreadOdds).toBe("-105");
    expect(row.homeSpreadOdds).toBe("-115");
    expect(row.bookTotal).toBe("57.5");
    expect(row.modelTotal).toBe("54.4");
    expect(row.modelOverOdds).toBe("+157");
    expect(row.modelUnderOdds).toBe("-157");
    expect(row.modelAwayML).toBeNull();
    expect(row.modelHomeML).toBeNull();
    expect(row.modelAwaySpreadOdds).not.toBe("+1928");
    expect(row.modelHomeSpreadOdds).not.toBe("-1928");
    expect(row.modelAwaySpreadOdds).toBe("+110");
    expect(row.modelHomeSpreadOdds).toBe("-110");
    // Exact canonical hash of the other 67 already-published source records.
    expect(
      createHash("sha256")
        .update(JSON.stringify(SOURCES.filter(g => g.event !== EVENT)))
        .digest("hex")
    ).toBe("fdd9fbd78b0660ebb816edc542292accc07ca3712193505f0abf5fa42dbfa1c1");
  });

  it("rejects absent, duplicate, wrong-identity and changed model imports", () => {
    expect(() => planCorrection([])).toThrow("Missing or duplicate");
    expect(() => planCorrection([original(), original()])).toThrow(
      "Missing or duplicate"
    );
    for (const wrong of [
      { awayTeam: "TLSA", homeTeam: "OKST" },
      { ncaaContestId: "other" },
      { gameDate: "2026-09-04" },
      { sport: "NCAAM" },
      { modelRunAt: 123 },
      { modelTotal: "59.9" },
      { modelHomeSpreadOdds: "-1900" },
      { awayModelSpread: "-12.6" },
    ])
      expect(() => planCorrection([{ ...original(), ...wrong }])).toThrow();
    expect(planCorrection([{ ...original(), ...correction }]).changed).toBe(
      false
    );
  });

  it("updates only six model/derived spread columns behind exact identity and old-value guards", () => {
    const row = original();
    const { sql, values } = correctionStatement(row);
    expect(sql.split(" WHERE ")[0]).toBe(
      "UPDATE games SET `awayModelSpread` = ?, `homeModelSpread` = ?, `modelAwaySpreadOdds` = ?, `modelHomeSpreadOdds` = ?, `spreadEdge` = ?, `spreadDiff` = ?"
    );
    expect(sql).toContain("`ncaaContestId` <=> ? AND `modelRunAt` <=> ?");
    expect(sql).toContain(
      "`modelAwaySpreadOdds` <=> ? AND `modelHomeSpreadOdds` <=> ?"
    );
    expect(values).toContain(EVENT);
    expect(values).toContain("+1928");
    expect(values).toContain("-1928");
    expect(() => verifyPreserved(row, { ...row, ...correction })).not.toThrow();
    for (const wrong of [
      { awayML: "-999" },
      { gameStatus: "final" },
      { sortOrder: 2 },
      { modelTotal: "55.0" },
      { spreadAwayMoneyPct: 1 },
    ])
      expect(() =>
        verifyPreserved(row, { ...row, ...correction, ...wrong })
      ).toThrow();
  });

  it("dry-run performs no writes and verification refuses the original direction", async () => {
    const db = fake([original()]);
    const plan = await runCorrection(db.store, "--dry-run");
    expect(plan.pending).toBe(true);
    expect(plan.modelRunAt).toBe(original().modelRunAt);
    expect(plan.previous).toEqual(
      Object.fromEntries(
        Object.entries(original()).filter(([key]) => key in correction)
      )
    );
    expect(plan.replacement).toEqual(correction);
    expect(db.calls).toEqual(["begin", "rollback"]);
    await expect(runCorrection(db.store, "--verify")).rejects.toThrow(
      "not been applied"
    );
    expect(db.rows()).toEqual([original()]);
  });

  it("commits once and is idempotent after exact readback", async () => {
    const db = fake([original()]);
    expect((await runCorrection(db.store, "--apply")).changed).toBe(true);
    expect(db.calls).toEqual(["begin", "update", "commit"]);
    expect((await runCorrection(db.store, "--apply")).changed).toBe(false);
    expect((await runCorrection(db.store, "--verify")).pending).toBe(false);
    expect(db.calls.filter(call => call === "update")).toHaveLength(1);
    expect(db.rows()).toEqual([{ ...original(), ...correction }]);
  });

  it("rolls back a lost comparison or unrelated-field readback change", async () => {
    for (const failure of ["cas", "preservation"] as const) {
      const db = fake([original()], failure);
      await expect(runCorrection(db.store, "--apply")).rejects.toThrow();
      expect(db.calls).not.toContain("commit");
      expect(db.calls.at(-1)).toBe("rollback");
      expect(db.rows()).toEqual([original()]);
    }
  });
});
