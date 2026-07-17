import { afterEach, describe, expect, test, vi, assert } from "vitest";

const { DurableObject, RpcTarget } = vi.hoisted(() => {
  class MockDurableObject {
    constructor(_state: unknown, _env: unknown) {}
  }

  class MockRpcTarget {}

  return { DurableObject: MockDurableObject, RpcTarget: MockRpcTarget };
});

vi.mock("cloudflare:workers", () => ({ DurableObject, RpcTarget }));

import { createInMemoryBackofficeRuntime } from "@/backoffice-runtime/in-memory-runtime";

import { InMemoryResendObject } from "./resend.do";

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
      objectFactories: {
        RESEND: ({ state, env, runtime: runtimeServices }) =>
          new InMemoryResendObject({
            state,
            env,
            runtime: runtimeServices,
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
    await resend.setAdminConfig(
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
    await resend.queueEmail(email, { idempotencyKey: "auth:user-created:user-1:tx-1" });
    await resend.queueEmail(email, { idempotencyKey: "auth:user-created:user-1:tx-1" });

    const response = await resend.fetch(new Request("https://resend.do/api/resend/emails"));
    assert(response.status === 200);
    const body = (await response.json()) as {
      emails: Array<{ subject: string | null }>;
    };
    expect(body.emails).toHaveLength(1);
    assert(body.emails[0]?.subject === "[DEVELOPMENT] Welcome");
  });
});
