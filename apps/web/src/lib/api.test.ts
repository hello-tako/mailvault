import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "./api";
import { clearGrant, rememberGrant, STEP_UP_HEADER } from "./grant";

afterEach(() => {
  clearGrant();
  vi.unstubAllGlobals();
});

describe("destructive API requests", () => {
  it("carries the live in-memory grant on permanent message deletion", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(
        new Response(JSON.stringify({ deleted: true, state: "PENDING" }), { status: 202 }),
      );
    vi.stubGlobal("fetch", fetch);
    rememberGrant("synthetic-grant", new Date(Date.now() + 60_000).toISOString());
    await api.deleteMessage("synthetic-message");
    const init = fetch.mock.calls[0]?.[1] as RequestInit;
    expect(init.method).toBe("DELETE");
    expect(new Headers(init.headers).get(STEP_UP_HEADER)).toBe("synthetic-grant");
    expect(new Headers(init.headers).get("x-mailvault")).toBe("1");
  });
});
