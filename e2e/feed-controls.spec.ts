import { test, expect, type Page, type Locator } from "@playwright/test";
import { ncaafSchoolName } from "../shared/ncaafSchoolNames";
import {
  DATE,
  SOURCES,
  ncaafSeptember5Record,
  presentNcaafSeptember5,
  ncaafSeptember5HistoryRecord,
  presentNcaafSeptember5History,
} from "../shared/ncaafSeptember5";

const names: Record<string, string> = {
  source_updated_at: "sourceUpdatedAt",
  provider_observed_at: "providerObservedAt",
  ingestion_pipeline_revision: "ingestionPipelineRevision",
};
const games = SOURCES.map((source, index) =>
  presentNcaafSeptember5({
    ...Object.fromEntries(
      Object.entries(ncaafSeptember5Record(source)).map(([key, value]) => [
        names[key] ?? key,
        value,
      ])
    ),
    id: 4350001 + index,
    sport: "NCAAF",
    gameDate: DATE,
    awayTeam: source.away,
    homeTeam: source.home,
    // Regression: an early final must stay above a later live game.
    gameStatus:
      source.away === "BRY"
        ? "final"
        : source.away === "BAY"
          ? "live"
          : source.initialStatus,
    publishedModel: true,
    publishedToFeed: true,
  })
);
const user = {
  id: 1,
  email: "member@example.com",
  username: "member",
  role: "user",
  hasAccess: true,
  expiryDate: null,
  termsAccepted: true,
};
async function stub(page: Page) {
  await page.route("**/api/trpc/**", async route => {
    const url = new URL(route.request().url());
    const operations = decodeURIComponent(
      url.pathname.replace(/^.*\/api\/trpc\//, "")
    ).split(",");
    const input = JSON.parse(url.searchParams.get("input") ?? "{}");
    const body = operations.map((operation, index) => {
      let json: unknown = [];
      if (operation === "appUsers.me") json = user;
      if (operation === "games.list")
        json =
          input[index]?.json?.gameDate !== DATE
            ? []
            : input[index]?.json?.sport === "NCAAF"
              ? games
              : [
                  {
                    ...games[0],
                    id: 7000001,
                    sport: "MLB",
                    awayTeam: "NYY",
                    homeTeam: "BOS",
                    gameStatus: "live",
                  },
                ];
      if (operation === "games.getCurrentDate")
        json = { effectiveDate: DATE, utcHour: 17, isBeforeCutoff: false };
      if (operation === "games.getAvailableDates") json = { dates: [DATE] };
      if (operation === "games.lastRefresh")
        json = { refreshedAt: SOURCES[0].splitsRetrievedAt };
      if (operation === "games.mlbLineups") json = {};
      if (operation === "oddsHistory.listForGame") {
        const gameIndex = games.findIndex(
          game => game.id === input[index]?.json?.gameId
        );
        const game = games[gameIndex];
        json = {
          history: SOURCES[gameIndex].history
            .map((quote, quoteIndex) =>
              presentNcaafSeptember5History(
                {
                  ...ncaafSeptember5HistoryRecord(quote),
                  id: quoteIndex + 1,
                  gameId: game.id,
                },
                game
              )
            )
            .sort((a, b) => Number(b.scrapedAt) - Number(a.scrapedAt)),
        };
      }
      return { result: { data: { json } } };
    });
    if (
      operations.includes("games.list") &&
      Object.values(input).some((value: any) => value.json?.gameDate !== DATE)
    )
      await new Promise(resolve => setTimeout(resolve, 700));
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

const output = "docs/audits/2026-09-05-feed-controls-evidence/screenshots";
const route = "/feed/model/09-05-2026";
const cards = (page: Page) =>
  page.locator("#dmf-league-NCAAF .projection-card");
async function open(page: Page) {
  await stub(page);
  await page.goto(route);
  await expect(cards(page)).toHaveCount(68);
  await expect(
    page.getByRole("region", { name: "Feed controls" })
  ).toBeVisible();
}
async function overflow(page: Page) {
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)
  ).toBeLessThanOrEqual(1);
  expect(
    await page
      .locator(".feed-toolbar")
      .evaluateAll(elements =>
        elements
          .filter(element => element.scrollWidth > element.clientWidth + 1)
          .map(element => element.className)
      )
  ).toEqual([]);
}

test("composes URL filters, restores back navigation and clears old games on date change", async ({
  page,
}) => {
  await open(page);
  await expect(page.locator(".dmf-league").first()).toHaveAttribute(
    "id",
    "dmf-league-NCAAF"
  );
  await page.getByLabel("Status", { exact: true }).selectOption("final");
  await expect(cards(page)).toHaveCount(
    games.filter(game => game.gameStatus === "final").length
  );
  await expect(page).toHaveURL(/status=final/);
  await page.getByLabel("Status", { exact: true }).selectOption("all");
  await page
    .getByLabel("Sport / league", { exact: true })
    .selectOption("NCAAF");
  await page
    .getByLabel("Conference", { exact: true })
    .selectOption({ label: "Big Ten Conference" });
  await expect(page.locator("#dmf-league-MLB")).toHaveCount(0);
  await page.getByRole("button", { name: "Game All games" }).click();
  await page.getByRole("combobox", { name: "Search games" }).fill("Ohio State");
  await page.getByRole("option", { name: "Ball State at Ohio State" }).click();
  await expect(cards(page)).toHaveCount(1);
  await expect(page).toHaveURL(/game=/);
  await page.getByRole("button", { name: "Next day", exact: true }).click();
  await expect(page).toHaveURL(/09-06-2026/);
  await expect(cards(page)).toHaveCount(0);
  await expect(page).not.toHaveURL(/game=/);
  await expect(
    page.getByText("No games for this date", { exact: true })
  ).toBeVisible();
  await page.goBack();
  await expect(cards(page)).toHaveCount(1);
  await expect(
    page.getByRole("button", { name: "Game Ball State at Ohio State" })
  ).toBeVisible();
  await page.getByLabel("Sport / league", { exact: true }).selectOption("MLB");
  await expect(page.locator("#dmf-league-MLB .projection-card")).toHaveCount(1);
  await expect(page.getByLabel("Conference", { exact: true })).toHaveValue(
    "all"
  );
  await expect(page).not.toHaveURL(/game=/);
});

test("calendar keyboard focus and expanded pricing preserve grid geometry", async ({
  page,
}) => {
  await open(page);
  const date = page.getByRole("button", { name: /^Choose date/ });
  await date.click();
  await expect(
    page.getByRole("dialog", { name: "Choose feed date" })
  ).toBeVisible();
  await expect(page.locator(".rdp-day_button[tabindex='0']")).toBeFocused();
  await page.screenshot({ path: `${output}/calendar.png` });
  await page.keyboard.press("Escape");
  await expect(date).toBeFocused();
  const first = cards(page).first();
  await expect(
    first.locator(".market-table, .market-table__basis")
  ).toHaveCount(0);
  const before = await first.boundingBox();
  const trigger = first.getByRole("button", {
    name: "View full AI model projections",
  });
  await trigger.click();
  const dialog = page.getByRole("dialog", {
    name: "Bryant at Army model projections",
  });
  await expect(dialog).toBeVisible();
  await expect(dialog.locator(".market-table__basis").first()).toHaveText(
    "at +37"
  );
  expect((await first.boundingBox())?.height).toBe(before?.height);
  await page.screenshot({ path: `${output}/projections.png` });
  await dialog
    .getByRole("button", { name: "Close full model projections" })
    .click();
  await expect(trigger).toBeFocused();
});

for (const [width, height] of [
  [320, 812],
  [375, 812],
  [768, 1024],
  [1024, 768],
  [1272, 827],
  [1440, 900],
  [1920, 1080],
]) {
  test(`compact ordered cards and adaptive names at ${width}x${height}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height });
    await open(page);
    await page.evaluate(() => document.fonts.ready);
    await overflow(page);
    const geometry = await cards(page).evaluateAll(elements =>
      elements.slice(0, 6).map(element => {
        const box = element.getBoundingClientRect();
        return { top: box.top, bottom: box.bottom, height: box.height };
      })
    );
    for (const item of geometry) {
      expect(item.height).toBeLessThan(490);
      const sameRow = geometry.filter(
        other => Math.abs(other.top - item.top) < 1
      );
      expect(
        Math.max(...sameRow.map(other => other.bottom)) -
          Math.min(...sameRow.map(other => other.bottom))
      ).toBeLessThanOrEqual(1);
    }
    const fits = await page
      .locator(".matchup__line:not(.matchup__line--measure)")
      .evaluateAll(elements =>
        elements.map(element => {
          const center = element.closest(".matchup__center")!;
          const measurement = center.querySelector(".matchup__line--measure")!;
          return {
            compact: element.getAttribute("data-compact"),
            fullFits:
              measurement.getBoundingClientRect().width <= center.clientWidth,
            width: element.getBoundingClientRect().width,
            available: center.clientWidth,
          };
        })
      );
    for (const item of fits) {
      expect(item.width).toBeLessThanOrEqual(item.available + 1);
      if (!item.fullFits) expect(item.compact).toBe("true");
    }
    await expect(cards(page).locator(".market-table__basis")).toHaveCount(0);
    await page.screenshot({ path: `${output}/feed-${width}.png` });
    await page.emulateMedia({ reducedMotion: "reduce", colorScheme: "light" });
    await page.goto(`${route}?theme=light`);
    await expect(cards(page)).toHaveCount(68);
    await overflow(page);
    expect(
      await cards(page).first().locator(".projection-card__live-dot").count()
    ).toBe(0);
    if (width === 375)
      await page.screenshot({ path: `${output}/feed-light-${width}.png` });
  });
}
