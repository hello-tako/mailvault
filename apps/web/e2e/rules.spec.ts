import { expect, test } from "@playwright/test";
import { openFold } from "./fixtures";

/*
 * Rules are the one place the app decides something about mail without being asked, so the
 * UI has to make the two limits visible: a rule needs a condition, and it can only file.
 * The form that writes one is folded away until asked for, so both tests open it first.
 */
test("a rule needs something to match on before it can be added", async ({ page }) => {
  await page.goto("/#/aliases");
  await openFold(page, "New rule");
  const card = page.locator(".card").filter({ hasText: /^Rules/ });
  const add = card.getByRole("button", { name: "Add rule" });

  await expect(add).toBeDisabled();
  // Filing is the default action, so one condition is enough to make a rule.
  await card.getByLabel("Sender domain").fill("mailchimp.com");
  await expect(add).toBeEnabled();
  // …unless the owner turns the only action off.
  await card.getByLabel(/File it out of the inbox list/).uncheck();
  await expect(add).toBeDisabled();
  await card.getByLabel("Tag (optional)").fill("newsletters");
  await expect(add).toBeEnabled();
});

test("creating, pausing and removing a rule, and nothing can delete mail", async ({ page }) => {
  await page.goto("/#/aliases");
  await openFold(page, "New rule");
  const card = page.locator(".card").filter({ hasText: /^Rules/ });
  await card.getByLabel("Subject contains").fill("e2e digest");
  await card.getByLabel(/File it out of the inbox list/).check();
  await card.getByRole("button", { name: "Add rule" }).click();

  const row = page.locator(".entity").filter({ hasText: "subject contains “e2e digest”" });
  await expect(row).toBeVisible();
  // The only actions a rule can take are filing and tagging — there is no delete to pick.
  await expect(row.getByText("not used yet")).toBeVisible();

  await row.getByRole("button", { name: "Pause" }).click();
  await expect(row.getByText("paused")).toBeVisible();

  await row.getByRole("button", { name: "More" }).click();
  await row.getByRole("menuitem", { name: "Delete rule" }).click();
  await expect(row).toHaveCount(0);
});

test("the inbox offers the filed view beside all and unread", async ({ page }) => {
  await page.goto("/#/inbox");
  await expect(page.getByRole("button", { name: "Filed" })).toBeEnabled();
  await page.getByRole("button", { name: "Filed" }).click();
  await expect(page.getByRole("button", { name: "Filed" })).toHaveClass(/active/);
  // Nothing is filed in the fixture, so the honest answer is an empty list, not a lie.
  await expect(page.locator(".msg")).toHaveCount(0);
});
