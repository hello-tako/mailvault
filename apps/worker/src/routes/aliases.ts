import { Hono } from "hono";
import { z } from "zod";
import {
  AliasStatus,
  CreateAliasSchema,
  CreatePortalLinkSchema,
  DeleteAliasSchema,
  ImportAliasesInputSchema,
  LocalPartMode,
  MailStatus,
  UpdateAliasSchema,
  isValidLocalPart,
  type ImportAliasesResult,
} from "@mailvault/shared";
import type { AppEnv } from "../app-env";
import { requestAliasPurge } from "../db/deletions";
import {
  aliasStats,
  aliasExists,
  createAlias,
  deleteAlias,
  getAliasById,
  listAliases,
  setAliasStatus,
  updateAlias,
} from "../db/aliases";
import { getDomainById, listDomains } from "../db/domains";
import { createGrant, listGrants, revokeGrant } from "../db/portal";
import { conflict, notFound } from "../lib/errors";
import { log } from "../lib/logging";
import { portalOrigin, portalPath } from "../portal/link";
import { randomLocalPart, nowIso } from "../lib/util";
import { normalizeLookupAddress, splitAddress } from "../mail/normalize";
import { actorOf, parseQuery, readJson } from "./_helpers";
import { requireStepUp } from "./security";

const IdParam = z.object({ id: z.string().min(1) });
const GrantParam = z.object({ id: z.string().min(1), grantId: z.string().min(1) });
const ListQuery = z.object({
  q: z.string().max(200).optional(),
  /** Archived aliases are hidden by default so the working list stays short. */
  view: z.enum(["all", "active", "archived"]).default("active"),
});

/**
 * Generate a collision-free random local part. Random/service modes use CSPRNG
 * (never Math.random, section 21); we retry on the rare in-domain clash so the
 * caller never has to. Reserved-name and format checks live in the shared schema.
 */
async function uniqueRandomPart(db: D1Database, domainId: string, prefix: string): Promise<string> {
  for (let i = 0; i < 24; i++) {
    const candidate = prefix ? `${prefix}-${randomLocalPart(6)}` : randomLocalPart(6);
    if (!isValidLocalPart(candidate)) continue;
    if (!(await aliasExists(db, domainId, candidate))) return candidate;
  }
  throw conflict("Could not generate a unique alias — please retry");
}

