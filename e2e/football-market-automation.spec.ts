import { test, expect, type Page } from "@playwright/test";

// Synthetic integration prices, NOT provider/publication evidence. Real source receipts live in docs/audits.
const pilots = [
  {
    id: 4390001,
    sport: "NCAAF",
    awayTeam: "SMU",
    homeTeam: "FSU",
    gameDate: "2026-09-07",
    startTimeEst: "19:30",
  },
  {
    id: 4380001,
    sport: "NFL",
    awayTeam: "NE",
    homeTeam: "SEA",
    gameDate: "2026-09-09",
    startTimeEst: "20:20",
  },
];
const prices = {
  awayBookSpread: "3.5",
  homeBookSpread: "-3.5",
  awaySpreadOdds: "-105",
  homeSpreadOdds: "-115",
  bookTotal: "44.5",
  overOdds: "-110",
  underOdds: "-110",
  awayML: "150",
  homeML: "-180",
};
const splits = {
  spreadAwayBetsPct: 0,
  spreadHomeBetsPct: 100,
  spreadAwayMoneyPct: 26,
  spreadHomeMoneyPct: 74,
  totalOverBetsPct: 51,
  totalUnderBetsPct: 49,
  totalOverMoneyPct: 50,
  totalUnderMoneyPct: 50,
  mlAwayBetsPct: 25,
  mlHomeBetsPct: 75,
  mlAwayMoneyPct: 45,
  mlHomeMoneyPct: 55,
};
async function stub(page: Page) {
  await page.route("**/api/trpc/**", route => {
    const url = new URL(route.request().url());
    const ops = decodeURIComponent(
      url.pathname.replace(/^.*\/api\/trpc\//, "")
    ).split(",");
    const input = JSON.parse(url.searchParams.get("input") ?? "{}");
    const body = ops.map((op, index) => {
      const args = input[index]?.json ?? {};
      let json: unknown = [];
      if (op === "appUsers.me")
        json = {
          id: 1,
          email: "member@example.com",
          username: "member",
          role: "user",
          hasAccess: true,
          expiryDate: null,
          termsAccepted: true,
        };
      if (op === "games.list")
        json = pilots
          .filter(p => p.sport === args.sport && p.gameDate === args.gameDate)
          .map(p => ({
            ...p,
            ...prices,
            ...splits,
            gameStatus: "upcoming",
            publishedToFeed: true,
            publishedModel: false,
            footballScheduleId: `fixture:${p.id}`,
            footballBinding: { kickoff: Date.parse(`${p.gameDate}T23:30Z`) },
            footballMarketState: {
              vsin_dk: {
                receivedAt: Date.now(),
                snapshot: splits,
                missing: [],
              },
              an_dk: { receivedAt: Date.now(), snapshot: {}, missing: [] },
            },
          }));
      if (op === "games.getCurrentDate")
        json = {
          effectiveDate: "2026-09-07",
          utcHour: 12,
          isBeforeCutoff: false,
        };
      if (op === "games.getAvailableDates")
        json = {
          dates: pilots
            .filter(p => p.sport === args.sport)
            .map(p => p.gameDate),
        };
      if (op === "games.lastRefresh")
        json = { refreshedAt: new Date().toISOString() };
      if (op === "games.mlbLineups") json = {};
      if (op === "oddsHistory.listForGame") {
        const rows = Array.from({ length: 451 }, (_, i) => ({
          id: 451 - i,
          gameId: args.gameId,
          scrapedAt: 1788780000000 - i * 300000,
          source: "auto",
          lineSource: "dk",
          sourceLabel: "VSiN DK",
          awaySpread: "3.5",
          homeSpread: "-3.5",
          awaySpreadOdds: "-105",
          homeSpreadOdds: "-115",
          total: "44.5",
          overOdds: "-110",
          underOdds: "-110",
          awayML: "150",
          homeML: "-180",
          ...splits,
        })).filter(r => !args.cursor || r.id < args.cursor.id);
        const history = rows.slice(0, 200),
          last = history.at(-1);
        json = {
          history,
          nextCursor:
            rows.length > 200 && last
              ? { id: last.id, scrapedAt: last.scrapedAt }
              : null,
        };
      }
      return { result: { data: { json } } };
    });
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(body),
    });
  });
  await page.route("**/api/dime/**", route =>
    route.fulfill({ status: 200, contentType: "application/json", body: "[]" })
  );
}
for (const width of [375, 768, 1024, 1440])
  for (const theme of ["dark", "light"] as const) {
    test(`${width} ${theme}: both pilots preserve book markets, navigation and all history pages`, async ({
      page,
    }) => {
      test.setTimeout(90_000);
      const errors: string[] = [];
      page.on("pageerror", error => errors.push(error.message));
      await stub(page);
      await page.setViewportSize({ width, height: 900 });
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
      await page.addInitScript(theme => {
        localStorage.setItem("dime-theme", theme);
        localStorage.setItem("dime.sidebar.rail", "0");
      }, theme);
      for (const pilot of pilots) {
        const slug = pilot.gameDate.split("-").slice(1).join("-") + "-2026";
        await page.goto(
          `/feed/model/${slug}?league=${pilot.sport}&game=${pilot.id}`
        );
        const card = page.locator(
          `#dmf-league-${pilot.sport} article.projection-card`
        );
        // Cold Vite transforms can outlast the default five-second assertion.
        await expect(card).toHaveCount(1, { timeout: 30_000 });
        await expect(card).toContainText("Action Network DK");
        await expect(card).not.toContainText("VSiN DK");
        await expect(card).toContainText("-105");
        await card.scrollIntoViewIfNeeded();
        await page.screenshot({
          path: `docs/audits/2026-09-07-football-markets-evidence/screenshots/${pilot.sport}-model-${width}-${theme}.png`,
        });
        const toggle = card.getByRole("button", {
          name: /View full AI Model Projections/i,
        });
        await toggle.click();
        await expect(page.getByRole("dialog")).toContainText("+3.5");
        await page.keyboard.press("Escape");
        if (width === 768)
          await page.getByRole("button", { name: "Menu", exact: true }).click();
        const tools =
          width < 768
            ? page.getByTestId("tab-tools")
            : page.getByRole("link", {
                name: "Betting Splits + Odds History",
                exact: true,
              });
        await expect(tools).toHaveAttribute(
          "href",
          `/betting-splits/${pilot.sport.toLowerCase()}-${slug}?game=${pilot.id}`
        );
        await tools.click();
        await expect(page).toHaveURL(
          new RegExp(
            `/betting-splits/${pilot.sport.toLowerCase()}-${slug}\\?game=${pilot.id}`
          )
        );
        const splitCard = page.locator(`#game-card-${pilot.id}`);
        await expect(splitCard).toContainText("100%");
        const helmet = splitCard.locator("img:visible").first();
        await expect(helmet).toBeVisible();
        await expect(helmet).toHaveAttribute(
          "src",
          /\/brand\/(?:ncaaf|nfl)-helmets\//
        );
        await expect
          .poll(() =>
            helmet.evaluate(img => (img as HTMLImageElement).naturalWidth)
          )
          .toBeGreaterThan(0);
        await splitCard.scrollIntoViewIfNeeded();
        await page.screenshot({
          path: `docs/audits/2026-09-07-football-markets-evidence/screenshots/${pilot.sport}-splits-${width}-${theme}.png`,
        });
        await splitCard.getByRole("button", { name: /history/i }).click();
        await expect(
          splitCard.getByRole("button", { name: /Load older observations/i })
        ).toBeVisible();
        await splitCard
          .getByRole("button", { name: /Load older observations/i })
          .click();
        await splitCard
          .getByRole("button", { name: /Load older observations/i })
          .click();
        await expect(splitCard).toContainText("451");
        await expect(splitCard).not.toContainText("VSiN DK");
        await expect(
          splitCard.getByRole("button", { name: /Load older observations/i })
        ).toHaveCount(0);
        const overflow = await page.evaluate(() => ({
          width: document.documentElement.scrollWidth - innerWidth,
          elements: [...document.querySelectorAll("body *")]
            .filter(
              el =>
                el.getBoundingClientRect().right > innerWidth + 1 &&
                getComputedStyle(el).position !== "absolute"
            )
            .slice(0, 20)
            .map(el => ({
              tag: el.tagName,
              class: el.className,
              right: el.getBoundingClientRect().right,
              width: el.getBoundingClientRect().width,
            })),
        }));
        expect(
          overflow.width,
          JSON.stringify(overflow.elements)
        ).toBeLessThanOrEqual(1);
        await page.screenshot({
          path: `docs/audits/2026-09-07-football-markets-evidence/screenshots/${pilot.sport}-${width}-${theme}.png`,
          fullPage: false,
        });
        await page.goBack();
        await expect(page).toHaveURL(
          new RegExp(
            `/feed/model/${slug}\\?league=${pilot.sport}&game=${pilot.id}`
          )
        );
      }
      expect(errors).toEqual([]);
    });
  }
