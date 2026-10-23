import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { AuthVerdict } from "@mailvault/shared";
import { AuthBanner } from "./MailInsights";

describe("AuthBanner provenance explanation", () => {
  it("explains that unverified header results do not establish the sender", () => {
    render(<AuthBanner verdict={AuthVerdict.Unverified} auth={null} />);

    expect(screen.getByText("Sender not verified")).toBeInTheDocument();
    expect(
      screen.getByText(/Cloudflare's Worker API provides no separate verified sender verdict/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/No trustworthy assessment is stored for this older message/i),
    ).toBeInTheDocument();
  });
});
