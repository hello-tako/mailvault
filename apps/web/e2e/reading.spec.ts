import { expect, test } from "@playwright/test";
import { openFold } from "./fixtures";

/*
 * What the reading view puts where. The redesign's promise is that a message is read before it
 * is audited: the body and any code it holds come first, and the panels that explain the mail —
 * where its links go, how the sender was checked, how a send was delivered — fold, and are the
 * owner's choice to start open.
 *
 * These are geometry contracts on purpose. A panel moved above the body still renders, still
 * passes a "is it visible" test, and quietly breaks the only reason the screen has an order.
 */
const CODED = "00000000-0000-4000-8000-0000000000m1";
const STRESS = "00000000-0000-4000-8000-0000000000m5";

test("a message opens on its body, with the code above it and the links folded", async ({ page }) => {
  await page.goto(`/#/messages/${STRESS}`);
  const body = await page.locator("iframe.email-frame").boundingBox();
  const links = await page.locator(".fold > summary", { hasText: "Verification links" }).boundingBox();
  expect(body && links, "body and links panel must be measurable").toBeTruthy();
  expect(body!.y, "the message itself comes before what explains it").toBeLessThan(links!.y);

  await expect(page.locator(".link-card").first()).toBeHidden();
  await openFold(page, "Verification links");
  await expect(page.locator(".link-card")).toHaveCount(4);
});

test("a code is never folded and never below the body", async ({ page }) => {
  // This seeded message has no stored body at all — the point is that the code still arrives
  // above whatever stands in for the body, and that the empty body says so instead of
  // painting a blank frame.
  await page.goto(`/#/messages/${CODED}`);
  const code = await page.locator(".code-card").boundingBox();
  const body = await page.locator(".mail-body").boundingBox();
  expect(code && body, "code and body must be measurable").toBeTruthy();
  expect(code!.y, "the code is above the body it belongs to").toBeLessThan(body!.y);
  await expect(page.locator(".code-card .code")).toContainText("55905149");
  await expect(page.getByText("This message has no readable body")).toBeVisible();
});

test("Settings decides whether the detail panels start open", async ({ page }) => {
  const group = page.getByRole("group", { name: "Message details" });
  await page.goto("/#/settings");
  await group.getByRole("button", { name: "Keep them open" }).click();

  await page.goto(`/#/messages/${STRESS}`);
  await expect(page.locator(".link-card")).toHaveCount(4);
});
