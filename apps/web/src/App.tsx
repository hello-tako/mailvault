import { Suspense, lazy, useEffect, useState } from "react";
import { Link, matchRoute, useRoute } from "./lib/router";
import { connectLive } from "./lib/live";
import { t, useLang } from "./lib/i18n";
import { useTheme } from "./lib/theme";
import { IconAlias, IconGauge, IconGlobe, IconInbox, IconSearch, IconSliders, VaultMark } from "./components/Icons";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { CommandPalette } from "./components/CommandPalette";
import { Loading } from "./components/ui";
import { NewMailToast } from "./components/NewMailToast";
import { MailboxRail } from "./components/mail/MailboxRail";
import { Dashboard } from "./pages/Dashboard";
import { Inbox } from "./pages/Inbox";

// Screens beyond the two the app opens on travel in their own chunks: a first visit pays
// for the dashboard and the inbox, not for the settings page it may never open. The
// command palette stays eager: it answers ⌘K within the same tick, before any chunk
// could arrive, and a keystroke racing a lazy load is a palette that ignores its owner.
const Domains = lazy(() => import("./pages/Domains").then((m) => ({ default: m.Domains })));
const Aliases = lazy(() => import("./pages/Aliases").then((m) => ({ default: m.Aliases })));
const AliasDetail = lazy(() => import("./pages/AliasDetail").then((m) => ({ default: m.AliasDetail })));
const MessageDetail = lazy(() => import("./pages/MessageDetail").then((m) => ({ default: m.MessageDetail })));
const Settings = lazy(() => import("./pages/Settings").then((m) => ({ default: m.Settings })));

const NAV = [
  { to: "/", key: "nav.dashboard", Icon: IconGauge },
  { to: "/domains", key: "nav.domains", Icon: IconGlobe },
  { to: "/aliases", key: "nav.aliases", Icon: IconAlias },
  { to: "/inbox", key: "nav.inbox", Icon: IconInbox },
  { to: "/settings", key: "nav.settings", Icon: IconSliders },
];

function isActive(path: string, to: string): boolean {
  if (to === "/") return path === "/";
  return path === to || path.startsWith(to + "/");
}

function Route() {
  const { path, query } = useRoute();
  const msg = matchRoute("/messages/:id", path);
  if (msg?.id) return <MessageDetail id={msg.id} />;
  const alias = matchRoute("/aliases/:id", path);
  if (alias?.id) return <AliasDetail id={alias.id} />;
  if (path === "/domains") return <Domains />;
  if (path === "/aliases") return <Aliases openNew={query.get("new") === "1"} />;
  if (path === "/inbox") return <Inbox aliasId={query.get("alias") ?? undefined} domainId={query.get("domain") ?? undefined} />;
  if (path === "/settings") return <Settings />;
  if (path === "/" || path === "") return <Dashboard />;
  return (
    <div className="page">
      <h1>{t("common.notFound")}</h1>
      <p className="muted">
        <Link to="/">{t("common.backToDashboard")}</Link>
      </p>
    </div>
  );
}

export function App() {
  const { path, query } = useRoute();
  useLang();
  useTheme();
  const [palette, setPalette] = useState(false);
  // The mailboxes are one screen's sub-navigation, not a global section, so they appear in
  // the rail only while that screen is on screen.
  const onInbox = path === "/inbox";

  useEffect(() => connectLive().stop, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPalette((open) => !open);
        return;
      }
      if (e.key === "/" && !e.metaKey && !e.ctrlKey && !e.altKey) {
        const el = document.activeElement;
        if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) return;
        e.preventDefault();
        setPalette(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">
            <VaultMark />
          </span>
          <span className="brand-text">
            <b>MailVault</b>
          </span>
        </div>
        <button className="rail-search" onClick={() => setPalette(true)}>
          <IconSearch size={16} />
          {t("pal.trigger")}
          <kbd>/</kbd>
        </button>
        <nav className="nav" aria-label={t("nav.menu")}>
          {NAV.map((n) => {
            const Icon = n.Icon;
            return (
              <Link key={n.to} to={n.to} className={isActive(path, n.to) ? "active" : ""}>
                <Icon />
                {t(n.key)}
              </Link>
            );
          })}
        </nav>
        {onInbox ? <MailboxRail current={query.get("domain") ?? undefined} /> : null}
      </aside>
      <main className="main">
        <ErrorBoundary>
          <Suspense fallback={<RouteFallback />} >
            <Route />
          </Suspense>
        </ErrorBoundary>
      </main>
      {palette ? <CommandPalette onClose={() => setPalette(false)} /> : null}
      <NewMailToast />
    </div>
  );
}

function RouteFallback() {
  return (
    <div className="page" aria-busy="true">
      <Loading />
    </div>
  );
}
