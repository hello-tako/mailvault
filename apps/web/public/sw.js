/*
 * MailVault service worker: offline shell + new-mail notifications.
 *
 * Nothing under /api/ is ever cached — an inbox left in the browser cache would be a
 * second, unaccessed copy of private mail. Navigations are network-first and fall back
 * to the cached shell only when offline.
 */
const CACHE = "mailvault-shell-v1";
const SHELL_URLS = ["/", "/icons/icon-192.png", "/icons/icon-512.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL_URLS)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

async function cacheLater(request, response) {
  if (!response || !response.ok || response.type !== "basic") return;
  const cache = await caches.open(CACHE);
  await cache.put(request, response.clone());
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/")) return;

  if (request.mode === "navigate") {
    // no-store: a deploy must reach an installed client on the next open. Without it the
    // HTTP cache can answer with the previous index.html, which points at the previous
    // hashed bundle — i.e. the app silently runs an old UI. Offline still falls back.
    event.respondWith(
      fetch(request, { cache: "no-store" })
        .then((response) => {
          void cacheLater(request, response);
          return response;
        })
        .catch(async () => (await caches.match(request)) || (await caches.match("/")) || Response.error()),
    );
    return;
  }

  event.respondWith(
    caches.match(request).then((hit) => {
      if (hit) return hit;
      return fetch(request).then((response) => {
        void cacheLater(request, response);
        return response;
      });
    }),
  );
});

/*
 * New-mail notification.
 *
 * The push itself stays payload-free: the device is told "something arrived", never what
 * it says. The content is fetched afterwards through the authenticated API, so it crosses
 * the Access gate exactly like the inbox does and a push service sees only an empty POST.
 *
 * Three rules keep that useful rather than leaking:
 * - only a TRUSTED sender (SPF/DKIM/DMARC aligned with From) is ever quoted, because a
 *   spoofed message choosing its own lock-screen text is precisely the attack;
 * - only sender and subject — never the body, and a code or URL inside the subject is
 *   masked, because "Your verification code is 55905149" is a real subject line;
 * - only mail that arrived in the last few minutes, so a ping delivered after a laptop
 *   wakes does not surface an old message as if it were new.
 * Anything missing (signed out, no session, odd response) falls back to the generic note.
 */
const NEW_MAIL_WINDOW_MS = 5 * 60 * 1000;

/*
 * The strings the worker writes onto a lock screen. It shares no code with the app bundle
 * and cannot read localStorage, so the app pushes its language choice in a message; until
 * one arrives the worker falls back to the browser language, which is what the app itself
 * would have started with.
 */
const NOTE_COPY = {
  en: { arrived: "New mail arrived", noSubject: "(no subject)" },
  vi: { arrived: "Thư mới đã tới", noSubject: "(không có chủ đề)" },
};
let uiLang = null;

function noteCopy() {
  if (uiLang === "en" || uiLang === "vi") return NOTE_COPY[uiLang];
  const browser = (self.navigator && self.navigator.language) || "en";
  return String(browser).toLowerCase().startsWith("vi") ? NOTE_COPY.vi : NOTE_COPY.en;
}

function genericNote() {
  return { title: "MailVault", body: noteCopy().arrived, tag: "mailvault-new-mail", renotify: true, url: "/#/inbox" };
}

self.addEventListener("message", (event) => {
  const data = event.data;
  if (data && data.type === "mailvault-lang" && (data.value === "en" || data.value === "vi")) uiLang = data.value;
});

function setNoteLang(value) {
  uiLang = value === "en" || value === "vi" ? value : null;
}

function senderLabel(item) {
  const raw = item.headerFrom || item.envelopeFrom || "";
  const quoted = /^\s*([^<]*?)\s*</.exec(raw);
  const name = quoted && quoted[1] ? quoted[1].replace(/^"|"$/g, "").trim() : "";
  return name || raw.split("@")[0] || "MailVault";
}

