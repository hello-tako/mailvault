import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { MailStatus } from "@mailvault/shared";
import { t } from "../lib/i18n";
import { ArtMailbox, ArtSearch, ArtAlias, ArtDomain } from "./Icons";

/** Stable tint choices for `Monogram`, so one sender always wears one colour. */
const TINTS = [12, 20, 28, 36];

/** A sender's initials on a tinted disc — identity at a glance without any address shown. */
export function Monogram({ name, large }: { name: string; large?: boolean }) {
  const clean = name.trim().replace(/^"+|"+$/g, "");
  const words = clean.split(/[\s._@-]+/).filter(Boolean);
  const initials = ((words[0]?.[0] ?? "?") + (words[1]?.[0] ?? "")).toUpperCase();
  let hash = 0;
  for (let i = 0; i < clean.length; i++) hash = (hash * 31 + clean.charCodeAt(i)) >>> 0;
  const tint = TINTS[hash % TINTS.length] as number;
  return (
    <span
      className={`mono-avatar ${large ? "mono-avatar--lg" : ""}`}
      aria-hidden="true"
      style={
        {
          "--av-bg": `color-mix(in oklab, var(--accent) ${tint}%, var(--surface-2))`,
          "--av-line": `color-mix(in oklab, var(--accent) ${tint + 14}%, var(--border))`,
        } as React.CSSProperties
      }
    >
      {initials}
    </span>
  );
}

export function Loading({ label }: { label?: string }) {
  return (
    <div className="loading">
      <span className="spinner" /> {label ?? t("common.loading")}
    </div>
  );
}

/**
 * The shape of the list that is about to arrive. A spinner in an empty page tells the owner
 * nothing about how long the list will be or where to look; this reserves the space and
 * fills it, so the first row lands without the page moving under their thumb.
 */
export function SkeletonList({ rows = 4 }: { rows?: number }) {
  return (
    <div className="skeleton-list" role="status" aria-label={t("common.loading")}>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="skeleton skeleton--row" />
      ))}
    </div>
  );
}

export function ErrorBanner({ message }: { message: string }) {
  return <div className="banner error">{message}</div>;
}


const ART = { mailbox: ArtMailbox, search: ArtSearch, alias: ArtAlias, domain: ArtDomain };

export function EmptyState({
  title,
  hint,
  action,
  art = "mailbox",
}: {
  title: string;
  hint?: string;
  action?: React.ReactNode;
  art?: keyof typeof ART;
}) {
  const Picture = ART[art];
  return (
    <div className="empty">
      <Picture />
      <strong>{title}</strong>
      {hint ? <span className="muted">{hint}</span> : null}
      {action}
    </div>
  );
}

const STATUS_PILL: Record<string, { cls: string; key: string }> = {
  [MailStatus.Ready]: { cls: "ready", key: "status.ready" },
  [MailStatus.Conflict]: { cls: "conflict", key: "status.conflict" },
  [MailStatus.Failed]: { cls: "error", key: "status.error" },
  [MailStatus.Provisioning]: { cls: "accent", key: "status.provisioning" },
  [MailStatus.Verifying]: { cls: "accent", key: "status.verifying" },
  [MailStatus.Preflight]: { cls: "accent", key: "status.preflight" },
  [MailStatus.Disabled]: { cls: "neutral", key: "status.disabled" },
  [MailStatus.Discovered]: { cls: "neutral", key: "status.discovered" },
};

export function StatusPill({ status }: { status: string }) {
  const s = STATUS_PILL[status];
  return <span className={`pill ${s?.cls ?? "neutral"}`}>{s ? t(s.key) : status}</span>;
}

/**
 * Which list row currently has its actions unfolded. One at a time: a list where every
 * row is open is the same list as before this existed.
 */
export function useOpenRow() {
  const [open, setOpen] = useState<string | null>(null);
  return {
    open,
    toggle: (id: string) => setOpen((cur) => (cur === id ? null : id)),
    close: () => setOpen(null),
  };
}

/**
 * A list row that reads as information first and controls second.
 *
 * The identity of the row is always visible; its actions are folded until the owner
 * engages with it — tapped on a touch screen, hovered or keyboard-focused on a desktop.
 * Folding is done with `grid-template-rows: 0fr` rather than `display: none` or
 * `visibility: hidden`, so the controls stay in the tab order and `:focus-within`
 * unfolds them: a keyboard user never walks into an action they cannot see, and a screen
 * reader still announces what a row can do.
 */
export function Row({
  id,
  open,
  onToggle,
  summary,
  actions,
  children,
}: {
  id: string;
  open: boolean;
  onToggle: (id: string) => void;
  summary: React.ReactNode;
  actions?: React.ReactNode;
  children?: React.ReactNode;
}) {
  const panel = useId();
  return (
    <div className={`entity ${open ? "is-open" : ""}`} data-row={id}>
      <div
        className="entity-summary"
        onClick={(e) => {
          // A control that is already inside the row does its own job; tapping it must not
          // also fold the row shut underneath the user's finger.
          if ((e.target as HTMLElement).closest("a,button,select,input,label")) return;
          onToggle(id);
        }}
      >
        <div className="entity-id">{summary}</div>
        {actions ? (
          <button
            className="ghost small entity-toggle"
            aria-expanded={open}
            aria-controls={panel}
            aria-label={t("common.showActions")}
            onClick={() => onToggle(id)}
          >
            ⋯
          </button>
        ) : null}
      </div>
      {actions ? (
        <div className="entity-fold" id={panel}>
          <div className="entity-actions">{actions}</div>
        </div>
      ) : null}
      {children}
    </div>
  );
}

