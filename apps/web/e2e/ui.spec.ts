import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
import { openFold, resetSeededAlias, resetSeededMail, SEEDED_ALIAS_ADDRESS } from "./fixtures";

/*
 * Layout contract for the phone build. These assert the things that silently break a
 * mobile UI: content wider than the viewport, controls too small to hit, an input under
 * 16px (iOS zooms the whole page), a navigation bar that scrolls away, and — specific to
 * a mail client — a forged OTP being echoed where the owner would tap it.
 */

const SCREENS: Array<[string, string]> = [
  ["dashboard", "/#/"],
  ["inbox", "/#/inbox"],
  ["aliases", "/#/aliases"],
  ["domains", "/#/domains"],
  ["settings", "/#/settings"],
];

async function fitsViewport(page: Page, where: string) {
  const { scrollWidth, clientWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(scrollWidth, `${where} must not overflow horizontally`).toBeLessThanOrEqual(
    clientWidth + 1,
  );
}

/*
 * An absolutely-positioned popover inside a rounded card is the mobile failure that
 * reports success: the DOM is there, the CSS box has a size, and the owner sees nothing
 * because an ancestor clipped it, or because the fixed tab bar paints over it. So measure
 * the real box and hit-test its centre rather than trusting a visibility check. Assert the
 * panel's class first (web-first, retried) — React decides up/down in an effect, so a
 * one-shot read races the flush it schedules.
 */
async function popoverFits(menu: Locator, where: string) {
  const probe = await menu.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    const bar = document.querySelector<HTMLElement>(".sidebar")?.getBoundingClientRect();
    return {
      top: r.top,
      bottom: r.bottom,
      left: r.left,
      right: r.right,
      vw: window.innerWidth,
      barTop: bar && bar.top > window.innerHeight / 2 ? bar.top : window.innerHeight,
      visibleAtCentre: !!at && el.contains(at),
      itemHeights: [...el.querySelectorAll('[role="menuitem"]')].map(
        (b) => b.getBoundingClientRect().height,
      ),
    };
  });
  const box = `pop=[${[probe.top, probe.right, probe.bottom, probe.left].map(Math.round).join(", ")}] vw=${probe.vw} barTop=${Math.round(probe.barTop)}`;
  expect(probe.visibleAtCentre, `${where}: popover is clipped or covered (${box})`).toBe(true);
  expect(probe.top, `${where}: popover runs above the viewport (${box})`).toBeGreaterThanOrEqual(0);
  expect(
    probe.bottom,
    `${where}: popover hides behind the bottom tab bar (${box})`,
  ).toBeLessThanOrEqual(probe.barTop + 1);
  expect(probe.left, `${where}: popover goes off the left edge (${box})`).toBeGreaterThanOrEqual(0);
  expect(probe.right, `${where}: popover goes off the right edge (${box})`).toBeLessThanOrEqual(
    probe.vw,
  );
  for (const h of probe.itemHeights)
    expect(h, `${where}: menu item too small to tap`).toBeGreaterThanOrEqual(40);
}

/*
 * Opening a message marks it read and archiving an alias takes it out of the default view,
 * and the local D1 survives between runs — so both are reset before they are asserted on.
 * See fixtures.ts.
 */
async function openInbox(page: Page) {
  await page.goto("/#/inbox");
  await resetSeededMail(page);
  await page.reload();
  await expect(page.locator(".msg")).toHaveCount(5);
}

async function openAliases(page: Page) {
  await page.goto("/#/aliases");
  await resetSeededAlias(page);
  await page.reload();
  return page.locator(".entity").filter({ hasText: SEEDED_ALIAS_ADDRESS });
}

test("phone: every screen fits the viewport, is labelled, and screenshots clean @mobile", async ({
  page,
}) => {
  for (const [name, path] of SCREENS) {
    await page.goto(path);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await fitsViewport(page, name);
    await page.screenshot({ path: `e2e-screens/${name}.png` });
  }
});

test("phone: navigation is a bottom bar with thumb-sized targets @mobile", async ({ page }) => {
  await page.goto("/#/inbox");
  const bar = page.locator("nav.nav");
  await expect(bar).toBeVisible();
  const box = await bar.boundingBox();
  const viewport = page.viewportSize();
  expect(box && viewport, "nav bar and viewport must be measurable").toBeTruthy();
  expect(box!.y + box!.height).toBeGreaterThanOrEqual(viewport!.height - 2);
  expect(box!.y).toBeGreaterThan(viewport!.height * 0.6);

  for (const link of await bar.getByRole("link").all()) {
    const h = (await link.boundingBox())?.height ?? 0;
    expect(h, "tab targets stay ≥40px").toBeGreaterThanOrEqual(40);
  }
  await expect(bar.getByRole("link", { name: "Inbox" })).toHaveClass(/active/);
});

