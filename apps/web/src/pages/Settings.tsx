import { withStepUp } from "../lib/passkeys";
import { useCallback, useEffect, useState } from "react";
import { api, ApiClientError } from "../lib/api";
import { disablePush, enablePush, pushState, type PushState } from "../lib/push";
import { registerPasskey, removePasskey } from "../lib/passkeys";
import { useAsync } from "../lib/useAsync";
import { relativeTime } from "../lib/format";
import { LANGS, lang, languageName, setLang, t, type Lang } from "../lib/i18n";
import { THEME_CHOICES, setTheme, theme, themeName, useTheme, type ThemeChoice } from "../lib/theme";
import { insightsOpen, setInsightsOpen } from "../lib/insights";
import { IconAuto, IconMoon, IconSun } from "../components/Icons";

type Status = { tone: "ok" | "error"; text: string } | null;

const errText = (e: unknown) =>
  e instanceof ApiClientError ? e.message : e instanceof Error ? e.message : t("set.requestFailed");

/**
 * How the interface looks. One card, because language, light/dark and whether a message's
 * detail panels start open are the same kind of choice — a way of reading, stored on this
 * device only, that changes nothing about what the server stores or accepts.
 */
function AppearanceCard() {
  const current = lang();
  const { choice } = useTheme();
  const [insights, setInsights] = useState(() => insightsOpen());
  return (
    <div className="card">
      <h2 style={{ marginTop: 0 }}>{t("set.appearanceTitle")}</h2>

      <div className="setting-row">
        <span className="label">
          <b>{t("set.langTitle")}</b>
          <span className="faint">{t("set.langHint")}</span>
        </span>
        <div className="seg" role="group" aria-label={t("set.langLabel")}>
          {LANGS.map((l: Lang) => (
            <button
              key={l}
              type="button"
              className={current === l ? "active" : ""}
              onClick={() => setLang(l)}
            >
              {languageName(l)}
            </button>
          ))}
        </div>
      </div>

      <div className="setting-row">
        <span className="label">
          <b>{t("set.themeTitle")}</b>
          <span className="faint">{t("set.themeHint")}</span>
        </span>
        <div className="seg" role="group" aria-label={t("set.themeLabel")}>
          {THEME_CHOICES.map((c: ThemeChoice) => {
            const Glyph = c === "paper" ? IconSun : c === "graphite" ? IconMoon : IconAuto;
            return (
              <button
                key={c}
                type="button"
                className={choice === c ? "active" : ""}
                onClick={() => setTheme(c)}
              >
                <Glyph size={16} />
                {t(`theme.${c}`)}
              </button>
            );
          })}
        </div>
      </div>

      <div className="setting-row">
        <span className="label">
          <b>{t("set.insightsTitle")}</b>
          <span className="faint">{t("set.insightsHint")}</span>
        </span>
        <div className="seg" role="group" aria-label={t("set.insightsLabel")}>
          <button
            type="button"
            className={!insights ? "active" : ""}
            onClick={() => {
              setInsights(false);
              setInsightsOpen(false);
            }}
          >
            {t("set.insightsFold")}
          </button>
          <button
            type="button"
            className={insights ? "active" : ""}
            onClick={() => {
              setInsights(true);
              setInsightsOpen(true);
            }}
          >
            {t("set.insightsOpen")}
          </button>
        </div>
      </div>

      <p className="faint" style={{ fontSize: 12, margin: 0 }}>
        {t("set.themeNow")} · {themeName(theme())}
      </p>
    </div>
  );
}

/**
 * Passkeys are what make an irreversible action cost more than a session cookie. The
 * browser prompts for them, so the only way to add one is a real gesture here.
 */
