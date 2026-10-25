import { useCallback, useEffect, useState } from "react";
import { api } from "../../lib/api";
import { ApiClientError } from "../../lib/api";
import { withStepUp } from "../../lib/passkeys";
import { copyText } from "../../lib/clipboard";
import { t } from "../../lib/i18n";
import { Modal } from "../ui";
import { PreflightClassification } from "@mailvault/shared";

/**
 * The Mail Setup wizard (plan W2, docs/DOMAIN-SETUP-WIZARD-2026-10-25.md): one screen that
 * takes a freshly added zone to "mail arrives and leaves" without leaving the dashboard.
 * Every mutation button here calls the same tested routes the rest of the Domains page
 * uses — the wizard's own contribution is the diagnosis, the order, and the copy-paste
 * for the one step an app cannot do for its owner.
 */

interface SetupResponse {
  domain: { id: string; zoneId: string; name: string; mailStatus: string; sendingStatus: string; sendingVia: string | null };
  token: { readsZone: boolean; hint: string | null };
  receiving: {
    classification: PreflightClassification;
    routing: boolean;
    catchAllOurs: boolean;
    mxCloudflare: number;
    mxForeign: number;
    mxProviders: string[];
  };
  dnsPublic: { resolvable: boolean | null };
  sending: { enabled: boolean; records: Array<Record<string, unknown>>; dmarcConflict: boolean };
  spf: { count: number; records: string[] };
  next: string[];
}

const CLASS_KEY: Partial<Record<PreflightClassification, string>> = {
  [PreflightClassification.ReadyToProvision]: "cls.readyToProvision",
  [PreflightClassification.AlreadyConfigured]: "cls.alreadyConfigured",
  [PreflightClassification.MxConflict]: "cls.mxConflict",
  [PreflightClassification.CatchAllConflict]: "cls.catchAllConflict",
  [PreflightClassification.ZoneInactive]: "cls.zoneInactive",
  [PreflightClassification.UnsupportedZone]: "cls.unsupportedZone",
  [PreflightClassification.ApiPermissionError]: "cls.apiPermissionError",
};

function StepCard({
  tone,
  title,
  detail,
  children,
}: {
  tone: "ok" | "warn" | "error" | "quiet";
  title: string;
  detail?: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <div className={`card setup-step ${tone}`} style={{ marginTop: 10 }}>
      <div className="row spread wrap">
        <b>{title}</b>
        {children}
      </div>
      {detail ? <div className="faint" style={{ marginTop: 6 }}>{detail}</div> : null}
    </div>
  );
}

