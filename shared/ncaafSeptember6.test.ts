import { describe, expect, it } from "vitest";
import { presentNcaafSeptember6 } from "./ncaafSeptember6";

const row = {
  id: 4350070,
  sport: "NCAAF",
  gameDate: "2026-09-06",
  ncaaContestId: "287973",
  awayTeam: "WIS",
  homeTeam: "ND",
  publishedModel: 1,
  modelRunAt: 1788746000000,
  awayModelSpread: "22.7",
  homeModelSpread: "-22.7",
  modelAwaySpreadOdds: "+125",
  modelHomeSpreadOdds: "-125",
  modelAwayML: "+1010",
  modelHomeML: "-1010",
  modelTotal: null,
  modelOverOdds: "+106",
  modelUnderOdds: "-106",
  awayBookSpread: "21.0",
  homeBookSpread: "-21.0",
  bookTotal: "46.5",
};
describe("September 6 owner model pricing basis", () => {
  it("binds supplied Wisconsin prices to 21, not its 22.7 projection or a refreshed book line", () => {
    for (const awayBookSpread of ["21.0", "20.5"])
      expect(
        presentNcaafSeptember6({ ...row, awayBookSpread }).modelPriceBasis
      ).toEqual({
        awaySpread: 21,
        homeSpread: -21,
        total: null,
        overTotal: 46.5,
        underTotal: 46.6,
      });
  });
  it("withholds provenance for changed, unpublished, redacted or unrelated owner records", () => {
    for (const change of [
      { id: 4350071 },
      { gameDate: "2026-09-05" },
      { ncaaContestId: "288813" },
      { homeTeam: "WASH" },
      { modelRunAt: null },
      { publishedModel: 0 },
      { homeModelSpread: "-21.0" },
      { modelHomeSpreadOdds: "-110" },
      { modelTotal: "46.6" },
      { modelOverOdds: "+105" },
    ])
      expect(
        presentNcaafSeptember6({ ...row, ...change }).modelPriceBasis ?? null
      ).toBeNull();
  });
});
