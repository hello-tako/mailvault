import { useEffect, useState } from "react";
import { api, ApiClientError } from "../lib/api";
import { Link, navigate } from "../lib/router";
import { useAsync } from "../lib/useAsync";
import { fullTime, relativeTime } from "../lib/format";
import { t } from "../lib/i18n";
import { CopyButton, ErrorBanner, Loading } from "../components/ui";
import { PortalLinks } from "../components/PortalLinks";

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="card" style={{ padding: "10px 12px" }}>
      <div className="faint" style={{ fontSize: 12 }}>
        {label}
      </div>
      <div style={{ fontWeight: 600, marginTop: 2 }}>{value}</div>
    </div>
  );
}

export function AliasDetail({ id }: { id: string }) {
  const { data, error, loading, reload } = useAsync(() => api.getAlias(id), [id]);
  const [label, setLabel] = useState("");
  const [notes, setNotes] = useState("");
  const [dirty, setDirty] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  // Re-seed the form whenever the server copy changes (including after a save).
  useEffect(() => {
    if (!data) return;
    setLabel(data.alias.label ?? "");
    setNotes(data.alias.notes ?? "");
    setDirty(false);
  }, [data]);

  async function save() {
    try {
      await api.updateAlias(id, { label: label.trim() || null, notes: notes.trim() || null });
      setNotice(t("common.saved"));
      reload();
    } catch (e) {
      setNotice(e instanceof ApiClientError ? e.message : t("common.saveFail"));
    }
  }

  async function patch(changes: { pinned?: boolean; archived?: boolean }) {
    try {
      await api.updateAlias(id, changes);
      reload();
    } catch (e) {
      setNotice(e instanceof ApiClientError ? e.message : t("common.updateFail"));
    }
  }

  if (loading && !data) return <Loading />;

  const a = data?.alias;
  const stats = data?.stats;

  return (
    <div className="page">
      <div style={{ marginBottom: 14 }}>
        <Link to="/aliases">{t("alias.back")}</Link>
      </div>

      {notice && <div className="banner ok">{notice}</div>}
      {error && <ErrorBanner message={error} />}

      {a && stats && (
        <>
          <div className="card">
            <div className="row spread wrap" style={{ gap: 12 }}>
              <div style={{ minWidth: 0 }}>
                <h1 style={{ marginBottom: 4, wordBreak: "break-all" }}>
                  {a.pinned ? "📌 " : null}
                  {a.label || t("aliases.noLabel")}
                </h1>
                <div className="addr muted">{a.address}</div>
                <div className="faint" style={{ fontSize: 12, marginTop: 6 }}>
                  {t(a.status === "ACTIVE" ? "alias.receiving" : "alias.notReceiving")} · {a.domainName} ·{" "}
                  {t("common.created", { at: relativeTime(a.createdAt) })}
                </div>
              </div>
              <div className="row wrap" style={{ justifyContent: "flex-end" }}>
                <CopyButton text={a.address} label={t("common.copyAddress")} />
                <button className="small" onClick={() => patch({ pinned: !a.pinned })}>
                  {t(a.pinned ? "aliases.unpin" : "aliases.pin")}
                </button>
                <button className="small" onClick={() => patch({ archived: !a.archived })}>
                  {t(a.archived ? "aliases.unarchive" : "aliases.archive")}
                </button>
                <button className="small" onClick={() => navigate(`/inbox?alias=${a.id}`)}>
                  {t("alias.openInbox")}
                </button>
              </div>
            </div>
          </div>

          <div className="grid mt" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))" }}>
            <Stat label={t("alias.statMessages")} value={String(stats.messages)} />
            <Stat label={t("alias.statUnread")} value={String(stats.unread)} />
            <Stat label={t("alias.statFirst")} value={stats.firstReceivedAt ? fullTime(stats.firstReceivedAt) : t("common.dash")} />
            <Stat label={t("alias.statLast")} value={stats.lastReceivedAt ? relativeTime(stats.lastReceivedAt) : t("common.dash")} />
          </div>

          <PortalLinks aliasId={a.id} />

          <div className="mt">
            <h2>{t("alias.notes")}</h2>
            <textarea
              className="search"
              rows={3}
              style={{ width: "100%", resize: "vertical" }}
              placeholder={t("alias.notesPlaceholder")}
              value={notes}
              maxLength={1000}
              onChange={(e) => {
                setNotes(e.target.value);
                setDirty(true);
              }}
            />
          </div>

          <div className="mt">
            <h2>{t("alias.label")}</h2>
            <input
              className="search"
              value={label}
              maxLength={120}
              placeholder={t("alias.labelPlaceholder")}
              onChange={(e) => {
                setLabel(e.target.value);
                setDirty(true);
              }}
            />
          </div>

          <div className="row-end mt">
            <button className="primary" disabled={!dirty} onClick={save}>
              {t("common.save")}
            </button>
          </div>

          <div className="mt">
            <h2>{t("alias.senders")}</h2>
            {stats.senders.length === 0 ? (
              <p className="muted">{t("alias.noSenders")}</p>
            ) : (
              <div className="stack">
                {stats.senders.map((s) => (
                  <div key={s.name} className="row spread" style={{ borderBottom: "1px solid var(--border)", paddingBottom: 6 }}>
                    <span className="mono" style={{ fontSize: 13, wordBreak: "break-all" }}>
                      {s.name}
                    </span>
                    <span className="faint" style={{ fontSize: 12 }}>
                      {s.count}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
