import { expect, test } from "@playwright/test";
import { resetSeededMail, SEEDED_UNREAD } from "./fixtures";

/*
 * These cover the interaction model rather than the pixels: one palette that reaches
 * anything, a code you can take without opening the mail that carried it, a message that
 * opens beside the list instead of replacing it, and a notice when something arrives while
 * you were looking elsewhere. Each one is the kind of thing that silently stops working
 * when someone moves a handler.
 */

test("command palette: finds a message and goes to it", async ({ page }) => {
  await page.goto("/#/settings");
  // Wait for the app to be mounted before pressing a key: the shortcut is a listener the
  // bundle installs, and a key typed into a page that has not started is simply lost.
  await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
  // "/" is the keyboard trigger. Chromium keeps Ctrl/Cmd+K for its own address bar on
  // some platforms, so a page cannot treat it as the only way in.
  await page.keyboard.press("/");
  const dialog = page.getByRole("dialog", { name: "Search and commands" });
  await expect(dialog).toBeVisible();
  // Idle state is navigation and actions, not an empty box.
  await expect(dialog.getByRole("option").first()).toBeVisible();

  await page.keyboard.type("verification");
  const options = dialog.getByRole("option");
  await expect.poll(async () => await options.count(), { timeout: 8000 }).toBeGreaterThan(0);

  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/#\/messages\//);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
});

test("command palette: runs a domain action and leaves no marker behind", async ({ page }) => {
  await page.goto("/#/settings");
  await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
  await page.keyboard.press("/");
  await page.keyboard.type("sync from");
  await expect(page.getByRole("option", { name: /Sync from Cloudflare/ })).toBeVisible();
  await page.keyboard.press("Enter");

  await expect(page).toHaveURL(/#\/domains$/);
  // The action ran: the screen answered the sync with what it got back — with no Cloudflare
  // credential in this environment, that answer is the token warning, and it is still proof
  // the request was made. The standing "Synced from Cloudflare" label the page used to carry
  // was visible whether or not anything had synced.
  await expect(page.locator(".banner")).toBeVisible();
  // The `run` marker is replaced out of the URL, so a reload does not call Cloudflare again.
  expect(page.url()).not.toContain("run=");
});

test("command palette: Escape closes without navigating", async ({ page }) => {
  await page.goto("/#/inbox");
  await page.locator(".rail-search").click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page).toHaveURL(/#\/inbox/);
});

test("phone: the code in a row copies without opening the message @mobile", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto("/#/inbox");
  await resetSeededMail(page);
  await page.reload();

  const row = page.locator(".msg", { hasText: "verification code" });
  const chip = row.locator(".msg-code");
  await expect(chip).toContainText("55905149");

  await chip.click();
  await expect(chip).toHaveClass(/is-copied/);
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("55905149");
  // The row is a link; copying must not also navigate.
  await expect(page).toHaveURL(/#\/inbox/);
});

test("phone: a forged code is still not offered for copying @mobile", async ({ page }) => {
  await page.goto("/#/inbox");
  await resetSeededMail(page);
  await page.reload();
  const spoofed = page.locator(".msg", { hasText: "Urgent" });
  await expect(spoofed.locator(".msg-code")).toHaveCount(0);
  await expect(spoofed.getByText("unverified sender")).toBeVisible();
});

test("desktop: a message opens beside the list, and the list survives", async ({ page }) => {
  await page.goto("/#/inbox");
  await resetSeededMail(page);
  await page.reload();
  await expect(page.locator(".msg")).toHaveCount(5);

  await page.locator(".msg").first().locator(".msg-link").click();
  const pane = page.locator(".mail-pane");
  await expect(pane).toBeVisible();
  // The point of the pane: you are still looking at the list you were reading.
  await expect(page.locator(".msglist .msg")).toHaveCount(5);
  await expect(page.locator(".msg.is-active")).toHaveCount(1);
  expect(page.url()).toContain("open=");
  await expect(pane.locator(".msg, .backlink")).toHaveCount(0);

  // j walks to the next unread without leaving the list.
  const first = page.url();
  await page.keyboard.press("j");
  await expect.poll(() => page.url()).not.toBe(first);
  await expect(pane).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(page.locator(".mail-pane")).toHaveCount(0);
  expect(page.url()).not.toContain("open=");
});

test("a nudge says how much arrived, and nothing else", async ({ page }) => {
  await page.goto("/#/settings");
  await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();

  const setRead = async (id: string, isRead: boolean) => {
    await page.evaluate(
      async ([msgId, read]) => {
        const res = await fetch(`/api/messages/${msgId}/read`, {
          method: "PATCH",
          headers: { "content-type": "application/json", "x-mailvault": "1" },
          body: JSON.stringify({ isRead: read }),
        });
        if (!res.ok) throw new Error(`${res.status}`);
      },
      [id, isRead] as [string, boolean],
    );
  };
  const nudge = () => page.evaluate(() => window.dispatchEvent(new Event("mailvault:new-mail")));
  const target = SEEDED_UNREAD[0] as string;

  // Baseline is taken at mount; drive the unread count down and back up so the next nudge
  // has somewhere to come from.
  await setRead(target, true);
  await nudge();
  await setRead(target, false);
  await nudge();

  const toast = page.getByRole("status").filter({ hasText: /new message/ });
  await expect(toast).toBeVisible();
  // Count only. The socket carries no content and neither does the notice.
  const text = await toast.innerText();
  expect(text).not.toMatch(/GitHub|verification|sign-in/i);

  await toast.getByRole("button", { name: "View" }).click();
  await expect(page).toHaveURL(/#\/inbox/);
});
