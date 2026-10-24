import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearDraft, draftIsBlank, readDraft, saveDraft } from "./drafts";

// The runner's global localStorage is not always a full Storage (Node's experimental
// implementation has been seen here without removeItem); the draft module only needs the
// three methods a browser always has, so the test supplies exactly those.
vi.stubGlobal(
  "localStorage",
  (() => {
    const m = new Map<string, string>();
    return {
      getItem: (k: string) => m.get(k) ?? null,
      setItem: (k: string, v: string) => void m.set(k, v),
      removeItem: (k: string) => void m.delete(k),
    };
  })(),
);

beforeEach(() => localStorage.removeItem("mailvault-draft"));

describe("compose drafts", () => {
  it("round-trips what was written", () => {
    saveDraft({ from: "ops@omnipos.tech", to: "a@b.com", cc: "", subject: "Hi", text: "Body" });
    const d = readDraft();
    expect(d?.from).toBe("ops@omnipos.tech");
    expect(d?.to).toBe("a@b.com");
    expect(d?.subject).toBe("Hi");
    expect(d?.savedAt).toBeTruthy();
  });

  it("treats a corrupted store as no draft rather than a broken composer", () => {
    localStorage.setItem("mailvault-draft", "{not json");
    expect(readDraft()).toBeNull();
  });

  it("clears", () => {
    saveDraft({ from: "x@y.z", to: "", cc: "", subject: "", text: "" });
    clearDraft();
    expect(readDraft()).toBeNull();
  });

  it("knows when there is nothing worth saving", () => {
    expect(draftIsBlank({ from: "", to: "  ", cc: "", subject: "", text: "" })).toBe(true);
    expect(draftIsBlank({ from: "", to: "", cc: "", subject: "", text: "one line" })).toBe(false);
  });
});
