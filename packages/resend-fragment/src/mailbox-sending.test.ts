import { afterAll, assert, beforeAll, beforeEach, describe, expect, test } from "vitest";

import { drainDurableHooks } from "@fragno-dev/test";

import { MAX_MAILBOX_ATTACHMENT_BYTES } from "./mailbox-sending";
import {
  createResendTestContext,
  drainDurableHooksWithRetries,
  receivingGetMock,
  sendMock,
  verifyMock,
} from "./test-context";

type ResendTestContext = Awaited<ReturnType<typeof createResendTestContext>>;

const alice = { owner: "user:alice", address: "quiet-amber-falcon@mail.example" };
const bob = { owner: "user:bob", address: "brave-tidy-otter@mail.example" };

describe("resend-fragment mailbox sending", () => {
  let ctx: ResendTestContext;

  beforeAll(async () => {
    ctx = await createResendTestContext();
  });

  beforeEach(async () => {
    await ctx.reset();
    sendMock.mockResolvedValue({ data: { id: "re_sent" }, error: null });
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  const services = () => ctx.fragment.services;
  const open = ({ owner, address }: { owner: string; address: string }) =>
    ctx.fragment.callServices(() => services().openMailbox({ owner, address }));
  const getMailbox = (owner: string) =>
    ctx.fragment.callServices(() => services().getMailbox(owner));
  const sendFromMailbox = (
    input: Partial<Parameters<ReturnType<typeof services>["sendFromMailbox"]>[0]> = {},
  ) =>
    ctx.fragment.callServices(() =>
      services().sendFromMailbox({
        owner: alice.owner,
        to: ["alice@home.example"],
        subject: "Your receipts",
        text: "Two receipts this week.",
        fromName: "Alice via Leyway",
        ...input,
      }),
    );
  const replyFromMailbox = (
    input: Partial<Parameters<ReturnType<typeof services>["replyFromMailbox"]>[0]> & {
      emailMessageId: string;
    },
  ) =>
    ctx.fragment.callServices(() =>
      services().replyFromMailbox({
        owner: alice.owner,
        text: "Thanks, received.",
        subject: null,
        fromName: "Alice via Leyway",
        ...input,
      }),
    );

  async function postWebhook(payload: unknown, svixId: string) {
    verifyMock.mockReturnValue(payload);
    const response = await ctx.fragment.handler(
      new Request(`http://localhost${ctx.fragment.mountRoute}/webhook`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "svix-id": svixId,
          "svix-timestamp": "123456",
          "svix-signature": "sig",
        },
        body: JSON.stringify(payload),
      }),
    );
    assert(response.status === 200);
    await drainDurableHooks(ctx.fragment);
  }

  /** Delivers an email from `from` to `to`, with Resend's authentication results. */
  async function receive({
    emailId,
    to,
    from = "Shop <orders@shop.example>",
    replyTo = [],
    dkim = "pass",
    headers = { references: "<earlier@shop.example>" },
  }: {
    emailId: string;
    to: string;
    from?: string;
    replyTo?: string[];
    dkim?: "pass" | "fail";
    headers?: Record<string, string>;
  }) {
    receivingGetMock.mockResolvedValue({
      data: {
        id: emailId,
        created_at: "2026-03-18T10:00:00.000Z",
        from,
        to: [to],
        cc: [],
        bcc: [],
        reply_to: replyTo,
        subject: "Your order",
        message_id: `<${emailId}@shop.example>`,
        html: null,
        text: "Order 42 ships tomorrow.",
        headers,
        attachments: [],
        authentication: { spf: "fail", dkim, dmarc: dkim === "pass" ? "pass" : "fail" },
      },
      error: null,
      headers: null,
    });
    await postWebhook(
      {
        type: "email.received",
        created_at: "2026-03-18T10:00:00.000Z",
        data: {
          created_at: "2026-03-18T10:00:00.000Z",
          email_id: emailId,
          from,
          to: [to],
          cc: [],
          bcc: [],
          subject: "Your order",
          message_id: `<${emailId}@shop.example>`,
          attachments: [],
        },
      },
      emailId,
    );
  }

  test("sends from the owner's address, once per email, with replies coming back to it", async () => {
    await open(alice);
    const result = await sendFromMailbox({
      attachments: [
        { filename: "receipts.csv", content: btoa("date,total\n"), contentType: "text/csv" },
      ],
    });
    assert(result.status === "queued");
    expect(result.email).toEqual({
      emailMessageId: result.email.emailMessageId,
      from: `"Alice via Leyway" <${alice.address}>`,
      to: ["alice@home.example"],
      subject: "Your receipts",
    });
    await drainDurableHooks(ctx.fragment);

    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(sendMock.mock.calls[0]?.[0]).toMatchObject({
      from: `"Alice via Leyway" <${alice.address}>`,
      to: ["alice@home.example"],
      replyTo: [alice.address],
      text: "Two receipts this week.",
      attachments: [
        { filename: "receipts.csv", content: btoa("date,total\n"), contentType: "text/csv" },
      ],
    });
    const stored = await ctx.getEmail(result.email.emailMessageId);
    assert(stored !== null);
    expect(stored.senderMailbox).toEqual(alice);
    // Resend has the file, so the stored message keeps only what it was.
    expect(stored.attachments).toEqual([
      expect.not.objectContaining({ content: expect.anything() }),
    ]);
    expect(stored.attachments).toEqual([
      expect.objectContaining({ filename: "receipts.csv", size: 11, contentType: "text/csv" }),
    ]);
    expect(ctx.onMailboxEmailQueued.mock.calls.map(([payload]) => payload)).toEqual([
      { emailMessageId: result.email.emailMessageId, senderMailbox: alice },
    ]);
  });

  test("refuses to send without a mailbox in use, or while its sending is suspended", async () => {
    assert((await sendFromMailbox()).status === "not-found");

    await open(alice);
    await ctx.fragment.callServices(() => services().pauseMailbox(alice.owner));
    assert((await sendFromMailbox()).status === "paused");

    await open(alice);
    await ctx.fragment.callServices(() => services().suspendMailboxSending(alice.owner));
    assert((await sendFromMailbox()).status === "sending-suspended");
    // It still receives.
    expect(await ctx.fragment.callServices(() => services().findMailbox(alice.address))).toEqual(
      alice,
    );

    await ctx.fragment.callServices(() => services().resumeMailboxSending(alice.owner));
    assert((await sendFromMailbox()).status === "queued");
    await drainDurableHooks(ctx.fragment);
    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  test("holds back email queued before its mailbox stopped sending", async () => {
    await open(alice);
    const suspended = await sendFromMailbox();
    const paused = await sendFromMailbox({ subject: "Second" });
    assert(suspended.status === "queued" && paused.status === "queued");

    await ctx.fragment.callServices(() => services().suspendMailboxSending(alice.owner));
    await drainDurableHooks(ctx.fragment);
    expect(sendMock).not.toHaveBeenCalled();
    const held = await ctx.getEmail(suspended.email.emailMessageId);
    assert(held?.status === "failed");
    assert(held.errorCode === "mailbox_sending_suspended");

    await ctx.fragment.callServices(() => services().resumeMailboxSending(alice.owner));
    const later = await sendFromMailbox({ subject: "Third" });
    assert(later.status === "queued");
    await ctx.fragment.callServices(() => services().pauseMailbox(alice.owner));
    await drainDurableHooks(ctx.fragment);
    expect(sendMock).not.toHaveBeenCalled();
    assert((await ctx.getEmail(later.email.emailMessageId))?.errorCode === "mailbox_paused");
  });

  test("keeps an email's attachments through a rate limit, and sends them on retry", async () => {
    await open(alice);
    const attachments = [
      { filename: "receipts.csv", content: btoa("date,total\n"), contentType: "text/csv" },
    ];
    sendMock
      .mockResolvedValueOnce({
        data: null,
        error: { name: "rate_limit_exceeded", message: "Too many requests", statusCode: 429 },
        headers: null,
      })
      .mockResolvedValue({ data: { id: "re_sent" }, error: null, headers: null });
    const result = await sendFromMailbox({ attachments });
    assert(result.status === "queued");

    await drainDurableHooks(ctx.fragment);
    const waiting = await ctx.getEmail(result.email.emailMessageId);
    assert(waiting?.status === "queued");
    assert(waiting.errorCode === "rate_limit_exceeded");

    await drainDurableHooksWithRetries(ctx.fragment);
    expect(sendMock).toHaveBeenCalledTimes(2);
    expect(sendMock.mock.calls[1]?.[0]).toMatchObject({ attachments });
    assert((await ctx.getEmail(result.email.emailMessageId))?.status === "sent");
  });

  test("refuses attachments larger than a stored message holds", async () => {
    await open(alice);
    const content = btoa("x".repeat(MAX_MAILBOX_ATTACHMENT_BYTES + 3));
    await expect(
      sendFromMailbox({ attachments: [{ filename: "big.bin", content }] }),
    ).rejects.toThrow(/at most 1000000/);
  });

  test("replies to a verified sender in the received email's conversation", async () => {
    await open(alice);
    await receive({ emailId: "re_order", to: alice.address });
    const received = await ctx.getEmail("re_order");
    assert(received?.threadId);

    const result = await replyFromMailbox({ emailMessageId: "re_order" });
    assert(result.status === "queued");
    expect(result.email).toMatchObject({
      to: ["orders@shop.example"],
      subject: "Re: Your order",
    });
    await drainDurableHooks(ctx.fragment);

    expect(sendMock.mock.calls[0]?.[0]).toMatchObject({
      to: ["orders@shop.example"],
      subject: "Re: Your order",
      replyTo: [alice.address],
      headers: {
        "In-Reply-To": "<re_order@shop.example>",
        References: "<earlier@shop.example> <re_order@shop.example>",
      },
    });
    const reply = await ctx.getEmail(result.email.emailMessageId);
    assert(reply !== null);
    // The shop's answer to the reply finds the conversation by the reply's Message-ID.
    assert(reply.threadId?.internalId === received.threadId.internalId);
    expect(reply.messageId).toMatch(/^<[0-9a-f-]+@mail\.example>$/);
    const threadId = ctx.onEmailReceived.mock.calls[0]?.[0]?.threadId;
    assert(threadId);
    const thread = await ctx.getThread(threadId);
    assert(thread?.messageCount === 2);
    assert(thread.lastDirection === "outbound");

    ctx.onEmailReceived.mockClear();
    await receive({
      emailId: "re_answer",
      to: alice.address,
      headers: { "in-reply-to": reply.messageId ?? "" },
    });
    expect(ctx.onEmailReceived.mock.calls[0]?.[0]).toMatchObject({
      threadId,
      threadResolvedVia: "in-reply-to",
    });
  });

  test("replies to the From address, never to a Reply-To", async () => {
    await open(alice);
    // DKIM vouches for the From address's domain, and a shared provider's domain holds strangers.
    await receive({
      emailId: "re_shared",
      to: alice.address,
      from: "attacker@mail.example.net",
      replyTo: ["victim@mail.example.net"],
    });
    await receive({
      emailId: "re_elsewhere",
      to: alice.address,
      replyTo: ["collect@attacker.example"],
    });

    const shared = await replyFromMailbox({ emailMessageId: "re_shared" });
    assert(shared.status === "queued");
    expect(shared.email.to).toEqual(["attacker@mail.example.net"]);
    const elsewhere = await replyFromMailbox({ emailMessageId: "re_elsewhere" });
    assert(elsewhere.status === "queued");
    expect(elsewhere.email.to).toEqual(["orders@shop.example"]);
  });

  test("replies to the From address, never to one its display name holds", async () => {
    await open(alice);
    // The attacker's own domain passes DKIM; the address in its display name is someone else's.
    await receive({
      emailId: "re_disguised",
      to: alice.address,
      from: '"<victim@bank.example>" <collect@attacker.example>',
    });
    const reply = await replyFromMailbox({ emailMessageId: "re_disguised" });
    assert(reply.status === "queued");
    expect(reply.email.to).toEqual(["collect@attacker.example"]);

    // A sender's name cannot pose as another address either.
    const sent = await sendFromMailbox({ fromName: "Bank <help@bank.example> via Leyway" });
    assert(sent.status === "queued");
    expect(sent.email.from).toBe(`"Bank help@bank.example via Leyway" <${alice.address}>`);
  });

  test("refuses replies to unverified senders and to email the owner did not receive", async () => {
    await open(alice);
    await open(bob);
    await receive({ emailId: "re_forged", to: alice.address, dkim: "fail" });
    await receive({ emailId: "re_bobs", to: bob.address });

    assert(
      (await replyFromMailbox({ emailMessageId: "re_forged" })).status === "sender-unverified",
    );
    assert((await replyFromMailbox({ emailMessageId: "re_bobs" })).status === "email-not-found");
    assert((await replyFromMailbox({ emailMessageId: "re_missing" })).status === "email-not-found");

    const sent = await sendFromMailbox();
    assert(sent.status === "queued");
    // Only received email gets a reply, never the mailbox's own.
    assert(
      (await replyFromMailbox({ emailMessageId: sent.email.emailMessageId })).status ===
        "email-not-found",
    );
    await drainDurableHooks(ctx.fragment);
    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  test("a complaint suspends the sending mailbox and reports its status to the owner", async () => {
    await open(alice);
    const sent = await sendFromMailbox();
    assert(sent.status === "queued");
    await drainDurableHooks(ctx.fragment);
    ctx.onMailboxChanged.mockClear();

    const statusEvent = (type: string, createdAt: string) => ({
      type,
      created_at: createdAt,
      data: {
        email_id: "re_sent",
        from: sent.email.from,
        to: sent.email.to,
        subject: sent.email.subject,
        created_at: createdAt,
      },
    });
    await postWebhook(statusEvent("email.delivered", "2099-01-01T10:00:00.000Z"), "delivered");
    // A complaint arriving before a later event still counts.
    await postWebhook(statusEvent("email.complained", "2099-01-01T09:00:00.000Z"), "complained");

    expect(
      ctx.onEmailStatusUpdated.mock.calls.map(([payload]) => [
        payload.status,
        payload.senderMailbox,
      ]),
    ).toEqual([
      ["delivered", alice],
      ["complained", alice],
    ]);
    expect(await getMailbox(alice.owner)).toEqual({
      ...alice,
      paused: false,
      sendingSuspended: true,
    });
    expect(ctx.onMailboxChanged.mock.calls.map(([mailbox]) => mailbox)).toEqual([
      { ...alice, paused: false, sendingSuspended: true },
    ]);
    assert((await sendFromMailbox()).status === "sending-suspended");
  });
});
