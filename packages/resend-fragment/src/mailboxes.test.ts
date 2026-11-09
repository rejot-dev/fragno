import { afterAll, assert, beforeAll, beforeEach, describe, expect, test } from "vitest";

import { drainDurableHooks } from "@fragno-dev/test";

import { createResendTestContext, receivingGetMock, verifyMock } from "./test-context";

type ResendTestContext = Awaited<ReturnType<typeof createResendTestContext>>;

describe("resend-fragment mailboxes", () => {
  let ctx: ResendTestContext;

  beforeAll(async () => {
    ctx = await createResendTestContext();
  });

  beforeEach(async () => {
    await ctx.reset();
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  const open = (owner: string, address: string) =>
    ctx.fragment.callServices(() => ctx.fragment.services.openMailbox({ owner, address }));
  const pause = (owner: string) =>
    ctx.fragment.callServices(() => ctx.fragment.services.pauseMailbox(owner));
  const replace = (owner: string, address: string) =>
    ctx.fragment.callServices(() =>
      ctx.fragment.services.replaceMailboxAddress({ owner, address }),
    );
  const find = (address: string) =>
    ctx.fragment.callServices(() => ctx.fragment.services.findMailbox(address));

  /** Resend reports `envelopeTo` as the recipients; the message's own To header names `headerTo`. */
  async function receive({
    emailId,
    envelopeTo,
    headerTo,
  }: {
    emailId: string;
    envelopeTo: string[];
    headerTo: string[];
  }) {
    const payload = {
      type: "email.received",
      created_at: "2026-03-18T10:00:00.000Z",
      data: {
        created_at: "2026-03-18T10:00:00.000Z",
        email_id: emailId,
        from: "Shop <orders@shop.example>",
        to: envelopeTo,
        cc: [],
        bcc: [],
        subject: "Fwd: Your receipt",
        message_id: `<${emailId}@shop.example>`,
        attachments: [],
      },
    };
    verifyMock.mockReturnValue(payload);
    receivingGetMock.mockResolvedValue({
      data: {
        id: emailId,
        created_at: "2026-03-18T10:00:00.000Z",
        from: "Shop <orders@shop.example>",
        to: headerTo,
        cc: [],
        bcc: [],
        reply_to: ["billing@shop.example"],
        subject: "Fwd: Your receipt",
        message_id: `<${emailId}@shop.example>`,
        html: "<p>Total: 12 EUR</p>",
        text: "Total: 12 EUR",
        headers: { "x-forwarded-for": "me@mail.example" },
        attachments: [],
        authentication: { spf: "fail", dkim: "pass", dmarc: "pass" },
      },
      error: null,
      headers: null,
    });

    const response = await ctx.fragment.handler(
      new Request(`http://localhost${ctx.fragment.mountRoute}/webhook`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "svix-id": emailId,
          "svix-timestamp": "123456",
          "svix-signature": "sig",
        },
        body: JSON.stringify(payload),
      }),
    );
    assert(response.status === 200);
    await drainDurableHooks(ctx.fragment);
  }

  test("an owner keeps one address however often it opens its mailbox", async () => {
    expect(await open("user:alice", "Receipts@Mail.Example")).toEqual({
      status: "opened",
      mailbox: {
        owner: "user:alice",
        address: "receipts@mail.example",
        paused: false,
        sendingSuspended: false,
      },
    });
    expect(await open("user:alice", "other@mail.example")).toMatchObject({
      mailbox: { address: "receipts@mail.example" },
    });
    expect(await open("user:bob", "receipts@mail.example")).toEqual({ status: "taken" });
    // The address alice was not given stays free.
    expect(await open("user:bob", "other@mail.example")).toMatchObject({
      mailbox: { address: "other@mail.example" },
    });
  });

  test("concurrent opens settle on one mailbox per owner and one owner per address", async () => {
    const sameOwner = await Promise.all([
      open("user:alice", "first@mail.example"),
      open("user:alice", "second@mail.example"),
    ]);
    const [first, second] = sameOwner;
    assert(first.status === "opened" && second.status === "opened");
    expect(second.mailbox).toEqual(first.mailbox);

    const sameAddress = await Promise.all([
      open("user:bob", "shared@mail.example"),
      open("user:carol", "shared@mail.example"),
    ]);
    expect(sameAddress.map(({ status }) => status).sort()).toEqual(["opened", "taken"]);
  });

  test("announces each mailbox change once it commits", async () => {
    const announced = async () => {
      await drainDurableHooks(ctx.fragment);
      const mailboxes = ctx.onMailboxChanged.mock.calls.map(([mailbox]) => mailbox);
      ctx.onMailboxChanged.mockClear();
      return mailboxes;
    };
    const alice = { owner: "user:alice", address: "receipts@mail.example" };

    await open(alice.owner, alice.address);
    expect(await announced()).toEqual([{ ...alice, paused: false, sendingSuspended: false }]);
    // Nothing changes when an open mailbox opens again or a paused one pauses again.
    await open(alice.owner, "other@mail.example");
    expect(await announced()).toEqual([]);
    await pause(alice.owner);
    await pause(alice.owner);
    expect(await announced()).toEqual([{ ...alice, paused: true, sendingSuspended: false }]);
    await open(alice.owner, "other@mail.example");
    expect(await announced()).toEqual([{ ...alice, paused: false, sendingSuspended: false }]);
    await replace(alice.owner, "new@mail.example");
    expect(await announced()).toEqual([
      { owner: alice.owner, address: "new@mail.example", paused: false, sendingSuspended: false },
    ]);
  });

  test("a paused mailbox receives nothing until its owner opens it again", async () => {
    await open("user:alice", "receipts@mail.example");
    expect(await pause("user:alice")).toEqual({ status: "paused" });
    expect(await find("receipts@mail.example")).toBeNull();

    expect(await open("user:alice", "other@mail.example")).toEqual({
      status: "opened",
      mailbox: {
        owner: "user:alice",
        address: "receipts@mail.example",
        paused: false,
        sendingSuspended: false,
      },
    });
    expect(await find("receipts@mail.example")).toEqual({
      address: "receipts@mail.example",
      owner: "user:alice",
    });
    expect(await pause("user:bob")).toEqual({ status: "not-found" });
  });

  test("a replaced address receives nothing and is never issued again", async () => {
    await open("user:alice", "receipts@mail.example");
    expect(await replace("user:alice", "fresh@mail.example")).toEqual({
      status: "replaced",
      mailbox: {
        owner: "user:alice",
        address: "fresh@mail.example",
        paused: false,
        sendingSuspended: false,
      },
    });
    expect(await find("receipts@mail.example")).toBeNull();
    expect(await find("fresh@mail.example")).toEqual({
      address: "fresh@mail.example",
      owner: "user:alice",
    });
    expect(await open("user:bob", "receipts@mail.example")).toEqual({ status: "taken" });
    expect(await replace("user:alice", "receipts@mail.example")).toEqual({ status: "taken" });
    expect(await replace("user:carol", "new@mail.example")).toEqual({ status: "not-found" });
  });

  test("refuses addresses that domain roles or thread replies need", async () => {
    expect(await open("user:alice", "postmaster@mail.example")).toMatchObject({
      status: "invalid",
    });
    expect(await open("user:alice", "receipts+shop@mail.example")).toMatchObject({
      status: "invalid",
    });
    expect(await open("user:alice", "receipts")).toMatchObject({ status: "invalid" });
  });

  test("delivers a forwarded email to the owner of the address Resend received it at", async () => {
    await open("user:alice", "receipts@mail.example");

    await receive({
      emailId: "re_forwarded",
      envelopeTo: ["Receipts@mail.example"],
      headerTo: ["me@mail.example"],
    });

    expect(ctx.onEmailReceived).toHaveBeenCalledWith(
      expect.objectContaining({
        providerEmailId: "re_forwarded",
        recipientMailbox: { address: "receipts@mail.example", owner: "user:alice" },
      }),
    );

    const [{ emailMessageId }] = ctx.onEmailReceived.mock.calls[0]!;
    const read = (owner: string) =>
      ctx.fragment.callServices(() =>
        ctx.fragment.services.getMailboxEmail({ emailMessageId, owner }),
      );
    expect(await read("user:alice")).toMatchObject({
      to: ["me@mail.example"],
      text: "Total: 12 EUR",
      recipientMailbox: { address: "receipts@mail.example", owner: "user:alice" },
      authentication: { spf: "fail", dkim: "pass", dmarc: "pass" },
    });
    expect(await read("user:bob")).toBeNull();
  });

  test("delivers an email once to each owner whose address it reached", async () => {
    await open("user:alice", "receipts@mail.example");
    await open("user:bob", "bills@mail.example");
    await open("user:carol", "later@mail.example");
    const idempotencyKeys: string[] = [];
    const delivered = () => {
      const payloads = ctx.onEmailReceived.mock.calls.map(([payload]) => payload);
      ctx.onEmailReceived.mockClear();
      idempotencyKeys.push(...payloads.map(({ idempotencyKey }) => idempotencyKey));
      return payloads.map(({ recipientMailbox }) => recipientMailbox);
    };
    const alice = { address: "receipts@mail.example", owner: "user:alice" };
    const bob = { address: "bills@mail.example", owner: "user:bob" };
    const carol = { address: "later@mail.example", owner: "user:carol" };

    // Resend may report an email twice at once, or once per recipient; it reaches no one twice.
    const shared = {
      emailId: "re_shared",
      envelopeTo: ["receipts@mail.example", "Bills@mail.example", "nobody@mail.example"],
      headerTo: ["receipts@mail.example", "bills@mail.example"],
    };
    await Promise.all([receive(shared), receive(shared)]);
    expect(delivered()).toEqual([alice, bob]);
    await receive({
      emailId: "re_shared",
      envelopeTo: ["bills@mail.example", "receipts@mail.example"],
      headerTo: ["receipts@mail.example", "bills@mail.example"],
    });
    expect(delivered()).toEqual([]);
    await receive({
      emailId: "re_shared",
      envelopeTo: ["later@mail.example", "bills@mail.example"],
      headerTo: ["later@mail.example"],
    });
    expect(delivered()).toEqual([carol]);

    const stored = await ctx.getEmailByProviderId("re_shared");
    assert(stored);
    const read = (owner: string) =>
      ctx.fragment.callServices(() =>
        ctx.fragment.services.getMailboxEmail({ emailMessageId: stored.id.valueOf(), owner }),
      );
    expect(await read("user:alice")).toMatchObject({ recipientMailbox: alice });
    expect(await read("user:bob")).toMatchObject({ recipientMailbox: bob });
    expect(await read("user:carol")).toMatchObject({ recipientMailbox: carol });
    expect(await read("user:dave")).toBeNull();
    // Integrators deduplicate on the key, so each owner's delivery has its own.
    assert(new Set(idempotencyKeys).size === 3);
  });

  test("stores email at unregistered or paused addresses without an owner", async () => {
    await open("user:alice", "receipts@mail.example");
    await pause("user:alice");

    // A registered address named only in the message's headers does not route it.
    await open("user:bob", "other@mail.example");
    await receive({
      emailId: "re_released",
      envelopeTo: ["receipts@mail.example"],
      headerTo: ["other@mail.example"],
    });

    expect(await ctx.getEmailByProviderId("re_released")).toBeTruthy();
    expect(ctx.onEmailReceived).toHaveBeenCalledWith(
      expect.objectContaining({ providerEmailId: "re_released", recipientMailbox: null }),
    );
  });
});
