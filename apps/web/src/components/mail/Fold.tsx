import type { ReactNode } from "react";

/**
 * One panel of a message that explains rather than shows: the links it carries, the evidence
 * behind its verdict, how a send was delivered.
 *
 * The summary says what is inside before it is opened, because a folded section with no label
 * is a thing the owner cannot decide about. Whether they start open is the owner's call in
 * Settings; the count is part of the label so a fold never hides how much it holds.
 */
export function Fold({
  title,
  count,
  open,
  children,
}: {
  title: string;
  count?: number;
  open: boolean;
  children: ReactNode;
}) {
  return (
    <details className="fold" open={open}>
      <summary>
        {title}
        {count ? <span className="fold-n">{count}</span> : null}
      </summary>
      <div className="fold-body">{children}</div>
    </details>
  );
}
