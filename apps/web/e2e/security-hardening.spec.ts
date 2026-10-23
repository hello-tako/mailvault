import { expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";

test("desktop: real WebAuthn gates deletion and last-passkey removal", async ({
  page,
  context,
}) => {
  test.setTimeout(60_000);
  execFileSync(
    "pnpm",
    [
      "--filter",
      "@mailvault/worker",
      "exec",
      "wrangler",
      "d1",
      "execute",
      "mail-vault-db",
      "--local",
      "--config",
      "wrangler.dev.jsonc",
      "--command",
      "DELETE FROM passkeys; DELETE FROM step_up_grants; DELETE FROM webauthn_challenges;",
    ],
    { stdio: "pipe" },
  );
  const cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
  await page.goto("/#/settings");
  await page.getByRole("button", { name: "Register a passkey" }).click();
  await expect(page.getByText("Passkey registered.", { exact: false })).toBeVisible();
  const security = await page.request.get("/api/security/status");
  const key = (await security.json()).passkeys[0];
  const refused = await page.request.delete(`/api/security/passkeys/${key.id}`, {
    headers: { origin: "http://localhost:8787", "x-mailvault": "1" },
  });
  expect(refused.status()).toBe(403);
  expect((await refused.json()).error.details.stepUpRequired).toBe(true);

  await page.goto("/#/inbox");
  await page.getByRole("button", { name: "Compose" }).click();
  const subject = `WebAuthn deletion ${Date.now()}`;
  const composer = page.getByRole("dialog", { name: "New message" });
  await composer.getByLabel("To", { exact: true }).fill("fixture@example.net");
  await composer.getByLabel("Subject", { exact: true }).fill(subject);
  await composer.getByLabel("Message", { exact: true }).fill("Synthetic security fixture");
  await composer.getByRole("button", { name: "Send" }).click();
  await expect(composer).toHaveCount(0);
  const row = page.locator(".msg").filter({ hasText: subject });
  await expect(row).toBeVisible();
  const messageId = await row.getAttribute("data-msg-id");
  expect(messageId).toBeTruthy();
  const denied = await page.request.delete(`/api/messages/${messageId}`, {
    headers: { origin: "http://localhost:8787", "x-mailvault": "1" },
  });
  expect(denied.status()).toBe(403);
  await row.getByRole("link").click();
  const assertion = page.waitForResponse(
    (r) => r.url().endsWith("/api/security/step-up/verify") && r.status() === 200,
  );
  const deletion = page.waitForResponse(
    (r) =>
      r.url().endsWith(`/api/messages/${messageId}`) &&
      r.request().method() === "DELETE" &&
      Boolean(r.request().headers()["x-mailvault-stepup"]),
  );
  await page.locator(".mail-pane").getByRole("button", { name: "Delete", exact: true }).click();
  await page
    .getByRole("dialog", { name: "Delete message" })
    .getByRole("button", { name: "Delete permanently" })
    .click();
  await assertion;
  const deletionResponse = await deletion;
  expect(deletionResponse.status(), await deletionResponse.text()).toBe(202);
  expect((await page.request.get(`/api/messages/${messageId}`)).status()).toBe(404);
  await expect(page.locator(".msg").filter({ hasText: subject })).toHaveCount(0);
  expect(
    await page.evaluate(() => Object.keys(localStorage).some((key) => /grant|stepup/i.test(key))),
  ).toBe(false);

  await page.goto("/#/settings");
  await page.getByRole("button", { name: "Remove", exact: true }).click();
  await expect(page.getByText("Passkey removed.", { exact: true })).toBeVisible();
  await expect(
    page.getByText("sign-in alone cannot authorize them.", { exact: false }),
  ).toBeVisible();
  expect((await (await page.request.get("/api/security/status")).json()).passkeys).toHaveLength(0);
  await page.screenshot({ path: "../../.hoplite/artifacts/passkey-step-up.png", fullPage: true });
});
