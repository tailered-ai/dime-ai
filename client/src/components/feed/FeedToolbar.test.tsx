import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { build } from "esbuild";
import { chromium, type Browser, type Page } from "playwright";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const project = path.resolve(import.meta.dirname, "../../../..");
let browser: Browser;
let javascript: string;
let stylesheet: string;

beforeAll(async () => {
  // Exercise real Radix, cmdk and DayPicker focus/keyboard behavior in Chromium.
  const bundle = await build({
    stdin: {
      contents: `
        import { useState } from "react";
        import { createRoot } from "react-dom/client";
        import { FeedToolbar } from "./client/src/components/feed/FeedToolbar";
        function Fixture() {
          const [props, setProps] = useState({
            date: "2026-09-05", today: "2026-09-05",
            filters: { status: "all", league: "all", conference: "all", game: "all" },
            leagueOptions: [{ value: "NCAAF", label: "College Football (NCAAF)" }, { value: "MLB", label: "Major League Baseball (MLB)" }],
            conferenceOptions: [{ value: "Big Ten Conference", label: "Big Ten Conference" }],
            gameOptions: [{ value: "wisconsin", label: "Notre Dame @ Wisconsin" }, { value: "clemson", label: "LSU @ Clemson" }],
            visibleCount: 2, totalCount: 2,
          });
          window.patchToolbar = patch => setProps(previous => ({ ...previous, ...patch }));
          window.toolbarState = props;
          return <FeedToolbar {...props}
            onDateChange={date => setProps(previous => ({ ...previous, date }))}
            onFiltersChange={filters => setProps(previous => ({ ...previous, filters }))} />;
        }
        createRoot(document.getElementById("root")).render(<Fixture />);
      `,
      resolveDir: project,
      loader: "tsx",
    },
    alias: {
      "@": path.join(project, "client/src"),
      "@shared": path.join(project, "shared"),
    },
    bundle: true,
    write: false,
    outfile: "toolbar.js",
    jsx: "automatic",
    define: { "process.env.NODE_ENV": '"production"' },
  });
  javascript = bundle.outputFiles!.find(file =>
    file.path.endsWith(".js")
  )!.text;
  stylesheet =
    readFileSync(path.join(project, "client/src/index.css"), "utf8") +
    "\n" +
    bundle.outputFiles!.find(file => file.path.endsWith(".css"))!.text +
    "\n" +
    readFileSync(
      path.join(project, "client/src/pages/dimeModelFeed.css"),
      "utf8"
    );
  browser = await chromium.launch({
    headless: true,
    channel: existsSync(chromium.executablePath()) ? "chromium" : "chrome",
  });
}, 30_000);

afterAll(async () => {
  await browser?.close();
});

async function mount(timezoneId = "America/Los_Angeles", width = 1024) {
  const page = await browser.newPage({
    timezoneId,
    viewport: { width, height: 900 },
  });
  page.setDefaultTimeout(5_000);
  await page.setContent(
    '<html class="dark"><head></head><body style="margin:0"><main class="dmf-root" data-dmf-theme="dark" id="root" style="padding:16px"></main></body></html>'
  );
  await page.addStyleTag({ content: stylesheet });
  await page.addScriptTag({ content: javascript });
  await page.getByRole("region", { name: "Feed controls" }).waitFor();
  return page;
}

async function patch(page: Page, props: Record<string, unknown>) {
  await page.evaluate(value => (window as any).patchToolbar(value), props);
  await page.waitForFunction(
    value =>
      Object.entries(value).every(
        ([key, expected]) =>
          JSON.stringify((window as any).toolbarState[key]) ===
          JSON.stringify(expected)
      ),
    props
  );
}

async function state(page: Page) {
  return page.evaluate(() => (window as any).toolbarState);
}

