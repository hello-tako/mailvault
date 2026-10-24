const KEY = "mailvault-insights";

/**
 * Whether the panels that *explain* a message start open: the verification links it carries,
 * the authentication evidence behind its verdict, how a send was delivered, the unsubscribe
 * route. The message itself and any code in it are never behind this.
 *
 * Collapsed unless the owner turned it on in Settings, and stored on the device like the
 * thread view and the language — a way of reading, not a fact about the mail.
 */
export function insightsOpen(): boolean {
  return localStorage.getItem(KEY) === "1";
}

export function setInsightsOpen(open: boolean) {
  localStorage.setItem(KEY, open ? "1" : "0");
}
