import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod";
import type { AppEnv } from "../app-env";
import type { Env } from "../env";
import { actorOf, readJson } from "./_helpers";
import { badRequest, notFound } from "../lib/errors";
import { log } from "../lib/logging";
import {
  addPasskey,
  consumeChallenge,
  findPasskeyByCredential,
  listPasskeys,
  newChallenge,
  newGrant,
  removePasskey,
  revokeGrants,
  toPublic,
  touchPasskey,
} from "../db/security";
import {
  CHALLENGE_TTL_MS,
  GRANT_TTL_MS,
  assertionOptions,
  registrationOptions,
  rpFor,
  verifyAssertion,
  verifyRegistration,
} from "../lib/webauthn";
import { requireIrreversibleStepUp, STEP_UP_HEADER } from "../security/irreversible";

export { STEP_UP_HEADER } from "../security/irreversible";

const CredentialResponse = z.object({
  response: z.record(z.unknown()),
  challenge: z.string().min(1),
  deviceLabel: z.string().max(120).optional(),
});

const AssertionResponse = z.object({
  response: z.record(z.unknown()),
  challenge: z.string().min(1),
});

/**
 * Refuse unless this request carries a live step-up grant.
 *
 * Called from the handlers that cannot be undone, after they have read the body and know
 * the request is actually destructive — an alias delete that keeps its mail does not need
 * a second factor, and pretending otherwise would train the owner to route around it.
 */
export async function requireStepUp(
  c: Context<AppEnv>,
  operation: Parameters<typeof requireIrreversibleStepUp>[2] = "alias.purge",
): Promise<void> {
  return requireIrreversibleStepUp(c.env.DB, c.req.header(STEP_UP_HEADER), operation);
}

async function challengeFor(c: Context<AppEnv>, kind: "register" | "assert"): Promise<string> {
  return newChallenge(c.env.DB, kind, CHALLENGE_TTL_MS);
}

/** Consume the stored challenge before verifying, so a response can only be replayed once. */
async function takeChallenge(
  c: Context<AppEnv>,
  kind: "register" | "assert",
  challenge: unknown,
): Promise<string> {
  if (typeof challenge !== "string" || challenge.length === 0)
    throw badRequest("Missing challenge");
  if (!(await consumeChallenge(c.env.DB, challenge, kind))) {
    throw badRequest("That prompt expired or was already used. Start again.");
  }
  return challenge;
}

function origin(env: Env) {
  const rp = rpFor(env);
  if (!rp) throw badRequest("Passkeys need an https APP_ORIGIN to be configured");
  return rp;
}

export const securityRoute = new Hono<AppEnv>()
  .get("/api/security/status", async (c) => {
    const keys = await listPasskeys(c.env.DB);
    return c.json({
      passkeys: keys.map(toPublic),
      enrolled: keys.length > 0,
      rpId: rpFor(c.env)?.rpID ?? null,
    });
  })

  .post("/api/security/passkeys/options", async (c) => {
    const rp = origin(c.env);
    const existing = await listPasskeys(c.env.DB);
    // Once one passkey exists, adding another is itself a sensitive operation.
    if (existing.length > 0) await requireStepUp(c, "passkey.enroll");
    const challenge = await challengeFor(c, "register");
    const options = await registrationOptions(rp, actorOf(c).email, existing);
    options.challenge = challenge;
    log.info("passkey_registration_started", {
      actor: actorOf(c).email,
      replacing: existing.length,
    });
    return c.json({ options, challenge });
  })

  .post("/api/security/passkeys/verify", async (c) => {
    const rp = origin(c.env);
    // Re-check on completion: an options request made with no keys must not become an
    // enrollment bypass if a key is added before verification completes.
    if ((await listPasskeys(c.env.DB)).length > 0) await requireStepUp(c, "passkey.enroll");
    const body = await readJson(c, CredentialResponse);
    const expected = await takeChallenge(c, "register", body.challenge);
    const verified = await verifyRegistration(rp, body.response as never, expected);
    if (!verified.ok) throw badRequest(verified.reason);

    const existing = await listPasskeys(c.env.DB);
    if (existing.some((p) => p.credentialId === verified.credentialId)) {
      throw badRequest("That passkey is already registered here.");
    }
    const stored = await addPasskey(c.env.DB, {
      credentialId: verified.credentialId,
      publicKey: verified.publicKey,
      counter: verified.counter,
      transports: verified.transports,
      deviceLabel: body.deviceLabel?.trim() || null,
    });
    log.info("passkey_registered", { actor: actorOf(c).email, passkeyId: stored.id });
    return c.json({ passkey: toPublic(stored) });
  })

  .delete("/api/security/passkeys/:id", async (c) => {
    const existing = await listPasskeys(c.env.DB);
    const target = existing.find((p) => p.id === c.req.param("id"));
    if (!target) throw notFound("Passkey not found");
    await requireStepUp(c, "passkey.remove");
    await removePasskey(c.env.DB, target.id);
    await revokeGrants(c.env.DB);
    log.info("passkey_removed", {
      actor: actorOf(c).email,
      passkeyId: target.id,
      remaining: existing.length - 1,
    });
    return c.json({ removed: true, remaining: existing.length - 1 });
  })

  .post("/api/security/step-up/options", async (c) => {
    const rp = origin(c.env);
    const keys = await listPasskeys(c.env.DB);
    if (keys.length === 0) throw badRequest("Register a passkey first.");
    const challenge = await challengeFor(c, "assert");
    const options = await assertionOptions(rp, keys);
    options.challenge = challenge;
    return c.json({ options, challenge });
  })

  .post("/api/security/step-up/verify", async (c) => {
    const rp = origin(c.env);
    const body = await readJson(c, AssertionResponse);
    const raw = body.response as {
      id?: unknown;
      clientExtensionResults?: Record<string, unknown>;
      response: Record<string, unknown>;
    };
    const expected = await takeChallenge(c, "assert", body.challenge);
    if (typeof raw.id !== "string") throw badRequest("Missing credential id");

    const passkey = await findPasskeyByCredential(c.env.DB, raw.id);
    if (!passkey) throw badRequest("That passkey is not registered here.");

    const verified = await verifyAssertion(rp, body.response as never, expected, passkey);
    if (!verified.ok) throw badRequest(verified.reason);

    await touchPasskey(c.env.DB, passkey.id, verified.newCounter);
    const grant = await newGrant(c.env.DB, GRANT_TTL_MS);
    log.info("step_up_granted", { actor: actorOf(c).email, passkeyId: passkey.id });
    // Shown once, and only its hash is stored.
    return c.json({
      token: grant.token,
      expiresAt: grant.expiresAt,
      seconds: Math.floor(GRANT_TTL_MS / 1000),
    });
  });
