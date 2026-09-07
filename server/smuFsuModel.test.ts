import { describe, expect, it } from "vitest";
import {
  SMU_FSU_KEY,
  SMU_FSU_MODEL,
  SMU_FSU_TOTALS,
  presentSmuFsuModel,
} from "./smuFsuModel";
import { stripGameModelFields } from "./feedGating";
const row = {
  sport: "NCAAF",
  gameDate: "2026-09-07",
  awayTeam: "SMU",
  homeTeam: "FSU",
  footballScheduleId: SMU_FSU_KEY,
  ...SMU_FSU_MODEL,
  publishedModel: true,
  modelRunAt: 1788796800000,
};
describe("SMU FSU exact owner pricing", () => {
  it.each(SMU_FSU_TOTALS)(
    "selects only the supplied quote at %s",
    (line, over, under) => {
      const input = {
        ...row,
        bookTotal: String(line),
        footballMarketState: { an_dk: { snapshot: { total: String(line) } } },
        overOdds: "-110",
        underOdds: "-110",
      };
      const output = presentSmuFsuModel(input) as Record<string, any>;
      expect(Number(output.modelOverOdds)).toBe(over);
      expect(Number(output.modelUnderOdds)).toBe(under);
      expect(output.modelPriceBasis).toEqual({
        awaySpread: -1,
        homeSpread: 1,
        total: line,
      });
      expect(output.overOdds).toBe("-110");
      expect(output.modelTotal).toBe("52.40");
      expect(stripGameModelFields(output).modelOverOdds).toBeNull();
      expect(input).not.toHaveProperty("modelOverOdds");
    }
  );
  it("does not interpolate, borrow another provider line, or reinterpret a changed model", () => {
    for (const input of [
      { ...row, bookTotal: "51.5" },
      {
        ...row,
        bookTotal: "51.5",
        footballMarketState: { an_dk: { snapshot: { total: "52.5" } } },
      },
      {
        ...row,
        bookTotal: "56",
        footballMarketState: { an_dk: { snapshot: { total: "56" } } },
      },
    ])
      expect(presentSmuFsuModel(input)).toMatchObject({
        modelOverOdds: null,
        modelUnderOdds: null,
      });
    for (const change of [
      { modelAwayML: "-113" },
      { awayTeam: "OTHER" },
      { publishedModel: false },
      { modelRunAt: null },
    ]) {
      const input = { ...row, ...change };
      expect(presentSmuFsuModel(input)).toBe(input);
    }
  });
});