export const aliasesRoute = new Hono<AppEnv>()
  .get("/api/aliases", async (c) => {
    const { q, view } = parseQuery(c, ListQuery);
    return c.json({ items: await listAliases(c.env.DB, q, view) });
  })

  /**
   * The whole address book as a file — for moving to a fresh install, or keeping beside the
   * weekly D1 export. Registered above `/:id` for the same reason `counters` is on messages:
   * registration order decides which route an "export" path reaches.
   */
  .get("/api/aliases/export", async (c) => {
    const aliases = await listAliases(c.env.DB, undefined, "all");
    const rows = aliases.map((a) => ({ address: a.address, label: a.label, notes: a.notes }));
    return new Response(JSON.stringify({ exportedAt: nowIso(), aliases: rows }, null, 2), {
      headers: {
        "content-type": "application/json",
        "content-disposition": `attachment; filename="mailvault-aliases-${nowIso().slice(0, 10)}.json"`,
        "cache-control": "private, no-store",
      },
    });
  })

  /**
   * Add back what an export wrote. Additive by construction: an address that already exists
   * is counted and left alone, and one whose domain this mailbox cannot receive on is
   * reported rather than half-created.
   */
  .post("/api/aliases/import", async (c) => {
    const { aliases } = await readJson(c, ImportAliasesInputSchema);
    const domains = await listDomains(c.env.DB);
    const byName = new Map(domains.map((d) => [d.name.toLowerCase(), d]));

    let created = 0;
    let skipped = 0;
    const invalid: string[] = [];
    for (const row of aliases) {
      const address = normalizeLookupAddress(row.address);
      const parts = splitAddress(address);
      const domainName = address.split("@")[1] ?? "";
      const domain = byName.get(domainName);
      if (!address || !parts.valid || !domain || domain.mailStatus !== MailStatus.Ready) {
        invalid.push(row.address);
        continue;
      }
      if (await aliasExists(c.env.DB, domain.id, parts.local)) {
        skipped += 1;
        continue;
      }
      try {
        const made = await createAlias(c.env.DB, {
          domainId: domain.id,
          domainName: domain.name,
          localPart: parts.local,
          label: row.label ?? null,
        });
        if (row.notes) await updateAlias(c.env.DB, made.id, { notes: row.notes });
        created += 1;
      } catch {
        // A row the database refused (a reserved name, a clash that raced us) is a report
        // line, not a reason to abandon the rest of the file.
        invalid.push(row.address);
      }
    }
    log.info("aliases_imported", { actor: actorOf(c).email, created, skipped, invalid: invalid.length });
    return c.json({ created, skipped, invalid } satisfies ImportAliasesResult);
  })

  /** One alias with its arrival history — counts, span and the senders that use it. */
  .get("/api/aliases/:id", async (c) => {
    const { id } = IdParam.parse({ id: c.req.param("id") });
    const alias = await getAliasById(c.env.DB, id);
    if (!alias) throw notFound("Alias not found");
    return c.json({ alias, stats: await aliasStats(c.env.DB, id) });
  })

  .post("/api/aliases", async (c) => {
    const body = await readJson(c, CreateAliasSchema);
    const domain = await getDomainById(c.env.DB, body.domainId);
    if (!domain) throw notFound("Domain not found — sync your domains first");

    let localPart: string;
    if (body.mode === LocalPartMode.Custom) {
      localPart = body.localPart;
    } else if (body.mode === LocalPartMode.ServiceRandom) {
      localPart = await uniqueRandomPart(c.env.DB, domain.id, body.service);
    } else {
      localPart = await uniqueRandomPart(c.env.DB, domain.id, "");
    }

    const alias = await createAlias(c.env.DB, {
      domainId: domain.id,
      domainName: domain.name,
      localPart,
      label: body.label ?? null,
    });
    log.info("alias_created", {
      actor: actorOf(c).email,
      aliasId: alias.id,
      domainId: domain.id,
      mode: body.mode,
    });
    return c.json(alias, 201);
  })

  /** Label, notes, pin and archive — only the fields present in the body change. */
  .patch("/api/aliases/:id", async (c) => {
    const { id } = IdParam.parse({ id: c.req.param("id") });
    const patch = await readJson(c, UpdateAliasSchema);
    if (!(await getAliasById(c.env.DB, id))) throw notFound("Alias not found");
    await updateAlias(c.env.DB, id, patch);
    log.info("alias_updated", { actor: actorOf(c).email, aliasId: id, fields: Object.keys(patch) });
    return c.json(await getAliasById(c.env.DB, id));
  })

  .post("/api/aliases/:id/enable", async (c) => {
    const { id } = IdParam.parse({ id: c.req.param("id") });
    if (!(await getAliasById(c.env.DB, id))) throw notFound("Alias not found");
    await setAliasStatus(c.env.DB, id, AliasStatus.Active);
    return c.json(await getAliasById(c.env.DB, id));
  })

  .post("/api/aliases/:id/disable", async (c) => {
    const { id } = IdParam.parse({ id: c.req.param("id") });
    if (!(await getAliasById(c.env.DB, id))) throw notFound("Alias not found");
    await setAliasStatus(c.env.DB, id, AliasStatus.Disabled);
    return c.json(await getAliasById(c.env.DB, id));
  })

  /**
   * A purge disables the alias and schedules bounded durable cleanup. A plain delete
   * preserves historical mail and detaches it from the alias (SET NULL).
   */
  .delete("/api/aliases/:id", async (c) => {
    const { id } = IdParam.parse({ id: c.req.param("id") });
    const { purgeMessages } = await readJson(c, DeleteAliasSchema);
    if (purgeMessages) {
      await requireStepUp(c, "alias.purge");
      const result = await requestAliasPurge(c.env.DB, id);
      if (!result.found) throw notFound("Alias not found");
      log.info("alias_purge_queued", { actor: actorOf(c).email, aliasId: id, state: result.state });
      return c.json(
        { deleted: result.state === "DONE", purgedMessages: true, state: result.state },
        result.state === "DONE" ? 200 : 202,
      );
    }

    if (!(await getAliasById(c.env.DB, id))) throw notFound("Alias not found");
    await deleteAlias(c.env.DB, id, false);
    log.info("alias_deleted", {
      actor: actorOf(c).email,
      aliasId: id,
      purgeMessages: false,
      r2Keys: 0,
    });
    return c.json({ deleted: true, purgedMessages: false, r2ObjectsRemoved: 0 });
  })

  /*
   * Portal links: what the owner hands to a buyer. The token appears in exactly one response
   * and is never stored in a readable form, so the list endpoint can show every link's state
   * — who looked, when it dies — without being able to rebuild any of them.
   */
  .post("/api/aliases/:id/portal-links", async (c) => {
    const { id } = IdParam.parse({ id: c.req.param("id") });
    const alias = await getAliasById(c.env.DB, id);
    if (!alias) throw notFound("Alias not found");
    const body = await readJson(c, CreatePortalLinkSchema);
    const { grant, token } = await createGrant(c.env.DB, {
      aliasId: id,
      label: body.label ?? null,
      ttlMinutes: body.ttlMinutes,
      maxViews: body.maxViews ?? null,
    });
    log.info("portal_link_created", { actor: actorOf(c).email, aliasId: id, grantId: grant.id, ttlMinutes: body.ttlMinutes });
    const origin = new URL(c.req.url).origin;
    return c.json({ grant, token, url: `${portalOrigin(c.env, origin)}${portalPath(token)}` });
  })

  .get("/api/aliases/:id/portal-links", async (c) => {
    const { id } = IdParam.parse({ id: c.req.param("id") });
    if (!(await getAliasById(c.env.DB, id))) throw notFound("Alias not found");
    const now = Date.now();
    const items = await listGrants(c.env.DB, id);
    return c.json({
      items: items.map((g) => ({ ...g, active: !g.revokedAt && Date.parse(g.expiresAt) > now && (g.maxViews === null || g.views < g.maxViews) })),
    });
  })

  .delete("/api/aliases/:id/portal-links/:grantId", async (c) => {
    const { id, grantId } = GrantParam.parse({ id: c.req.param("id"), grantId: c.req.param("grantId") });
    const removed = await revokeGrant(c.env.DB, grantId, id);
    if (!removed) throw notFound("Link not found");
    log.info("portal_link_revoked", { actor: actorOf(c).email, aliasId: id, grantId });
    return c.json({ revoked: true });

  });
