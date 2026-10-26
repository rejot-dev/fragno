import { afterEach, describe, expect, test, vi, assert } from "vitest";

const { DurableObject, RpcTarget } = vi.hoisted(() => {
  class MockDurableObject {
    constructor(_state: unknown, _env: unknown) {}
  }

  class MockRpcTarget {}

  return { DurableObject: MockDurableObject, RpcTarget: MockRpcTarget };
});

vi.mock("cloudflare:workers", () => ({ DurableObject, RpcTarget }));

import { createBackofficeSystemExecution } from "@/backoffice-runtime/context";
import { createInMemoryBackofficeRuntime } from "@/backoffice-runtime/in-memory-runtime";
import type { LocalBackofficeObjects } from "@/backoffice-runtime/local-object-factory";

import { ResendObject } from "./resend.do";

const localObjects = {
  RESEND: (input) => new ResendObject(input),
} satisfies LocalBackofficeObjects;

const runtimes: Array<Awaited<ReturnType<typeof createInMemoryBackofficeRuntime>>> = [];

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map(async (runtime) => await runtime.cleanup()));
});

describe("Resend Durable Object", () => {
  test("configures the singleton with system scope and idempotently queues email", async () => {
    const createWebhook = vi.fn(async () => ({
      data: { id: "webhook-1", signing_secret: "webhook-secret" },
      error: null,
    }));
    const runtime = await createInMemoryBackofficeRuntime({
      objects: {
        ...localObjects,
        RESEND: ({ state, env, runtime: runtimeServices, implementation, nowEpochMs }) =>
          new ResendObject({
            nowEpochMs,
            state,
            env,
            runtime: runtimeServices,
            implementation,
            createClient: () =>
              ({
                webhooks: { create: createWebhook },
              }) as never,
            runtimeMode: "development",
          }),
      },
    });
    runtimes.push(runtime);

    const resend = runtime.objects.resend.singleton();
    await resend.commands.setAdminConfig(
      {
        apiKey: "re_test",
        defaultFrom: "Fragno <hello@example.com>",
        webhookBaseUrl: "https://backoffice.example",
      },
      { kind: "system" },
      "https://backoffice.example",
    );

    expect(createWebhook).toHaveBeenCalledWith({
      endpoint: "https://backoffice.example/api/resend/system/webhook",
      events: expect.any(Array),
    });

    const email = {
      to: "user@example.com",
      subject: "Welcome",
      text: "Welcome",
    };
    const options = { idempotencyKey: "auth:user-created:user-1:tx-1", senderName: null };
    await resend.commands.queueEmail(email, options);
    await resend.commands.queueEmail(email, options);
    // A first-party app's email keeps the configured address under the app's name.
    await resend.commands.queueEmail(
      { ...email, subject: "Your code" },
      { idempotencyKey: "auth:app-sign-in-code:1", senderName: 'Book"keeping\r\n' },
    );

    const response = await resend.http.fetchAuthorized(
      new Request("https://resend.do/api/resend/emails"),
      { execution: createBackofficeSystemExecution({ kind: "system" }) },
    );
    assert(response.status === 200);
    const body = (await response.json()) as {
      emails: Array<{ subject: string | null; from: string | null }>;
    };
    expect(body.emails.map(({ subject, from }) => ({ subject, from }))).toEqual(
      expect.arrayContaining([
        { subject: "[DEVELOPMENT] Welcome", from: "Fragno <hello@example.com>" },
        { subject: "[DEVELOPMENT] Your code", from: '"Bookkeeping" <hello@example.com>' },
      ]),
    );
    expect(body.emails).toHaveLength(2);
  });
});