function pickNewMail(items, now) {
  let best = null;
  let bestAt = 0;
  for (const item of items || []) {
    if (!item || item.isRead || item.authVerdict !== "TRUSTED") continue;
    const at = Date.parse(item.receivedAt || "");
    if (!Number.isFinite(at) || now - at > NEW_MAIL_WINDOW_MS || at > now + 60_000) continue;
    if (at > bestAt) {
      best = item;
      bestAt = at;
    }
  }
  return best;
}

/*
 * The subject is the useful part of a notification and also where senders put the secret:
 * "Your GitHub verification code is 55905149" is a real subject line. So the code the server
 * already identified is masked, URLs become a word rather than a truncated address you
 * could be tempted to tap, and long subjects stop at a reasonable length.
 */
function safeSubject(item) {
  let subject = String(item.subject || "").replace(/\s+/g, " ").trim();
  if (!subject) return noteCopy().noSubject;
  subject = subject.replace(/https?:\/\/\S+/gi, "[link]");
  const code = item.primaryCode;
  if (code && typeof code === "string" && subject.indexOf(code) !== -1) {
    subject = subject.split(code).join("••••••");
  }
  return subject.length > 120 ? subject.slice(0, 119) + "…" : subject;
}

async function newMailNote() {
  let response;
  try {
    response = await fetch("/api/messages?filter=unread&limit=10", { credentials: "same-origin", cache: "no-store" });
  } catch {
    return genericNote(); // offline, or the network refused
  }
  if (!response.ok) return genericNote(); // signed out, or Access answered instead of the API
  let body;
  try {
    body = await response.json();
  } catch {
    return genericNote();
  }
  const picked = pickNewMail(body && body.items, Date.now());
  if (!picked) return genericNote();
  return {
    title: senderLabel(picked),
    body: safeSubject(picked),
    // One stack rather than a spiral (D3): renotify replaces the previous notification,
    // while the deep link still opens this exact message.
    tag: "mailvault-new-mail",
    renotify: true,
    url: "/#/messages/" + picked.id,
  };
}

self.addEventListener("push", (event) => {
  event.waitUntil(
    newMailNote().then((note) =>
      self.registration.showNotification(note.title, {
        actions: [
          { action: "read", title: "Mark read" },
          { action: "archive", title: "File" },
        ],
        body: note.body,
        icon: "/icons/icon-192.png",
        badge: "/icons/icon-192.png",
        tag: note.tag,
        data: { url: note.url },
      }),
    ),
  );
});

self.addEventListener("notificationclick", (event) => {
  const note = event.notification;
  const id = note.data && note.data.url ? String(note.data.url).split("/").pop() : null;
  if (event.action === "read" || event.action === "archive") {
    // D3: act without opening anything. Same-origin fetches carry the CSRF header the app
    // itself uses; a failed action is a no-op — the app remains the source of truth.
    event.waitUntil(
      (async () => {
        try {
          if (event.action === "read" && id) {
            await fetch(`/api/messages/${id}/read`, {
              method: "PATCH",
              headers: { "content-type": "application/json", "x-mailvault": "1" },
              body: JSON.stringify({ isRead: true }),
            });
          } else if (event.action === "archive" && id) {
            await fetch("/api/messages/bulk", {
              method: "POST",
              headers: { "content-type": "application/json", "x-mailvault": "1" },
              body: JSON.stringify({ action: "archive", ids: [id] }),
            });
          }
        } catch {
          /* no-op: the app stays the source of truth */
        }
        note.close();
      })(),
    );
    return;
  }
  note.close();
  const target = (event.notification.data && event.notification.data.url) || "/";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if ("navigate" in client) {
          void client.navigate(target);
          return client.focus();
        }
      }
      return self.clients.openWindow(target);
    }),
  );
});

/*
 * Seam for tests only (src/lib/notify.test.ts, plus the phone E2E which runs newMailNote()
 * inside the real worker): the runtime never reads this. The push path cannot be driven
 * from a page, and these decisions are the security-relevant part of it.
 */
self.__mailvaultNotify = { newMailNote, pickNewMail, senderLabel, safeSubject, genericNote, setNoteLang };
