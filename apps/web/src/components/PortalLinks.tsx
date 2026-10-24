import { useState } from "react";
import { PORTAL_MAX_VIEWS_CAP, type PortalLink, type PortalLinkCreated } from "@mailvault/shared";
import { api, ApiClientError } from "../lib/api";
import { useAsync } from "../lib/useAsync";
import { fullTime, relativeTime } from "../lib/format";
import { t } from "../lib/i18n";
import { CopyButton, Modal } from "./ui";

/**
 * The owner's half of the code portal: make a link, hand it to the buyer, withdraw it after.
 *
 * A link is shown exactly once, because what makes it usable by a stranger on the other side of
 * a sale is also what makes it a credential. Nothing here can re-read one — the list can only
 * report how a link has been used, which is the other thing the owner needs when a customer
 * claims the code never arrived.
 */

const TTL_CHOICES = [15, 30, 60, 180, 1440];

function ttlLabel(minutes: number): string {
  if (minutes % 1440 === 0) return t("portal.nDays", { n: minutes / 1440 });
  if (minutes % 60 === 0) return t("portal.nHours", { n: minutes / 60 });
  return t("portal.nMinutes", { n: minutes });
}

/** A link dies four ways and lives one; only a withdrawn row carries its own timestamp. */
function stateOf(link: PortalLink, now = Date.now()): { key: string; cls: string } {
  if (link.revokedAt) return { key: "portal.revoked", cls: "neutral" };
  if (Date.parse(link.expiresAt) <= now) return { key: "portal.expired", cls: "muted" };
  if (link.maxViews !== null && link.views >= link.maxViews) return { key: "portal.spent", cls: "warn" };
  return { key: "portal.live", cls: "ready" };
}

function viewsLabel(link: PortalLink): string {
  return link.maxViews === null
    ? t("portal.viewsOpen", { n: link.views })
    : t("portal.viewsCapped", { n: link.views, max: link.maxViews });
}

/** Mirrors the Worker's own bound, so a click never comes back as a 400 the owner has to guess at. */
function viewsProblem(raw: string): string | null {
  const value = raw.trim();
  if (value === "") return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > PORTAL_MAX_VIEWS_CAP) return t("portal.badViews", { max: PORTAL_MAX_VIEWS_CAP });
  return null;
}

function CreatedOnce({ created, onClose }: { created: PortalLinkCreated; onClose: () => void }) {
  return (
    <Modal title={t("portal.onceTitle")} onClose={onClose}>
      <p className="muted" style={{ marginTop: 0 }}>
        {t("portal.onceBody")}
      </p>
      <p className="addr mono-box" translate="no">
        {created.url}
      </p>
      <div className="row wrap mt" style={{ gap: 10, alignItems: "center" }}>
        <CopyButton text={created.url} label={t("portal.copyLink")} />
        <a href={created.url} target="_blank" rel="noopener noreferrer">
          {t("portal.openLink")}
        </a>
      </div>
      <p className="muted mt">{t("portal.onceExpiry", { at: fullTime(created.grant.expiresAt) })}</p>
    </Modal>
  );
}

export function PortalLinks({ aliasId }: { aliasId: string }) {
  const { data, error, reload } = useAsync(() => api.listPortalLinks(aliasId), [aliasId]);
  const [ttlMinutes, setTtlMinutes] = useState(60);
  const [maxViews, setMaxViews] = useState("");
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [created, setCreated] = useState<PortalLinkCreated | null>(null);

  const views = viewsProblem(maxViews);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    if (views) return;
    setBusy(true);
    setProblem(null);
    try {
      const result = await api.createPortalLink(aliasId, {
        ttlMinutes,
        maxViews: maxViews.trim() === "" ? null : Number(maxViews),
        label: label.trim() || null,
      });
      setCreated(result);
      setLabel("");
      setMaxViews("");
      reload();
    } catch (err) {
      setProblem(err instanceof ApiClientError ? err.message : t("portal.createFail"));
    } finally {
      setBusy(false);
    }
  }

  async function withdraw(link: PortalLink) {
    setBusy(true);
    setProblem(null);
    try {
      await api.revokePortalLink(aliasId, link.id);
      reload();
    } catch (err) {
      setProblem(err instanceof ApiClientError ? err.message : t("portal.revokeFail"));
    } finally {
      setBusy(false);
    }
  }

  const links = data?.items ?? [];

  return (
    <div className="card mt">
      <h2 style={{ marginTop: 0 }}>{t("portal.title")}</h2>
      <p className="muted" style={{ marginTop: 0 }}>
        {t("portal.intro")}
      </p>

      {error && <div className="banner error">{error}</div>}
      {problem && <div className="banner error">{problem}</div>}

      {links.length > 0 && (
        <ul className="msglist" style={{ marginBottom: 12 }}>
          {links.map((l) => {
            const s = stateOf(l);
            return (
              <li key={l.id} className="entity">
                <div className="entity-summary">
                  <div className="entity-id">
                    <div className="entity-title">
                      <div className="entity-name">{l.label || t("portal.noLabel")}</div>
                      <span className={`pill ${s.cls}`}>{t(s.key)}</span>
                    </div>
                    <div className="entity-facts">
                      <span>{t("portal.expiresAt", { at: fullTime(l.expiresAt) })}</span>
                      <span>{viewsLabel(l)}</span>
                      <span>{l.lastSeenAt ? t("portal.lastSeen", { at: relativeTime(l.lastSeenAt) }) : t("portal.never")}</span>
                    </div>
                  </div>
                  <button className="ghost small" disabled={busy || !l.active} onClick={() => withdraw(l)}>
                    {t("portal.withdraw")}
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <details className="fold mt">
        <summary>{t("portal.newTitle")}</summary>
        <div className="fold-body">
          <form onSubmit={add}>
            <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(min(200px, 100%), 1fr))" }}>
              <div className="field">
                <label htmlFor="portal-ttl">{t("portal.ttl")}</label>
                <select id="portal-ttl" value={ttlMinutes} onChange={(e) => setTtlMinutes(Number(e.target.value))}>
                  {TTL_CHOICES.map((m) => (
                    <option key={m} value={m}>
                      {ttlLabel(m)}
                      {m === 60 ? ` · ${t("portal.default")}` : ""}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label htmlFor="portal-views">{t("portal.maxViews")}</label>
                <input
                  id="portal-views"
                  value={maxViews}
                  onChange={(e) => setMaxViews(e.target.value)}
                  inputMode="numeric"
                  placeholder={String(PORTAL_MAX_VIEWS_CAP)}
                />
              </div>
              <div className="field">
                <label htmlFor="portal-label">{t("portal.labelField")}</label>
                <input
                  id="portal-label"
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                  maxLength={80}
                  placeholder={t("portal.labelExample")}
                />
              </div>
            </div>
            {views ? <p className="field-problem">{views}</p> : null}
            <div className="row-end mt">
              <button type="submit" className="primary" disabled={busy || !!views}>
                {busy ? t("portal.creating") : t("portal.create")}
              </button>
            </div>
          </form>
        </div>
      </details>

      {created ? <CreatedOnce created={created} onClose={() => setCreated(null)} /> : null}
    </div>
  );
}
