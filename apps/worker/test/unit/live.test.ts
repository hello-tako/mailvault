import { describe, expect, it } from "vitest";
import type { Env } from "../../src/env";
import { notifyNewMail, notifySendFailed } from "../../src/live/hub";

/**
 * The hub is a Durable Object, which needs workerd to run. What is worth pinning here is
 * the addressing: which hub instances get nudged, and that a nudge can never break the
 * delivery that sent it.
 */
function fakeHub(failFor: string[] = []) {
  const nudged: string[] = [];
  const ns = {
    idFromName: (name: string) => name,
    get: (id: string) => ({
      fetch: async (req: Request) => {
        nudged.push(`${id} ${req.method} ${new URL(req.url).pathname}`);
        if (failFor.includes(id)) throw new Error("object unavailable");
        return new Response("ok");
      },
    }),
  };
  return { ns: ns as unknown as DurableObjectNamespace, nudged };
}

const envWith = (over: Partial<Env>): Env =>
  ({ ENVIRONMENT: "test", ALLOWED_EMAILS: "", ...over }) as unknown as Env;

describe("notifyNewMail", () => {
  it("nudges one hub per allowlisted owner, keyed by the lowercased address", async () => {
    const hub = fakeHub();
    await notifyNewMail(envWith({ MAILBOX_HUB: hub.ns, ALLOWED_EMAILS: " Tung@Example.com, other@example.com " }));

    expect(hub.nudged).toEqual(["tung@example.com POST /notify", "other@example.com POST /notify"]);
  });

  it("uses a single shared hub when the app is open to the whole Access team", async () => {
    const hub = fakeHub();
    await notifyNewMail(envWith({ MAILBOX_HUB: hub.ns, ALLOWED_EMAILS: "" }));
    expect(hub.nudged).toEqual(["team POST /notify"]);
  });

  it("resolves even when an owner's object is unreachable", async () => {
    const hub = fakeHub(["bad@example.com"]);
    await expect(notifyNewMail(envWith({ MAILBOX_HUB: hub.ns, ALLOWED_EMAILS: "bad@example.com, good@example.com" }))).resolves.toBeUndefined();
    expect(hub.nudged).toHaveLength(2);
  });

  it("is a no-op where the binding does not exist, so local runs and tests do not need it", async () => {
    await expect(notifyNewMail(envWith({}))).resolves.toBeUndefined();
  });
});

describe("notifySendFailed", () => {
  it("nudges the same owner hubs, on the send-failed route", async () => {
    const hub = fakeHub();
    await notifySendFailed(envWith({ MAILBOX_HUB: hub.ns, ALLOWED_EMAILS: " Tung@Example.com " }));
    expect(hub.nudged).toEqual(["tung@example.com POST /notify-send-failed"]);
  });

  it("survives an unavailable hub — a nudge must never break the delivery that sent it", async () => {
    const hub = fakeHub(["tung@example.com"]);
    await expect(
      notifySendFailed(envWith({ MAILBOX_HUB: hub.ns, ALLOWED_EMAILS: "tung@example.com" })),
    ).resolves.toBeUndefined();
  });
});
