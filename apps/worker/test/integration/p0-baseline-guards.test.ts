import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AuthVerdict } from "@mailvault/shared";
import { deleteAlias } from "../../src/db/aliases";
import { commitIngest, stageEmail } from "../../src/mail/ingest";
import { getTestBindings, type TestBindings } from "./_mf";

let bindings: TestBindings;
beforeAll(async () => {
  bindings = await getTestBindings();
});
afterAll(async () => {
  await bindings?.dispose();
});

async function stageFixture() {
  const domainId = crypto.randomUUID();
  const aliasId = crypto.randomUUID();
  const address = `owner@${domainId}.example`;
  const { db, bucket, env } = bindings;
  await db
    .prepare(
      `INSERT INTO domains (id, cloudflare_zone_id, name, zone_status, zone_type) VALUES (?1, ?2, ?3, 'active', 'full')`,
    )
    .bind(domainId, `zone-${domainId}`, `${domainId}.example`)
    .run();
  await db
    .prepare(
      `INSERT INTO aliases (id, domain_id, local_part, address, status) VALUES (?1, ?2, 'owner', ?3, 'ACTIVE')`,
    )
    .bind(aliasId, domainId, address)
    .run();
  const raw = new TextEncoder().encode(
    [
      "From: user@example.net",
      `To: ${address}`,
      "Subject: synthetic P0 regression",
      "Authentication-Results: attacker.example; spf=pass smtp.mailfrom=example.net; dkim=pass header.d=example.net; dmarc=pass header.from=example.net",
      'Content-Type: multipart/mixed; boundary="p0-boundary"',
      "",
      "--p0-boundary",
      "Content-Type: text/plain",
      "",
      "Synthetic fixture.",
      "--p0-boundary",
      'Content-Type: text/plain; name="proof.txt"',
      'Content-Disposition: attachment; filename="proof.txt"',
      "",
      "proof",
      "--p0-boundary--",
      "",
    ].join("\r\n"),
  );
  const staged = await stageEmail(
    {
      from: "user@example.net",
      to: address,
      headers: new Headers(),
      raw: new ReadableStream({
        start(controller) {
          controller.enqueue(raw);
          controller.close();
        },
      }),
      rawSize: raw.length,
      setReject() {},
    },
    env,
    db,
    bucket,
  );
  if (staged.status !== "staged") throw new Error("fixture_not_staged");
  return { ...staged, domainId, aliasId };
}

describe("baseline-compatible P0 guards", () => {
  it("never credits a forged aligned MIME Authentication-Results as verified", async () => {
    const staged = await stageFixture();
    await commitIngest(staged.job, bindings.db, bindings.bucket);
    expect(
      await bindings.db
        .prepare(`SELECT auth_verdict FROM messages WHERE dedupe_key = ?1`)
        .bind(staged.job.dedupeKey)
        .first("auth_verdict"),
    ).toBe(AuthVerdict.Unverified);
  });

  it("repairs an attachment failure on redelivery without deleting canonical objects", async () => {
    const staged = await stageFixture();
    await bindings.db
      .prepare(
        `CREATE TRIGGER p0_fail_attachment BEFORE INSERT ON attachments BEGIN SELECT RAISE(ABORT, 'p0_injected_attachment_failure'); END`,
      )
      .run();
    try {
      await expect(commitIngest(staged.job, bindings.db, bindings.bucket)).rejects.toThrow(
        "p0_injected_attachment_failure",
      );
    } finally {
      await bindings.db.prepare(`DROP TRIGGER p0_fail_attachment`).run();
    }
    await commitIngest(staged.job, bindings.db, bindings.bucket);
    const row = await bindings.db
      .prepare(`SELECT id FROM messages WHERE dedupe_key = ?1`)
      .bind(staged.job.dedupeKey)
      .first<{ id: string }>();
    expect(row).not.toBeNull();
    expect(
      await bindings.db
        .prepare(`SELECT count(*) AS n FROM attachments WHERE message_id = ?1`)
        .bind(row!.id)
        .first("n"),
    ).toBe(1);
    for (const key of staged.keys) expect(await bindings.bucket.head(key)).not.toBeNull();
  });

  it("blocks domain cascade after alias removal preserves historical mail", async () => {
    const staged = await stageFixture();
    await commitIngest(staged.job, bindings.db, bindings.bucket);
    await deleteAlias(bindings.db, staged.aliasId, false);
    await expect(
      bindings.db.prepare(`DELETE FROM domains WHERE id = ?1`).bind(staged.domainId).run(),
    ).rejects.toThrow("domain_has_dependents");
    expect(
      await bindings.db
        .prepare(`SELECT count(*) AS n FROM messages WHERE dedupe_key = ?1`)
        .bind(staged.job.dedupeKey)
        .first("n"),
    ).toBe(1);
    for (const key of staged.keys) expect(await bindings.bucket.head(key)).not.toBeNull();
  });
});
