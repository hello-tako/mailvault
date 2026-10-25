import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../app-env";
import { deleteContact, listContacts, upsertContact } from "../db/contacts";
import { actorOf, asApiError, readJson } from "./_helpers";
import { log } from "../lib/logging";

const ContactBody = z.object({
  address: z.string().trim().toLowerCase().regex(/^[^@\s]+@[^@\s]+$/, "one email address"),
  name: z.string().trim().max(120).nullable().optional(),
  note: z.string().max(2000).nullable().optional(),
});
const IdParam = z.object({ id: z.string().min(1) });

/** The owner's kept addresses (B10). */
export const contactsRoute = new Hono<AppEnv>()
  .get("/api/contacts", async (c) => {
    try {
      const q = c.req.query("q") || undefined;
      return c.json({ items: await listContacts(c.env.DB, q) });
    } catch (err) {
      throw asApiError(err);
    }
  })
  .post("/api/contacts", async (c) => {
    const body = await readJson(c, ContactBody);
    const contact = await upsertContact(c.env.DB, body);
    log.info("contact_saved", { actor: actorOf(c).email, address: contact.address });
    return c.json(contact, 201);
  })
  .delete("/api/contacts/:id", async (c) => {
    const { id } = IdParam.parse({ id: c.req.param("id") });
    const removed = await deleteContact(c.env.DB, id);
    return c.json({ removed });
  });
