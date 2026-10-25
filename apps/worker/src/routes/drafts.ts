import { Hono } from "hono";
import { z } from "zod";
import { DraftInputSchema } from "@mailvault/shared";
import type { AppEnv } from "../app-env";
import { deleteDraft, getDraft, listDrafts, upsertDraft } from "../db/drafts";
import { asApiError, readJson } from "./_helpers";

const IdParam = z.object({ id: z.string().min(1) });

/** Drafts live in the vault and follow the owner between devices (plan B4). */
export const draftsRoute = new Hono<AppEnv>()
  .get("/api/drafts", async (c) => {
    try {
      return c.json({ items: await listDrafts(c.env.DB) });
    } catch (err) {
      throw asApiError(err);
    }
  })
  .get("/api/drafts/:id", async (c) => {
    const { id } = IdParam.parse({ id: c.req.param("id") });
    const draft = await getDraft(c.env.DB, id);
    if (!draft) return c.json({ draft: null });
    return c.json({ draft });
  })
  .put("/api/drafts/:id", async (c) => {
    try {
      const { id } = IdParam.parse({ id: c.req.param("id") });
      const body = await readJson(c, DraftInputSchema.omit({ id: true }));
      // The path names the slot; a body id would only ever be a second opinion.
      const draft = await upsertDraft(c.env.DB, { ...body, id });
      return c.json(draft);
    } catch (err) {
      throw asApiError(err);
    }
  })
  .delete("/api/drafts/:id", async (c) => {
    const { id } = IdParam.parse({ id: c.req.param("id") });
    if (!(await deleteDraft(c.env.DB, id))) return c.json({ deleted: false });
    return c.json({ deleted: true });
  });
