import { useCallback, useEffect, useRef, useState } from "react";
import { ApiClientError } from "./api";
import { t } from "./i18n";
import { NEW_MAIL_EVENT } from "./live";

export interface AsyncState<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  reload: () => void;
}

export interface UseAsyncOptions {
  /**
   * Whether a new-mail nudge refetches this hook. The nudge says "the list changed", so it
   * belongs to the inbox list and the badges beside it — a page full of hooks all
   * refetching on every arrival was the tab telling itself the same news twice.
   */
  live?: boolean;
}

/** Minimal loader keyed by `deps`. `run` must be stable (wrap in useCallback). */
export function useAsync<T>(
  run: () => Promise<T>,
  deps: readonly unknown[],
  opts: UseAsyncOptions = {},
): AsyncState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (opts.live === true) {
      const onNewMail = () => setNonce((n) => n + 1);
      window.addEventListener(NEW_MAIL_EVENT, onNewMail);
      return () => window.removeEventListener(NEW_MAIL_EVENT, onNewMail);
    }
  }, [opts.live]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    run()
      .then((d) => !cancelled && setData(d))
      .catch((e: unknown) => {
        if (cancelled) return;
        setError(e instanceof ApiClientError ? e.message : e instanceof Error ? e.message : t("common.error"));
      })
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [...deps, nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  return { data, error, loading, reload };
}
