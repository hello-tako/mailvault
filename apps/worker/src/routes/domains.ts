import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod";
import {
  AuthPolicy,
  DomainIdsBodySchema,
  PreflightClassification,
  type DiscoveredZone,
} from "@mailvault/shared";
import type { AppEnv } from "../app-env";
import { domainDenylist } from "../env";
import {
  getDomainByZoneId,
  listDomains,
  setDomainAuthPolicy,
  upsertDiscoveredZones,
} from "../db/domains";
import { preflightMany, provisionMany, provisionDomain } from "../provisioning/provisioner";
import { runWatchdog } from "../provisioning/watchdog";
import { log } from "../lib/logging";
import { badRequest, notFound, AppError } from "../lib/errors";
import { actorOf, asApiError, cfClient, readJson } from "./_helpers";
import { requireStepUp } from "./security";
import { verifyDeliveryPath } from "../provisioning/preflight";

const ZoneIdParam = z.object({ id: z.string().min(1) });

/** Provision/preflight bodies accept explicit, dangerous-action takeover confirmations. */
const ProvisionBodySchema = DomainIdsBodySchema.extend({
  allowCatchAllTakeover: z.boolean().default(false),
  allowMxTakeover: z.boolean().default(false),
});

function requireWorkerName(env: AppEnv["Bindings"]): string {
  const name = env.MAIL_WORKER_NAME;
  if (!name) {
    throw new AppError(
      503,
      "WORKER_NAME_UNSET",
      "MAIL_WORKER_NAME must be configured so catch-all rules can target this Worker.",
    );
  }
  return name;
}

async function authorizeTakeovers(
  c: Context<AppEnv>,
  zoneIds: string[],
  workerName: string,
  flags: { allowMxTakeover: boolean; allowCatchAllTakeover: boolean },
): Promise<void> {
  const client = cfClient(c.env);
  const results = await preflightMany(c.env.DB, client, zoneIds, workerName);
  const eligible = new Set<PreflightClassification>([
    PreflightClassification.MxConflict,
    PreflightClassification.CatchAllConflict,
    PreflightClassification.ReadyToProvision,
    PreflightClassification.AlreadyConfigured,
  ]);

  // Resolve authorization for the entire batch before any domain can be mutated.
  for (const result of results) {
    if (!eligible.has(result.classification)) continue;
    const path = await verifyDeliveryPath(client, result.zoneId, workerName);
    if (flags.allowMxTakeover && path.mx.foreign.length > 0)
      await requireStepUp(c, "provision.mx-takeover");
    if (flags.allowCatchAllTakeover && path.foreignCatchAll)
      await requireStepUp(c, "provision.catch-all-takeover");
  }
}

