import { describe, expect, it, vi } from "vitest";
import type { Env } from "../../src/env";
import { nextAlertState, recordOpsFailure, type AlertState } from "../../src/lib/ops-alert";

const T0 = Date.parse("2026-10-24T12:00:00.000Z");
const HOUR = 60 * 60_000;

describe("nextAlertState", () => {
  it("starts a fresh streak of one on the first failure", () => {
    const { state, shouldAlert } = nextAlertState(null, T0);
    expect(state).toEqual({ count: 1, firstAt: new Date(T0).toISOString(), lastSentAt: null });
    expect(shouldAlert).toBe(false);
  });

  it("does not alert below the threshold: three failures inside an hour is the bar", () => {
    const first = nextAlertState(null, T0).state;
    const second = nextAlertState(first, T0 + 60_000);
    expect(second.shouldAlert).toBe(false);
    const third = nextAlertState(second.state, T0 + 120_000);
    expect(third.state.count).toBe(3);
    expect(third.shouldAlert).toBe(true);
    expect(third.state.lastSentAt).toBe(new Date(T0 + 120_000).toISOString());
  });

  it("keeps counting without a second mail: one alert per pipeline per day", () => {
    let state: AlertState | null = null;
    for (const at of [0, 1, 2, 3, 4].map((m) => T0 + m * 60_000)) {
      state = nextAlertState(state, at).state;
    }
    const again = nextAlertState(state!, T0 + 5 * 60_000);
    expect(again.state.count).toBe(6);
    expect(again.shouldAlert).toBe(false);
    expect(again.state.lastSentAt).toBe(state!.lastSentAt);
  });

  it("alerts again once the cooldown has passed", () => {
    const fired = { count: 3, firstAt: new Date(T0).toISOString(), lastSentAt: new Date(T0 + 2 * 60_000).toISOString() };
    const next = nextAlertState(fired, T0 + 25 * HOUR);
    // The window has lapsed, so this failure is a new streak — but the alert can go out
    // again the moment that streak reaches the threshold.
    expect(next.state.count).toBe(1);
    expect(next.shouldAlert).toBe(false);
    const thirdInNewStreak = nextAlertState(
      { ...next.state, count: 2 },
      T0 + 25 * HOUR + 2 * 60_000,
    );
    expect(thirdInNewStreak.shouldAlert).toBe(true);
  });

  it("a quiet hour starts the streak over rather than accumulating across days", () => {
    const stale = { count: 5, firstAt: new Date(T0 - 2 * HOUR).toISOString(), lastSentAt: null };
    const next = nextAlertState(stale, T0);
    expect(next.state.count).toBe(1);
    expect(next.state.firstAt).toBe(new Date(T0).toISOString());
    expect(next.shouldAlert).toBe(false);
  });
});

describe("recordOpsFailure", () => {
  function envWith(db: D1Database, emails = "tungbipdz@gmail.com"): { env: Env; send: ReturnType<typeof vi.fn> } {
    const send = vi.fn(async () => ({ messageId: "alert" }));
    const env = {
      DB: db,
      ALLOWED_EMAILS: emails,
      EMAIL: { send },
      ANALYTICS: { writeDataPoint: () => undefined },
    } as unknown as Env;
    return { env, send };
  }

  /** A D1 stub with a real key/value memory for app_settings and one sender row. */
  function memoryDb(initial: Record<string, string> = {}, sender: { address: string; via: string | null } | null = { address: "ops@omnipos.tech", via: "send.omnipos.tech" }) {
    const stored = { ...initial };
    // `prepare()` must answer both `.bind(...).first()` (settings) and a bare `.first()`
    // (the sender lookup), exactly like the real D1 binding does.
    const db = {
      prepare(sql: string) {
        const statement = (args: unknown[]) => ({
          async first() {
            if (sql.includes("FROM aliases")) return sender;
            if (sql.includes("app_settings")) return { value: stored[String(args[0])] ?? null };
            return null;
          },
          async run() {
            if (sql.includes("ON CONFLICT")) stored[String(args[0])] = String(args[1]);
          },
        });
        return { ...statement([]), bind: (...args: unknown[]) => statement(args) };
      },
    } as unknown as D1Database;
    return { db, stored };
  }

  it("sends one mail when the streak reaches the threshold, and remembers it sent", async () => {
    const { db, stored } = memoryDb();
    const { env, send } = envWith(db);
    for (let i = 0; i < 3; i++) await recordOpsFailure(env, "ingest-commit", `boom ${i}`);

    expect(send).toHaveBeenCalledTimes(1);
    const call = send.mock.calls[0]![0] as { from: string; to: string[]; subject: string; replyTo?: string };
    expect(call.from).toBe("ops@send.omnipos.tech"); // sends through the domain's own sending name
    expect(call.replyTo).toBe("ops@omnipos.tech"); // answers come back to the alias
    expect(call.to).toEqual(["tungbipdz@gmail.com"]);
    expect(call.subject).toContain("failures"); // the human label; the body names the pipeline
    expect((call as { text: string }).text).toContain("Pipeline: ingest-commit");
    const state = JSON.parse(stored["opsAlert:ingest-commit"]!) as AlertState;
    expect(state.count).toBe(3);
    expect(state.lastSentAt).not.toBeNull();
  });

  it("does not mail again while the cooldown holds", async () => {
    const { db } = memoryDb();
    const { env, send } = envWith(db);
    for (let i = 0; i < 6; i++) await recordOpsFailure(env, "delivery-events", "db down");
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("stays silent when there is no way to send: the metric says skipped, nothing throws", async () => {
    const { db } = memoryDb();
    const { env, send } = envWith(db, "");
    send.mockClear();
    await expect(recordOpsFailure(env, "ingest-commit", "boom")).resolves.toBeUndefined();
    expect(send).not.toHaveBeenCalled();
  });

  it("a database failure inside the alert itself is swallowed, not propagated", async () => {
    const broken = {
      prepare: () => {
        const boom = () => {
          throw new Error("d1 unavailable");
        };
        return { first: boom, run: boom, bind: () => ({ first: boom, run: boom }) };
      },
    } as unknown as D1Database;
    const { env } = envWith(broken);
    await expect(recordOpsFailure(env, "ingest-commit", "boom")).resolves.toBeUndefined();
  });
});
