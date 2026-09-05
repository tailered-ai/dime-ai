import { test, expect, type Page } from "@playwright/test";
import {
  NCAAF_SEPTEMBER4,
  ncaafSeptember4Record,
  presentNcaafSeptember4,
} from "../shared/ncaafSeptember4";
import {
  NCAAF_DK_SOURCES,
  presentNcaafDk,
  ncaafDkHistoryRecord,
  presentNcaafDkHistory,
} from "../shared/ncaafSeptember4Dk";

const names: Record<string, string> = {
  source_updated_at: "sourceUpdatedAt",
  provider_observed_at: "providerObservedAt",
  ingestion_pipeline_revision: "ingestionPipelineRevision",
};
const games = NCAAF_SEPTEMBER4.map((game, i) =>
  presentNcaafDk(
    presentNcaafSeptember4({
      ...Object.fromEntries(
        Object.entries(ncaafSeptember4Record(game)).map(([key, value]) => [
          names[key] ?? key,
          value,
        ])
      ),
      ...NCAAF_DK_SOURCES.find(source => source.event === game.event)!.splits,
      id: 4320001 + i,
      sport: "NCAAF",
      gameDate: "2026-09-04",
      awayTeam: game.away,
      homeTeam: game.home,
      gameStatus: "upcoming",
      publishedModel: true,
      publishedToFeed: true,
    })
  )
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
  await page.route("**/api/trpc/**", route => {
    const url = new URL(route.request().url());
    const ops = decodeURIComponent(
      url.pathname.replace(/^.*\/api\/trpc\//, "")
    ).split(",");
    const input = JSON.parse(url.searchParams.get("input") ?? "{}");
    const body = ops.map((op, i) => {
      let json: unknown = [];
      if (op === "appUsers.me") json = user;
      if (op === "games.list")
        json = input[i]?.json?.sport === "NCAAF" ? games : [];
      if (op === "games.getCurrentDate")
        json = {
          effectiveDate: "2026-09-04",
          utcHour: 23,
          isBeforeCutoff: false,
        };
      if (op === "games.getAvailableDates") json = { dates: ["2026-09-04"] };
      if (op === "games.lastRefresh")
        json = { refreshedAt: "2026-09-05T00:03:10Z" };
      if (op === "games.mlbLineups") json = {};
      if (op === "oddsHistory.listForGame") {
        const game = games.find(game => game.id === input[i]?.json?.gameId)!;
        const source = NCAAF_DK_SOURCES.find(
          source => source.away === game.awayTeam
        )!;
        json = {
          history: source.history
            .map((quote, j) => ({
              ...presentNcaafDkHistory(ncaafDkHistoryRecord(quote)),
              id: j + 1,
              gameId: game.id,
            }))
            .sort((a, b) => b.scrapedAt - a.scrapedAt),
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
const output = "docs/audits/2026-09-04-ncaaf-dk-polish-evidence/screenshots";
for (const width of [375, 768, 1024, 1440])
  for (const theme of ["dark", "light"] as const) {
    test(`${width} ${theme}: five cards, centered control, scaled sidebar and DK history`, async ({
      page,
    }) => {
      const errors: string[] = [];
      page.on("pageerror", error => errors.push(error.message));
      await stub(page);
      await page.setViewportSize({ width, height: width === 375 ? 812 : 900 });
      await page.emulateMedia({ colorScheme: theme });
      await page.addInitScript(theme => {
        localStorage.setItem("dime-theme", theme);
        localStorage.setItem("dime.sidebar.rail", "0");
      }, theme);
      await page.goto("/feed/model/09-04-2026");
      const cards = page.locator("#dmf-league-NCAAF article.projection-card");
      await expect(cards).toHaveCount(5);
      await expect(page.locator("article.projection-card")).toHaveCount(5);
      await expect(cards.nth(1)).toContainText("Model: MSU -7.36");
      await expect(cards.nth(1)).toContainText("+241");
      const contexts = cards.locator(".matchup__context");
      for (const text of await contexts.allTextContents())
        expect(text).toBe("NCAAF");
      const buttons = cards.locator(".projection-card__markets-toggle");
      const measurements = await buttons.evaluateAll(elements =>
        elements.map(el => {
          const box = el.getBoundingClientRect();
          const label = el.querySelector("span")!.getBoundingClientRect();
          return {
            offset: Math.abs(label.x + label.width / 2 - box.x - box.width / 2),
            height: box.height,
          };
        })
      );
      for (const measure of measurements) {
        expect(measure.offset).toBeLessThan(1);
        expect(measure.height).toBeGreaterThanOrEqual(44);
      }
      if (width >= 1024) {
        const sidebar = page.locator("aside.dc-sidebar");
        const box = (await sidebar.boundingBox())!;
        const clipped = await sidebar
          .locator(".dc-nav-group .dc-sidebar-text")
          .evaluateAll(labels =>
            labels
              .filter(label => label.scrollWidth > label.clientWidth + 1)
              .map(label => label.textContent)
          );
        expect(clipped).toEqual([]);
        const rem = await page.evaluate(() =>
          parseFloat(getComputedStyle(document.documentElement).fontSize)
        );
        expect(box.width).toBeGreaterThanOrEqual(17 * rem - 1);
        expect(box.width).toBeLessThanOrEqual(19 * rem + 1);
        await expect(
          page.getByRole("button", { name: "Collapse sidebar" })
        ).toBeVisible();
      }
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth - innerWidth
        )
      ).toBeLessThanOrEqual(1);
      await page.screenshot({
        path: `${output}/feed-${width}-${theme}.png`,
        fullPage: true,
      });
      await buttons.first().focus();
      await page.keyboard.press("Enter");
      await expect(
        page.getByRole("dialog", { name: /model projections/i })
      ).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(buttons.first()).toBeFocused();
      if (width >= 1024) {
        await page.getByRole("button", { name: "Collapse sidebar" }).click();
        await expect(
          page.getByRole("button", { name: "Expand sidebar" })
        ).toBeVisible();
        await page.getByRole("button", { name: "Expand sidebar" }).click();
        await page.locator(".dc-settings-trigger").click();
        const menu = page.locator(".dc-settings-menu.open");
        await expect(menu).toBeVisible();
        const bounds = (await menu.boundingBox())!;
        expect(bounds.x).toBeGreaterThanOrEqual(0);
        expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
        await page.keyboard.press("Escape");
      } else if (width === 768) {
        await page.getByRole("button", { name: "Menu", exact: true }).click();
        await expect(
          page.getByRole("dialog", { name: "Dime navigation" })
        ).toBeVisible();
        await page
          .getByRole("button", { name: "Close navigation", exact: true })
          .first()
          .click();
      }
      await page.goto("/betting-splits/ncaaf-09-04-2026");
      await expect(page.locator('[id^="game-card-"]')).toHaveCount(5);
      if (width < 768) {
        await page
          .locator("#game-card-4320001")
          .getByRole("button", { name: "TOTAL", exact: true })
          .click();
        await page
          .locator("#game-card-4320002")
          .getByRole("button", { name: "ML", exact: true })
          .click();
      }
      await expect(page.locator("#game-card-4320001")).toContainText("55.5");
      await expect(page.locator("#game-card-4320002")).toContainText("-395");
      await page.screenshot({
        path: `${output}/splits-${width}-${theme}.png`,
        fullPage: true,
      });
      const card = page.locator("#game-card-4320002");
      await card.getByRole("button", { name: /ODDS.*SPLITS HISTORY/i }).click();
      await expect(
        card.getByText("VSiN DK", { exact: true }).first()
      ).toBeVisible();
      const opening = card.locator("tr").filter({ hasText: "07/15" }).first();
      await expect(opening).toContainText("0%");
      await expect(opening).toContainText("100%");
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth - innerWidth
        )
      ).toBeLessThanOrEqual(1);
      await page.screenshot({
        path: `${output}/history-${width}-${theme}.png`,
        fullPage: true,
      });
      expect(errors).toEqual([]);
    });
  }

test("reduced motion keeps sidebar navigation usable", async ({ page }) => {
  await stub(page);
  await page.setViewportSize({ width: 1024, height: 768 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.addInitScript(() =>
    localStorage.setItem("dime.sidebar.rail", "0")
  );
  await page.goto("/feed/model/09-04-2026");
  await expect(
    page.getByRole("button", { name: "Collapse sidebar" })
  ).toBeVisible();
  expect(
    await page
      .locator("aside.dc-sidebar")
      .evaluate(el => getComputedStyle(el).transitionDuration)
  ).toBe("0s");
  await page.getByRole("button", { name: "Collapse sidebar" }).click();
  await expect(
    page.getByRole("button", { name: "Expand sidebar" })
  ).toBeVisible();
  await page.screenshot({ path: `${output}/reduced-motion.png` });
});
