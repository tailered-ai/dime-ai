import { expect, it } from "vitest";
import { prepareSmuFsuModel } from "./publishSmuFsuModel.mts";
import { SMU_FSU_KEY, SMU_FSU_MODEL } from "../server/smuFsuModel";
const empty = () => ({
  id: 12,
  sport: "NCAAF",
  gameDate: "2026-09-07",
  awayTeam: "SMU",
  homeTeam: "FSU",
  footballScheduleId: SMU_FSU_KEY,
  publishedToFeed: 1,
  publishedModel: 0,
  modelRunAt: null,
  modelOverOdds: null,
  modelUnderOdds: null,
  ...Object.fromEntries(Object.keys(SMU_FSU_MODEL).map(key => [key, null])),
});
it("imports exact owner fields, preserves replay time and rejects conflicting models/identity", () => {
  const row = empty();
  const fields = prepareSmuFsuModel([row], 1788796800000);
  expect(fields).toEqual({
    ...SMU_FSU_MODEL,
    publishedModel: 1,
    modelRunAt: 1788796800000,
  });
  expect(prepareSmuFsuModel([{ ...row, ...fields }], 1788797800000)).toEqual(
    fields
  );
  expect(row.modelRunAt).toBeNull();
  for (const rows of [
    [],
    [row, row],
    [{ ...row, awayTeam: "FSU" }],
    [{ ...row, modelAwayML: "-113" }],
    [{ ...row, modelRunAt: 1 }],
  ])
    expect(() => prepareSmuFsuModel(rows, 1788796800000)).toThrow();
});
