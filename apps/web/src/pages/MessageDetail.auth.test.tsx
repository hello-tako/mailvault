import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import {
  AuthVerdict,
  MessageDirection,
  type MessageDetail as MessageDetailData,
} from "@mailvault/shared";
import { MessageDetail } from "./MessageDetail";

const mockState = vi.hoisted(() => ({ message: null as MessageDetailData | null }));

vi.mock("../lib/useAsync", () => ({
  useAsync: () => ({
    data: mockState.message ? { ...mockState.message, items: [] } : null,
    error: null,
    loading: false,
    reload: () => undefined,
  }),
}));

vi.mock("../lib/useOutbox", () => ({
  useOutbox: () => ({ capabilities: null, aliases: [], reload: () => undefined }),
}));

function unverifiedMessage(id: string): MessageDetailData {
  return {
    id,
    aliasId: "alias-1",
    aliasAddress: "codes@example.com",
    aliasLabel: null,
    domainName: "example.com",
    envelopeFrom: "sender@example.net",
    headerFrom: "Sender <sender@example.net>",
    headerTo: "codes@example.com",
    subject: "Sign in",
    preview: null,
    receivedAt: "2026-01-01T00:00:00.000Z",
    headerDate: null,
    isRead: true,
    starred: false,
    archived: false,
    ruleTag: null,
    hasAttachments: false,
    attachmentCount: 0,
    primaryCode: "123456",
    codeCount: 1,
    linkCount: 1,
    direction: MessageDirection.In,
    threadRootId: id,
    sendStatus: null,
    cc: null,
    providerMessageId: "provider-1",
    rawSize: 100,
    extractedCodes: [{ value: "123456", kind: "numeric", length: 6, confidence: 1 }],
    verificationLinks: [
      { url: "https://example.net/verify", hostname: "example.net", label: "Verify", score: 1 },
    ],
    attachments: [],
    htmlBody: null,
    textBody: "The body contains verification code 123456.",
    parseDegraded: false,
    auth: null,
    authVerdict: AuthVerdict.Unverified,
    oneClickUnsubscribe: false,
    listUnsubscribe: null,
    appliedRuleNote: null,
    recipients: [],
    inReplyTo: null,
    references: [],
    replyTo: null,
    sendError: null,
  } as MessageDetailData;
}

describe("MessageDetail sender-auth content gating", () => {
  beforeEach(() => {
    mockState.message = unverifiedMessage("message-1");
  });

  it("hides the body, extracted secrets and links until explicit reveal", () => {
    render(<MessageDetail id="message-1" />);

    expect(
      screen.queryByText("The body contains verification code 123456."),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("123456")).not.toBeInTheDocument();
    expect(screen.queryByText("Verify")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Show anyway/i }));

    expect(screen.getByText("The body contains verification code 123456.")).toBeInTheDocument();
    expect(screen.getByText("Verify")).toBeInTheDocument();
  });

  it("does not carry an explicit reveal over to another message", () => {
    const { rerender } = render(<MessageDetail id="message-1" />);
    fireEvent.click(screen.getByRole("button", { name: /Show anyway/i }));
    expect(screen.getByText("The body contains verification code 123456.")).toBeInTheDocument();

    mockState.message = unverifiedMessage("message-2");
    rerender(<MessageDetail id="message-2" />);

    expect(
      screen.queryByText("The body contains verification code 123456."),
    ).not.toBeInTheDocument();
  });
});
