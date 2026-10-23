import { useEffect, useMemo, useRef, useState } from "react";
import { api, ApiClientError } from "../lib/api";
import { navigate, useRoute } from "../lib/router";
import { withStepUp } from "../lib/passkeys";
import { useAsync } from "../lib/useAsync";
import { relativeTime } from "../lib/format";
import { t } from "../lib/i18n";
import {
  ConfirmDialog,
  EmptyState,
  ErrorBanner,
  Menu,
  Modal,
  Row,
  SkeletonList,
  StatusPill,
  useOpenRow,
} from "../components/ui";
import {
  FILTERS,
  bucketOf,
  isRoutingNotEnabledReceipt,
  routingConsoleUrl,
  type Bucket,
} from "../lib/domains";
import {
  AuthPolicy,
  ConflictType,
  MailStatus,
  PreflightClassification,
  type Domain,
  type PreflightResult,
  type ProvisionOutcome,
} from "@mailvault/shared";

const CLASS_PILL: Record<string, { cls: string; key: string }> = {
  [PreflightClassification.ReadyToProvision]: { cls: "ready", key: "cls.readyToProvision" },
  [PreflightClassification.AlreadyConfigured]: { cls: "accent", key: "cls.alreadyConfigured" },
  [PreflightClassification.MxConflict]: { cls: "conflict", key: "cls.mxConflict" },
  [PreflightClassification.CatchAllConflict]: { cls: "conflict", key: "cls.catchAllConflict" },
  [PreflightClassification.ZoneInactive]: { cls: "error", key: "cls.zoneInactive" },
  [PreflightClassification.UnsupportedZone]: { cls: "error", key: "cls.unsupportedZone" },
  [PreflightClassification.ApiPermissionError]: { cls: "error", key: "cls.apiPermissionError" },
  [PreflightClassification.ProvisioningError]: { cls: "error", key: "cls.provisioningError" },
};

function ClassPill({ c }: { c: string }) {
  const s = CLASS_PILL[c];
  return <span className={`pill ${s?.cls ?? "neutral"}`}>{s ? t(s.key) : c}</span>;
}

function RoutingHint({ d }: { d: Domain }) {
  const href = routingConsoleUrl(d);
  if (!href) return null;
  return (
    <a
      className="small"
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      style={{
        textDecoration: "none",
        border: "1px solid var(--border)",
        borderRadius: 8,
        padding: "4px 8px",
        whiteSpace: "nowrap",
      }}
    >
      {t("dom.enableRouting")}
    </a>
  );
}

function ConflictDetail({ result }: { result: PreflightResult }) {
  const cf = result.conflict;
  if (!cf) return null;
  return (
    <div className="banner error" style={{ marginBottom: 0 }}>
      {/* `cf.message` is written by the Cloudflare API or the Worker's own preflight, and is
          shown as it arrived: rewording it here would mean guessing at a state we did not
          phrase. Everything around it is translated. */}
      <div style={{ fontWeight: 600 }}>{cf.message}</div>
      {cf.type === ConflictType.Mx && cf.mxRecords && cf.mxRecords.length > 0 && (
        <ul className="mono" style={{ margin: "4px 0 0", paddingLeft: 18, fontSize: 12 }}>
          {cf.mxRecords.map((r, i) => (
            <li key={i}>
              {r.priority} {r.exchange}
            </li>
          ))}
        </ul>
      )}
      {cf.type === ConflictType.CatchAll && (
        <div className="mono" style={{ fontSize: 12 }}>
          {t("dom.routedTo", { type: cf.catchAll?.actionType ?? t("dom.unknown") })}
          {cf.catchAll?.destination ? ` → ${cf.catchAll.destination}` : ""}
        </div>
      )}
    </div>
  );
}

