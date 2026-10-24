import { useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import { navigate } from "../lib/router";
import { NEW_MAIL_EVENT, SEND_FAILED_EVENT } from "../lib/live";
import { t } from "../lib/i18n";

/**
 * "Mail arrived" as a notice, not a silent refetch.
 *
 * The socket carries no content (SECURITY.md §6.4), and neither does this: the count comes
 * from the same authenticated list route the inbox uses, so the only thing said out loud is
 * how many unread messages the owner could already see if they were looking. Who sent them
 * stays behind the API call that requires a session.
 */
export function NewMailToast() {
  const [count, setCount] = useState<number | null>(null);
  const [sendFailed, setSendFailed] = useState(false);
  const baseline = useRef<number | null>(null);

  useEffect(() => {
    let alive = true;
    const total = () =>
      api
        .listMessages({ filter: "unread", limit: 1 })
        .then((r) => r.total)
        .catch(() => null);

    void total().then((v) => {
      if (v !== null) baseline.current = v;
    });

    const onNewMail = async () => {
      const now = await total();
      if (now === null || !alive) return;
      const before = baseline.current;
      baseline.current = now;
      if (before === null || now <= before) return;
      setCount(now - before);
    };

    window.addEventListener(NEW_MAIL_EVENT, onNewMail);
    return () => {
      alive = false;
      window.removeEventListener(NEW_MAIL_EVENT, onNewMail);
    };
  }, []);

  // A failed delivery is a notice with a deadline: the address may still be fixable by
  // hand while the reason is fresh. Content stays behind the authenticated Sent view.
  useEffect(() => {
    const onSendFailed = () => setSendFailed(true);
    window.addEventListener(SEND_FAILED_EVENT, onSendFailed);
    return () => window.removeEventListener(SEND_FAILED_EVENT, onSendFailed);
  }, []);
  useEffect(() => {
    if (!sendFailed) return;
    const timer = setTimeout(() => setSendFailed(false), 8000);
    return () => clearTimeout(timer);
  }, [sendFailed]);

  useEffect(() => {
    if (count === null) return;
    const timer = setTimeout(() => setCount(null), 8000);
    return () => clearTimeout(timer);
  }, [count]);

  if (count === null && !sendFailed) return null;

  return (
    <div className="toast-host" role="status">
      <div className="toast">
        {sendFailed ? (
          <>
            <span className="msg-count">{t("toast.sendFailed")}</span>
            <span className="actions">
              <button
                className="small primary"
                onClick={() => {
                  setSendFailed(false);
                  navigate("/inbox");
                }}
              >
                {t("toast.viewSent")}
              </button>
              <button
                className="ghost small"
                aria-label={t("common.close")}
                onClick={() => setSendFailed(false)}
              >
                ✕
              </button>
            </span>
          </>
        ) : (
          <>
        <span className="msg-count">{t("toast.newMail", { n: count ?? 0 })}</span>
        <span className="actions">
          <button
            className="small primary"
            onClick={() => {
              setCount(null);
              navigate("/inbox");
            }}
          >
            {t("toast.view")}
          </button>
          <button className="ghost small" aria-label={t("common.close")} onClick={() => setCount(null)}>
            ✕
          </button>
        </span>
          </>
        )}
      </div>
    </div>
  );
}
