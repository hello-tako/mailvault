import type { Env } from "../env";

/**
 * One websocket hub per owner.
 *
 * Its whole job is to say "something new happened" to the tabs that are already open, so
 * that the browser can go and ask through the normal authenticated API. Nothing about the
 * message itself crosses this socket — no sender, no subject, no code — which is the same
 * boundary the push notifications honour.
 *
 * The instance id is derived from the owner's email, so two identities on the same team
 * never share a hub even though the payload is only a nudge.
 */
export class MailboxHub implements DurableObject {
  constructor(
    private readonly state: DurableObjectState,
    private readonly env: Env,
  ) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/connect") {
      // `Object.values` on a WebSocketPair is typed as possibly-empty by the Workers
      // types; the runtime always hands back the client/server pair.
      const [client, server] = Object.values(new WebSocketPair()) as [WebSocket, WebSocket];
      // Accepted here rather than by the caller: the socket's lifetime belongs to this
      // isolate, and `getWebSockets()` is the authoritative list after a restart.
      this.state.acceptWebSocket(server);
      server.send(JSON.stringify({ type: "hello" }));
      return new Response(null, { status: 101, webSocket: client });
    }

    if (url.pathname === "/notify") {
      this.broadcast({ type: "new-mail" });
      return new Response("ok", { status: 200 });
    }

    return new Response("not found", { status: 404 });
  }

  /** The client pings to keep proxies from idling the socket out; reply so it can tell a
   *  dead connection from a quiet one. */
  async websocketMessage(connection: WebSocket, message: string | ArrayBuffer): Promise<void> {
    // The client pings to keep proxies from idling the socket out; answering lets it tell
    // a quiet connection from a dead one. Anything else needs no action: a browser that
    // stops responding is dropped by the close handler.
    if (typeof message === "string" && message.trim() === "ping") {
      try {
        connection.send("pong");
      } catch {
        // A socket that cannot be written to is on its way out anyway.
      }
    }
  }

  websocketClose(_connection: WebSocket): void {
    // `getWebSockets()` no longer lists it, so there is nothing to clean up.
  }

  /**
   * Best-effort fan-out. A socket that throws on send is terminated rather than left to
   * fail on every future message, and one dead client must never stop the others.
   */
  private broadcast(payload: Record<string, unknown>): void {
    const body = JSON.stringify(payload);
    for (const socket of this.state.getWebSockets()) {
      try {
        socket.send(body);
      } catch {
        try {
          socket.close(1011, "send failed");
        } catch {
          /* already gone */
        }
      }
    }
  }
}

/**
 * Nudge every configured owner's open tabs. Called after a message is committed, never
 * before: a notification for mail that failed to store would be a lie the inbox then has
 * to take back.
 */
export async function notifyNewMail(env: Env): Promise<void> {
  const hub = env.MAILBOX_HUB;
  if (!hub) return;
  const owners = (env.ALLOWED_EMAILS ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  // With no allowlist the app is open to the whole Access team, which is one shared
  // mailbox and so one shared hub.
  const targets = owners.length > 0 ? owners : ["team"];
  await Promise.allSettled(
    targets.map((owner) => {
      const stub = hub.get(hub.idFromName(owner));
      return stub.fetch(new Request("https://hub/notify", { method: "POST" }));
    }),
  );
}
