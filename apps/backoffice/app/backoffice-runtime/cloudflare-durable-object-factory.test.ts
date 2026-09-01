import { assert, describe, expect, test, vi } from "vitest";

import { CloudflareDurableObjectFactory } from "./cloudflare-durable-object-factory";
import {
  BACKOFFICE_INTERNAL_CONTEXT_HEADER,
  verifyAuthorizedBackofficeObjectRequest,
} from "./internal-object-request";
import type { BackofficeObjectAddress } from "./object-registry";

const address = {
  binding: "AUTOMATIONS",
  scope: { kind: "org", orgId: "org-1" },
} as const satisfies BackofficeObjectAddress;

const execution = {
  scope: { kind: "org", orgId: "org-1" } as const,
  actors: {
    initiator: {
      scope: "internal" as const,
      type: "backoffice",
      id: "interactive",
      role: "initiator" as const,
    },
    principal: null,
    delegation: [],
  },
};

describe("Cloudflare Durable Object factory", () => {
  test("separates commands from HTTP and controls the internal context header", async () => {
    const requests: Request[] = [];
    const stub = {
      ping: vi.fn(async () => "pong"),
      fetch: vi.fn(async (request: Request) => {
        requests.push(request);
        return new Response("ok");
      }),
    };
    const namespace = {
      idFromName: vi.fn(() => ({ name: "v1:org:org-1" }) as DurableObjectId),
      get: vi.fn(() => stub),
    };
    const env = {
      AUTOMATIONS: namespace,
      BACKOFFICE_INTERNAL_REQUEST_SECRET: "cloudflare-object-factory-test-secret-1234567890",
    } as unknown as CloudflareEnv;
    const handle = new CloudflareDurableObjectFactory(env).get<{
      ping(): Promise<string>;
    }>({ name: "AUTOMATIONS" }, address);

    await expect(handle.commands.ping()).resolves.toBe("pong");
    await handle.http.fetch(
      new Request("https://automations.test/api/automations/_internal/outbox", {
        headers: { [BACKOFFICE_INTERNAL_CONTEXT_HEADER]: "caller-controlled" },
      }),
    );
    assert(!requests[0]?.headers.has(BACKOFFICE_INTERNAL_CONTEXT_HEADER));

    await handle.http.fetchAuthorized(new Request("https://automations.test/api/pi/sessions"), {
      execution,
      propagationContext: null,
    });
    const authorizedRequest = requests[1]!;
    assert(authorizedRequest.headers.has(BACKOFFICE_INTERNAL_CONTEXT_HEADER));
    await expect(
      verifyAuthorizedBackofficeObjectRequest({
        request: authorizedRequest,
        address,
        env,
      }),
    ).resolves.toMatchObject({ context: { execution, propagationContext: null } });
  });
});