function Receipt({ o, d }: { o: ProvisionOutcome; d: Domain }) {
  return (
    <div className={`banner ${o.ok ? "ok" : "error"}`} style={{ marginBottom: 0 }}>
      <div style={{ fontWeight: 600 }}>
        {t(o.ok ? "dom.mailEnabled" : "dom.provisionFailed")}
        {o.error ? ` — ${o.error}` : ""}
      </div>
      {isRoutingNotEnabledReceipt(o) ? (
        <div className="row" style={{ marginTop: 8 }}>
          <RoutingHint d={d} />
          <span className="faint" style={{ fontSize: 12 }}>
            {t("dom.routingHint")}
          </span>
        </div>
      ) : null}
      <ul style={{ margin: "4px 0 0", paddingLeft: 18, fontSize: 12 }}>
        {o.steps.length === 0 ? <li className="faint">{t("dom.noSteps")}</li> : null}
        {o.steps.map((s, i) => (
          <li key={i}>
            {s.ok ? "✓" : "✗"} {s.step}
            {s.detail ? ` (${s.detail})` : ""}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function Domains() {
  const { data, error, loading, reload } = useAsync(() => api.listDomains(), []);
  const domains = useMemo(() => data?.items ?? [], [data]);

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [preflights, setPreflights] = useState<Record<string, PreflightResult>>({});
  const [outcomes, setOutcomes] = useState<Record<string, ProvisionOutcome>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState<Bucket | "all">("all");
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmProvision, setConfirmProvision] = useState(false);
  const [takeover, setTakeover] = useState(false);
  const [mxTakeover, setMxTakeover] = useState(false);
  const [removing, setRemoving] = useState<Domain | null>(null);
  const [sendingFor, setSendingFor] = useState<Domain | null>(null);
  const [retryTakeover, setRetryTakeover] = useState<Domain | null>(null);
  const folded = useOpenRow();

  const allZones = useMemo(() => domains.map((d) => d.cloudflareZoneId), [domains]);
  const selectedZones = useMemo(() => [...selected], [selected]);

  const visible = useMemo(
    () =>
      domains.filter((d) =>
        filter === "all"
          ? true
          : bucketOf(d, preflights[d.cloudflareZoneId], outcomes[d.cloudflareZoneId]) === filter,
      ),
    [domains, filter, preflights, outcomes],
  );

  const counts = useMemo(() => {
    const c: Record<string, number> = {
      all: domains.length,
      ready: 0,
      conflict: 0,
      error: 0,
      unconfigured: 0,
      other: 0,
    };
    for (const d of domains) {
      const k = bucketOf(d, preflights[d.cloudflareZoneId], outcomes[d.cloudflareZoneId]);
      c[k] = (c[k] ?? 0) + 1;
    }
    return c;
  }, [domains, preflights, outcomes]);

  async function changeAuthPolicy(d: Domain, policy: AuthPolicy) {
    setBusy(true);
    setActionError(null);
    try {
      await withStepUp(() => api.setAuthPolicy(d.cloudflareZoneId, policy));
      reload();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : t("dom.ePolicy"));
    } finally {
      setBusy(false);
    }
  }

  function toggle(zoneId: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(zoneId)) next.delete(zoneId);
      else next.add(zoneId);
      return next;
    });
  }

  function toggleExpand(zoneId: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(zoneId)) next.delete(zoneId);
      else next.add(zoneId);
      return next;
    });
  }

  function selectVisibleEligible() {
    const eligible = visible
      .filter((d) => preflights[d.cloudflareZoneId]?.safeToProvision)
      .map((d) => d.cloudflareZoneId);
    setSelected((prev) => new Set([...prev, ...eligible]));
    setNotice(
      eligible.length ? t("dom.selectedEligible", { n: eligible.length }) : t("dom.noneEligible"),
    );
  }

  async function runSync() {
    setBusy(true);
    setActionError(null);
    try {
      const r = await api.syncDomains();
      setNotice(t("dom.synced", { n: r.discovered }));
      reload();
    } catch (e) {
      setActionError(e instanceof ApiClientError ? e.message : t("dom.eSync"));
    } finally {
      setBusy(false);
    }
  }

  async function runPreflight(zoneIds: string[]) {
    if (zoneIds.length === 0) return;
    setBusy(true);
    setActionError(null);
    setNotice(t("dom.pfStart", { label: t("dom.preflighting"), n: zoneIds.length }));
    try {
      const r = await api.preflightDomains(zoneIds);
      setPreflights((prev) => {
        const next = { ...prev };
        for (const item of r.results) next[item.zoneId] = item;
        return next;
      });
      const conflicts = r.results.filter((x) => !x.safeToProvision && x.conflict).length;
      const denied = r.results.filter(
        (x) => x.classification === PreflightClassification.ApiPermissionError,
      ).length;
      setNotice(
        t("dom.pfDone", { n: r.results.length }) +
          t("dom.pfConflicts", { n: conflicts }) +
          (denied ? t("dom.pfDenied", { n: denied }) : "") +
          t("dom.pfEnd"),
      );
      // Surface evidence for anything that is not safe, without forcing a click.
      setExpanded((prev) => {
        const next = new Set(prev);
        for (const x of r.results) if (!x.safeToProvision) next.add(x.zoneId);
        return next;
      });
    } catch (e) {
      setActionError(e instanceof ApiClientError ? e.message : t("dom.ePreflight"));
    } finally {
      setBusy(false);
    }
  }

  async function runVerify() {
    setBusy(true);
    setActionError(null);
    try {
      const r = await api.verifyDomains();
      const { report } = r;
      if (report.checked === 0) {
        setNotice(t("dom.vNone"));
      } else if (report.drifted.length === 0 && report.failed.length === 0) {
        setNotice(
          t("dom.vAll", { n: report.checked }) +
            (report.restored.length
              ? t("dom.vRestored", { names: report.restored.join(", ") })
              : ""),
        );
      } else {
        setNotice(
          t("dom.vChecked", { n: report.checked }) +
            t("dom.vDrifted", { n: report.drifted.length }) +
            (report.drifted.length ? t("dom.vNames", { names: report.drifted.join(", ") }) : "") +
            (report.failed.length ? t("dom.vFailed", { n: report.failed.length }) : "") +
            t("dom.pfEnd"),
        );
        setExpanded((prev) => {
          const next = new Set(prev);
          for (const d of data?.items ?? [])
            if (report.drifted.includes(d.name)) next.add(d.cloudflareZoneId);
          return next;
        });
      }
      reload();
    } catch (e) {
      setActionError(e instanceof ApiClientError ? e.message : t("dom.eVerify"));
    } finally {
      setBusy(false);
    }
  }

  const needsTakeover = selectedZones.some(
    (z) => preflights[z]?.classification === PreflightClassification.CatchAllConflict,
  );
  /**
   * Selected domains whose mail currently lands at another provider, with the exact records
   * at stake. The owner has to confirm deleting these per batch, and sees what goes.
   */
  const mxTargets = selectedZones
    .map((z) => ({ zoneId: z, name: nameOf(z), pf: preflights[z] }))
    .filter(
      (x) =>
        x.pf?.classification === PreflightClassification.MxConflict &&
        (x.pf.conflict?.mxRecords?.length ?? 0) > 0,
    );

  async function runProvision() {
    if (selectedZones.length === 0) return;
    setBusy(true);
    setActionError(null);
    try {
      const r = await withStepUp(() =>
        api.provisionDomains(selectedZones, {
          allowCatchAllTakeover: takeover,
          allowMxTakeover: mxTakeover,
        }),
      );
      setOutcomes((prev) => {
        const next = { ...prev };
        for (const o of r.results) next[o.zoneId] = o;
        return next;
      });
      const ok = r.results.filter((o) => o.ok).length;
      setNotice(t("dom.enabledMail", { ok, total: r.results.length }));
      setConfirmProvision(false);
      setSelected(new Set());
      reload();
    } catch (e) {
      setActionError(e instanceof ApiClientError ? e.message : t("dom.eProvision"));
    } finally {
      setBusy(false);
    }
  }

  async function runRetry(d: Domain, withTakeover: boolean) {
    setBusy(true);
    setActionError(null);
    try {
      const o = await api.retryDomain(d.cloudflareZoneId, withTakeover);
      setOutcomes((prev) => ({ ...prev, [o.zoneId]: o }));
      setExpanded((prev) => new Set(prev).add(o.zoneId));
      setRetryTakeover(null);
      reload();
    } catch (e) {
      setActionError(e instanceof ApiClientError ? e.message : t("dom.eRetry"));
    } finally {
      setBusy(false);
    }
  }

  async function confirmRemove() {
    if (!removing) return;
    setBusy(true);
    try {
      await withStepUp(() => api.removeDomain(removing.cloudflareZoneId));
      setNotice(t("dom.removed", { name: removing.name }));
      setRemoving(null);
      reload();
    } catch (e) {
      setActionError(e instanceof ApiClientError ? e.message : t("dom.eRemove"));
      setRemoving(null);
    } finally {
      setBusy(false);
    }
  }

  /*
   * The command palette runs these by navigating here with a `run` marker, so there is one
   * implementation of each and its notices appear where the rest of them do. The marker is
   * replaced out of the URL immediately: reloading the page must not re-fire a call to
   * Cloudflare that the owner did not ask for twice.
   */
  const { query } = useRoute();
  const run = query.get("run");
  const fired = useRef<string | null>(null);
  useEffect(() => {
    if (!run || fired.current === run) return;
    fired.current = run;
    navigate("/domains", true);
    if (run === "sync") void runSync();
    if (run === "verify") void runVerify();
  }, [run]);

  function nameOf(zoneId: string): string {
    return domains.find((d) => d.cloudflareZoneId === zoneId)?.name ?? zoneId;
  }

  return (
    <div className="page">
      <div className="page-head">
        <h1>{t("dom.title")}</h1>
        <div className="actions">
          <button onClick={runSync} disabled={busy}>
            {busy ? t("common.working") : t("dom.sync")}
          </button>
          <button
            className="ghost small"
            onClick={() => runPreflight(allZones)}
            disabled={busy || allZones.length === 0}
          >
            {t("dom.preflightAll")}
          </button>
          <button
            className="ghost small"
            onClick={runVerify}
            disabled={busy}
            title={t("dom.verifyTitle")}
          >
            {t("dom.verify")}
          </button>
        </div>
      </div>

      {notice && <div className="banner ok">{notice}</div>}
      {error && <ErrorBanner message={error} />}
      {actionError && <ErrorBanner message={actionError} />}
      {loading && !data && <SkeletonList rows={4} />}

      {data && domains.length === 0 && (
        <EmptyState
          art="domain"
          title={t("dom.emptyTitle")}
          hint={t("dom.emptyHint")}
          action={
            <button className="primary" onClick={runSync} disabled={busy}>
              {t("dom.sync")}
            </button>
          }
        />
      )}

      {domains.length > 0 && (
        <>
          <div className="toolbar">
            <div className="tabs">
              {FILTERS.map((f) => (
                <button
                  key={f.id}
                  type="button"
                  className={filter === f.id ? "active" : ""}
                  onClick={() => setFilter(f.id)}
                >
                  {t(f.labelKey)} ({counts[f.id] ?? 0})
                </button>
              ))}
            </div>
          </div>

          {visible.length === 0 ? (
            <EmptyState
              art="search"
              title={t("dom.noMatch", {
                filter: t(FILTERS.find((f) => f.id === filter)?.labelKey ?? "dom.filterAll"),
              })}
              hint={t("dom.noMatchHint")}
              action={
                <button className="small" onClick={() => setFilter("all")}>
                  {t("dom.showAll")}
                </button>
              }
            />
          ) : (
            <div className="card card--flush">
              <div className="list-head">
                <label className="row" style={{ gap: 10, cursor: "pointer", margin: 0 }}>
                  <input
                    type="checkbox"
                    style={{ width: "auto", minHeight: 0 }}
                    checked={
                      visible.length > 0 && visible.every((d) => selected.has(d.cloudflareZoneId))
                    }
                    onChange={() => {
                      const allVis = visible.map((d) => d.cloudflareZoneId);
                      const every = allVis.every((z) => selected.has(z));
                      setSelected((prev) => {
                        const next = new Set(prev);
                        for (const z of allVis) {
                          if (every) next.delete(z);
                          else next.add(z);
                        }
                        return next;
                      });
                    }}
                    aria-label={t("dom.selectAllVisible")}
                  />
                  {/* The count itself lives in the bulk bar below, where it stays on screen
                      while the owner works through the list. */}
                  <span className="faint" style={{ fontSize: 13 }}>
                    {t("dom.selectAllVisible")}
                  </span>
                </label>
                {/* Bulk actions belong to the selection, so they appear with it — and on a
                    phone they appear at the bottom, where the thumb already is. */}
                <div className="head-actions">
                  <button className="ghost small" onClick={selectVisibleEligible} disabled={busy}>
                    {t("dom.selectEligible")}
                  </button>
                </div>
              </div>
              {visible.map((d) => {
                const zoneId = d.cloudflareZoneId;
                const pf = preflights[zoneId];
                const oc = outcomes[zoneId];
                const open = expanded.has(zoneId);
                const hasEvidence = !!pf?.conflict || !!oc;
                return (
                  <Row
                    key={d.id}
                    id={d.id}
                    open={folded.open === d.id}
                    onToggle={folded.toggle}
                    summary={
                      <>
                        <div className="entity-title">
                          <div className="row" style={{ gap: 10, minWidth: 0 }}>
                            <input
                              type="checkbox"
                              style={{ width: "auto", minHeight: 0 }}
                              checked={selected.has(zoneId)}
                              onChange={() => toggle(zoneId)}
                              aria-label={t("dom.selectN", { name: d.name })}
                            />
                            <span className="entity-name">{d.name}</span>
                          </div>
                          <StatusPill status={d.mailStatus} />
                        </div>
                        <div className="entity-facts">
                          <span>
                            {d.zoneStatus} · {d.zoneType === "full" ? t("dom.full") : d.zoneType}
                          </span>
                          {pf ? <ClassPill c={pf.classification} /> : null}
                          {/* Sending is its own capability: a domain can receive and still
                              not be allowed to sign outbound mail. */}
                          <span
                            className={`pill ${d.sendingStatus === "ENABLED" ? "ok" : "neutral"}`}
                          >
                            {t(
                              d.sendingStatus === "ENABLED"
                                ? "dom.sendingEnabled"
                                : d.sendingStatus === "DISABLED"
                                  ? "dom.sendingDisabled"
                                  : "dom.sendingUnknown",
                            )}
                          </span>
                          <span>{t("dom.checked", { at: relativeTime(d.lastCheckedAt) })}</span>
                        </div>
                      </>
                    }
                    actions={
                      <>
                        {hasEvidence ? (
                          <button
                            className="small"
                            onClick={() => toggleExpand(zoneId)}
                            aria-expanded={open}
                          >
                            {t(open ? "dom.hideDetails" : "dom.showDetails")}
                          </button>
                        ) : null}
                        {d.mailStatus === MailStatus.Ready && (
                          <>
                            <button
                              className="small"
                              onClick={() => navigate(`/inbox?domain=${d.id}`)}
                            >
                              {t("dom.openMailbox")}
                            </button>
                            {d.sendingStatus !== "ENABLED" ? (
                              <button
                                className="small"
                                onClick={() => setSendingFor(d)}
                                disabled={busy}
                              >
                                {t("dom.enableSending")}
                              </button>
                            ) : null}
                            <select
                              className="small"
                              value={d.authPolicy}
                              disabled={busy}
                              title={t("dom.authPolicyTitle")}
                              onChange={(e) =>
                                void changeAuthPolicy(d, e.target.value as AuthPolicy)
                              }
                            >
                              <option value={AuthPolicy.Warn}>{t("dom.authWarn")}</option>
                              <option value={AuthPolicy.Reject}>{t("dom.authReject")}</option>
                              <option value={AuthPolicy.Off}>{t("dom.authOff")}</option>
                            </select>
                          </>
                        )}
                        <Menu
                          small
                          items={[
                            ...(d.mailStatus === MailStatus.Failed ||
                            d.mailStatus === MailStatus.Conflict
                              ? [
                                  {
                                    label: t("dom.retry"),
                                    disabled: busy,
                                    onSelect: () => {
                                      if (d.conflictType === ConflictType.CatchAll)
                                        setRetryTakeover(d);
                                      else void runRetry(d, false);
                                    },
                                  },
                                ]
                              : []),
                            {
                              label: t("dom.remove"),
                              danger: true,
                              disabled: busy,
                              onSelect: () => setRemoving(d),
                            },
                          ]}
                        />
                      </>
                    }
                  >
                    {open && (pf?.conflict || oc) ? (
                      <div className="entity-details">
                        <div className="stack">
                          {pf?.conflict ? <ConflictDetail result={pf} /> : null}
                          {oc ? <Receipt o={oc} d={d} /> : null}
                        </div>
                      </div>
                    ) : null}
                  </Row>
                );
              })}
            </div>
          )}

          {selectedZones.length > 0 && (
            <div className="bulkbar">
              <span className="count">
                {t("dom.selected", { n: selectedZones.length, total: visible.length })}
              </span>
              <div className="actions">
                <button className="ghost small" onClick={() => setSelected(new Set())}>
                  {t("dom.clear")}
                </button>
                <button
                  className="small"
                  onClick={() => runPreflight(selectedZones)}
                  disabled={busy}
                >
                  {t("dom.preflightN", { n: selectedZones.length })}
                </button>
                <button
                  className="primary small"
                  onClick={() => {
                    setTakeover(false);
                    setMxTakeover(false);
                    setConfirmProvision(true);
                  }}
                  disabled={busy}
                >
                  {t("dom.enableMailN", { n: selectedZones.length })}
                </button>
              </div>
            </div>
          )}
        </>
      )}

      {confirmProvision && (
        <Modal title={t("dom.enableTitle")} onClose={() => setConfirmProvision(false)}>
          <p className="muted" style={{ marginTop: 0 }}>
            {t("dom.enableBody", { n: selectedZones.length })}
          </p>
          <ul
            className="mono"
            style={{
              paddingLeft: 18,
              fontSize: 12,
              marginBottom: 12,
              maxHeight: 160,
              overflow: "auto",
            }}
          >
            {selectedZones.map((z) => (
              <li key={z}>{nameOf(z)}</li>
            ))}
          </ul>

          <div className="banner" style={{ marginBottom: 12 }}>
            <strong>{t("dom.enableAssure")}</strong>
            {t("dom.enableAssureRest")}
          </div>

          {mxTargets.length > 0 && (
            <>
              <label className="row" style={{ cursor: "pointer", marginBottom: 12 }}>
                <input
                  type="checkbox"
                  style={{ width: "auto" }}
                  checked={mxTakeover}
                  onChange={(e) => setMxTakeover(e.target.checked)}
                />
                {t("dom.mxTakeover", { n: mxTargets.length })}
              </label>
              {mxTakeover && (
                <div className="banner error" style={{ marginBottom: 12 }}>
                  <div className="mono" style={{ fontSize: 12, maxHeight: 180, overflow: "auto" }}>
                    {mxTargets.map((t2) => (
                      <div key={t2.zoneId} style={{ marginBottom: 4 }}>
                        <strong>{t2.name}</strong>:{" "}
                        {(t2.pf?.conflict?.mxRecords ?? [])
                          .map((m) => `${m.priority} ${m.exchange}`)
                          .join(", ")}
                      </div>
                    ))}
                  </div>
                  <div className="faint" style={{ fontSize: 12, marginTop: 6 }}>
                    {t("dom.mxNote")}
                  </div>
                </div>
              )}
            </>
          )}

          {needsTakeover && (
            <>
              <label className="row" style={{ cursor: "pointer", marginBottom: 12 }}>
                <input
                  type="checkbox"
                  style={{ width: "auto" }}
                  checked={takeover}
                  onChange={(e) => setTakeover(e.target.checked)}
                />
                {t("dom.caTakeover")}
              </label>
              {takeover && (
                <div className="banner error" style={{ marginBottom: 12 }}>
                  {t("dom.caWarn")}
                </div>
              )}
            </>
          )}

          <div className="row-end">
            <button onClick={() => setConfirmProvision(false)}>{t("common.cancel")}</button>
            <button
              className="primary"
              onClick={runProvision}
              disabled={
                busy || (needsTakeover && !takeover) || (mxTargets.length > 0 && !mxTakeover)
              }
            >
              {busy ? t("dom.enabling") : t("dom.enableMail")}
            </button>
          </div>
        </Modal>
      )}

      {retryTakeover && (
        <Modal title={t("dom.retryTitle")} onClose={() => setRetryTakeover(null)}>
          <p className="muted" style={{ marginTop: 0 }}>
            <span className="addr">{retryTakeover.name}</span> {t("dom.retryBodyA")}
          </p>
          <div className="banner error" style={{ marginBottom: 12 }}>
            {t("dom.retryWarn")}
          </div>
          <div className="row-end">
            <button onClick={() => setRetryTakeover(null)}>{t("common.cancel")}</button>
            <button
              className="danger"
              onClick={() => runRetry(retryTakeover, true)}
              disabled={busy}
            >
              {t("dom.retryConfirm")}
            </button>
          </div>
        </Modal>
      )}

      {sendingFor && (
        <SendingDialog
          domain={sendingFor}
          onClose={() => setSendingFor(null)}
          onChanged={reload}
          onDone={(message) => {
            setSendingFor(null);
            setNotice(message);
            reload();
          }}
          onError={setActionError}
        />
      )}

      {removing && (
        <ConfirmDialog
          title={t("dom.removeTitle")}
          confirmLabel={t("dom.removeConfirm")}
          description={
            <>
              <div style={{ marginBottom: 8 }}>
                {t("dom.removeBodyA")} <span className="addr">{removing.name}</span>{" "}
                {t("dom.removeBodyB")}
              </div>
              <div className="banner" style={{ marginBottom: 0 }}>
                {t("dom.removeNoteA")} <strong>{t("dom.removeNot")}</strong> {t("dom.removeNoteB")}
              </div>
            </>
          }
          onConfirm={confirmRemove}
          onClose={() => setRemoving(null)}
        />
      )}
    </div>
  );
}

