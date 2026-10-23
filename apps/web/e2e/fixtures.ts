import { expect, type Locator, type Page } from "@playwright/test";

/*
 * The local D1 survives between E2E runs, and the app's own behaviour — opening a message
 * marks it read, archiving an alias removes it from the default view — mutates what the
 * next run asserts. So every suite that reasons about unread counts or alias state resets
 * its fixtures first, from inside the page, where the browser supplies the same-origin
 * headers the CSRF guard requires.
 */
export const SEEDED_UNREAD = ["00000000-0000-4000-8000-0000000000m1", "00000000-0000-4000-8000-0000000000m3"];
export const SEEDED_MAILS = [
  "00000000-0000-4000-8000-0000000000m1",
  "00000000-0000-4000-8000-0000000000m2",
  "00000000-0000-4000-8000-0000000000m3",
  "00000000-0000-4000-8000-0000000000m4",
  "00000000-0000-4000-8000-0000000000m5",
];
export const SEEDED_ALIAS = "00000000-0000-4000-8000-00000000al01";
export const SEEDED_ALIAS_ADDRESS = "github-x9f2@demo.example";
export const SEEDED_DOMAIN = "demo.example";

export async function resetSeededMail(page: Page) {
  await page.evaluate(async (ids) => {
    for (const id of ids) {
      const res = await fetch(`/api/messages/${id}/read`, {
        method: "PATCH",
        headers: { "content-type": "application/json", "x-mailvault": "1" },
        body: JSON.stringify({ isRead: false }),
      });
      if (!res.ok) throw new Error(`reset ${id}: ${res.status}`);
    }
  }, SEEDED_UNREAD);
}

export async function resetSeededAlias(page: Page) {
  await page.evaluate(async (id) => {
    const res = await fetch(`/api/aliases/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", "x-mailvault": "1" },
      body: JSON.stringify({ archived: false, pinned: false }),
    });
    if (!res.ok) throw new Error(`reset alias ${id}: ${res.status}`);
  }, SEEDED_ALIAS);
}

/**
 * Put the seeded mail back into the state this suite reasons about: nothing filed, and
 * starred exactly where the test expects. The star and the filing are the two flags a suite
 * changes by clicking, so a run that leaves them moved would make the next run's counts a
 * question about history rather than about the app.
 */
export async function resetSeededFlags(page: Page, starred: string[]) {
  await page.evaluate(async ({ all, keep, unread }) => {
    const bulk = (action: string, messageIds: string[]) =>
      messageIds.length === 0
        ? Promise.resolve()
        : fetch("/api/messages/bulk", {
            method: "POST",
            headers: { "content-type": "application/json", "x-mailvault": "1" },
            body: JSON.stringify({ ids: messageIds, action }),
          }).then((r) => {
            if (!r.ok) throw new Error(`reset ${action}: ${r.status}`);
          });
    await bulk("unarchive", all);
    await bulk("unstar", all);
    await bulk("star", keep);
    // Read state still travels one message at a time; the selection routes take ids in a
    // body and this one takes a flag, and each is right for what it does.
    for (const id of unread) {
      await fetch(`/api/messages/${id}/read`, {
        method: "PATCH",
        headers: { "content-type": "application/json", "x-mailvault": "1" },
        body: JSON.stringify({ isRead: false }),
      });
    }
  }, { all: SEEDED_MAILS, keep: starred, unread: SEEDED_UNREAD });
}

/**
 * Open one of a message's folded detail panels — the links it carries, the authentication
 * evidence, how a send was delivered. They start folded (Settings can turn that off), and a
 * suite that reasons about what is inside one has to ask for it the way the owner does.
 */
export async function openFold(scope: Page | Locator, title: string) {
  const summary = scope.locator(".fold > summary", { hasText: title });
  await expect(summary, `the "${title}" panel is offered`).toBeVisible();
  await summary.click();
}

/** A local-only grant fixture for cleanup; route enforcement is tested separately. */
export async function deleteTestMessage(page: Page, id: string | null) {
  const { randomBytes, createHash } = await import("node:crypto");
  const { execFileSync } = await import("node:child_process");
  const token = randomBytes(32).toString("hex");
  const hash = createHash("sha256").update(token).digest("hex");
  const now = new Date().toISOString();
  const expires = new Date(Date.now() + 60_000).toISOString();
  execFileSync("pnpm", ["--filter", "@mailvault/worker", "exec", "wrangler", "d1", "execute", "mail-vault-db", "--local", "--config", "wrangler.dev.jsonc", "--command",
    `INSERT INTO step_up_grants(token_hash,created_at,expires_at) VALUES('${hash}','${now}','${expires}')`], { stdio: "pipe" });
  const status = await page.evaluate(async ({ messageId, grant }) => {
    const res = await fetch(`/api/messages/${messageId}`, { method: "DELETE", headers: { "x-mailvault": "1", "x-mailvault-stepup": grant } });
    return res.status;
  }, { messageId: id, grant: token });
  if (status !== 202 && status !== 200) throw new Error(`cleanup ${id}: ${status}`);
}
