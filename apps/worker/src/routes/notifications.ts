import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../app-env";
import {
  deleteNotificationPref,
  listNotificationPrefs,
  upsertNotificationPref,
} from "../db/notifications";
import { notFound } from "../lib/errors";
import { asApiError, readJson } from "./_helpers";

const PrefBody = z.object({
  scopeType: z.enum(["alias", "sender_domain"]),
  scopeValue: z.string().trim().min(1).max(254),
  action: z.enum(["all", "mute"]),
});

const IdParam = z.object({ id: z.string().min(1) });

/** Which mail is allowed to interrupt (plan D1). Muting never touches storage or search. */
export const notificationsRoute = new Hono<AppEnv>()
  .get("/api/notifications/prefs", async (c) => {
    try {
      return c.json({ items: await listNotificationPrefs(c.env.DB) });
    } catch (err) {
      throw asApiError(err);
    }
  })
  .put("/api/notifications/prefs", async (c) => {
    try {
      const body = await readJson(c, PrefBody);
      // An alias scope holds the alias's id, a sender scope the domain — never an address
      // book of who writes in.
      const value =
        body.scopeType === "sender_domain" ? body.scopeValue.toLowerCase() : body.scopeValue;
      const pref = await upsertNotificationPref(
        c.env.DB,
        { scopeType: body.scopeType, scopeValue: value },
        body.action,
      );
      return c.json(pref);
    } catch (err) {
      throw asApiError(err);
    }
  })
  .delete("/api/notifications/prefs/:id", async (c) => {
    const { id } = IdParam.parse({ id: c.req.param("id") });
    if (!(await deleteNotificationPref(c.env.DB, id))) throw notFound("Preference not found");
    return c.json({ id });
  });
