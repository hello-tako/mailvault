import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { AuthVerdict, MessageSummarySchema } from "@mailvault/shared";
import { MsgItem } from "./MessageRow";

function message(authVerdict: AuthVerdict) {
  return MessageSummarySchema.parse({
    authVerdict,
    id: "message-1",
    aliasId: "alias-1",
    aliasAddress: "codes@example.com",
    aliasLabel: null,
    domainName: "example.com",
    envelopeFrom: "sender@example.net",
    headerFrom: "Sender <sender@example.net>",
    headerTo: "codes@example.com",
    subject: "Sign in",
    preview: "Your code is 123456",
    receivedAt: "2026-01-01T00:00:00.000Z",
    isRead: true,
    hasAttachments: false,
    attachmentCount: 0,
    primaryCode: "123456",
  });
}

function renderRow(authVerdict: AuthVerdict) {
  return render(
    <ul>
      <MsgItem
        m={message(authVerdict)}
        scoped={false}
        fresh={false}
        active={false}
        wide={false}
        onOpen={vi.fn()}
      />
    </ul>,
  );
}

describe("MessageRow sender-auth content gating", () => {
  it("hides previews and inline codes until the inbound sender is trusted", () => {
    renderRow(AuthVerdict.Unverified);

    expect(screen.queryByText("Your code is 123456")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Copy code" })).not.toBeInTheDocument();
    expect(screen.getByText(/unverified sender/i)).toBeInTheDocument();
  });

  it("shows previews and inline codes for trusted inbound mail", () => {
    renderRow(AuthVerdict.Trusted);

    expect(screen.getByText("Your code is 123456")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy code" })).toBeInTheDocument();
  });
});