test("phone: text controls are 16px so iOS never zooms on focus @mobile", async ({ page }) => {
  await page.goto("/#/inbox");
  const size = await page.locator("input.search").evaluate((el) => getComputedStyle(el).fontSize);
  expect(parseFloat(size)).toBeGreaterThanOrEqual(16);
  const height = (await page.locator("input.search").boundingBox())?.height ?? 0;
  expect(height).toBeGreaterThanOrEqual(44);
});

test("phone: the inbox is a card list, searchable, and never shows a forged code @mobile", async ({
  page,
}) => {
  await openInbox(page);
  await expect(page.locator(".msg")).toHaveCount(5);
  await expect(page.locator(".msg.unread")).toHaveCount(2);

  const list = page.locator(".card--flush");
  // Trusted mail may surface its code; a spoofed row must show a warning instead of a
  // code the owner would paste somewhere.
  await expect(list.locator(".msg-code")).toHaveCount(2);
  await expect(list.locator(".msg", { hasText: "verification code" }).locator(".msg-code")).toHaveText(/55905149/);
  await expect(list.locator(".msg", { hasText: "Urgent" }).locator(".msg-code")).toHaveCount(0);
  await expect(list.locator(".msg", { hasText: "Urgent" }).getByText("unverified sender")).toBeVisible();

  // Two lines and nothing else: the card this replaces was ~120px, and the row's height is
  // what decides how much mail a phone screen holds.
  const rowHeight = (await list.locator(".msg").first().boundingBox())?.height ?? 0;
  expect(rowHeight, "a phone row stays under 68px").toBeLessThan(68);

  await page.locator("input.search").fill("digest");
  await page.locator("input.search").press("Enter");
  await expect(page.locator(".msg")).toHaveCount(1);

  await page.screenshot({ path: "e2e-screens/inbox-list.png", fullPage: true });
});

test("phone: opening spoofed mail explains it before showing anything clickable @mobile", async ({
  page,
}) => {
  await openInbox(page);
  await page.locator(".msg", { hasText: "Urgent" }).locator("a").click();

  await expect(page.getByText("Unverified message content is hidden.")).toBeVisible();
  await expect(page.locator(".code-card")).toHaveCount(0);
  await expect(page.locator(".link-card")).toHaveCount(0);
  await page.screenshot({ path: "e2e-screens/message-spoofed.png" });

  await page.getByRole("button", { name: /Show anyway/ }).click();
  await expect(page.locator(".code-card")).toHaveCount(1);
});

const STRESS_MSG = "00000000-0000-4000-8000-0000000000m5";

test("phone: a folded magic link, a tracking wrapper and an ASCII table all read cleanly @mobile", async ({
  page,
}) => {
  await page.goto(`/#/messages/${STRESS_MSG}`);
  await openFold(page, "Verification links");
  const cards = page.locator(".link-card");
  await expect(cards).toHaveCount(4);

  // The token was broken across a line break in the mail; the UI must show it whole.
  const magic = cards.filter({ hasText: "intent=device&token=eyJ" });
  await expect(magic.locator(".link-url")).toContainText("OiJVNThTTEoiLCJleHAi");
  await expect(magic.locator(".link-url")).toContainText("next=%2Fsettings%2Fsecurity");

  // A wrapped link shows where it really goes, says the message carried it behind a
  // tracking host, and still offers the address as sent.
  const wrapped = cards.filter({ hasText: "Confirm your device" });
  await expect(wrapped.locator(".link-host")).toHaveText("console.cloud.example");
  await expect(wrapped.getByText(/tracking host/)).toBeVisible();
  await expect(wrapped.getByRole("link", { name: /Open as sent/ })).toBeVisible();

  await fitsViewport(page, "stress message");
  // The sanitized HTML has to actually paint: a blank sandboxed frame would leave every
  // other assertion here green.
  const frame = page.frameLocator("iframe.email-frame");
  await expect(frame.getByText("A new sign-in reached Example Cloud.")).toBeVisible();
  await expect(frame.locator("script")).toHaveCount(0);
  // Real mail is built from tables with width="300" cells; inside a 360px frame that has to
  // shrink rather than pan, because a frame you scroll sideways is unreadable on a phone.
  await expect
    .poll(() =>
      frame
        .locator("body")
        .evaluate(
          (b) => (b.ownerDocument ?? document).documentElement.scrollWidth - window.innerWidth,
        ),
    )
    .toBeLessThanOrEqual(1);
  await page.locator("iframe.email-frame").scrollIntoViewIfNeeded();
  await page.screenshot({ path: "e2e-screens/message-stress-html.png" });

  // Plain text: paragraphs flow, and the indented summary keeps its columns in a box that
  // scrolls by itself instead of widening the page.
  await page.getByRole("button", { name: "Show plain text" }).click();
  await expect(page.locator("pre.text-plain").first()).toContainText(
    "  device     Chrome 129 on macOS 15.6",
  );
  await expect(page.locator(".text-body a").first()).toHaveAttribute(
    "rel",
    "noopener noreferrer nofollow",
  );
  await page.locator(".text-body").scrollIntoViewIfNeeded();
  await page.screenshot({ path: "e2e-screens/message-stress-text.png" });
  await fitsViewport(page, "stress message as plain text");
});

