import { afterEach, expect, it, vi } from "vitest";
import { scrapeVsinBettingSplits } from "./vsinBettingSplitsScraper";

afterEach(() => vi.unstubAllGlobals());
// Minimal sp-table contract from the public DraftKings NFL view, not live odds.
function row(
  home = false,
  percentages = [26, 48, 50, 51, 45, 25],
  code = "20260909NFL00061"
) {
  const cells = [
    `<button data-gamecode="${code}"></button>`,
    `<a class="sp-team-link" href="/nfl/teams/${home ? "seattle-seahawks" : "new-england-patriots"}">${home ? "Seattle Seahawks" : "New England Patriots"}</a>`,
    home ? "-3.5" : "+3.5",
    `${percentages[0]}%`,
    `${percentages[1]}%`,
    "44.5",
    `${percentages[2]}%`,
    `${percentages[3]}%`,
    home ? "-180" : "+150",
    `${percentages[4]}%`,
    `${percentages[5]}%`,
  ];
  return `<tr class="sp-row">${cells.map((c, i) => `<td>${i < 2 ? c : `<span class="sp-badge">${c}</span>`}</td>`).join("")}</tr>`;
}
function page(rows = row() + row(true, [74, 52, 50, 49, 55, 75])) {
  return `<table class="sp-table"><thead><tr class="sp-source-dk"><th class="sp-sport-name"><a href="/nfl/games/?gamedate=2026-09-09">NFL</a></th>${["Spread", "Handle", "Bets", "Total", "Handle", "Bets", "Money", "Handle", "Bets"].map(s => `<th>${s}</th>`).join("")}</tr></thead><tbody>${rows}</tbody></table>`;
}
async function read(html: string) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(html))
  );
  return scrapeVsinBettingSplits("sport", "NFL");
}
it("reads future posted NFL events from the DraftKings sport view with both sides and provenance", async () => {
  const results = await read(page());
  expect(fetch).toHaveBeenCalledWith(
    "https://data.vsin.com/betting-splits/?source=DK&sport=NFL",
    expect.any(Object)
  );
  expect(results).toHaveLength(1);
  expect(results[0]).toMatchObject({
    gameId: "20260909NFL00061",
    sport: "NFL",
    gameDate: "2026-09-09",
    spreadAwayMoneyPct: 26,
    spreadHomeMoneyPct: 74,
    totalOverBetsPct: 51,
    totalUnderBetsPct: 49,
    mlAwayBetsPct: 25,
    mlHomeBetsPct: 75,
    provenance: { responseSha256: expect.stringMatching(/^[a-f0-9]{64}$/) },
  });
});
it("preserves legitimate zero/100 and keeps missing counterpart unavailable", async () => {
  const result = await read(
    page(
      row(false, [0, 0, 0, 0, 0, 0]) + row(true, [100, 100, 100, 100, 100, 100])
    )
  );
  expect(result[0]).toMatchObject({
    spreadAwayBetsPct: 0,
    spreadHomeBetsPct: 100,
  });
  const missing = await read(page().replace("74%", "—"));
  expect(missing[0]).toMatchObject({
    spreadAwayMoneyPct: 26,
    spreadHomeMoneyPct: null,
  });
  const pending = await read(
    page(row(false, [0, 0, 0, 0, 0, 0]) + row(true, [0, 0, 0, 0, 0, 0]))
  );
  expect(pending[0]).toMatchObject({
    spreadAwayMoneyPct: null,
    spreadHomeMoneyPct: null,
    mlAwayBetsPct: null,
    mlHomeBetsPct: null,
  });
  await expect(read(page().replace("74%", "80%"))).rejects.toThrow(
    "contradictory"
  );
});
it("binds every posted date to its own header inside the single sport-view table", async () => {
  const next = page()
    .replaceAll("20260909", "20260913")
    .replaceAll("2026-09-09", "2026-09-13");
  const html = page().replace(
    "</table>",
    next.replace('<table class="sp-table">', "")
  );
  expect((await read(html)).map(g => g.gameDate)).toEqual([
    "2026-09-09",
    "2026-09-13",
  ]);
});
it("rejects mismatched rows/dates/books, malformed percentages and incomplete football tables", async () => {
  for (const html of [
    page(row() + row(true, [74, 52, 50, 49, 55, 75], "20260910NFL00061")),
    page().replace("gamedate=2026-09-09", "gamedate=2026-09-10"),
    page().replace("sp-source-dk", "sp-source-circa"),
    page().replace(
      "/nfl/teams/seattle-seahawks",
      "/mlb/teams/seattle-seahawks"
    ),
    page().replace("26%", "126%"),
    page(row()),
    "<html>Access denied</html>",
  ])
    await expect(read(html)).rejects.toThrow();
});
