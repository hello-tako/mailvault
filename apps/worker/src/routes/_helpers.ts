import type { Context } from "hono";
import { z } from "zod";
import type { ZodTypeAny, output } from "zod";
import { CloudflareApiError, createCloudflareClient, type CloudflareClient } from "../cf/api-client";
import type { Env } from "../env";
import { AppError, badRequest, upstream } from "../lib/errors";
import type { AppEnv } from "../app-env";

type Ctx = Context<AppEnv>;

/** Parse + validate a JSON body; a schema failure becomes a 400 VALIDATION_ERROR. */
export async function readJson<T extends ZodTypeAny>(c: Ctx, schema: T): Promise<output<T>> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw badRequest("Request body must be valid JSON");
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw badRequest("Validation failed", z.flattenError(parsed.error).fieldErrors);
  }
  return parsed.data as output<T>;
}

/** Validate query params through a Zod schema (for paginated/filterable GETs). */
export function parseQuery<T extends ZodTypeAny>(c: Ctx, schema: T): output<T> {
  const q = c.req.query();
  const parsed = schema.safeParse(q);
  if (!parsed.success) {
    throw badRequest("Invalid query", z.flattenError(parsed.error).fieldErrors);
  }
  return parsed.data as output<T>;
}

/**
 * Build a Cloudflare API client from the Worker secret binding. The token is never
 * returned, logged, or placed on a response (section 6). If it is unset we fail
 * cleanly with an actionable error rather than calling out with no credentials.
 */
export function cfClient(env: Env): CloudflareClient {
  const token = env.CLOUDFLARE_API_TOKEN;
  if (!token) {
    throw new AppError(
      503,
      "CLOUDFLARE_TOKEN_UNSET",
      "Cloudflare API token is not configured. Set the CLOUDFLARE_API_TOKEN secret before this operation.",
    );
  }
  return createCloudflareClient({ token, accountId: env.CF_ACCOUNT_ID || undefined });
}

/** Translate a normalized Cloudflare error into a stable API error (no token leak). */
export function asApiError(err: unknown): unknown {
  if (err instanceof CloudflareApiError) {
    if (err.kind === "auth") {
      return new AppError(502, "CLOUDFLARE_AUTH", "Cloudflare rejected the API token (authentication failed).", err.cfCodes);
    }
    if (err.kind === "permission") {
      return new AppError(502, "CLOUDFLARE_PERMISSION", "The API token lacks a required permission for this action.", err.cfCodes);
    }
    if (err.kind === "rate_limited") {
      return new AppError(429, "RATE_LIMITED", "Cloudflare rate limit hit; please retry shortly.");
    }
    return upstream("Cloudflare API request failed", { kind: err.kind, cfCodes: err.cfCodes });
  }
  return err;
}

/** Actor convenience (guaranteed present after the auth middleware). */
export function actorOf(c: Ctx): NonNullable<AppEnv["Variables"]["actor"]> {
  return c.get("actor");
}
