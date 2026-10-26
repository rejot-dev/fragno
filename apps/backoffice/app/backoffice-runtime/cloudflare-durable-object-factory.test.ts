import { assert, describe, expect, test, vi } from "vitest";

import { CloudflareDurableObjectFactory } from "./cloudflare-durable-object-factory";
import {
  BACKOFFICE_INTERNAL_CONTEXT_HEADER,
  verifyAuthorizedBackofficeObjectRequest,
} from "./internal-object-request";
import type { BackofficeObjectAddress } from "./object-registry";

const address = {
  binding: "AUTOMATIONS",
  scope: { kind: "org", orgId: "org-1", jurisdiction: null },
} as const satisfies BackofficeObjectAddress;

const execution = {
  kind: "deferred" as const,
  scopeRestriction: null,
  scope: { kind: "org", orgId: "org-1", jurisdiction: null } as const,
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

    await handle.http.fetchAuthorized(
      new Request("https://automations.test/api/automations/routes"),
      {
        execution,
        propagationContext: null,
      },
    );
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

  test("forwards response bodies unless the caller passes them through", async () => {
    const responses: Response[] = [];
    const stub = {
      fetch: vi.fn(async () => {
        const response = new Response(new ReadableStream());
        responses.push(response);
        return response;
      }),
    };
    const env = {
      AUTOMATIONS: {
        idFromName: () => ({ name: "v1:org:org-1" }) as DurableObjectId,
        get: () => stub,
      },
    } as unknown as CloudflareEnv;
    const { http } = new CloudflareDurableObjectFactory(env).get({ name: "AUTOMATIONS" }, address);
    const request = () => new Request("https://automations.test/api/automations/_internal/outbox");

    assert.notStrictEqual(await http.fetch(request()), responses[0]);
    assert.strictEqual(await http.fetch(request(), { passThrough: true }), responses[1]);
  });

  test("keeps a scope's objects in its root owner's jurisdiction", () => {
    const stub = {};
    const euNamespace = {
      idFromName: vi.fn((name: string) => ({ name, jurisdiction: "eu" }) as DurableObjectId),
      get: vi.fn(() => stub),
    };
    const namespace = {
      idFromName: vi.fn((name: string) => ({ name }) as DurableObjectId),
      jurisdiction: vi.fn(() => euNamespace),
      get: vi.fn(() => stub),
    };
    const factory = new CloudflareDurableObjectFactory({
      AUTOMATIONS: namespace,
      DURABLE_OBJECT_JURISDICTIONS: "enforced",
    } as unknown as CloudflareEnv);

    factory.get(
      { name: "AUTOMATIONS" },
      {
        binding: "AUTOMATIONS",
        scope: {
          kind: "project",
          owner: { kind: "org", orgId: "org-1", jurisdiction: "eu" },
          projectId: "project-1",
        },
      },
    );
    expect(namespace.jurisdiction).toHaveBeenCalledWith("eu");
    expect(euNamespace.idFromName).toHaveBeenCalledWith("v1:project:org:org-1@eu:project-1");

    // Objects made before jurisdictions keep their names in the unrestricted namespace.
    factory.get({ name: "AUTOMATIONS" }, address);
    expect(namespace.jurisdiction).toHaveBeenCalledOnce();
    expect(namespace.idFromName).toHaveBeenCalledWith("v1:org:org-1");

    // workerd implements no jurisdictions; the name alone keeps the scope's objects apart.
    new CloudflareDurableObjectFactory({
      AUTOMATIONS: namespace,
      DURABLE_OBJECT_JURISDICTIONS: "local",
    } as unknown as CloudflareEnv).get(
      { name: "AUTOMATIONS" },
      {
        binding: "AUTOMATIONS",
        scope: { kind: "org", orgId: "org-1", jurisdiction: "eu" },
      },
    );
    expect(namespace.jurisdiction).toHaveBeenCalledOnce();
    expect(namespace.idFromName).toHaveBeenCalledWith("v1:org:org-1@eu");
  });
});
