import { describe, expect, it } from "vitest";
import { MailStatus, type MailboxStat } from "@mailvault/shared";
import { arrivalLabel, MAILBOX_LIMIT, selectableMailboxes, splitMailboxes } from "./mailboxes";

function box(name: string, over: Partial<MailboxStat> = {}): MailboxStat {
  return {
    domainId: `id-${name}`,
    name,
    mailStatus: MailStatus.Ready,
    total: 0,
    unread: 0,
    lastReceivedAt: null,
    ...over,
  };
}

describe("splitMailboxes", () => {
  it("leads with the mailboxes that have mail and collapses the rest", () => {
    const all = [box("busy.example", { total: 9, unread: 4 }), box("empty.example"), box("quiet.example", { total: 1 })];
    const split = splitMailboxes(all, 2);
    expect(split.shown.map((m) => m.name)).toEqual(["busy.example", "quiet.example"]);
    expect(split.overflow).toEqual([]);
    expect(split.empty.map((m) => m.name)).toEqual(["empty.example"]);
  });

  it("keeps the API's order past the limit instead of re-sorting by name", () => {
    const all = Array.from({ length: MAILBOX_LIMIT + 3 }, (_, i) => box(`d${i}.example`, { total: 100 - i }));
    const split = splitMailboxes(all);
    expect(split.shown).toHaveLength(MAILBOX_LIMIT);
    expect(split.overflow.map((m) => m.name)).toEqual([`d${MAILBOX_LIMIT}.example`, `d${MAILBOX_LIMIT + 1}.example`, `d${MAILBOX_LIMIT + 2}.example`]);
  });

  it("collapses onto nothing when every mailbox has mail", () => {
    const all = Array.from({ length: MAILBOX_LIMIT + 1 }, (_, i) => box(`d${i}.example`, { total: 1 }));
    const split = splitMailboxes(all);
    expect(split.empty).toEqual([]);
    expect(split.overflow).toHaveLength(1);
  });
});

describe("selectableMailboxes", () => {
  const all = [box("ready.example"), box("broken.example", { mailStatus: MailStatus.Conflict })];

  it("does not offer a domain that cannot receive mail", () => {
    expect(selectableMailboxes(all).map((m) => m.domainId)).toEqual(["id-ready.example"]);
  });

  it("keeps the mailbox already open, or switching away from it would break the back gesture", () => {
    const picked = selectableMailboxes(all, "id-broken.example");
    expect(picked.map((m) => m.domainId)).toEqual(["id-ready.example", "id-broken.example"]);
  });
});

describe("arrivalLabel", () => {
  const labelled = { aliasLabel: "GitHub", aliasAddress: "gh-7f2a@demo.example", domainName: "demo.example" };
  const unlabelled = { aliasLabel: null, aliasAddress: "gh-7f2a@demo.example", domainName: "demo.example" };

  it("leads with the domain when rows from several mailboxes are mixed", () => {
    expect(arrivalLabel(labelled, false)).toBe("demo.example · GitHub");
  });

  it("drops the domain inside one mailbox, where every row shares it", () => {
    expect(arrivalLabel(labelled, true)).toBe("GitHub");
  });

  it("leaves a bare address alone, because it already carries the domain", () => {
    expect(arrivalLabel(unlabelled, false)).toBe("gh-7f2a@demo.example");
  });
});
