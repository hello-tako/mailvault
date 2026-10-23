import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../app-env";
import { badRequest } from "../lib/errors";
import { log } from "../lib/logging";
import { actorOf, readJson } from "./_helpers";
import { requireIrreversibleStepUp, STEP_UP_HEADER } from "../security/irreversible";
import {
  EMBEDDING_DIMENSIONS,
  EMBEDDING_MODEL,
  backfill,
  indexedCount,
  purgeIndex,
  semanticEnabled,
  setSemanticEnabled,
} from "../lib/semantic";

const Toggle = z.object({ enabled: z.boolean() });

/**
 * Opt-in semantic search.
 *
 * Turning this on copies a short excerpt of each message (sender, subject, the first
 * ~900 characters of the body) into a vector index in this Cloudflare account. That is a
 * second place message content exists, so it never happens unless the owner says so here,
 * and turning it off deletes the vectors rather than leaving them unused.
 */
export const semanticRoute = new Hono<AppEnv>()
  .get("/api/semantic", async (c) => {
    const counts = await indexedCount(c.env.DB);
    return c.json({
      enabled: await semanticEnabled(c.env.DB),
      indexed: counts.indexed,
      total: counts.total,
      model: EMBEDDING_MODEL,
      dimensions: EMBEDDING_DIMENSIONS,
      available: !!c.env.AI && !!c.env.VECTORIZE,
    });
  })

  .post("/api/semantic", async (c) => {
    const { enabled } = await readJson(c, Toggle);
    if (!c.env.AI || !c.env.VECTORIZE) throw badRequest("This deployment has no AI or vector index bound.");
    if (!enabled) await requireIrreversibleStepUp(c.env.DB, c.req.header(STEP_UP_HEADER), "semantic.purge");
    await setSemanticEnabled(c.env.DB, enabled);
    let purged = 0;
    if (!enabled) purged = await purgeIndex(c.env);
    log.info("semantic_setting_changed", { actor: actorOf(c).email, enabled, purged });
    const counts = await indexedCount(c.env.DB);
    return c.json({ enabled, indexed: counts.indexed, total: counts.total, purged });
  })

  .post("/api/semantic/backfill", async (c) => {
    if (!(await semanticEnabled(c.env.DB))) throw badRequest("Turn semantic search on first.");
    const result = await backfill(c.env, 50);
    log.info("semantic_backfill", { actor: actorOf(c).email, ...result });
    return c.json(result);
  });
