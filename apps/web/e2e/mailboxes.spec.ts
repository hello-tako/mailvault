import { expect, test } from "@playwright/test";
import { resetSeededMail } from "./fixtures";

/*
 * One domain, one mailbox. Mail for several domains used to land in one undifferentiated
 * list, so "where is my code" meant reading every row. These assert the contract rather
 * than a realistic count: the dashboard names the mailbox that has mail, and the inbox can
 * be narrowed to it and back.
 */
test("dashboard presents the domain with mail as its own mailbox", async ({ page }) => {
  await page.goto("/#/");
  await resetSeededMail(page);
  await page.reload();

  const card = page.locator(".mailbox").filter({ hasText: "demo.example" });
  await expect(card).toBeVisible();
  await expect(card).toContainText("5 messages");
  await expect(card.getByText("2 unread")).toBeVisible();

  await card.click();
  await expect(page).toHaveURL(/#\/inbox\?domain=/);
  await expect(page.getByRole("heading", { name: "Inbox" })).toBeVisible();
  await expect(page.locator(".msg")).toHaveCount(5);
  // Inside one mailbox the domain is what was filtered on, so the rows stop repeating it.
  await expect(page.locator(".msg-alias").first()).toHaveText("GitHub (demo)");
});

test("the rail narrows the inbox to one mailbox and back", async ({ page }) => {
  await page.goto("/#/inbox");
  const rail = page.locator(".rail-mailboxes");
  // A mailbox is a place, so it is offered where places are chosen — not beside the search
  // box, where it read as one more filter over the same list.
  await expect(rail.getByRole("button", { name: /^All mailboxes/ })).toHaveCount(1);
  await expect(page.locator(".msg-alias").first()).toContainText("demo.example");

  await rail.getByRole("button", { name: /demo\.example/ }).click();
  await expect(page).toHaveURL(/#\/inbox\?domain=/);
  await expect(page.locator(".msg")).toHaveCount(5);
  await expect(page.locator(".msg-alias").first()).toHaveText("GitHub (demo)");
  await expect(rail.getByRole("button", { name: /demo\.example/ })).toHaveClass(/active/);

  await rail.getByRole("button", { name: /^All mailboxes/ }).click();
  await expect(page).toHaveURL(/#\/inbox$/);
  await expect(page.locator(".msg-alias").first()).toContainText("demo.example");
});

test("phone: an open tab reaches the live hub and refetches when nudged @mobile", async ({ page }) => {
  const sockets: string[] = [];
  page.on("websocket", (ws) => sockets.push(ws.url()));

  await page.goto("/#/inbox");
  await expect
    .poll(() => sockets.filter((u) => u.endsWith("/api/live")).length, "the app should hold one socket to the hub")
    .toBeGreaterThan(0);

  /*
   * A recorded socket attempt is not a connection — the first version of this test passed
   * while the handshake was failing, because the browser logs the attempt either way. So
   * complete a real handshake from the page and wait for the hub's first frame.
   */
  const handshake = await page.evaluate(
    () =>
      new Promise<{ opened: boolean; first: string | null }>((resolve) => {
        const proto = location.protocol === "https:" ? "wss:" : "ws:";
        const ws = new WebSocket(`${proto}//${location.host}/api/live`);
        const done = (opened: boolean, first: string | null) => {
          try {
            ws.close();
          } catch {
            /* already gone */
          }
          resolve({ opened, first });
        };
        ws.onopen = () => {};
        ws.onmessage = (ev) => done(true, String(ev.data));
        ws.onerror = () => done(false, null);
        setTimeout(() => done(false, null), 5000);
      }),
  );
  expect(handshake.opened, "the hub must accept an authenticated upgrade").toBe(true);
  expect(JSON.parse(handshake.first ?? "{}").type).toBe("hello");

  // The nudge carries no data, so the visible effect is a refetch through the normal
  // authenticated route — the same one the Refresh button uses.
  const refetch = page.waitForResponse((r) => r.url().includes("/api/messages"));
  await page.evaluate(() => window.dispatchEvent(new Event("mailvault:new-mail")));
  await refetch;
  await expect(page.locator(".msg")).toHaveCount(5);
});

test("phone: the filters share two lines so mail starts near the top @mobile", async ({ page }) => {
  await page.goto("/#/inbox");
  const top = await page.locator(".msg").first().boundingBox();
  const tabs = await page.locator(".toolbar .tabs").boundingBox();
  const picker = await page.locator(".mailbox-select").boundingBox();
  expect(top && tabs && picker, "list and filters must be measurable").toBeTruthy();
  // The mailbox picker shares a line with the unread tabs (their boxes overlap
  // vertically), rather than stacking a third row of controls above the mail.
  expect(picker!.y, "picker starts below the tabs' line").toBeLessThan(tabs!.y + tabs!.height);
  expect(picker!.y + picker!.height, "picker ends above the tabs' line").toBeGreaterThan(tabs!.y);
  // Measured at 206px: a title line, one line of tabs and the picker, one line of search.
  // An extra wrapped line of filters costs ~52px of mail, which is what this bound is for.
  expect(Math.round(top!.y)).toBeLessThan(240);
  await page.screenshot({ path: "e2e-screens/inbox-mailbox.png", fullPage: true });
});