/** Clipboard with a transient "Copied" confirmation. */
export function CopyButton({ text, label, small }: { text: string; label?: string; small?: boolean }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1400);
    return () => clearTimeout(timer);
  }, [copied]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand("copy");
      } catch {
        /* ignore */
      }
      document.body.removeChild(ta);
    }
    setCopied(true);
  }

  return (
    <button
      className={`small ${small ? "ghost" : ""} ${copied ? "is-copied" : ""}`}
      onClick={copy}
      aria-label={t("common.copyX", { what: text })}
    >
      {copied ? t("common.copied") : (label ?? t("common.copy"))}
    </button>
  );
}

/**
 * The one overlay that is not a child of the screen it was opened from.
 *
 * A dialog covers the whole window, so living inside a view's DOM makes it inherit that view's
 * stacking and layout — and any ancestor that animates, transforms or filters quietly becomes
 * the containing block of its `position: fixed` backdrop. Mounting on `document.body` removes
 * the whole class of problem, and keeps a sheet above the bottom navigation instead of under it.
 */
export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return createPortal(
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label={title}>
        <div className="row spread">
          <h2>{title}</h2>
          <button className="ghost small" onClick={onClose} aria-label={t("common.close")}>
            ✕
          </button>
        </div>
        <div className="mt">{children}</div>
      </div>
    </div>,
    document.body,
  );
}

/**
 * A small dropdown for the actions that should not crowd a row. Hand-rolled because the
 * alternative is a dependency for one widget: this keeps the same keyboard contract the
 * rest of the app has — Escape and clicking away close it, arrows move focus, and focus
 * returns to the trigger.
 */
export interface MenuItem {
  label: string;
  onSelect: () => void;
  danger?: boolean;
  disabled?: boolean;
}

export function Menu({ label, items, small }: { label?: string; items: MenuItem[]; small?: boolean }) {
  const [open, setOpen] = useState(false);
  const [up, setUp] = useState(false);
  const [left, setLeft] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const pop = popRef.current;
    const trigger = triggerRef.current;

    // A row near the bottom of a phone has no room below it; flip instead of clipping.
    // The bottom tab bar is fixed and paints over content, so on phones it — not the
    // viewport edge — is the real bottom boundary a popover has to clear.
    if (pop && trigger) {
      const rect = trigger.getBoundingClientRect();
      const popHeight = pop.offsetHeight;
      const bar = document.querySelector<HTMLElement>(".sidebar")?.getBoundingClientRect();
      const overlaysBottom = !!bar && bar.top > window.innerHeight / 2 && bar.bottom >= window.innerHeight - 1;
      const floor = overlaysBottom && bar ? bar.top : window.innerHeight;
      setUp(floor - rect.bottom < popHeight + 16 && rect.top > popHeight + 16);
      // Anchored to the trigger's right edge by default; on a narrow window the trigger
      // can sit so far left that the panel would hang off-screen instead.
      setLeft(rect.right - pop.offsetWidth < 8);
      pop.querySelector<HTMLButtonElement>("[role='menuitem']:not([disabled])")?.focus();
    }

    const close = () => {
      setOpen(false);
      triggerRef.current?.focus();
    };
    const onPointerDown = (e: PointerEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) close();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        close();
        return;
      }
      if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
      const nodes = Array.from(
        popRef.current?.querySelectorAll<HTMLButtonElement>("[role='menuitem']:not([disabled])") ?? [],
      );
      if (nodes.length === 0) return;
      e.preventDefault();
      const at = nodes.indexOf(document.activeElement as HTMLButtonElement);
      const next = e.key === "ArrowDown" ? (at + 1) % nodes.length : (at - 1 + nodes.length) % nodes.length;
      nodes[next]?.focus();
    };

    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, [open]);

  if (items.length === 0) return null;

  return (
    <div className="menu" ref={wrapRef}>
      <button
        ref={triggerRef}
        className={small ? "small" : ""}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        {label ?? t("common.more")}
      </button>
      {open && (
        <div ref={popRef} role="menu" className={`menu-pop ${up ? "menu-up" : ""} ${left ? "menu-left" : ""}`}>
          {items.map((item) => (
            <button
              key={item.label}
              role="menuitem"
              className={item.danger ? "danger" : ""}
              disabled={item.disabled}
              onClick={() => {
                setOpen(false);
                item.onSelect();
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Destructive-action confirm requiring the owner to click an explicit danger button. */
export function ConfirmDialog({
  title,
  description,
  confirmLabel,
  danger = true,
  onConfirm,
  onClose,
}: {
  title: string;
  description: React.ReactNode;
  confirmLabel: string;
  danger?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <Modal title={title} onClose={onClose}>
      <div className="muted" style={{ marginBottom: 18 }}>{description}</div>
      <div className="row-end">
        <button onClick={onClose}>{t("common.cancel")}</button>
        <button className={danger ? "danger" : "primary"} onClick={onConfirm}>
          {confirmLabel}
        </button>
      </div>
    </Modal>
  );
}
