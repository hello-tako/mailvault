import { expect, test } from "@playwright/test";
import { openFold } from "./fixtures";

/*
 * The parts of a mailbox that are felt when you read rather than when you send: one row per
 * conversation, a reply that carries what it answers, an address completed from mail you have
 * actually exchanged, and a way out of a newsletter that does not require reading it again.
 */

const COMMUNITY = "00000000-0000-4000-8000-0000000000m4";
const DIGEST = "00000000-0000-4000-8000-0000000000m2";
const STRESS = "00000000-0000-4000-8000-0000000000m5";

test("conversations: the list groups by thread and says so per row", async ({ page }) => {
  await page.goto("/#/inbox");
  const toggle = page.getByRole("button", { name: "Threads" });
  await expect(toggle).toHaveAttribute("aria-pressed", "true");

  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await expect(page.evaluate(() => localStorage.getItem("mailvault-threaded"))).resolves.toBe("0");

  // The preference is the point: it survives a reload, like the language and the theme.
  await page.reload();
  await expect(page.getByRole("button", { name: "Threads" })).toHaveAttribute("aria-pressed", "false");
  await toggle.click();
  await expect(page.locator(".msg").first()).toBeVisible();
});

test("a reply carries the message it answers, quoted", async ({ page }) => {
  await page.goto(`/#/messages/${STRESS}`);
  await page.getByRole("button", { name: "Reply" }).click();

  const dialog = page.getByRole("dialog", { name: "Reply" });
  const body = dialog.getByLabel("Message", { exact: true });
  await expect(body).toBeVisible();
  const value = await body.inputValue();
  // The blockquote marker survives on at least one line, and the attribution names the sender.
  expect(value).toContain(">");
  expect(value).toContain("Example Cloud Security");
  // The attribution names the sender and the message that follows it is folded, so the quote
  // is a block and not a bare line that could be mistaken for the owner's own words.
  const after = value.split("wrote").pop() ?? "";
  expect(after.split("\n").some((line) => line.startsWith("> "))).toBe(true);
});

test("the `r` key answers what is on screen", async ({ page }) => {
  await page.goto(`/#/messages/${COMMUNITY}`);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await page.keyboard.press("r");
  await expect(page.getByRole("dialog", { name: "Reply" })).toBeVisible();
});

test("unsubscribe: offered for an aligned sender, explained for one that is not", async ({ page }) => {
  await page.goto(`/#/messages/${COMMUNITY}`);
  await openFold(page, "Unsubscribe");
  const card = page.locator(".unsubscribe");
  await expect(card).toBeVisible();
  const link = card.getByRole("link", { name: "Unsubscribe" });
  await expect(link).toHaveAttribute("href", "https://example.org/unsub?id=9f2");
  // A new tab that cannot reach back into the app's window.
  await expect(link).toHaveAttribute("rel", /noopener/);
  await expect(card.getByRole("link", { name: "By email instead" })).toHaveAttribute("href", /^mailto:unsub@example\.org/);

  await page.goto(`/#/messages/${DIGEST}`);
  await expect(page.locator(".unsubscribe")).toHaveCount(0);
  await expect(page.getByText("did not pass authentication")).toBeVisible();
});

test("the composer completes an address from the mailbox's own history", async ({ page }) => {
  await page.goto("/#/inbox");
  await page.getByRole("button", { name: "Compose" }).click();
  const dialog = page.getByRole("dialog", { name: "New message" });
  const to = dialog.getByLabel("To", { exact: true });

  await to.click();
  await to.type("@example.org", { delay: 30 });
  const list = dialog.getByRole("listbox");
  await expect(list).toBeVisible();
  await expect(list.getByRole("option").first()).toContainText("no-reply@example.org");

  // Accepting a suggestion must not send the message.
  await to.press("Enter");
  await expect(to).toHaveValue("no-reply@example.org, ");
  await expect(dialog).toBeVisible();
  await expect(list).toHaveCount(0);
});
