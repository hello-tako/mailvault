import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

/*
 * The notification content is chosen by the service worker, not the server: the push is
 * payload-free and the worker fetches through the authenticated API. These are the rules
 * that decide what appears on a lock screen, so they are tested directly against the
 * worker's own code (public/sw.js exposes a seam for this and nothing reads it at runtime).
 */

type Summary = Record<string, unknown>;

interface Notify {
  newMailNote: () => Promise<{ title: string; body: string; tag: string; url: string; renotify?: boolean }>;
  pickNewMail: (items: Array<Summary | null> | null, now: number) => Summary | null;
  senderLabel: (item: Summary) => string;
  safeSubject: (item: Summary) => string;
  genericNote: () => { title: string; body: string; tag: string; url: string };
  setNoteLang: (value: string | null) => void;
}

function api(): Notify {
  const holder = globalThis as unknown as { __mailvaultNotify?: Notify };
  if (!holder.__mailvaultNotify) throw new Error("service worker seam is missing");
  return holder.__mailvaultNotify;
}

const MINUTE = 60_000;
const NOW = Date.parse("2026-09-19T15:00:00.000Z");

function mail(id: string, over: Summary = {}): Summary {
  return {
    id,
    isRead: false,
    authVerdict: "TRUSTED",
    headerFrom: "GitHub <noreply@github.com>",
    envelopeFrom: "noreply@github.com",
    subject: "Your verification code",
    receivedAt: new Date(NOW - MINUTE).toISOString(),
    primaryCode: "55905149",
    ...over,
  };
}

beforeAll(async () => {
  const path = "../../public/sw.js";
  await import(/* @vite-ignore */ path);
});

describe("sender label", () => {
  it("uses the display name, and falls back to the mailbox", () => {
    expect(api().senderLabel(mail("a", { headerFrom: '"Example Cloud Security" <no-reply@cloud.example>' }))).toBe(
      "Example Cloud Security",
    );
    expect(api().senderLabel(mail("b", { headerFrom: null }))).toBe("noreply");
  });
});

describe("which message may be quoted", () => {
  it("picks the newest trusted unread message inside the window", () => {
    const items = [
      mail("old", { receivedAt: new Date(NOW - 40 * MINUTE).toISOString() }),
      mail("new", { receivedAt: new Date(NOW - 30 * 1000).toISOString() }),
      mail("mid", { receivedAt: new Date(NOW - 3 * MINUTE).toISOString() }),
    ];
    expect(api().pickNewMail(items, NOW)?.id).toBe("new");
  });

  it("never quotes a message that failed sender authentication", () => {
    const spoofed = mail("x", { authVerdict: "SPOOFED", subject: "Your account will close" });
    expect(api().pickNewMail([spoofed], NOW)).toBeNull();
    expect(api().pickNewMail([spoofed, mail("y")], NOW)?.id).toBe("y");
  });

  it("ignores read mail, clock-skewed futures, and junk rows", () => {
    expect(api().pickNewMail([mail("r", { isRead: true })], NOW)).toBeNull();
    expect(api().pickNewMail([mail("f", { receivedAt: new Date(NOW + 10 * MINUTE).toISOString() })], NOW)).toBeNull();
    expect(api().pickNewMail([null, {}, mail("z", { receivedAt: "not a date" })], NOW)).toBeNull();
    expect(api().pickNewMail(null, NOW)).toBeNull();
  });
});

describe("subject hygiene", () => {
  it("collapses the sender's line wrapping, and leaves a plain subject alone", () => {
    expect(api().safeSubject(mail("s", { subject: "Re:   your\n  ticket #4417" }))).toBe("Re: your ticket #4417");
  });

  it("masks only the code the server identified, not any number", () => {
    expect(api().safeSubject(mail("s", { subject: "Order 4417 shipped", primaryCode: "55905149" }))).toBe(
      "Order 4417 shipped",
    );
    expect(api().safeSubject(mail("s", { subject: "Code 55905149", primaryCode: null }))).toBe("Code 55905149");
  });

  it("truncates a subject long enough to fill a lock screen", () => {
    const long = api().safeSubject(mail("s", { subject: "x".repeat(400) }));
    expect(long.length).toBe(120);
    expect(long.endsWith("…")).toBe(true);
  });
});

describe("building the notification", () => {
  const note = async (impl: () => Response | Promise<Response>) => {
    globalThis.fetch = vi.fn(impl) as unknown as typeof fetch;
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    try {
      return await api().newMailNote();
    } finally {
      vi.useRealTimers();
    }
  };

  it("asks the authenticated API, and deep-links to that message", async () => {
    const items = [mail("m7", { receivedAt: new Date(NOW - 20_000).toISOString() })];
    const result = await note(() => Response.json({ items, total: 1 }));
    expect(result.title).toBe("GitHub");
    expect(result.body).toBe("Your verification code");
    expect(result.url).toBe("/#/messages/m7");
    // D3: one stack, not a spiral — renotify replaces, the deep link still lands on m7.
    expect(result.tag).toBe("mailvault-new-mail");
    expect(result.renotify).toBe(true);
    expect(globalThis.fetch).toHaveBeenCalledWith("/api/messages?filter=unread&limit=10", expect.objectContaining({ cache: "no-store" }));
  });

  it("masks a code or URL that the sender put in the subject", async () => {
    const items = [mail("m8", { subject: "Code 55905149 open https://github.com/login?token=abc now" })];
    const result = await note(() => Response.json({ items }));
    expect(result.body).toBe("Code •••••• open [link] now");
    expect(JSON.stringify(result)).not.toContain("55905149");
    expect(JSON.stringify(result)).not.toContain("github.com/login");
  });

  it("falls back to the generic note when signed out, offline, or holding nothing new", async () => {
    const generic = api().genericNote();
    expect(generic.body).toBe("New mail arrived");
    expect(await note(() => new Response("nope", { status: 403 }))).toEqual(generic);
    expect(await note(() => Promise.reject(new Error("offline")))).toEqual(generic);
    expect(await note(() => Response.json({ items: [mail("m9", { authVerdict: "UNVERIFIED" })] }))).toEqual(generic);
    expect(await note(() => new Response("<html>Access</html>"))).toEqual(generic);
  });

  it("says (no subject) rather than showing an empty notification", async () => {
    const items = [mail("m10", { subject: null })];
    expect((await note(() => Response.json({ items }))).body).toBe("(no subject)");
  });

  /*
   * The worker cannot read localStorage, so a language the owner picked in Settings reaches
   * it only as a message. Both notes a push can produce are checked here in each language.
   */
  describe("in the language the app was told", () => {
    afterEach(() => api().setNoteLang(null));

    it("writes the generic note in Vietnamese", async () => {
      api().setNoteLang("vi");
      expect((await note(() => new Response("nope", { status: 403 }))).body).toBe("Thư mới đã tới");
    });

    it("translates the empty-subject placeholder, but never the message's own subject", async () => {
      api().setNoteLang("vi");
      const empty = await note(() => Response.json({ items: [mail("m11", { subject: null })] }));
      expect(empty.body).toBe("(không có chủ đề)");
      const titled = await note(() =>
        Response.json({ items: [mail("m12", { subject: "Invoice from the shop", receivedAt: new Date(NOW - 20_000).toISOString() })] }),
      );
      expect(titled.body).toBe("Invoice from the shop");
    });

    it("an unrecognized value falls back to the browser language, not to nothing", async () => {
      api().setNoteLang("fr");
      expect((await note(() => new Response("nope", { status: 403 }))).body).toBe("New mail arrived");
    });
  });
});