/*
 * The push path can't be triggered from a page, but Playwright can run code inside the
 * installed worker — which is the only place the real session cookies exist. So this asks
 * the worker itself: can it reach the API, what would it quote, and does a code ever get
 * into a notification.
 */
type MsgRow = { id: string; authVerdict: string };
type Note = { title: string; body: string; tag: string; url: string };
type NotifyApi = {
  pickNewMail: (items: MsgRow[] | null, now: number) => MsgRow | null;
  newMailNote: () => Promise<Note>;
};

test("phone: the worker turns a new-mail ping into sender and subject, never a code @mobile", async ({
  page,
  context,
}) => {
  await page.goto("/#/inbox");
  await expect.poll(() => context.serviceWorkers().length).toBeGreaterThan(0);
  const worker = context.serviceWorkers()[0];
  if (!worker) throw new Error("the app never registered a service worker");

  const seen = await worker.evaluate(async () => {
    const api = (self as unknown as { __mailvaultNotify: NotifyApi }).__mailvaultNotify;
    const res = await fetch("/api/messages?filter=unread&limit=10", { cache: "no-store" });
    const json = (await res.json()) as { items: MsgRow[] };
    // Seeded mail is dated; judge it at a moment when the trusted one was minutes old.
    const picked = api.pickNewMail(json.items, Date.parse("2026-09-19T08:30:30.000Z"));
    return { status: res.status, unread: json.items.length, picked, note: await api.newMailNote() };
  });

  expect(seen.status, "the worker's fetch carries the session, like the app does").toBe(200);
  expect(seen.unread).toBeGreaterThan(0);
  expect(seen.picked?.id).toBe("00000000-0000-4000-8000-0000000000m1");
  expect(seen.picked?.authVerdict).toBe("TRUSTED");
  // Nothing recent in this fixture, so the real ping must degrade to the generic note
  // rather than quote an hours-old subject as if it had just landed.
  expect(seen.note.tag).toBe("mailvault-new-mail");
  expect(JSON.stringify(seen.note)).not.toContain("55905149");
});

test("desktop: the same inbox markup grids into one-line rows", async ({ page }) => {
  await openInbox(page);
  await expect(page.locator(".msg")).toHaveCount(5);
  /*
   * One markup, two shapes: on a phone a row is two short lines, here it is one line of five
   * columns — tick, star, sender, the message itself, when. The contract is the shape and the
   * height, because the height is the whole point: at ~120px a screen held four messages, and
   * the grid is what lets the same rows hold twenty.
   */
  const row = page.locator(".msg").first().locator(".msg-row");
  const grid = await row.evaluate((el) => {
    const s = getComputedStyle(el);
    return { areas: s.gridTemplateAreas, columns: s.gridTemplateColumns.split(" ").length, height: el.getBoundingClientRect().height };
  });
  expect(grid.columns, "five columns: tick · star · sender · line · time").toBe(5);
  expect(grid.areas).toContain('"check star sender line time"');
  expect(Math.round(grid.height), "one row, not a card").toBeLessThanOrEqual(44);
  await page.screenshot({ path: "e2e-screens/inbox-desktop.png" });
});

