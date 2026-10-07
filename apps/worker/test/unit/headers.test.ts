import { describe, expect, it } from "vitest";
import { decorateResponse } from "../../src/security/headers";
import type { Env } from "../../src/env";

const env = { ENVIRONMENT: "production", APP_ORIGIN: "https://mail.example" } as unknown as Env;

/**
 * The response wrapper that hardens every reply has to leave a websocket handshake
 * alone: `new Response(body, { status: 101 })` throws, and rebuilding it would drop the
 * socket the runtime attached. This is the bug that only shows in production, because
 * `wrangler dev` is not where the wrapper ran.
 */
describe("decorateResponse", () => {
  it("passes a 101 upgrade through untouched, same object", () => {
    const socket = {} as WebSocket;
    const handshake = { status: 101, headers: new Headers(), body: null, webSocket: socket } as unknown as Response;
    expect(decorateResponse(env, "https://mail.example/api/live", handshake)).toBe(handshake);
  });

  it("still hardens an ordinary response", () => {
    const res = decorateResponse(env, "https://mail.example/api/messages", new Response("[]", { status: 200 }));
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("Content-Security-Policy")).toContain("default-src 'self'");
  });

  it("keeps the policy a route wrote for itself", () => {
    const page = new Response("<p>x</p>", {
      status: 200,
      headers: { "Content-Security-Policy": "default-src 'none'", "Referrer-Policy": "no-referrer" },
    });
    const res = decorateResponse(env, "https://mail.example/c/token", page);
    // The portal page carries a token in its URL and one inline script, so both of its tighter
    // values have to survive; the headers it did not write still get added.
    expect(res.headers.get("Content-Security-Policy")).toBe("default-src 'none'");
    expect(res.headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(res.headers.get("X-Frame-Options")).toBe("DENY");
  });
});
