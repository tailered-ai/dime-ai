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
  await page.route("**/api/trpc/**", route => {
    const url = new URL(route.request().url());
    const operations = decodeURIComponent(
      url.pathname.replace(/^.*\/api\/trpc\//, "")
    ).split(",");
    const input = JSON.parse(url.searchParams.get("input") ?? "{}");
    const body = operations.map((operation, index) => {
      let json: unknown = [];
      if (operation === "appUsers.me") json = user;
      if (operation === "games.list")
        json = input[index]?.json?.sport === "NCAAF" ? games : [];
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
const signed = (value: number | null) =>
  value == null ? "—" : value > 0 ? `+${value}` : `${value}`;
const sourceCard = (cards: Locator, source: (typeof SOURCES)[number]) =>
  cards.filter({
    has: cards
      .page()
      .locator(
        `[title="${ncaafSchoolName(source.away)} @ ${ncaafSchoolName(source.home)}"]`
      ),
  });
const output =
  "docs/audits/2026-09-05-ncaaf-market-layout-evidence/screenshots";
const chronologicalGames = [...games].sort((a, b) =>
  String(a.startTimeEst).localeCompare(String(b.startTimeEst))
);
async function noOverflow(page: Page) {
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)
  ).toBeLessThanOrEqual(1);
  const clippedTables = await page
    .locator(".market-table:visible")
    .evaluateAll(tables =>
      tables.flatMap(table => {
        const tableBox = table.getBoundingClientRect();
        return Array.from(table.querySelectorAll("tbody th, tbody td")).flatMap(
          cell => {
            const box = cell.getBoundingClientRect();
            return cell.scrollWidth > cell.clientWidth + 1 ||
              box.left < tableBox.left - 1 ||
              box.right > tableBox.right + 1
              ? [cell.textContent]
              : [];
          }
        );
      })
    );
  expect(clippedTables).toEqual([]);
}
async function checkMarket(
  page: Page,
  source: (typeof SOURCES)[number],
  market: "spread" | "total" | "ml"
) {
  const dialog = page.getByRole("dialog", { name: /model projections/i });
  const rows = dialog.locator(".market-table tbody tr");
  await expect(rows).toHaveCount(2);
  const book =
    market === "spread"
      ? [source.book.awaySpreadOdds, source.book.homeSpreadOdds]
      : market === "total"
        ? [source.book.overOdds, source.book.underOdds]
        : [source.book.awayML, source.book.homeML];
  if (source.away === "UCLA" && market !== "ml") book.fill("-110");
  const model =
    market === "spread"
      ? [source.model.awaySpreadOdds, source.model.homeSpreadOdds]
      : market === "total"
        ? [source.model.overOdds, source.model.underOdds]
        : [null, null];
  const bookLines =
    market === "spread"
      ? [signed(source.book.awaySpread), signed(source.book.homeSpread)]
      : market === "total"
        ? [String(source.book.total), String(source.book.total)]
        : [null, null];
  const differs =
    market === "spread"
      ? source.model.basis.awaySpread !== source.book.awaySpread ||
        source.model.basis.homeSpread !== source.book.homeSpread ||
        source.book.awaySpread == null ||
        source.book.homeSpread == null
      : market === "total"
        ? source.model.basis.total !== source.book.total ||
          source.book.total == null
        : false;
  for (let side = 0; side < 2; side++) {
    const row = rows.nth(side);
    await expect(row.locator("th")).toHaveText(
      market === "total"
        ? side === 0
          ? "Over"
          : "Under"
        : ncaafSchoolName(side === 0 ? source.away : source.home)
    );
    const bookCell = row.locator("td").nth(0);
    const modelCell = row.locator("td").nth(1);
    if (market === "ml") {
      await expect(bookCell).toHaveText(book[side] ?? "—");
      await expect(modelCell).toHaveText("—");
    } else {
      await expect(bookCell.locator(".market-table__line")).toHaveText(
        bookLines[side]!
      );
      await expect(bookCell.locator(".market-table__price")).toHaveText(
        `(${book[side] ?? "—"})`
      );
      await expect(modelCell.locator(".market-table__line")).toHaveText(
        bookLines[side]!
      );
      await expect(modelCell.locator(".market-table__price")).toHaveText(
        `(${!differs ? (model[side] ?? "—") : "—"})`
      );
      if (model[side] != null && differs)
        await expect(modelCell.locator(".market-table__basis")).toHaveText(
          "Pricing unavailable at this line"
        );
      else
        await expect(modelCell.locator(".market-table__basis")).toHaveCount(0);
    }
  }
  const implied = (price: string) => {
    const odds = Number(price);
    return odds < 0 ? -odds / (-odds + 100) : 100 / (odds + 100);
  };
  const edges = book.map((price, side) =>
    !differs && price != null && model[side] != null
      ? (implied(model[side]!) - implied(price)) * 100
      : 0
  );
  const edge = Math.max(0, ...edges);
  await expect(dialog.locator(".market-table tfoot")).toHaveText(
    edge > 0
      ? `EDGE ${edge < 0.1 ? "<0.1" : `+${edge.toFixed(1)}`}%`
      : market !== "ml" &&
          (differs ||
            book.some(price => price == null) ||
            model.some(price => price == null))
        ? "Comparison unavailable"
        : "NO EDGE"
  );
  if (differs || edge === 0) {
    await expect(dialog.locator(".market-table__row--signal")).toHaveCount(0);
  } else
    await expect(dialog.locator(".market-table__row--signal")).toHaveCount(1);
  await noOverflow(page);
}

const scenarios = [
  ...[375, 768, 817, 1024, 1440].flatMap(width =>
    (["dark", "light"] as const).map(theme => ({
      width,
      theme,
      fullAudit: false,
      reducedMotion: false,
    }))
  ),
  { width: 375, theme: "dark" as const, fullAudit: false, reducedMotion: true },
  {
    width: 1440,
    theme: "dark" as const,
    fullAudit: true,
    reducedMotion: false,
  },
];
for (const { width, theme, fullAudit, reducedMotion } of scenarios) {
  const scenario = `${width}-${theme}${reducedMotion ? "-reduced-motion" : ""}${fullAudit ? "-source-audit" : ""}`;
  test(`${fullAudit ? "source audit" : "layout"} ${scenario}: 68 NCAAF school names and honest market cells`, async ({
    page,
  }) => {
    test.setTimeout(180_000);
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await stub(page);
    await page.setViewportSize({ width, height: width === 375 ? 812 : 900 });
    await page.emulateMedia({
      colorScheme: theme,
      reducedMotion: reducedMotion ? "reduce" : "no-preference",
    });
    await page.addInitScript(theme => {
      localStorage.setItem("dime-theme", theme);
      localStorage.setItem("dime.sidebar.rail", "0");
    }, theme);
    await page.goto("/feed/model/09-05-2026");
    const cards = page.locator("#dmf-league-NCAAF article.projection-card");
    await expect(cards).toHaveCount(68);
    await expect(page.locator("article.projection-card")).toHaveCount(68);
    expect(
      await cards
        .locator(".matchup__line")
        .evaluateAll(elements =>
          elements.map(element => element.getAttribute("title"))
        )
    ).toEqual(
      chronologicalGames.map(
        game =>
          `${ncaafSchoolName(game.awayTeam)} @ ${ncaafSchoolName(game.homeTeam)}`
      )
    );
    for (const source of SOURCES) {
      const card = sourceCard(cards, source);
      await expect(card).toHaveCount(1);
      if (
        games.find(game => game.awayTeam === source.away)?.gameStatus ===
        "upcoming"
      )
        await expect(card.locator(".matchup__venue")).toHaveAttribute(
          "title",
          `Model: ${ncaafSchoolName(source.home)} ${signed(source.model.homeSpread)} · Total ${source.model.total}`
        );
      await expect(card).not.toContainText("No model projection published");
      await expect(card).not.toContainText(
        "Book/model comparison unavailable."
      );
    }
    const helmets = cards.locator(".team-logo-box--helmet");
    await expect(helmets).toHaveCount(136);
    const helmetLayout = await helmets.evaluateAll(elements =>
      elements.map(element => {
        const box = element.getBoundingClientRect();
        const center = element
          .closest(".matchup__grid")!
          .querySelector(".matchup__center")!
          .getBoundingClientRect();
        return {
          height: box.height,
          overlapsName: box.left < center.right && box.right > center.left,
        };
      })
    );
    const helmetHeight = await page.evaluate(
      () =>
        3.5 * parseFloat(getComputedStyle(document.documentElement).fontSize)
    );
    expect(
      helmetLayout.every(
        box => Math.abs(box.height - helmetHeight) < 0.1 && !box.overlapsName
      )
    ).toBe(true);
    const namesOverflow = await cards
      .locator(".matchup__line, .matchup__venue, .summary__pick")
      .evaluateAll(elements =>
        elements
          .filter(element => element.scrollWidth > element.clientWidth + 1)
          .map(element => element.textContent)
      );
    expect(namesOverflow).toEqual([]);
    const comparison = sourceCard(cards, SOURCES[0]);
    await comparison
      .getByRole("button", {
        name: "View next market: Total (2 of 2)",
        exact: true,
      })
      .click();
    await expect(
      comparison.locator('.summary__viewport[tabindex="0"]')
    ).toContainText("54.4");
    await expect(
      comparison.locator('.summary__viewport[tabindex="0"]')
    ).not.toContainText("at 50.5");
    const returnToSpread = comparison.getByRole("button", {
      name: "View next market: Spread (1 of 2)",
      exact: true,
    });
    await expect(returnToSpread).toBeFocused();
    if (theme === "light")
      expect(
        await returnToSpread.evaluate(
          element => getComputedStyle(element).color
        )
      ).not.toBe("rgb(255, 255, 255)");
    await returnToSpread.click();
    await expect(
      comparison.locator('.summary__viewport[tabindex="0"]')
    ).toContainText("Bryant");
    await expect(
      comparison.locator('.summary__viewport[tabindex="0"]')
    ).toContainText("+26.7");
    if (reducedMotion) {
      expect(
        await comparison
          .locator(".summary-carousel__track")
          .evaluate(element => getComputedStyle(element).scrollBehavior)
      ).toBe("auto");
      const nextTotal = comparison.getByRole("button", {
        name: "View next market: Total (2 of 2)",
        exact: true,
      });
      expect(
        await nextTotal.evaluate(
          element => getComputedStyle(element).transitionDuration
        )
      ).toBe("0s");
      await expect(nextTotal).toBeFocused();
    }
    const missingSpread = SOURCES.filter(
      source => source.book.awaySpread == null
    );
    expect(missingSpread).toHaveLength(4);
    for (const source of missingSpread)
      await expect(sourceCard(cards, source)).toHaveCount(1);
    await noOverflow(page);
    await page.evaluate(() => {
      for (const scroller of document.querySelectorAll(
        ".dc-shell-external-scroll, .dmf-scroll"
      )) {
        scroller.scrollTo({ top: 0, behavior: "instant" });
      }
      window.scrollTo({ top: 0, behavior: "instant" });
    });
    await page.screenshot({ path: `${output}/feed-${scenario}.png` });
    // The separate source audit walks all prices. Layout cases exercise the
    // owner's Miami example, a long-name positive edge and missing Book/model prices.
    const checked = fullAudit
      ? SOURCES
      : [
          SOURCES.find(source => source.away === "M-OH")!,
          SOURCES.find(source => source.away === "VMI")!,
          missingSpread[0],
        ];
    for (const [index, source] of checked.entries()) {
      const button = sourceCard(cards, source).getByRole("button", {
        name: "View full AI model projections",
      });
      await button.scrollIntoViewIfNeeded();
      await button.focus();
      await page.keyboard.press("Enter");
      const dialog = page.getByRole("dialog", { name: /model projections/i });
      await expect(dialog).toBeVisible();
      await checkMarket(page, source, "spread");
      if (index === 0)
        await page.screenshot({
          path: `${output}/model-basis-${scenario}.png`,
        });
      await dialog
        .getByRole("link", {
          name: "Show Total projections, page 2 of",
          exact: false,
        })
        .click();
      await checkMarket(page, source, "total");
      if (source.book.awayML != null || source.book.homeML != null) {
        await dialog
          .getByRole("link", { name: /Show Moneyline projections, page 3 of/i })
          .click();
        await checkMarket(page, source, "ml");
      }
      await page.keyboard.press("Escape");
      await expect(button).toBeFocused();
    }
    if (!fullAudit) {
      expect(errors).toEqual([]);
      return;
    }
    await page.goto("/betting-splits/ncaaf-09-05-2026");
    await expect(page.locator('[id^="game-card-"]')).toHaveCount(68, {
      timeout: 20_000,
    });
    expect(
      await page
        .locator('[id^="game-card-"]')
        .evaluateAll(elements => elements.map(element => element.id))
    ).toEqual(chronologicalGames.map(game => `game-card-${game.id}`));
    await expect(page.locator(".bs-header")).toContainText("VSiN DK");
    const first = page.locator(`#game-card-${games[0].id}`);
    if (width >= 768) {
      for (const [index, source] of SOURCES.entries()) {
        const card = page.locator(`#game-card-${games[index].id}`);
        await expect(card).toHaveCount(1);
        const columns = card.locator("[data-market-col]:visible");
        await expect(columns).toHaveCount(3);
        if (source.book.awaySpread != null)
          await expect(columns.nth(0)).toContainText(
            `${ncaafSchoolName(source.away)} (${signed(source.book.awaySpread)}) (${source.book.awaySpreadOdds})`
          );
        await expect(columns.nth(1)).toContainText(
          `OVER ${source.book.total} (${source.book.overOdds})`
        );
        await expect(columns.nth(1)).toContainText(
          `UNDER ${source.book.total} (${source.book.underOdds})`
        );
      }
    } else {
      await expect(first).toContainText(`Bryant (+37.5) (-108)`);
      await first.getByRole("button", { name: "TOTAL", exact: true }).click();
      await expect(first).toContainText(`OVER 51.5 (-110)`);
      await first.getByRole("button", { name: "SPREAD", exact: true }).click();
    }
    await noOverflow(page);
    await page.screenshot({ path: `${output}/splits-${scenario}.png` });
    await first.getByRole("button", { name: /ODDS.*SPLITS HISTORY/i }).click();
    await expect(
      first.getByText("AN DK", { exact: true }).first()
    ).toBeVisible();
    await expect(
      first.getByText("VSiN DK", { exact: true }).first()
    ).toBeVisible();
    const rounded = first
      .locator("tr")
      .filter({ hasText: "VSiN DK" })
      .filter({ hasText: "13%" })
      .filter({ hasText: "88%" });
    await expect(rounded.first()).toBeVisible();
    await rounded.first().scrollIntoViewIfNeeded();
    await noOverflow(page);
    await page.screenshot({ path: `${output}/history-${scenario}.png` });
    expect(errors).toEqual([]);
  });
}
