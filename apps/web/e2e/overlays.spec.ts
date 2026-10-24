import { expect, test, type Page } from "@playwright/test";
import { resetSeededFlags, SEEDED_ALIAS_ADDRESS, SEEDED_MAILS } from "./fixtures";

/*
 * Why this file exists.
 *
 * A dialog that opens below the fold is not a bug in that dialog — it is a bug in every dialog at
 * once, and on a desktop window tall enough to hide it. `.page` animated a `transform`, and any
 * element with a transform becomes the containing block for `position: fixed` descendants: every
 * modal backdrop inside the view was therefore sized to the *document* (1115px) rather than the
 * screen (915px). The create-alias sheet landed at y=636 with its button at y=1054, off-screen and
 * untappable — the form had to be hunted for by scrolling the page, and the page did not scroll
 * far enough.
 *
 * So the checks below are the two properties that were broken, applied to every overlay rather
 * than the one that was reported: the sheet is positioned inside the screen, and the action you
 * opened it to perform is where a tap at its own centre actually lands.
 */

const VIEWS = ["/#/", "/#/inbox", "/#/aliases", "/#/domains", "/#/settings"];
const M1 = SEEDED_MAILS[0];
const M2 = SEEDED_MAILS[1];

/**
 * The invariant, stated in CSS rather than in screenshots: no element an overlay is nested inside
 * may create a containing block. `position: fixed` is what a backdrop is, and a transform, filter,
 * perspective, will-change or paint containment anywhere above it silently changes what "fixed"
 * is fixed to.
 */
test("@mobile no view creates a containing block for the overlays inside it", async ({ page }) => {
  for (const view of VIEWS) {
    await page.goto(view);
    await expect(page.locator(".page").first()).toBeVisible();
    const offenders = await page.evaluate(() => {
      const bad: string[] = [];
      for (const el of document.querySelectorAll("body, .app, .main, .page")) {
        const cs = getComputedStyle(el);
        const name = (el.className || el.tagName).toString();
        if (cs.transform !== "none") bad.push(`${name}: transform=${cs.transform}`);
        if (cs.filter !== "none") bad.push(`${name}: filter=${cs.filter}`);
        if (cs.perspective !== "none") bad.push(`${name}: perspective=${cs.perspective}`);
        if (cs.backdropFilter !== "none") bad.push(`${name}: backdrop-filter=${cs.backdropFilter}`);
        if (/transform/.test(cs.willChange)) bad.push(`${name}: will-change=${cs.willChange}`);
        if (/\b(paint|layout|strict|content)\b/.test(cs.contain)) bad.push(`${name}: contain=${cs.contain}`);
      }
      return bad;
    });
    expect(offenders, `containing block inside ${view}`).toEqual([]);
  }
});

/**
 * The box of an element once it has stopped moving.
 *
 * Sheets slide up from 24px below their resting place, so measuring the frame after it opens
 * reports a box that never exists when the animation ends. Waiting for two identical readings
 * beats guessing a duration, and it fails loudly rather than flakily if the element never settles.
 */
async function settledBox(target: ReturnType<Page["locator"]>) {
  let previous = await target.boundingBox();
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await new Promise((r) => setTimeout(r, 80));
    const current = await target.boundingBox();
    if (previous && current && Math.abs(previous.y - current.y) < 1 && Math.abs(previous.height - current.height) < 1) {
      return current;
    }
    previous = current;
  }
  throw new Error("the element never came to rest");
}

/**
 * Prove an open dialog can actually be used with a thumb: the sheet is on the screen, and its
 * primary action is the thing a tap at its centre would hit.
 */
async function expectDialogUsable(page: Page) {
  const viewport = page.viewportSize()!;
  const backdrop = page.locator(".modal-backdrop");
  await expect(backdrop).toBeVisible();

  const sheet = await settledBox(page.locator(".modal"));
  expect(Math.round(sheet!.y), "the sheet starts on the screen").toBeGreaterThanOrEqual(0);
  expect(sheet!.y + sheet!.height, "and ends on it too").toBeLessThanOrEqual(viewport.height + 1);
  // The backdrop covering exactly the viewport is the direct measure of the bug: a page-sized one
  // means it resolved against an ancestor, not the window.
  const cover = await backdrop.boundingBox();
  expect(Math.round(cover!.height)).toBeLessThanOrEqual(viewport.height + 1);

  const action = page.locator('.modal button.primary, .modal button.danger, .modal button[type="submit"]').last();
  await action.scrollIntoViewIfNeeded();
  const box = await settledBox(action);
  expect(box!.y + box!.height, "the action is inside the screen").toBeLessThanOrEqual(viewport.height + 1);
  const hit = await page.evaluate(({ x, y }) => {
    const el = document.elementFromPoint(x, y);
    return el ? `${el.tagName.toLowerCase()}:${el.className}` : "none";
  }, { x: box!.x + box!.width / 2, y: box!.y + box!.height / 2 });
  expect(hit, "a tap at its centre lands on the action, not on what covers it").toContain("button");

  await page.keyboard.press("Escape");
  await expect(backdrop).toHaveCount(0);
}

test("@mobile the compose sheet is usable", async ({ page }) => {
  await page.goto("/#/inbox");
  await expect(page.locator(".msg").first()).toBeVisible();
  await page.getByRole("button", { name: "Compose" }).click();
  await expectDialogUsable(page);
});

test("@mobile the create-alias sheet is usable", async ({ page }) => {
  await page.goto("/#/aliases");
  await page.getByRole("button", { name: "+ Create alias" }).click();
  await expectDialogUsable(page);
});

test("@mobile the alias delete confirmation is usable", async ({ page }) => {
  await page.goto("/#/aliases");
  const row = page.locator(".entity").filter({ hasText: SEEDED_ALIAS_ADDRESS });
  await row.locator(".entity-summary").click();
  await row.getByRole("button", { name: "More" }).click();
  await row.getByRole("menuitem", { name: "Delete" }).click();
  await expectDialogUsable(page);
  // Cancelled, not confirmed: the seeded alias is another suite's subject.
  await expect(row).toHaveCount(1);
});

test("@mobile the message delete confirmation is usable", async ({ page }) => {
  await page.goto(`/#/messages/${M1}`);
  // Delete sits in the row's More menu now, so the confirmation is reached the way the owner
  // reaches it — and the menu is a popover, which is part of what this suite measures.
  await page.getByRole("button", { name: "More" }).click();
  await page.getByRole("menuitem", { name: "Delete" }).click();
  await expectDialogUsable(page);
});

test("@mobile a selection's bulk bar and its confirmation are both within reach", async ({ page }) => {
  await page.goto("/#/inbox");
  await expect(page.locator(".msg").first()).toBeVisible();
  await resetSeededFlags(page, []);
  await page.reload();
  await page.locator(`[data-msg-id="${M1}"] input[type="checkbox"]`).check();
  await page.locator(`[data-msg-id="${M2}"] input[type="checkbox"]`).check();

  const viewport = page.viewportSize()!;
  const bar = page.locator(".bulkbar");
  await expect(bar).toBeVisible();
  const box = await settledBox(bar);
  // The bar is `position: fixed` inside the view, so it broke exactly like the dialogs did.
  expect(box!.y + box!.height, "the bulk bar is on the screen").toBeLessThanOrEqual(viewport.height + 1);

  await bar.getByRole("button", { name: "Delete" }).click();
  await expectDialogUsable(page);
});
