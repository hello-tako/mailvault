import { describe, expect, it } from "vitest";
import { mergeSpfRecords } from "../../src/provisioning/setup";

describe("mergeSpfRecords (W3)", () => {
  it("unions mechanisms in first-seen order, keeping the stronger all", () => {
    expect(
      mergeSpfRecords([
        "v=spf1 include:_spf.ionos.com ~all",
        "v=spf1 include:_spf.mx.cloudflare.net ~all",
      ]),
    ).toBe("v=spf1 include:_spf.ionos.com include:_spf.mx.cloudflare.net ~all");
  });

  it("never softens: -all wins over ~all regardless of order", () => {
    expect(
      mergeSpfRecords(["v=spf1 a ~all", "v=spf1 include:x.example -all"]),
    ).toBe("v=spf1 a include:x.example -all");
  });

  it("de-duplicates the same include arriving twice", () => {
    expect(
      mergeSpfRecords(["v=spf1 include:_spf.mx.cloudflare.net ~all", "v=spf1 include:_spf.mx.cloudflare.net ip4:1.2.3.4 ~all"]),
    ).toBe("v=spf1 include:_spf.mx.cloudflare.net ip4:1.2.3.4 ~all");
  });

  it("refuses to merge fewer than two records", () => {
    expect(mergeSpfRecords(["v=spf1 ~all"])).toBeNull();
    expect(mergeSpfRecords([])).toBeNull();
  });
});
