import { expect, test, type Page } from "@playwright/test";
import { SEEDED_ALIAS, SEEDED_ALIAS_ADDRESS } from "./fixtures";

/*
 * The customer's half of the product, tested from a browser: the owner makes a link for one
 * address, hands it over, and a stranger sees a number and nothing else. Only the browser can
 * answer the question that matters here — what a buyer can actually reach — so this suite
 * follows the link itself rather than stopping at the API.
 *
 * The seeded mail is deliberately old, which is the state a buyer arrives in most often: the
 * page is open, the code has not landed yet, and it is still honest about that.
 */

const LINKS = `/api/aliases/${SEEDED_ALIAS}/portal-links`;

test.beforeEach(async ({ page }) => {
  await page.goto("/#/aliases");
  // A crashed run leaves its live link behind, and a leftover link would be counted by the
  // list this suite reads. Only active ones can be withdrawn; the dead ones are history.
  await page.evaluate(async (path) => {
    const list = await (await fetch(path)).json();
    for (const g of list.items ?? []) {
      if (!g.active) continue;
      await fetch(`${path}/${g.id}`, { method: "DELETE", headers: { "content-type": "application/json", "x-mailvault": "1" } });
    }
  }, LINKS);
});

async function openMintForm(page: Page) {
  await page.goto(`/#/aliases/${SEEDED_ALIAS}`);
  await expect(page.getByRole("heading", { name: "Code links" })).toBeVisible();
  await page.getByText("Create a link").click();
  return page.getByLabel("Note for this link").locator("xpath=ancestor::form");
}

test("makes a link, shows it once, then never shows its secret again", async ({ page }) => {
  const form = await openMintForm(page);
  // Local dev state survives between runs; a per-run note keeps this test from matching
  // the links earlier runs minted. CI resets D1 per run, where this stays unique too.
  const note = `order 77 ${Date.now()}`;
  await form.getByLabel("Note for this link").fill(note);
  await form.getByLabel("Looks allowed").fill("3");
  await form.getByRole("button", { name: "Create link" }).click();

  const dialog = page.getByRole("dialog", { name: "Copy this link now" });
  await expect(dialog).toBeVisible();
  const url = (await dialog.locator(".addr").textContent()) ?? "";
  const token = new URL(url).pathname.split("/c/")[1] ?? "";
  expect(token, "the link is the credential, so it has to be there").toMatch(/^[A-Za-z0-9_-]{16,64}$/);
  await dialog.getByLabel("Close").click();

  // The row knows how the link is doing; it cannot know the link.
  const row = page.locator(".entity").filter({ hasText: note });
  await expect(row.getByText("Live")).toBeVisible();
  await expect(row.getByText("0 of 3 looks used")).toBeVisible();

  const listed = await page.evaluate(async (path) => (await fetch(path)).json(), LINKS);
  expect(JSON.stringify(listed), "a list of links must not hand out one").not.toContain(token);

  await row.getByRole("button", { name: "Withdraw" }).click();
  await expect(row.getByText("Withdrawn")).toBeVisible();
});

test("the page a buyer opens waits for the code and gives nothing else", async ({ page, context }) => {
  const form = await openMintForm(page);
  await form.getByRole("button", { name: "Create link" }).click();
  const dialog = page.getByRole("dialog", { name: "Copy this link now" });
  const url = (await dialog.locator(".addr").textContent()) ?? "";
  await dialog.getByLabel("Close").click();

  const buyer = await context.newPage();
  await buyer.goto(url);
  // A buyer's page speaks Vietnamese unless the link says otherwise — the shop's customers do.
  await expect(buyer.getByText("Mã của bạn")).toBeVisible();
  await expect(buyer.getByText(/Đang chờ mã/)).toBeVisible();
  await expect(buyer.getByText(SEEDED_ALIAS_ADDRESS)).toBeVisible();
  await buyer.goto(`${url}?lang=en`);
  await expect(buyer.getByText("Your code")).toBeVisible();

  // What the mailbox holds but the link does not offer: the seeded code is 8 digits at 0.85
  // confidence and it is older than the window, so the answer has to be "not yet".
  const html = await buyer.content();
  expect(html).not.toContain("55905149");
  expect(html).not.toContain("Please enter your verification code");

  const answer = await buyer.evaluate(async (path) => {
    const res = await fetch(`${path}/code`);
    return { status: res.status, body: await res.json() };
  }, new URL(url).pathname);
  expect(answer).toEqual({
    status: 200,
    body: { state: "waiting", alias: SEEDED_ALIAS_ADDRESS, windowMinutes: 30 },
  });

  // A link nobody issued answers the same way as one the owner withdrew: no code, no subject,
  // no hint of what else the mailbox holds.
  const dead = await buyer.evaluate(async (origin) => {
    const res = await fetch(`${origin}/c/not-a-real-link-000000/code`);
    return { status: res.status, body: await res.json() };
  }, new URL(url).origin);
  expect(dead).toEqual({ status: 404, body: { state: "invalid" } });
});
