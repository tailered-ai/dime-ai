import { expect, test, type Page } from "@playwright/test";

const VIEWPORTS = [
  { name: "mobile", width: 390, height: 844 },
  { name: "tablet", width: 834, height: 1112 },
  { name: "desktop", width: 1440, height: 900 },
] as const;

const USER = {
  id: 1,
  email: "member@example.com",
  username: "member",
  role: "user",
  hasAccess: true,
  expiryDate: null,
  termsAccepted: true,
};

const MATCHUPS = [
  ["MASS", "RUT"],
  ["AKR", "WF"],
  ["COLO", "GT"],
  ["UAB", "ILL"],
] as const;

const SPLITS_GAMES = MATCHUPS.map(([awayTeam, homeTeam], index) => ({
  id: index + 1,
  sport: "NCAAF",
  awayTeam,
  homeTeam,
  gameDate: "2026-09-03",
  startTimeEst: `${16 + index}:00`,
  gameStatus: "upcoming",
  gameClock: null,
  awayScore: null,
  homeScore: null,
  awayBookSpread: "+3.5",
  homeBookSpread: "-3.5",
  bookTotal: "51.5",
  awayML: "+140",
  homeML: "-160",
  spreadAwayBetsPct: 39,
  spreadAwayMoneyPct: 36,
  totalOverBetsPct: 59,
  totalOverMoneyPct: 67,
  mlAwayBetsPct: 35,
  mlAwayMoneyPct: 32,
}));

const SLATE_GAMES = MATCHUPS.map(([awayTeam, homeTeam], index) => ({
  id: index + 101,
  awayTeam,
  homeTeam,
  awayFull: awayTeam,
  homeFull: homeTeam,
  awayNickname: awayTeam,
  homeNickname: homeTeam,
  awayLogo: "data:image/gif;base64,R0lGODlhAQABAAAAACw=",
  homeLogo: "data:image/gif;base64,R0lGODlhAQABAAAAACw=",
  awayColor: "#45E0A8",
  homeColor: "#FFFFFF",
  gameTime: `${16 + index}:00`,
  sport: "NCAAF",
  gameDate: "2026-09-03",
  status: "scheduled",
  gameNumber: 1,
  odds: {
    awayMl: { odds: 140, value: 0 },
    homeMl: { odds: -160, value: 0 },
    awayRl: { odds: -110, value: 3.5 },
    homeRl: { odds: -110, value: -3.5 },
    over: { odds: -110, value: 51.5 },
    under: { odds: -110, value: 51.5 },
    bookId: 123,
  },
}));

async function stubApi(page: Page) {
  await page.route("**/api/trpc/**", route => {
    const url = new URL(route.request().url());
    const ops = decodeURIComponent(
      url.pathname.replace(/^.*\/api\/trpc\//, "")
    ).split(",");
    const body = ops.map(op => {
      const json =
        op === "appUsers.me"
          ? USER
          : op === "games.list"
            ? SPLITS_GAMES
            : op === "games.getCurrentDate"
              ? {
                  effectiveDate: "2026-09-03",
                  utcHour: 18,
                  isBeforeCutoff: false,
                }
              : op === "games.getAvailableDates"
                ? { dates: ["2026-09-03"] }
                : op === "games.lastRefresh"
                  ? { refreshedAt: "2026-09-03T18:00:00Z" }
                  : op === "betTracker.getSlate"
                    ? SLATE_GAMES
                    : op === "betTracker.getCalendarData"
                      ? { days: [], monthRecord: null, equityCurve: [] }
                      : op === "betTracker.listWithStatsPaginated"
                        ? { bets: [], stats: null, nextCursor: null }
                        : [];
      return { result: { data: { json } } };
    });
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(body),
    });
  });
  await page.route("**/api/dime/**", route =>
    route.fulfill({ status: 500, body: "stubbed offline (e2e)" })
  );
}

function expectNoHorizontalOverflow(page: Page) {
  return expect
    .poll(() =>
      page.evaluate(() => {
        const root = document.scrollingElement!;
        return root.scrollWidth - root.clientWidth;
      })
    )
    .toBeLessThanOrEqual(1);
}

function expectVisibleText(page: Page, text: string) {
  return expect
    .poll(async () => {
      const matches = page.getByText(text, { exact: true });
      for (let index = 0; index < (await matches.count()); index++) {
        if (await matches.nth(index).isVisible()) return true;
      }
      return false;
    })
    .toBe(true);
}

for (const viewport of VIEWPORTS) {
  test(`NCAAF is populated and primary on both surfaces at ${viewport.name}`, async ({
    page,
  }) => {
    await stubApi(page);
    await page.setViewportSize(viewport);

    await page.goto("/betting-splits/ncaaf-09-03-2026");
    const activeLeague = page.locator("button.bs-pill[data-active='true']");
    await expect(activeLeague).toHaveText("NCAAF");
    for (const [away, home] of MATCHUPS) {
      await expectVisibleText(page, away);
      await expectVisibleText(page, home);
    }
    await expectNoHorizontalOverflow(page);

    await page.goto("/bet-tracker");
    const ncaaf = page.getByRole("button", { name: "NCAAF", exact: true });
    const mlb = page.getByRole("button", { name: "MLB", exact: true });
    await expect(ncaaf).toHaveClass(/border-primary/);
    expect((await ncaaf.boundingBox())!.x).toBeLessThan(
      (await mlb.boundingBox())!.x
    );

    await page.getByRole("button", { name: "ADD BET" }).click();
    await page.getByRole("button", { name: /Select game/ }).click();
    for (const [away, home] of MATCHUPS) {
      await expectVisibleText(page, away);
      await expectVisibleText(page, home);
    }
    await expectNoHorizontalOverflow(page);
  });
}
