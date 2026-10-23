/**
 * One compose draft, kept on the device the owner is typing on.
 *
 * A draft is a convenience, not a record: it lives in localStorage only, it is never sent
 * anywhere, and clearing it is always safe. Replies are anchored to the message they
 * answer and stay out of this entirely — the draft slot belongs to "I started writing
 * something and got interrupted".
 */
export interface ComposeDraft {
  from: string;
  to: string;
  cc: string;
  subject: string;
  text: string;
  savedAt: string;
}

export type ComposeDraftFields = Omit<ComposeDraft, "savedAt">;

const KEY = "mailvault-draft";

export function readDraft(): ComposeDraft | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<ComposeDraft>;
    if (typeof parsed.from !== "string") return null;
    return {
      from: parsed.from,
      to: typeof parsed.to === "string" ? parsed.to : "",
      cc: typeof parsed.cc === "string" ? parsed.cc : "",
      subject: typeof parsed.subject === "string" ? parsed.subject : "",
      text: typeof parsed.text === "string" ? parsed.text : "",
      savedAt: typeof parsed.savedAt === "string" ? parsed.savedAt : "",
    };
  } catch {
    return null;
  }
}

export function saveDraft(fields: ComposeDraftFields): void {
  try {
    localStorage.setItem(KEY, JSON.stringify({ ...fields, savedAt: new Date().toISOString() }));
  } catch {
    // Quota or privacy mode: losing a draft beats crashing the composer.
  }
}

export function clearDraft(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* nothing to do */
  }
}

/** Nothing written anywhere — saving this would be keeping an empty promise. */
export function draftIsBlank(d: ComposeDraftFields): boolean {
  return !(d.from.trim() || d.to.trim() || d.cc.trim() || d.subject.trim() || d.text.trim());
}