test("phone: a row's actions stay folded until it is engaged @mobile", async ({ page }) => {
  const row = await openAliases(page);
  await expect(row).toHaveCount(1);
  const fold = row.locator(".entity-actions");

  // Resting state: the list is addresses and counts, not a wall of buttons.
  await expect(fold).toBeHidden();
  await expect(row.locator(".entity-toggle")).toHaveAttribute("aria-expanded", "false");

  await row.locator(".entity-summary").click();
  await expect(fold).toBeVisible();
  await expect(row.locator(".entity-toggle")).toHaveAttribute("aria-expanded", "true");
  // Copy · Mail here · Disable · More — the rarer actions are one tap deeper still.
  await expect(row.locator(".entity-actions > button, .entity-actions > div")).toHaveCount(4);
  await expect(row.getByRole("button", { name: "Archive" })).toHaveCount(0);

  // Folding is a tap away in both directions, so a mis-tap is not sticky.
  await row.locator(".entity-summary").click();
  await expect(fold).toBeHidden();

  // Keyboard: focusing a folded control must unfold it, never walk into an invisible button.
  await row.locator(".entity-summary").click();
  await row.getByRole("button", { name: "Copy" }).focus();
  await expect(fold).toBeVisible();
});

test("phone: the More menu inside an engaged row still clears the tab bar @mobile", async ({
  page,
}) => {
  const row = await openAliases(page);
  await expect(row).toHaveCount(1);
  await row.locator(".entity-summary").click();

  await row.getByRole("button", { name: "More" }).click();
  const menu = row.getByRole("menu");
  await expect(menu.getByRole("menuitem")).toHaveCount(4);
  await expect(menu).not.toHaveClass(/menu-up/); // room below: open downwards
  await popoverFits(menu, "alias row");

  await menu.getByRole("menuitem", { name: "Archive" }).click();
  await expect(row).toHaveCount(0);

  // It left the Active list, so the row is gone from this tab.
  await page.getByRole("tab", { name: "Archived" }).click();
  const archived = page.locator(".entity").filter({ hasText: SEEDED_ALIAS_ADDRESS });
  await expect(archived).toHaveCount(1);
  await archived.locator(".entity-summary").click();

  /*
   * The case the first version got wrong: the fixed tab bar paints over the bottom of the
   * screen, so the viewport's measure of "room below" lies and the panel must flip.
   *
   * Lift the row by padding above it until only half the panel's height is left beneath it,
   * and leave the window alone. Resizing the window to a height computed from a measurement is
   * what made this flaky: the arithmetic could ask for more than the browser allows, the
   * request was clamped without saying so, and the row ended up with room below after all — so
   * the flip stopped being required and the assertion failed for a reason that had nothing to
   * do with the menu. Padding is never refused.
   */
  const trigger = archived.locator(".menu > button");
  await trigger.click();
  // `scrollHeight`, not the bounding box: the box is still animating while the panel opens.
  const NEED = (await archived.getByRole("menu").evaluate((el) => el.scrollHeight)) + 16;
  await page.keyboard.press("Escape");
  await expect(archived.getByRole("menu")).toHaveCount(0);

  const placed = await trigger.evaluate((el) => ({
    bottom: el.getBoundingClientRect().bottom,
    vh: window.innerHeight,
  }));
  const lift = Math.max(0, Math.round(placed.vh - placed.bottom - NEED / 2));
  await page.evaluate((pad) => {
    (document.activeElement as HTMLElement | null)?.blur();
    document.body.style.paddingTop = `${pad}px`;
  }, lift);
  const room = await trigger.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const bar = document.querySelector<HTMLElement>(".sidebar")?.getBoundingClientRect();
    return {
      toViewport: Math.round(window.innerHeight - r.bottom),
      toBar: Math.round((bar?.top ?? window.innerHeight) - r.bottom),
      above: Math.round(r.top),
    };
  });
  expect(room.toViewport, "the bottom of the window is close").toBeLessThan(NEED);
  expect(room.toBar, "and the tab bar covers even less of it").toBeLessThan(NEED);
  expect(room.above, "but there is room above to flip into").toBeGreaterThan(NEED);
  await trigger.click();
  const flipped = archived.getByRole("menu");
  await expect(flipped).toHaveClass(/menu-up/);
  await popoverFits(flipped, "bottom row");

  /*
   * Found live, not locally: in a narrow window the chips wrap, so the More trigger lands
   * at the row's left edge — and the panel, anchored to that trigger's right edge, hangs
   * off-screen. It has to re-anchor to the left instead.
   */
  await page.setViewportSize({ width: 350, height: 900 });
  await page.evaluate(() => {
    document.body.style.paddingTop = "";
  });
  await page.keyboard.press("Escape");
  await expect(archived.getByRole("menu")).toHaveCount(0);
  await trigger.click();
  const narrow = archived.getByRole("menu");
  await expect(narrow).toHaveClass(/menu-left/);
  await popoverFits(narrow, "narrow window");

  await archived.getByRole("menuitem", { name: "Unarchive" }).click();
  await expect(archived).toHaveCount(0);
});