export const domainsRoute = new Hono<AppEnv>()
  .get("/api/domains", async (c) => c.json({ items: await listDomains(c.env.DB) }))

  /** Discovery is read-only against Cloudflare — it never mutates a zone (section 9). */
  .post("/api/domains/sync", async (c) => {
    try {
      const client = cfClient(c.env);
      const zones = await client.listAllZones();
      const discovered: DiscoveredZone[] = zones.map((z) => ({
        cloudflareZoneId: z.id,
        cloudflareAccountId: z.account?.id ?? c.env.CF_ACCOUNT_ID ?? null,
        name: z.name,
        status: z.status,
        type: z.type,
        account: z.account ? { id: z.account.id ?? null, name: z.account.name ?? null } : null,
      }));
      await upsertDiscoveredZones(c.env.DB, discovered);
      log.info("domains_synced", { actor: actorOf(c).email, discovered: discovered.length });
      return c.json({ discovered: discovered.length, items: await listDomains(c.env.DB) });
    } catch (err) {
      throw asApiError(err);
    }
  })

  /** Preflight classifies safety for each selected zone. Performs no mutation. */
  .post("/api/domains/preflight", async (c) => {
    try {
      const body = await readJson(c, DomainIdsBodySchema);
      const client = cfClient(c.env);
      const workerName = requireWorkerName(c.env);
      const results = await preflightMany(c.env.DB, client, body.zoneIds, workerName);
      return c.json({ results });
    } catch (err) {
      throw asApiError(err);
    }
  })

  /** Provision mutates Cloudflare — only ever after this explicit, authenticated action. */
  .post("/api/domains/provision", async (c) => {
    try {
      const body = await readJson(c, ProvisionBodySchema);
      const client = cfClient(c.env);
      const workerName = requireWorkerName(c.env);
      await authorizeTakeovers(c, body.zoneIds, workerName, {
        allowMxTakeover: body.allowMxTakeover,
        allowCatchAllTakeover: body.allowCatchAllTakeover,
      });
      const results = await provisionMany(c.env.DB, client, body.zoneIds, workerName, {
        allowCatchAllTakeover: body.allowCatchAllTakeover,
        allowMxTakeover: body.allowMxTakeover,
        denyDomains: domainDenylist(c.env),
        authorizeTakeover: (operation) => requireStepUp(c, operation),
      });
      log.info("domains_provisioned", {
        actor: actorOf(c).email,
        count: results.length,
        ok: results.filter((r) => r.ok).length,
        takeover: body.allowCatchAllTakeover,
        mxTakeover: body.allowMxTakeover,
      });
      return c.json({ results });
    } catch (err) {
      throw asApiError(err);
    }
  })

  /** Retry = provision one domain; :id is the Cloudflare zone id. */
  .post("/api/domains/:id/retry", async (c) => {
    const { id: zoneId } = ZoneIdParam.parse({ id: c.req.param("id") });
    try {
      // Retry may be sent with no body; absence means "no takeover confirmation".
      let allowCatchAllTakeover = false;
      let allowMxTakeover = false;
      try {
        const body = await readJson(
          c,
          z.object({
            allowCatchAllTakeover: z.boolean().optional(),
            allowMxTakeover: z.boolean().optional(),
          }),
        );
        allowCatchAllTakeover = body.allowCatchAllTakeover ?? false;
        allowMxTakeover = body.allowMxTakeover ?? false;
      } catch {
        /* empty/absent body is fine for a retry */
      }
      const client = cfClient(c.env);
      const workerName = requireWorkerName(c.env);
      await authorizeTakeovers(c, [zoneId], workerName, { allowCatchAllTakeover, allowMxTakeover });
      const result = await provisionDomain(c.env.DB, client, zoneId, workerName, {
        allowCatchAllTakeover,
        allowMxTakeover,
        denyDomains: domainDenylist(c.env),
        authorizeTakeover: (operation) => requireStepUp(c, operation),
      });
      return c.json(result);
    } catch (err) {
      throw asApiError(err);
    }
  })

  /**
   * Re-verify the delivery path of every domain MailVault believes works (or flagged as
   * drifted). Read-only against Cloudflare; updates MailVault's own rows only.
   */
  .post("/api/domains/verify", async (c) => {
    try {
      const client = cfClient(c.env);
      const report = await runWatchdog(c.env.DB, client, requireWorkerName(c.env));
      log.info("domains_verified", {
        actor: actorOf(c).email,
        checked: report.checked,
        drifted: report.drifted.length,
        failed: report.failed.length,
      });
      return c.json({ report, items: await listDomains(c.env.DB) });
    } catch (err) {
      throw asApiError(err);
    }
  })

  /**
   * Owner sets how this domain treats mail whose sender failed authentication.
   * Local setting only — it never touches Cloudflare.
   */
  .patch("/api/domains/:id/auth-policy", async (c) => {
    const { id: zoneId } = ZoneIdParam.parse({ id: c.req.param("id") });
    const body = await readJson(c, z.object({ policy: z.nativeEnum(AuthPolicy) }));
    const domain = await getDomainByZoneId(c.env.DB, zoneId);
    if (!domain) throw notFound("Domain not found");
    // Weakening this is exactly what an attacker with a stolen session would want, and it
    // is invisible in the mail that then arrives.
    if (body.policy === AuthPolicy.Off) await requireStepUp(c, "auth-policy.weaken");
    await setDomainAuthPolicy(c.env.DB, domain.id, body.policy);
    log.info("domain_auth_policy_set", { actor: actorOf(c).email, zoneId, policy: body.policy });
    return c.json({ zoneId, authPolicy: body.policy });
  })

  /**
   * Forget a domain from MailVault. This ONLY removes local tracking rows —
   * it never deletes or mutates the Cloudflare zone (section: removing must not
   * delete the zone). Refuses while aliases still depend on it to avoid a
   * surprising cascade.
   */
  .delete("/api/domains/:id", async (c) => {
    const { id: zoneId } = ZoneIdParam.parse({ id: c.req.param("id") });
    const domain = await getDomainByZoneId(c.env.DB, zoneId);
    if (!domain) throw notFound("Domain not found");
    await requireStepUp(c, "domain.forget");
    const deleted = await c.env.DB.prepare(
      `DELETE FROM domains
         WHERE id = ?1
           AND NOT EXISTS (SELECT 1 FROM aliases WHERE domain_id = ?1)
           AND NOT EXISTS (SELECT 1 FROM messages WHERE domain_id = ?1)`,
    )
      .bind(domain.id)
      .run();
    if (!deleted.meta.changes) {
      const [aliasCount, messageCount] = await Promise.all([
        c.env.DB.prepare(`SELECT COUNT(*) AS c FROM aliases WHERE domain_id = ?1`)
          .bind(domain.id)
          .first<{ c: number }>(),
        c.env.DB.prepare(`SELECT COUNT(*) AS c FROM messages WHERE domain_id = ?1`)
          .bind(domain.id)
          .first<{ c: number }>(),
      ]);
      if (Number(messageCount?.c ?? 0) > 0) {
        throw badRequest(
          "This domain still has historical mail. Purge or otherwise resolve those messages before forgetting the domain.",
          {
            messageCount: Number(messageCount?.c ?? 0),
          },
        );
      }
      if (Number(aliasCount?.c ?? 0) > 0) {
        throw badRequest("Remove or reassign this domain's aliases before removing it.", {
          aliasCount: Number(aliasCount?.c ?? 0),
        });
      }
      throw notFound("Domain not found");
    }
    log.info("domain_forgotten", { actor: actorOf(c).email, zoneId });
    return c.json({ removed: true, zoneId });
  });