function PasskeysCard() {
  const { data, loading, reload } = useAsync(() => api.securityStatus(), []);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<Status>(null);
  const supported = typeof window !== "undefined" && "PublicKeyCredential" in window;

  async function add() {
    setBusy(true);
    setStatus(null);
    try {
      await registerPasskey();
      setStatus({ tone: "ok", text: t("set.passRegistered") });
      reload();
    } catch (e) {
      setStatus({ tone: "error", text: errText(e) });
    } finally {
      setBusy(false);
    }
  }

  async function drop(id: string) {
    setBusy(true);
    setStatus(null);
    try {
      await removePasskey(id);
      setStatus({ tone: "ok", text: t("set.passRemoved") });
      reload();
    } catch (e) {
      setStatus({ tone: "error", text: errText(e) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card mt">
      <h2 style={{ marginTop: 0 }}>{t("set.passTitle")}</h2>
      <p className="muted" style={{ marginTop: 0 }}>
        {t("set.passIntro")}
      </p>

      {loading && !data ? (
        <p className="faint">{t("common.loading")}</p>
      ) : (
        <>
          {data && data.passkeys.length > 0 ? (
            <ul className="msglist">
              {data.passkeys.map((p) => (
                <li key={p.id} className="entity">
                  <div className="entity-summary">
                    <div className="entity-id">
                      <div className="entity-name">{p.deviceLabel || t("set.passWord")}</div>
                      <div className="entity-facts">
                        <span>{t("set.added", { at: relativeTime(p.createdAt) })}</span>
                        <span>
                          {p.lastUsedAt
                            ? t("set.lastUsed", { at: relativeTime(p.lastUsedAt) })
                            : t("set.neverUsed")}
                        </span>
                        {p.transports?.length ? <span>{p.transports.join(", ")}</span> : null}
                      </div>
                    </div>
                    <button className="ghost small" disabled={busy} onClick={() => drop(p.id)}>
                      {t("common.remove")}
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <div className="banner">{t("set.passNone")}</div>
          )}

          {status && (
            <div className={`banner ${status.tone === "ok" ? "ok" : "error"}`}>{status.text}</div>
          )}

          <div className="row wrap" style={{ marginTop: 12 }}>
            <button className="primary" disabled={busy || !supported} onClick={add}>
              {t(data?.passkeys.length ? "set.passAddAnother" : "set.passRegister")}
            </button>
          </div>

          {!supported && (
            <p className="faint" style={{ fontSize: 12 }}>
              {t("set.passUnsupported")}
            </p>
          )}
          {data?.rpId && (
            <p className="faint" style={{ fontSize: 12 }}>
              {t("set.passBoundA")}
              <span className="addr">{data.rpId}</span>
              {t("set.passBoundB")}
            </p>
          )}
        </>
      )}
    </div>
  );
}

/**
 * The one setting that copies message content somewhere else, so the card says what it
 * does before it offers a button.
 */
function SemanticCard() {
  const { data, reload } = useAsync(() => api.semanticStatus(), []);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<Status>(null);

  async function set(on: boolean) {
    setBusy(true);
    setStatus(null);
    try {
      const r = await (on ? api.semanticSet(on) : withStepUp(() => api.semanticSet(on)));
      setStatus({ tone: "ok", text: on ? t("set.semOnNew") : t("set.semOff", { n: r.purged }) });
      reload();
    } catch (e) {
      setStatus({ tone: "error", text: errText(e) });
    } finally {
      setBusy(false);
    }
  }

  async function fill() {
    setBusy(true);
    setStatus(null);
    try {
      let r = await api.semanticBackfill();
      let done = r.indexed;
      // 50 at a time keeps each request short; the loop stops when nothing is left.
      while (r.indexed > 0 && r.remaining > 0 && done < 500) {
        r = await api.semanticBackfill();
        done += r.indexed;
      }
      setStatus({ tone: "ok", text: t("set.semIndexed", { n: done, r: r.remaining }) });
      reload();
    } catch (e) {
      setStatus({ tone: "error", text: errText(e) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card mt">
      <h2 style={{ marginTop: 0 }}>{t("set.semTitle")}</h2>
      <p className="muted" style={{ marginTop: 0 }}>
        {t("set.semIntro")}
      </p>

      <table style={{ marginBottom: 12 }}>
        <tbody>
          <tr>
            <td className="muted">{t("set.semState")}</td>
            <td>{data ? t(data.enabled ? "set.semOn" : "set.semOffWord") : t("common.dash")}</td>
          </tr>
          <tr>
            <td className="muted">{t("set.semIndexedLabel")}</td>
            <td>{data ? t("set.semOf", { i: data.indexed, t: data.total }) : t("common.dash")}</td>
          </tr>
          <tr>
            <td className="muted">{t("set.semModel")}</td>
            <td className="addr">
              {data?.model ?? t("common.dash")} ·{" "}
              {t("set.semDims", { n: data?.dimensions ?? t("common.dash") })}
            </td>
          </tr>
        </tbody>
      </table>

      {status && (
        <div className={`banner ${status.tone === "ok" ? "ok" : "error"}`}>{status.text}</div>
      )}

      <div className="row wrap" style={{ marginTop: 12 }}>
        {data?.enabled ? (
          <button disabled={busy} onClick={() => set(false)}>
            {t("set.semTurnOff")}
          </button>
        ) : (
          <button className="primary" disabled={busy || !data?.available} onClick={() => set(true)}>
            {t("set.semTurnOn")}
          </button>
        )}
        {data?.enabled && (
          <button className="small" disabled={busy} onClick={fill}>
            {t("set.semBackfill")}
          </button>
        )}
      </div>
      {data && !data.available && (
        <p className="faint" style={{ fontSize: 12 }}>
          {t("set.semUnavailable")}
        </p>
      )}
    </div>
  );
}

/** R1-A3: Sync may itself enable mail on newly discovered zones preflight clears. The
 * guardrail is structural, not a promise in prose: provisionDomain refuses anything short
 * of a clean zone without the owner's takeover confirmations, so auto mode can never
 * take over an MX or a catch-all. */
function AutoProvisionCard() {
  const { data, error, loading, reload } = useAsync(() => api.getAutoProvision(), []);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ tone: "ok" | "error"; text: string } | null>(null);

  async function set(enabled: boolean) {
    setBusy(true);
    setStatus(null);
    try {
      await api.setAutoProvision(enabled);
      setStatus({ tone: "ok", text: t(enabled ? "set.apOn" : "set.apOff") });
      reload();
    } catch (e) {
      setStatus({ tone: "error", text: e instanceof Error ? e.message : "error" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card mt">
      <h2 style={{ marginTop: 0 }}>{t("set.apTitle")}</h2>
      <p className="muted" style={{ marginTop: 0 }}>
        {t("set.apIntro")}
      </p>
      {error && <div className="banner error">{error}</div>}
      {loading && <div className="banner">{t("common.loading")}</div>}
      {data && (
        <div className="row wrap" style={{ marginTop: 12 }}>
          {data.enabled ? (
            <button disabled={busy} onClick={() => set(false)}>
              {t("set.apTurnOff")}
            </button>
          ) : (
            <button className="primary" disabled={busy} onClick={() => set(true)}>
              {t("set.apTurnOn")}
            </button>
          )}
        </div>
      )}
      {status && (
        <div className={`banner ${status.tone === "ok" ? "ok" : "error"}`} style={{ marginTop: 12 }}>
          {status.text}
        </div>
      )}
    </div>
  );
}

export function Settings() {

  const [state, setState] = useState<PushState | null>(null);
  // Every browser holding a subscription, readable by name — the endpoint never leaves
  // the server (D4).
  const { data: devices, reload: reloadDevices } = useAsync(() => api.pushDevices(), []);
  const [server, setServer] = useState<{ enabled: boolean; subscriptions: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<Status>(null);

  const refresh = useCallback(async () => {
    const [local, remote] = await Promise.all([pushState(), api.pushStatus().catch(() => null)]);
    setState(local);
    setServer(remote);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function run(action: () => Promise<{ ok: boolean; message: string }>) {
    setBusy(true);
    setStatus(null);
    try {
      const result = await action();
      setStatus({ tone: result.ok ? "ok" : "error", text: result.message });
      await refresh();
    } catch (e) {
      setStatus({
        tone: "error",
        text: e instanceof ApiClientError ? e.message : t("set.requestFailed"),
      });
    } finally {
      setBusy(false);
    }
  }

  const subscribed = !!state?.subscribed;
  const configured = server?.enabled ?? false;

  return (
    <div className="page">
      <div className="page-head">
        <h1>{t("set.title")}</h1>
      </div>

      <AppearanceCard />

      <div className="card mt">
        <h2 style={{ marginTop: 0 }}>{t("set.notifTitle")}</h2>
        <p className="muted" style={{ marginTop: 0 }}>
          {t("set.notifIntro")}
        </p>

        <table style={{ marginBottom: 12 }}>
          <tbody>
            <tr>
              <td className="muted">{t("set.server")}</td>
              <td>{t(configured ? "set.pushOn" : "set.pushOff")}</td>
            </tr>
            <tr>
              <td className="muted">{t("set.browser")}</td>
              <td>
                {subscribed
                  ? t("set.subscribed")
                  : t("set.notSubscribed") +
                    (state && state.permission !== "default"
                      ? ` · ${t("set.permission", { p: state.permission })}`
                      : "")}
              </td>
            </tr>
            <tr>
              <td className="muted">{t("set.devices")}</td>
              <td>{devices ? String(devices.items.length) : server ? String(server.subscriptions) : t("common.dash")}</td>
            </tr>
          </tbody>
        </table>

        {devices && devices.items.length > 0 ? (
          <ul className="device-list">
            {devices.items.map((d) => (
              <li key={d.id}>
                <input
                  aria-label={t("set.deviceName")}
                  defaultValue={d.label ?? ""}
                  placeholder={d.userAgent ? d.userAgent.slice(0, 60) : t("set.unknownDevice")}
                  onBlur={(e) => {
                    const label = e.target.value.trim();
                    if (label === (d.label ?? "")) return;
                    void api.labelPushDevice(d.id, label).then(reloadDevices);
                  }}
                />
                <span className="faint">
                  {d.fails > 0 ? t("set.deviceFailing", { n: d.fails }) : t("set.deviceOk")}
                </span>
                <button
                  className="ghost small"
                  onClick={() => {
                    void api.revokePushDevice(d.id).then(() => {
                      reloadDevices();
                    });
                  }}
                >
                  {t("set.deviceRevoke")}
                </button>
              </li>
            ))}
          </ul>
        ) : null}

        {status && (
          <div className={`banner ${status.tone === "ok" ? "ok" : "error"}`}>{status.text}</div>
        )}

        <div className="row wrap" style={{ marginTop: 12 }}>
          {!subscribed && (
            <button
              className="primary"
              disabled={busy || !configured}
              onClick={() => run(enablePush)}
            >
              {t("set.turnOn")}
            </button>
          )}
          {subscribed && (
            <button disabled={busy} onClick={() => run(disablePush)}>
              {t("set.turnOff")}
            </button>
          )}
          {subscribed && (
            <button
              className="small"
              disabled={busy}
              onClick={() =>
                run(async () => {
                  const r = await api.pushTest();
                  return {
                    ok: r.sent > 0,
                    message: r.sent
                      ? t("set.testSent", { n: r.sent })
                      : t("set.testNone", {
                          skip: r.skipped ? t("set.testSkip", { n: r.skipped }) : "",
                        }),
                  };
                })
              }
            >
              {t("set.test")}
            </button>
          )}
        </div>
        {state?.support === "unsupported" && (
          <p className="faint" style={{ fontSize: 12 }}>
            {t("set.unsupported")}
          </p>
        )}
        {state?.support === "insecure" && (
          <p className="faint" style={{ fontSize: 12 }}>
            {t("set.insecure")}
          </p>
        )}
      </div>

      <PasskeysCard />
      <AutoProvisionCard />
      <SemanticCard />

      <div className="card mt">
        <h2 style={{ marginTop: 0 }}>{t("set.installTitle")}</h2>
        <p className="muted" style={{ marginBottom: 0 }}>
          {t("set.installBody")}
        </p>
      </div>
    </div>
  );
}