/**
 * Enabling Email Sending for one domain.
 *
 * The dialog exists because the change reaches past this app: the DNS records are the
 * domain's own, and a DMARC policy written at the domain affects every service that sends as
 * it — including services MailVault has never heard of. So the exact records are listed from
 * Cloudflare's read-only preview before anything happens, and a conflicting DMARC needs both
 * a ticked box and a passkey.
 */
function SendingDialog({
  domain,
  onClose,
  onDone,
  onChanged,
  onError,
}: {
  domain: Domain;
  onClose: () => void;
  onDone: (message: string) => void;
  /** The chosen sending name landed; re-read the list without closing this dialog. */
  onChanged: () => void;
  onError: (message: string) => void;
}) {
  // The dialog's own copy, because `domain` is a snapshot: after a choice lands the list
  // refetches but this prop does not, and a stale name here would preview the wrong identity.
  const [via, setVia] = useState<string | null>(domain.sendingVia);
  const {
    data: preview,
    error,
    loading,
  } = useAsync(() => api.sendingPreview(domain.cloudflareZoneId), [domain.cloudflareZoneId, via]);
  const { data: names } = useAsync(
    () => api.sendingNames(domain.cloudflareZoneId),
    [domain.cloudflareZoneId],
  );
  const [confirmDmarc, setConfirmDmarc] = useState(false);
  const [busy, setBusy] = useState(false);

  const blocked = !!preview?.dmarcConflict && !confirmDmarc;
  // The zone's other sending names, which is how a domain reaches an identity that is already
  // onboarded without anybody writing a DMARC policy at its apex.
  const others = (names?.items ?? []).filter(
    (n) => n.name.toLowerCase() !== domain.name.toLowerCase(),
  );

  /** Point this domain's mail at one of its zone's sending names. Writes no DNS. */
  async function chooseVia(chosen: string) {
    setBusy(true);
    try {
      await api.setSendingVia(domain.cloudflareZoneId, chosen || null);
      setVia(chosen || null);
      onChanged();
    } catch (err) {
      onError(err instanceof Error ? err.message : t("dom.sendingViaFailed"));
    }
    setBusy(false);
  }

  async function enable() {
    setBusy(true);
    try {
      // The route decides that a DMARC takeover needs the passkey; the page only reacts to
      // the 403 and replays the call, so a gate added later cannot be missed here.
      const r = await withStepUp(() =>
        api.enableSending(domain.cloudflareZoneId, !!preview?.dmarcConflict),
      );
      onDone(
        t(r.alreadyEnabled ? "dom.sendingAlreadyOn" : "dom.sendingEnabledDone", {
          domain: preview?.domainName ?? domain.name,
        }),
      );
    } catch (err) {
      onError(err instanceof Error ? err.message : t("dom.sendingNeedsPermission"));
      setBusy(false);
    }
  }

  return (
    <Modal title={t("dom.enableSendingTitle", { domain: domain.name })} onClose={onClose}>
      {loading && <SkeletonList rows={3} />}
      {error && <ErrorBanner message={error} />}
      {preview && (
        <>
          {others.length > 0 ? (
            <div className="field">
              <label htmlFor="sending-via">{t("dom.sendingVia")}</label>
              <select
                id="sending-via"
                value={via ?? ""}
                disabled={busy}
                onChange={(e) => void chooseVia(e.target.value)}
              >
                <option value="">{domain.name}</option>
                {others.map((n) => (
                  <option key={n.name} value={n.name}>
                    {n.name} · {t(n.enabled ? "dom.sendingEnabled" : "dom.sendingDisabled")}
                  </option>
                ))}
              </select>
              <div className="field-hint">{t("dom.sendingViaHint")}</div>
            </div>
          ) : null}
          {preview.alreadyEnabled ? (
            <div className="banner ok">
              {t("dom.sendingAlreadyOnVia", { domain: preview.domainName })}
            </div>
          ) : (
            <>
              <p className="muted">{t("dom.enableSendingBody", { domain: preview.domainName })}</p>
              <ul className="record-list mono">
                {preview.records.map((r) => (
                  <li key={`${r.type}:${r.name}`}>
                    <strong>{r.type}</strong> {r.name} → {r.content.slice(0, 90)}
                    {r.content.length > 90 ? "…" : ""}
                  </li>
                ))}
              </ul>
              <div className="banner">
                {t("dom.enableSendingNote", { domain: preview.domainName })}
              </div>
              {preview.dmarcConflict ? (
                <>
                  <div className="banner error">
                    {t("dom.dmarcConflict", { domain: preview.domainName })}
                  </div>
                  <label className="row checkbox-row">
                    <input
                      type="checkbox"
                      checked={confirmDmarc}
                      onChange={(e) => setConfirmDmarc(e.target.checked)}
                    />
                    <span>{t("dom.dmarcConfirm", { domain: preview.domainName })}</span>
                  </label>
                </>
              ) : null}
            </>
          )}
          <div className="row-end">
            <button onClick={onClose}>{t("common.cancel")}</button>
            {preview.alreadyEnabled ? null : (
              <button
                className="primary"
                disabled={blocked || busy}
                aria-busy={busy}
                onClick={() => void enable()}
              >
                {t("dom.enableSending")}
              </button>
            )}
          </div>
        </>
      )}
    </Modal>
  );
}
