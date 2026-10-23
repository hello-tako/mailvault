import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { SEEDED_UNREAD } from "./fixtures";

/*
 * The Vietnamese build is the one a phone is most likely to show and the one most likely to
 * break a layout: "Đánh dấu chưa đọc" is longer than "Mark unread", and a word like
 * "tên miền" must not be forced onto three lines by a button that grew. These run at handset
 * width and check three things: the strings really are Vietnamese, nothing printed a raw
 * dictionary key instead, and nothing went wider than the screen.
 */

const SCREENS: Array<[string, string]> = [
  ["dashboard", "/#/"],
  ["inbox", "/#/inbox"],
  ["aliases", "/#/aliases"],
  ["domains", "/#/domains"],
  ["settings", "/#/settings"],
];

/** A key that reached the screen means a string was looked up that nobody defined. */
const LEAKED_KEY =
  /(?:^|[\s(—:,">])(?:nav|common|time|status|dash|inbox|msg|dom|cls|alias|aliases|lp|rule|reuse|set|push)\.[A-Za-z][A-Za-z0-9]*(?=$|[\s.,!?:;"')])/;

async function useLanguage(page: Page, lang: "vi" | "en") {
  // Only as a first-run seed: an init script runs again on reload, and a test that checks a
  // choice survived a reload cannot also keep forcing the choice it started from.
  await page.addInitScript(
    (value) => {
      if (!window.localStorage.getItem("mailvault-lang")) window.localStorage.setItem("mailvault-lang", value);
    },
    lang,
  );
}

async function fitsViewport(page: Page, where: string) {
  const { scrollWidth, clientWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(scrollWidth, `${where} must not overflow horizontally`).toBeLessThanOrEqual(clientWidth + 1);
}

test("phone: the screens speak Vietnamese and still fit @mobile", async ({ page }) => {
  await useLanguage(page, "vi");

  await page.goto("/#/");
  await expect(page.getByRole("heading", { level: 1, name: "Tổng quan", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Hộp thư", exact: true })).toBeVisible();

  for (const [name, path] of SCREENS) {
    await page.goto(path);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    const text = await page.locator(".page").innerText();
    expect(LEAKED_KEY.test(text), `${name}: a dictionary key was printed instead of a string`).toBe(false);
    await fitsViewport(page, `vi ${name}`);
    await page.screenshot({ path: `e2e-screens/vi-${name}.png` });
  }
});

/*
 * A tab strip that scrolls sideways without a scrollbar hides a filter the owner has no way
 * to know exists, and Vietnamese labels are the longest they get. Measure every tab.
 */
test("phone: no filter tab sits off the edge @mobile", async ({ page }) => {
  await useLanguage(page, "vi");
  await page.goto("/#/domains");
  await expect(page.locator(".toolbar .tabs button")).toHaveCount(5);

  const clipped = await page.evaluate(() => {
    const w = document.documentElement.clientWidth;
    return [...document.querySelectorAll<HTMLElement>(".toolbar .tabs button")]
      .map((b) => ({ label: b.textContent?.trim() ?? "", right: Math.round(b.getBoundingClientRect().right) }))
      .filter((b) => b.right > w + 1);
  });
  expect(clipped, "every filter is reachable without scrolling sideways").toEqual([]);
});

test("phone: a message view keeps its Vietnamese chrome @mobile", async ({ page }) => {
  await useLanguage(page, "vi");
  await page.goto(`/#/messages/${SEEDED_UNREAD[0]}`);
  await expect(page.getByRole("link", { name: "← Hộp thư" })).toBeVisible();
  await expect(page.getByRole("heading", { level: 2, name: "Nội dung", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Khác" }).click();
  await expect(page.getByRole("menuitem", { name: "Xoá", exact: true })).toBeVisible();
  await fitsViewport(page, "vi message");
});

/*
 * The switcher is the only way to leave the browser's language, so it has to change the
 * screen it sits on and survive a reload — the choice is stored, not remembered in memory.
 */
test("phone: switching back to English works and is remembered @mobile", async ({ page }) => {
  await useLanguage(page, "vi");
  await page.goto("/#/settings");
  await expect(page.getByRole("heading", { level: 1, name: "Cài đặt", exact: true })).toBeVisible();

  await page.getByRole("button", { name: "English", exact: true }).click();
  await expect(page.getByRole("link", { name: "Inbox", exact: true })).toBeVisible();

  await page.reload();
  await expect(page.getByRole("heading", { level: 1, name: "Settings", exact: true })).toBeVisible();
  const stored = await page.evaluate(() => window.localStorage.getItem("mailvault-lang"));
  expect(stored).toBe("en");

  const text = await page.locator(".page").innerText();
  expect(LEAKED_KEY.test(text), "an English screen printed a dictionary key").toBe(false);
  await fitsViewport(page, "en settings");
});
