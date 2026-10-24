import { useEffect, useMemo, useRef, useState } from "react";
import { api, ApiClientError, ALIASES_EXPORT_HREF } from "../lib/api";
import {
  LocalPartMode,
  MailStatus,
  localPartProblem,
  normalizeLocalPartInput,
  type Alias,
  type CreateAliasInput,
  type Domain,
  type ImportAliasesInput,
  type UpdateAliasInput,
} from "@mailvault/shared";
import { navigate } from "../lib/router";
import { withStepUp } from "../lib/passkeys";
import { useAsync } from "../lib/useAsync";
import { relativeTime } from "../lib/format";
import { localPartPhrases, t } from "../lib/i18n";
import { ConfirmDialog, CopyButton, EmptyState, ErrorBanner, Menu, Modal, Row, SkeletonList, useOpenRow } from "../components/ui";
import { AddressReuseCard, RulesCard } from "../components/RulesCard";

function describeError(e: unknown): string {
  if (!(e instanceof ApiClientError)) return t("aliases.createFail");
  // The API already says which rule failed and why; showing only `message` gave the owner
  // "Validation failed" with nothing to act on.
  const details = e.details as Record<string, unknown> | undefined;
  const reasons = Object.values(details ?? {}).flatMap((v) => (Array.isArray(v) ? v.map(String) : []));
  return reasons.length ? reasons.join(" · ") : e.message;
}

function CreateAliasModal({ onClose, onCreated }: { onClose: () => void; onCreated: (a: Alias) => void }) {
  const { data: domains } = useAsync(() => api.listDomains(), []);
  const ready = useMemo(() => (domains?.items ?? []).filter((d) => d.mailStatus === MailStatus.Ready), [domains]);

  const [domainId, setDomainId] = useState("");
  const [mode, setMode] = useState<LocalPartMode>(LocalPartMode.ServiceRandom);
  const [service, setService] = useState("");
  const [localPart, setLocalPart] = useState("");
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!domainId && ready[0]) setDomainId(ready[0].id);
  }, [ready, domainId]);

  const domain: Domain | undefined = ready.find((d) => d.id === domainId);
  const problem = mode === LocalPartMode.Custom && localPart.trim() ? localPartProblem(localPart, localPartPhrases()) : null;
  const missingName = mode === LocalPartMode.Custom && !localPart.trim();

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    const base = { domainId, label: label.trim() || null };
    // Sent as typed: the API normalizes, so what the owner sees in the preview is exactly
    // what the server will store.
    const input: CreateAliasInput =
      mode === LocalPartMode.Custom
        ? { ...base, mode: LocalPartMode.Custom, localPart }
        : mode === LocalPartMode.ServiceRandom
          ? { ...base, mode: LocalPartMode.ServiceRandom, service: service.trim() }
          : { ...base, mode: LocalPartMode.Random };
    try {
      const created = await api.createAlias(input);
      onCreated(created);
      onClose();
    } catch (e2) {
      setErr(describeError(e2));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title={t("aliases.createTitle")} onClose={onClose}>
      {ready.length === 0 ? (
        <>
          <div className="muted" style={{ marginBottom: 14 }}>
            {t("aliases.noReadyDomain")}
          </div>
          <button className="primary" onClick={() => (onClose(), navigate("/domains"))}>
            {t("aliases.goToDomains")}
          </button>
        </>
      ) : (
        <form onSubmit={submit}>
          {err && <ErrorBanner message={err} />}
          <div className="field">
            <label>{t("aliases.domain")}</label>
            <select value={domainId} onChange={(e) => setDomainId(e.target.value)}>
              {ready.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label>{t("aliases.label")}</label>
            <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder={t("aliases.labelExample")} maxLength={120} />
          </div>
          <div className="field">
            <label>{t("aliases.type")}</label>
            <div className="tabs">
              <button type="button" className={mode === LocalPartMode.ServiceRandom ? "active" : ""} onClick={() => setMode(LocalPartMode.ServiceRandom)}>
                {t("aliases.typeService")}
              </button>
              <button type="button" className={mode === LocalPartMode.Random ? "active" : ""} onClick={() => setMode(LocalPartMode.Random)}>
                {t("aliases.typeRandom")}
              </button>
              <button type="button" className={mode === LocalPartMode.Custom ? "active" : ""} onClick={() => setMode(LocalPartMode.Custom)}>
                {t("aliases.typeCustom")}
              </button>
            </div>
          </div>
          {mode === LocalPartMode.ServiceRandom && (
            <div className="field">
              <label>{t("aliases.serviceName")}</label>
              <input value={service} onChange={(e) => setService(e.target.value)} placeholder="github" />
              {domain && <Preview local={service ? `${service.replace(/[^a-zA-Z0-9._-]+/g, "-").toLowerCase()}-…` : "service-…"} domain={domain.name} />}
            </div>
          )}
          {mode === LocalPartMode.Random && domain && <Preview local="x7k29p" domain={domain.name} />}
          {mode === LocalPartMode.Custom && (
            <div className="field">
              <label htmlFor="alias-local-part">{t("aliases.customName")}</label>
              <input
                id="alias-local-part"
                value={localPart}
                onChange={(e) => setLocalPart(e.target.value)}
                placeholder="github03"
                maxLength={64}
                aria-invalid={!!problem}
                aria-describedby={problem ? "alias-local-part-problem" : undefined}
              />
              {/* The reason appears while typing, not after a failed submit, and the preview
                  shows the address the server will actually store (`Tung` → `tung`). */}
              {problem && (
                <div className="field-problem" id="alias-local-part-problem" role="alert">
                  {problem}
                </div>
              )}
              {domain && <Preview local={normalizeLocalPartInput(localPart) || "…"} domain={domain.name} />}
            </div>
          )}
          <div className="row-end" style={{ marginTop: 8 }}>
            <button type="button" onClick={onClose}>
              {t("common.cancel")}
            </button>
            <button type="submit" className="primary" disabled={busy || !domainId || !!problem || missingName}>
              {busy ? t("aliases.creating") : t("aliases.createSubmit")}
            </button>
          </div>
        </form>
      )}
    </Modal>
  );
}

