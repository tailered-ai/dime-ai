import { afterEach, expect, it, vi } from "vitest";
import { fetchFootballSchedule } from "./footballSchedule";
afterEach(() => vi.unstubAllGlobals());
const smu = {
  id: "401858212",
  season: { year: 2026, type: 2 },
  competitions: [
    {
      date: "2026-09-07T23:30Z",
      timeValid: true,
      status: {
        type: {
          id: "1",
          state: "pre",
          description: "Scheduled",
          detail: "Scheduled",
        },
      },
      competitors: [
        {
          homeAway: "away",
          team: {
            id: "2567",
            abbreviation: "SMU",
            displayName: "SMU Mustangs",
          },
        },
        {
          homeAway: "home",
          team: {
            id: "52",
            abbreviation: "FSU",
            displayName: "Florida State Seminoles",
          },
        },
      ],
    },
  ],
};
const payload = (events: unknown[]) => ({
  leagues: [{ slug: "college-football" }],
  events,
});
it("seeds the verified SMU pilot with an ESPN namespace, ET kickoff, no prices, and a fingerprint", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify(payload([smu]))))
  );
  const result = await fetchFootballSchedule(
    "NCAAF",
    "20260801-20270220",
    2026
  );
  expect(result.rows).toHaveLength(1);
  expect(result.rows[0]).toMatchObject({
    sport: "NCAAF",
    gameDate: "2026-09-07",
    startTimeEst: "19:30",
    awayTeam: "SMU",
    homeTeam: "FSU",
    footballScheduleId: "espn:ncaaf:2026:401858212",
    footballBinding: {
      kickoff: Date.parse("2026-09-07T23:30Z"),
      awayEspnId: 2567,
      homeEspnId: 52,
      scheduleRevision: expect.stringMatching(/^[a-f0-9]{64}$/),
    },
  });
  expect(result.rows[0]).not.toHaveProperty("bookTotal");
  expect(result.rows[0]).not.toHaveProperty("modelTotal");
});
it("keeps TBD time explicit and rejects duplicate/wrong-league/truncated source responses", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(
          JSON.stringify(
            payload([
              {
                ...smu,
                competitions: [{ ...smu.competitions[0], timeValid: false }],
              },
            ])
          )
        )
    )
  );
  expect(
    (await fetchFootballSchedule("NCAAF", "20260907", 2026)).rows[0]
  ).toMatchObject({ startTimeEst: "TBD", footballBinding: { kickoff: null } });
  for (const body of [
    payload([smu, smu]),
    { leagues: [{ slug: "nfl" }], events: [smu] },
    payload(Array(1000).fill(smu)),
  ]) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify(body)))
    );
    await expect(
      fetchFootballSchedule("NCAAF", "20260907", 2026)
    ).rejects.toThrow();
  }
});
it("retains an authoritative FCS opponent absent from the old fixed-slate catalog", async () => {
  const event = structuredClone(smu);
  event.competitions[0].competitors[0].team = {
    id: "50",
    abbreviation: "FAMU",
    displayName: "Florida A&M Rattlers",
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify(payload([event]))))
  );
  expect(
    (await fetchFootballSchedule("NCAAF", "20260907", 2026)).rows[0]
  ).toMatchObject({
    awayTeam: "FAMU",
    footballBinding: { awayEspnId: 50, awayName: "Florida A&M Rattlers" },
  });
  event.competitions[0].competitors[0].team.abbreviation = "FSU";
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify(payload([event]))))
  );
  await expect(
    fetchFootballSchedule("NCAAF", "20260907", 2026)
  ).rejects.toThrow(/identity/);
});
