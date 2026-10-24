import { useState } from "react";
import { api, ApiClientError } from "../lib/api";
import { useAsync } from "../lib/useAsync";
import { relativeTime } from "../lib/format";
import { rulePhrases, t } from "../lib/i18n";
import { describeRule, type Rule, type RuleAction, type RuleMatch } from "@mailvault/shared";
import { Menu } from "./ui";

function ruleSummary(r: Rule): string {
  return describeRule(r.match, r.action, rulePhrases());
}

/**
 * Rules are deliberately small: match on who sent it or what the subject says, then file
 * it. There is no delete action to choose, because a rule that destroys mail is the one
 * outcome this app promises it will not have.
 */
export function RulesCard() {
  const { data, reload, error } = useAsync(() => api.listRules(), []);
  const [senderDomain, setSenderDomain] = useState("");
  const [subjectContains, setSubjectContains] = useState("");
  const [archive, setArchive] = useState(true);
  const [tag, setTag] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const rules = data?.items ?? [];
  const nothingToMatch = !senderDomain.trim() && !subjectContains.trim();
  const nothingToDo = !archive && !tag.trim();

  async function add(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setProblem(null);
    const match: RuleMatch = {};
    if (senderDomain.trim()) match.senderDomain = senderDomain.trim().toLowerCase();
    if (subjectContains.trim()) match.subjectContains = subjectContains.trim();
    const action: RuleAction = {};
    if (archive) action.archive = true;
    if (tag.trim()) action.tag = tag.trim();
    try {
      await api.createRule({ match, action });
      setSenderDomain("");
      setSubjectContains("");
      setTag("");
      setArchive(true);
      reload();
    } catch (err) {
      setProblem(err instanceof ApiClientError ? err.message : t("rule.createFail"));
    } finally {
      setBusy(false);
    }
  }

  async function drop(r: Rule) {
    setBusy(true);
    try {
      await api.deleteRule(r.id);
      reload();
    } catch (err) {
      setProblem(err instanceof ApiClientError ? err.message : t("rule.deleteFail"));
    } finally {
      setBusy(false);
    }
  }

  async function toggleEnabled(r: Rule) {
    setBusy(true);
    try {
      await api.updateRule(r.id, { enabled: !r.enabled });
      reload();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card mt">
      <h2 style={{ marginTop: 0 }}>{t("rule.title")}</h2>
      <p className="muted" style={{ marginTop: 0 }}>
        {t("rule.intro")}
      </p>

      {error && <div className="banner error">{error}</div>}
      {problem && <div className="banner error">{problem}</div>}

      {rules.length > 0 && (
        <ul className="msglist" style={{ marginBottom: 12 }}>
          {rules.map((r) => (
            <li key={r.id} className="entity">
              <div className="entity-summary">
                <div className="entity-id">
                  <div className="entity-name">{ruleSummary(r)}</div>
                  <div className="entity-facts">
                    <span>{t(r.hits === 1 ? "rule.hitOnce" : "rule.hits", { n: r.hits })}</span>
                    {r.lastHitAt ? (
                      <span>{t("rule.last", { at: relativeTime(r.lastHitAt) })}</span>
                    ) : (
                      <span>{t("rule.never")}</span>
                    )}
                    {!r.enabled ? <span className="pill neutral">{t("rule.paused")}</span> : null}
                  </div>
                </div>
                <div className="row" style={{ gap: 6 }}>
                  <button className="ghost small" disabled={busy} onClick={() => toggleEnabled(r)}>
                    {t(r.enabled ? "rule.pause" : "rule.resume")}
                  </button>
                  <Menu
                    small
                    items={[
                      {
                        label: t("rule.delete"),
                        danger: true,
                        disabled: busy,
                        onSelect: () => drop(r),
                      },
                    ]}
                  />
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}

      {/* The form is folded because it is used when a rule is written, not every time the
          screen is opened — and left open on a phone it was more screen than the rules are. */}
      <details className="fold mt">
        <summary>{t("rule.newTitle")}</summary>
        <div className="fold-body">
          <form onSubmit={add}>
            <div
              className="grid"
              style={{ gridTemplateColumns: "repeat(auto-fit, minmax(min(200px, 100%), 1fr))" }}
            >
              <div className="field">
                <label htmlFor="rule-sender">{t("rule.sender")}</label>
                <input
                  id="rule-sender"
                  value={senderDomain}
                  onChange={(e) => setSenderDomain(e.target.value)}
                  placeholder="newsletters.github.com"
                  maxLength={253}
                />
              </div>
              <div className="field">
                <label htmlFor="rule-subject">{t("rule.subject")}</label>
                <input
                  id="rule-subject"
                  value={subjectContains}
                  onChange={(e) => setSubjectContains(e.target.value)}
                  placeholder="receipt"
                  maxLength={120}
                />
              </div>
              <div className="field">
                <label htmlFor="rule-tag">{t("rule.tag")}</label>
                <input
                  id="rule-tag"
                  value={tag}
                  onChange={(e) => setTag(e.target.value)}
                  placeholder="newsletters"
                  maxLength={60}
                />
              </div>
            </div>
            <label className="row" style={{ cursor: "pointer", marginTop: 8 }}>
              <input
                type="checkbox"
                style={{ width: "auto" }}
                checked={archive}
                onChange={(e) => setArchive(e.target.checked)}
              />
              {t("rule.file")}
            </label>
            <div className="row-end" style={{ marginTop: 10 }}>
              <button
                type="submit"
                className="primary"
                disabled={busy || nothingToMatch || nothingToDo}
              >
                {t("rule.add")}
              </button>
              {nothingToMatch && <span className="field-problem">{t("rule.needsMatch")}</span>}
              {nothingToDo && <span className="field-problem">{t("rule.needsAction")}</span>}
            </div>
          </form>
        </div>
      </details>
    </div>
  );
}

/**
 * Senders that hold more than one alias. Judged on the envelope sender, which SPF has to
 * have agreed about, rather than on a `From:` header anyone can type.
 */
export function AddressReuseCard() {
  const { data, error } = useAsync(() => api.addressReuse(), []);
  const items = data?.items ?? [];

  if (error) return null;
  if (items.length === 0) {
    return (
      <div className="card mt">
        <h2 style={{ marginTop: 0 }}>{t("reuse.title")}</h2>
        <p className="muted" style={{ marginBottom: 0 }}>
          {t("reuse.none")}
        </p>
      </div>
    );
  }

  return (
    <div className="card mt">
      <h2 style={{ marginTop: 0 }}>{t("reuse.title")}</h2>
      <p className="muted" style={{ marginTop: 0 }}>
        {t("reuse.intro")}
      </p>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>{t("reuse.sender")}</th>
              <th>{t("reuse.aliases")}</th>
              <th>{t("reuse.mail")}</th>
              <th>{t("reuse.first")}</th>
              <th>{t("reuse.last")}</th>
            </tr>
          </thead>
          <tbody>
            {items.map((r) => (
              <tr key={r.senderDomain}>
                <td className="addr">{r.senderDomain}</td>
                <td>{r.aliases}</td>
                <td>{r.messages}</td>
                <td className="muted">{relativeTime(r.firstSeen)}</td>
                <td className="muted">{relativeTime(r.lastSeen)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
