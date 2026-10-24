import { useMemo } from "react";
import { api } from "../lib/api";
import { Link, navigate } from "../lib/router";
import { useAsync } from "../lib/useAsync";
import { relativeTime } from "../lib/format";
import { splitMailboxes } from "../lib/mailboxes";
import { t } from "../lib/i18n";
import { useLiveStatus } from "../lib/live";
import { ErrorBanner, SkeletonList } from "../components/ui";
import { MsgItem } from "../components/MessageRow";
import { MailStatus, type MailboxStat } from "@mailvault/shared";

function MailboxCard({ m }: { m: MailboxStat }) {
  const receiving = m.mailStatus === MailStatus.Ready;
  return (
    <Link to={`/inbox?domain=${m.domainId}`} className="mailbox">
      <span className="mailbox-name">{m.name}</span>
      <span className="mailbox-facts">
        <span>{t("common.nMessages", { n: m.total })}</span>
        {m.unread > 0 ? <span className="pill ready">{t("common.nUnread", { n: m.unread })}</span> : null}
        {m.lastReceivedAt ? <span>{t("common.last", { at: relativeTime(m.lastReceivedAt) })}</span> : null}
        {!receiving ? <span className="pill conflict">{t("dash.notReceiving")}</span> : null}
      </span>
    </Link>
  );
}

export function Dashboard() {
  const { data, error, loading } = useAsync(() => api.dashboard(), []);
  const { data: health } = useAsync(() => api.health(), []);
  const live = useLiveStatus();

  const split = useMemo(() => splitMailboxes(data?.mailboxes ?? []), [data]);
  const hidden = split.overflow.length + split.empty.length;
  const latest = useMemo(
    () => (data?.mailboxes ?? []).map((m) => m.lastReceivedAt).filter(Boolean).sort().at(-1),
    [data],
  );

  const status = health ? (health.ok ? "dash.online" : "dash.degraded") : "dash.checking";
  const unread = data?.unreadMessages ?? 0;

  return (
    <div className="page">
      <div className="page-head">
        <h1>{t("dash.title")}</h1>
      </div>

      {error && <ErrorBanner message={error} />}
      {loading && !data && <SkeletonList rows={3} />}

      {data && (
        <>
          {/* The one band that answers the two questions this app exists for: is anything
              waiting for me, and is the post still arriving where it should. */}
          <section className="vault">
            <div style={{ minWidth: 0 }}>
              <div className="vault-top">
                <span
                  className={`live-dot ${health ? (health.ok ? "" : "warn") : "idle"} ${live === "live" && health?.ok ? "is-pulsing" : ""}`}
                />
                <span className="eyebrow">{t(status)}</span>
              </div>
              <div className="vault-figure">
                <span className="num">{unread > 0 ? unread : data.totalMessages}</span>
                <span className="unit">{t(unread > 0 ? "dash.unitUnread" : "dash.unitStored")}</span>
              </div>
              <ul className="vault-facts">
                <li>
                  <strong>{data.activeDomains}</strong> {t("dash.domainsReceive", { n: data.totalDomains })}
                </li>
                <li>
                  <strong>{data.totalAliases}</strong> {t("dash.aliases")}
                </li>
                {/* The unread count is never repeated here: the figure above is that number
                    whenever there is one, and a second copy of it reads as a second fact. */}
                {latest ? <li>{t("common.last", { at: relativeTime(latest) })}</li> : null}
              </ul>
            </div>
            <div className="vault-actions">
              <button className="primary" onClick={() => navigate("/aliases?new=1")}>
                {t("dash.newAlias")}
              </button>
              <button className="ghost" onClick={() => navigate("/inbox")}>
                {t("dash.allMail")}
              </button>
            </div>
          </section>

          {health && !health.ok && (
            <div className="banner error">
              {t("dash.healthFail", {
                what:
                  [
                    health.checks?.d1 === "error" && t("dash.hcD1"),
                    health.checks?.r2 === "error" && t("dash.hcR2"),
                    health.checks?.token === "error" && t("dash.hcToken"),
                  ]
                    .filter(Boolean)
                    .join(", ") || t("dash.hcAny"),
              })}
            </div>
          )}

          <div className="card card--flush">
            <div className="list-head">
              <h2 style={{ margin: 0 }}>{t("dash.mailboxes")}</h2>
              <span className="faint" style={{ fontSize: 13 }}>
                {t("dash.mailboxHint")}
              </span>
            </div>
            <div style={{ padding: "var(--space-2)" }}>
              {split.shown.length === 0 ? (
                <div className="muted" style={{ fontSize: 14 }}>
                  {t("dash.empty")}
                </div>
              ) : (
                <div className="mailboxes">
                  {split.shown.map((m) => (
                    <MailboxCard key={m.domainId} m={m} />
                  ))}
                </div>
              )}
              {hidden > 0 && (
                <details className="more-mailboxes">
                  <summary>
                    {t("dash.otherDomains", {
                      n: hidden,
                      plural: t(hidden === 1 ? "dash.wordDomain" : "dash.wordDomains"),
                    })}
                    {/* Only worth saying when it is not obvious from the count above it. */}
                    {split.empty.length > 0 && split.empty.length !== hidden
                      ? ` ${t("dash.noMailYet", { n: split.empty.length })}`
                      : ""}
                  </summary>
                  <div className="chipset">
                    {[...split.overflow, ...split.empty].map((m) => (
                      <Link key={m.domainId} to={`/inbox?domain=${m.domainId}`} className="chip">
                        {m.name}
                        {m.total > 0 ? ` · ${m.total}` : ""}
                      </Link>
                    ))}
                  </div>
                </details>
              )}
            </div>
          </div>

          <div className="card card--flush mt">
            <div className="list-head">
              <h2 style={{ margin: 0 }}>{t("dash.recent")}</h2>
            </div>
            {data.recentMessages.length === 0 ? (
              <p className="muted" style={{ padding: "var(--space-3)" }}>
                {t("dash.noMessages")}
              </p>
            ) : (
              <ul className="msglist">
                {data.recentMessages.map((m) => (
                  <MsgItem key={m.id} m={m} scoped={false} fresh={false} active={false} wide={false} onOpen={() => undefined} />
                ))}
              </ul>
            )}
          </div>
        </>
      )}
    </div>
  );
}