describe("FeedToolbar", () => {
  it("composes all filters, searches games with the keyboard and restores focus on Escape", async () => {
    const page = await mount();
    try {
      const status = page.getByLabel("Status", { exact: true });
      expect(await status.locator("option").allTextContents()).toEqual([
        "All statuses",
        "Scheduled",
        "Live",
        "Final",
        "Postponed",
        "Suspended",
      ]);
      await status.selectOption("suspended");
      await page
        .getByLabel("Sport / league", { exact: true })
        .selectOption("NCAAF");
      await page
        .getByLabel("Conference", { exact: true })
        .selectOption("Big Ten Conference");
      const game = page.getByRole("button", { name: "Game All games" });
      await game.focus();
      await page.keyboard.press("Enter");
      const search = page.getByRole("combobox", { name: "Search games" });
      await search.fill("Wisconsin");
      await page
        .getByRole("option", { name: "Notre Dame @ Wisconsin" })
        .waitFor();
      await page.keyboard.press("Enter");
      expect((await state(page)).filters).toEqual({
        status: "suspended",
        league: "NCAAF",
        conference: "Big Ten Conference",
        game: "wisconsin",
      });
      const selected = page.getByRole("button", {
        name: "Game Notre Dame @ Wisconsin",
      });
      await selected.click();
      await patch(page, { loading: true });
      expect(await search.isDisabled()).toBe(true);
      await patch(page, { loading: false });
      await search.fill("no-such-team");
      await page.getByText("No games match your search.").waitFor();
      await page.keyboard.press("Escape");
      await page.waitForFunction(() =>
        document.activeElement?.textContent?.includes("Notre Dame @ Wisconsin")
      );
      expect(await selected.getAttribute("aria-expanded")).toBe("false");
      await selected.click();
      await page
        .getByRole("option", { name: "All games", exact: true })
        .click();
      expect((await state(page)).filters.game).toBe("all");
    } finally {
      await page.close();
    }
  });

  it.each(["America/Los_Angeles", "Pacific/Kiritimati"])(
    "selects literal calendar dates without shifts in %s",
    async timezone => {
      const page = await mount(timezone);
      try {
        await page
          .getByRole("button", { name: "Choose date, Sat, Sep 5, 2026" })
          .click();
        await page.waitForFunction(() =>
          document.activeElement?.classList.contains("rdp-day_button")
        );
        await page.keyboard.press("ArrowRight");
        await page.keyboard.press("Enter");
        await page
          .getByRole("button", { name: "Choose date, Sun, Sep 6, 2026" })
          .waitFor();
        expect((await state(page)).date).toBe("2026-09-06");
        await page.waitForFunction(
          () =>
            document.activeElement?.getAttribute("aria-label") ===
            "Choose date, Sun, Sep 6, 2026"
        );
        await patch(page, { date: "2028-02-28" });
        await page.getByRole("button", { name: "Next day" }).click();
        expect((await state(page)).date).toBe("2028-02-29");
        await page.getByRole("button", { name: "Next day" }).click();
        expect((await state(page)).date).toBe("2028-03-01");
        await patch(page, { date: "2026-03-08" });
        await page.getByRole("button", { name: "Previous day" }).click();
        expect((await state(page)).date).toBe("2026-03-07");
        await page.getByRole("button", { name: "Today", exact: true }).click();
        expect((await state(page)).date).toBe("2026-09-05");
        expect(
          await page
            .getByRole("button", { name: "Today", exact: true })
            .isDisabled()
        ).toBe(true);
      } finally {
        await page.close();
      }
    }
  );

  it("handles unavailable options, loading, malformed dates and date boundaries", async () => {
    const page = await mount();
    try {
      await patch(page, {
        leagueOptions: [],
        conferenceOptions: [],
        gameOptions: [],
        totalCount: 0,
        visibleCount: 0,
      });
      expect(
        await page.getByLabel("Sport / league", { exact: true }).isDisabled()
      ).toBe(true);
      expect(
        await page.getByLabel("Conference", { exact: true }).isDisabled()
      ).toBe(true);
      expect(
        await page
          .getByRole("button", { name: "Game No games available" })
          .isDisabled()
      ).toBe(true);
      await page.getByRole("button", { name: /Choose date/ }).click();
      await patch(page, { loading: true });
      await page.getByText("Loading games…").waitFor();
      expect(
        await page
          .locator(".rdp-day_button")
          .evaluateAll(
            buttons =>
              buttons.length > 0 &&
              buttons.every(
                button =>
                  (button as HTMLButtonElement).disabled ||
                  button.getAttribute("aria-disabled") === "true"
              )
          )
      ).toBe(true);
      await page.keyboard.press("Escape");
      expect(
        await page.getByRole("button", { name: "Next day" }).isDisabled()
      ).toBe(true);
      expect(
        await page.getByLabel("Status", { exact: true }).isDisabled()
      ).toBe(true);
      await patch(page, { loading: false, date: "2026-02-31" });
      expect(
        await page.getByRole("button", { name: "Previous day" }).isDisabled()
      ).toBe(true);
      expect(
        await page.getByRole("button", { name: "Next day" }).isDisabled()
      ).toBe(true);
      await page.getByRole("button", { name: "Today", exact: true }).click();
      expect((await state(page)).date).toBe("2026-09-05");
      await patch(page, { date: "0001-01-01" });
      expect(
        await page.getByRole("button", { name: "Previous day" }).isDisabled()
      ).toBe(true);
      await patch(page, { date: "9999-12-31" });
      expect(
        await page.getByRole("button", { name: "Next day" }).isDisabled()
      ).toBe(true);
    } finally {
      await page.close();
    }
  });

  it("keeps controls and calendar inside mobile and desktop widths in both themes", async () => {
    const page = await mount();
    try {
      for (const width of [375, 768, 1024, 1440]) {
        await page.setViewportSize({ width, height: 900 });
        for (const theme of ["dark", "light"]) {
          await page.evaluate(value => {
            document.documentElement.classList.toggle("dark", value === "dark");
            document.getElementById("root")!.dataset.dmfTheme = value;
          }, theme);
          await page.getByRole("button", { name: /Choose date/ }).click();
          await page
            .getByRole("dialog", { name: "Choose feed date" })
            .waitFor();
          expect(
            await page.evaluate(
              () => document.documentElement.scrollWidth <= innerWidth
            )
          ).toBe(true);
          const calendar = await page
            .getByRole("dialog", { name: "Choose feed date" })
            .boundingBox();
          expect(calendar!.x).toBeGreaterThanOrEqual(0);
          expect(calendar!.width).toBeLessThanOrEqual(360);
          expect(calendar!.x + calendar!.width).toBeLessThanOrEqual(width);
          await page.keyboard.press("Escape");
        }
      }
      await page.emulateMedia({ reducedMotion: "reduce" });
      expect(
        await page
          .getByRole("button", { name: "Next day" })
          .evaluate(element => getComputedStyle(element).transitionDuration)
      ).toBe("0s");
    } finally {
      await page.close();
    }
  });
});