export function SetupWizard({
  zoneId,
  onClose,
  onOpenSending,
  onChanged,
}: {
  zoneId: string;
  onClose: () => void;
  /** The sending half reuses the page's existing dialog — wizard shows its state here. */
  onOpenSending: () => void;
  onChanged: () => void;
}) {
  const [data, setData] = useState<SetupResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [takeover, setTakeover] = useState(false);
  // W4: one probe at a time — send, then poll; the worker cleans the alias up on arrival.
  const [probe, setProbe] = useState<{ arrived: boolean; aliasId: string; messageId?: string } | null>(null);
  const [pollCount, setPollCount] = useState(0);

  const pollProbe = useCallback(
    (aliasId?: string) => {
      const id = aliasId ?? probe?.aliasId;
      if (!id) return;
      setBusy(true);
      void api
        .setupProbeStatus(zoneId, id)
        .then((r) => {
          setPollCount((n) => n + 3);
          if (r.arrived) {
            setProbe({ arrived: true, aliasId: id, messageId: r.messageId });
            setNotice(t("wiz.probeArrived"));
            onChanged();
          }
        })
        .catch(() => undefined)
        .finally(() => setBusy(false));
    },
    [probe?.aliasId, zoneId, onChanged],
  );

  const load = useCallback(() => {
    setData(null);
    setError(null);
    void api
      .domainSetup(zoneId)
      .then((r) => setData(r as unknown as SetupResponse))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [zoneId]);

  useEffect(load, [load]);

  async function enableReceiving() {
    setBusy(true);
    setNotice(null);
    try {
      const result = await withStepUp(() =>
        api.provisionDomains([zoneId], {
          allowCatchAllTakeover: takeover,
          allowMxTakeover: takeover,
        }),
      );
      const outcome = result.results[0];
      if (outcome?.ok) {
        setNotice(t("wiz.receivingDone"));
        onChanged();
        load();
      } else {
        setError(outcome?.error ?? t("dom.eProvision"));
      }
    } catch (e) {
      const msg = e instanceof ApiClientError ? e.message : String(e);
      setError(msg);
      // The honest escalation: conflicts need the owner's explicit takeover tick.
      if (/MX|catch-all|conflict/i.test(msg)) setTakeover(true);
    } finally {
      setBusy(false);
    }
  }

  const next = data?.next ?? [];
  const receivingOk = !!data && data.receiving.classification === PreflightClassification.AlreadyConfigured;
  const dnsProbeKnown = data?.dnsPublic.resolvable !== null && data?.dnsPublic.resolvable !== undefined;

  return (
    <Modal title={t("wiz.title", { name: data?.domain.name ?? "" })} onClose={onClose}>
      {error ? <div className="banner error">{error}</div> : null}
      {notice ? <div className="banner ok">{notice}</div> : null}
      {!data && !error ? <div className="banner">{t("common.loading")}</div> : null}

      {data ? (
        <>
          <StepCard
            tone={data.token.readsZone ? "quiet" : "error"}
            title={t("wiz.tokenTitle")}
            detail={data.token.readsZone ? t("wiz.tokenOk") : data.token.hint ?? t("wiz.tokenBad")}
          />

          <StepCard
            tone={receivingOk ? "ok" : data.token.readsZone ? "warn" : "quiet"}
            title={t("wiz.receivingTitle")}
            detail={
              receivingOk
                ? t("wiz.receivingOkDetail", {
                    mx: data.receiving.mxCloudflare,
                    dns: dnsProbeKnown
                      ? t(data.dnsPublic.resolvable ? "wiz.dnsSeen" : "wiz.dnsNotSeen")
                      : t("wiz.dnsUnknown"),
                  })
                : t("wiz.receivingPendingDetail", {
                    cls: t(CLASS_KEY[data.receiving.classification] ?? "cls.provisioningError"),
                    foreign: data.receiving.mxForeign,
                    providers: data.receiving.mxProviders.join(", ") || t("common.dash"),
                  })
            }
          >
            {next.includes("enable-receiving") ? (
              <span className="row wrap" style={{ gap: 8 }}>
                {takeover ? (
                  <label className="check small">
                    <input type="checkbox" checked={takeover} onChange={(e) => setTakeover(e.target.checked)} />
                    {t("wiz.takeoverTick")}
                  </label>
                ) : null}
                <button className="primary small" disabled={busy} onClick={() => void enableReceiving()}>
                  {t("wiz.enableReceiving")}
                </button>
              </span>
            ) : null}
          </StepCard>

          <StepCard
            tone={data.sending.enabled ? "ok" : data.token.readsZone ? "warn" : "quiet"}
            title={t("wiz.sendingTitle")}
            detail={
              data.sending.enabled
                ? t("wiz.sendingOkDetail", { via: data.domain.sendingVia ?? t("wiz.viaNone") })
                : t("wiz.sendingPendingDetail")
            }
          >
            <button className="small" onClick={onOpenSending}>
              {t(data.sending.enabled ? "wiz.reviewSending" : "wiz.enableSending")}
            </button>
          </StepCard>

          {next.includes("queue-subscription") ? (
            <StepCard
              tone="warn"
              title={t("wiz.queueTitle")}
              detail={t("wiz.queueDetail")}
            >
              <button
                className="ghost small"
                onClick={() => {
                  void copyText(
                    `./scripts/ops/queues-subscription.sh ${zoneId} ${data.domain.name}`,
                  ).then(() => setNotice(t("wiz.queueCopied")));
                }}
              >
                {t("wiz.queueCopy")}
              </button>
            </StepCard>
          ) : null}

          {next.includes("spf-merge") ? (
            <StepCard tone="warn" title={t("wiz.spfTitle")} detail={data.spf.records.join("  ·  ")}>
              <span className="row wrap" style={{ gap: 8, alignItems: "center" }}>
                <span className="faint">{t("wiz.spfDetail")}</span>
                <button
                  className="small"
                  disabled={busy}
                  onClick={() => {
                    setBusy(true);
                    setNotice(null);
                    void withStepUp(() => api.mergeSpf(zoneId))
                      .then((r) => {
                        setNotice(r.merged ? t("wiz.spfMerged", { content: r.content ?? "" }) : t("wiz.spfSkip", { reason: r.reason ?? "" }));
                        onChanged();
                        load();
                      })
                      .catch((e) => setError(e instanceof ApiClientError ? e.message : String(e)))
                      .finally(() => setBusy(false));
                  }}
                >
                  {t("wiz.spfMerge")}
                </button>
              </span>
            </StepCard>
          ) : null}

          {receivingOk && data.sending.enabled ? (
            <StepCard tone={probe ? (probe.arrived ? "ok" : "warn") : "quiet"} title={t("wiz.probeTitle")} detail={
              probe
                ? probe.arrived
                  ? t("wiz.probeArrived")
                  : t("wiz.probeWaiting")
                : t("wiz.probeDetail")
            }>
              {probe && !probe.arrived ? (
                <span className="row" style={{ gap: 8 }}>
                  <span className="faint">{pollCount > 0 ? `${pollCount}s` : ""}</span>
                  <button className="small" disabled={busy} onClick={() => void pollProbe()}>
                    {t("wiz.dnsRetry")}
                  </button>
                </span>
              ) : !probe ? (
                <button
                  className="small"
                  disabled={busy}
                  onClick={() => {
                    setBusy(true);
                    setError(null);
                    void api
                      .sendSetupProbe(zoneId)
                      .then((r) => {
                        setProbe({ arrived: false, aliasId: r.aliasId });
                        setNotice(t("wiz.probeSent", { address: r.probeAddress }));
                        void pollProbe(r.aliasId);
                      })
                      .catch((e) => setError(e instanceof ApiClientError ? e.message : String(e)))
                      .finally(() => setBusy(false));
                  }}
                >
                  {t("wiz.probeSend")}
                </button>
              ) : null}
            </StepCard>
          ) : null}

          {next.includes("probe-dns") ? (
            <StepCard tone="error" title={t("wiz.dnsTitle")} detail={t("wiz.dnsDetail")}>
              <button className="small" disabled={busy} onClick={load}>
                {t("wiz.dnsRetry")}
              </button>
            </StepCard>
          ) : null}
        </>
      ) : null}
    </Modal>
  );
}