function Preview({ local, domain }: { local: string; domain: string }) {
  return (
    <div className="muted" style={{ marginTop: 6, fontSize: 13 }}>
      {t("aliases.willCreate")} <span className="addr">{local}@{domain}</span>
    </div>
  );
}

export function Aliases({ openNew }: { openNew: boolean }) {
  const [q, setQ] = useState("");
  const [view, setView] = useState<"active" | "archived" | "all">("active");
  const { data, error, loading, reload } = useAsync(() => api.listAliases(q || undefined, view), [q, view]);
  const [showNew, setShowNew] = useState(openNew);
  const [deleting, setDeleting] = useState<Alias | null>(null);
  const [purge, setPurge] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const folded = useOpenRow();
  const importFile = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (openNew) setShowNew(true);
  }, [openNew]);

  /** Accepts what Export writes (`{aliases: [...]}`) or a bare array of the same rows. */
  async function importFromFile(file: File) {
    try {
      const parsed = JSON.parse(await file.text()) as { aliases?: unknown } | unknown[];
      const rows = Array.isArray(parsed) ? parsed : parsed.aliases;
      if (!Array.isArray(rows) || rows.length === 0) throw new Error(t("aliases.importEmpty"));
      const result = await api.importAliases({ aliases: rows as ImportAliasesInput["aliases"] });
      setNotice(t("aliases.importReport", { created: result.created, skipped: result.skipped, invalid: result.invalid.length }));
      reload();
    } catch (e) {
      setNotice(e instanceof ApiClientError || e instanceof Error ? e.message : t("common.updateFail"));
    }
  }

  async function toggleStatus(a: Alias) {
    if (a.status === "ACTIVE") await api.disableAlias(a.id);
    else await api.enableAlias(a.id);
    folded.close();
    reload();
  }

  async function patch(a: Alias, changes: UpdateAliasInput) {
    try {
      await api.updateAlias(a.id, changes);
      folded.close();
      reload();
    } catch (e) {
      setNotice(e instanceof ApiClientError ? e.message : t("common.updateFail"));
    }
  }

  async function confirmDelete() {
    if (!deleting) return;
    try {
      await withStepUp(() => api.deleteAlias(deleting.id, purge));
      setDeleting(null);
      setNotice(purge ? t("aliases.deletedPurged") : t("aliases.deleted"));
      setPurge(false);
      reload();
    } catch (e) {
      setNotice(e instanceof ApiClientError ? e.message : t("common.deleteFail"));
    }
  }

  return (
    <div className="page">
      <div className="page-head">
        <h1>{t("aliases.title")}</h1>
        <div className="actions">
          <button className="small ghost" onClick={() => (window.location.href = ALIASES_EXPORT_HREF)}>
            {t("aliases.export")}
          </button>
          <button className="small ghost" onClick={() => importFile.current?.click()}>
            {t("aliases.import")}
          </button>
          {/* Hidden until chosen: an import is a file pick, not a text field. */}
          <input
            ref={importFile}
            type="file"
            accept="application/json,.json"
            hidden
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              if (file) void importFromFile(file);
            }}
          />
          <button className="primary" onClick={() => setShowNew(true)}>
            {t("dash.newAlias")}
          </button>
        </div>
      </div>

      {notice && <div className="banner ok">{notice}</div>}
      {error && <ErrorBanner message={error} />}

      <div className="toolbar">
        <input className="search" placeholder={t("aliases.search")} value={q} onChange={(e) => setQ(e.target.value)} />
        <div className="tabs" role="tablist">
          {(["active", "archived", "all"] as const).map((v) => (
            <button key={v} type="button" role="tab" aria-selected={view === v} className={view === v ? "active" : ""} onClick={() => setView(v)}>
              {t(v === "active" ? "aliases.active" : v === "archived" ? "aliases.archived" : "aliases.all")}
            </button>
          ))}
        </div>
      </div>

      {loading && !data && <SkeletonList rows={4} />}
      {data && data.items.length === 0 && (
        <Empty q={q} onCreate={() => setShowNew(true)} />
      )}

      {data && data.items.length > 0 && (
        <div className="card card--flush">
          {data.items.map((a) => (
            <Row
              key={a.id}
              id={a.id}
              open={folded.open === a.id}
              onToggle={folded.toggle}
              summary={
                <>
                  <div className="entity-title">
                    <div className="entity-name">
                      {a.pinned ? "📌 " : null}
                      {a.label || <span className="muted">{t("aliases.noLabel")}</span>}
                    </div>
                    <span className={`pill ${a.status === "ACTIVE" ? "ready" : "neutral"}`}>
                      {t(a.status === "ACTIVE" ? "aliases.active" : "status.disabled")}
                    </span>
                  </div>
                  <div className="addr entity-addr">{a.address}</div>
                  {a.notes ? (
                    <div className="entity-note" title={a.notes}>
                      {a.notes}
                    </div>
                  ) : null}
                  <div className="entity-facts">
                    <span>{t("common.nMessages", { n: a.messageCount ?? 0 })}</span>
                    <span>{a.unreadCount ? t("common.nUnread", { n: a.unreadCount }) : t("common.allRead")}</span>
                    <span>{t("common.created", { at: relativeTime(a.createdAt) })}</span>
                    {a.archived ? <span>{t("aliases.archived")}</span> : null}
                  </div>
                </>
              }
              actions={
                <>
                  <CopyButton text={a.address} label={t("common.copyAddress")} />
                  <button className="small" onClick={() => navigate(`/inbox?alias=${a.id}`)}>
                    {t("aliases.mailHere")}
                  </button>
                  <button className="small" onClick={() => toggleStatus(a)}>
                    {t(a.status === "ACTIVE" ? "aliases.disable" : "aliases.enable")}
                  </button>
                  <Menu
                    small
                    items={[
                      { label: t("aliases.openDetails"), onSelect: () => navigate(`/aliases/${a.id}`) },
                      { label: t(a.pinned ? "aliases.unpin" : "aliases.pin"), onSelect: () => patch(a, { pinned: !a.pinned }) },
                      { label: t(a.archived ? "aliases.unarchive" : "aliases.archive"), onSelect: () => patch(a, { archived: !a.archived }) },
                      { label: t("common.delete"), danger: true, onSelect: () => setDeleting(a) },
                    ]}
                  />
                </>
              }
            />
          ))}
        </div>
      )}

      <RulesCard />
      <AddressReuseCard />

      {showNew && <CreateAliasModal onClose={() => setShowNew(false)} onCreated={() => reload()} />}

      {deleting && (
        <ConfirmDialog
          title={t("aliases.deleteTitle")}
          confirmLabel={t(purge ? "aliases.deleteConfirmPurge" : "aliases.deleteConfirm")}
          description={
            <>
              <div style={{ marginBottom: 10 }}>
                {t("aliases.deleteBody", { address: deleting.address })}
              </div>
              <label className="row" style={{ cursor: "pointer" }}>
                <input
                  type="checkbox"
                  style={{ width: "auto" }}
                  checked={purge}
                  onChange={(e) => setPurge(e.target.checked)}
                />
                {t("aliases.purgeChoice")}
              </label>
              {purge && (
                <div className="banner error" style={{ marginTop: 10, marginBottom: 0 }}>
                  {t("aliases.purgeWarning", { n: deleting.messageCount ?? 0 })}
                </div>
              )}
            </>
          }
          onConfirm={confirmDelete}
          onClose={() => setDeleting(null)}
        />
      )}
    </div>
  );
}

function Empty({ q, onCreate }: { q: string; onCreate: () => void }) {
  return (
    <EmptyState
      art={q ? "search" : "alias"}
      title={t(q ? "aliases.emptySearch" : "aliases.emptyTitle")}
      hint={t(q ? "aliases.emptySearchHint" : "aliases.emptyHint")}
      action={
        q ? null : (
          <button className="primary" onClick={onCreate}>
            {t("dash.newAlias")}
          </button>
        )
      }
    />
  );
}
