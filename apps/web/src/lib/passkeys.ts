import { startAuthentication, startRegistration } from "@simplewebauthn/browser";
import { api } from "./api";
import { ApiClientError } from "./api";
import { clearGrant, rememberGrant } from "./grant";

/**
 * Passkey step-up: a second factor for the actions that cannot be undone.
 *
 * Access already says which account you signed into. This says the same person is holding
 * this device now, so a copied session cookie cannot purge mail or detach a domain on its
 * own.
 */

export function needsStepUp(e: unknown): boolean {
  return (
    e instanceof ApiClientError &&
    e.status === 403 &&
    (e.details as { stepUpRequired?: boolean } | undefined)?.stepUpRequired === true
  );
}

/** Ask the authenticator, then remember the short-lived grant the server hands back. */
export async function stepUp(): Promise<void> {
  const { options, challenge } = await api.stepUpOptions();
  const response = await startAuthentication({ optionsJSON: options as never });
  const grant = await api.stepUpVerify({ response, challenge });
  rememberGrant(grant.token, grant.expiresAt);
}

/**
 * Run an action, and if the server says it needs the passkey, ask for it and run once more.
 * The caller does not decide whether the action is sensitive — the route does — so adding a
 * gate later cannot leave a page behind that forgot to ask.
 */
export async function withStepUp<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (e) {
    if (!needsStepUp(e)) throw e;
    await stepUp();
    return await run();
  }
}

export async function registerPasskey(deviceLabel?: string): Promise<void> {
  await withStepUp(async () => {
    const { options, challenge } = await api.passkeyOptions();
    const response = await startRegistration({ optionsJSON: options as never });
    await api.passkeyVerify({ response, challenge, deviceLabel });
  });
  // Enrolling a new key is not the same as proving you hold one.
  clearGrant();
}

export async function removePasskey(id: string): Promise<void> {
  await withStepUp(() => api.deletePasskey(id));
  clearGrant();
}
