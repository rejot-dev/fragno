import { beforeEach, describe, expect, test, vi } from "vitest";

const {
  migrateMock,
  createPiRuntimeMock,
  createPiBashCommandContextMock,
  createPiRouteBashRuntimeMock,
  createRouteBackedAutomationsBashRuntimeMock,
  createOtpBashRuntimeMock,
  loadDurableHookQueueMock,
  isValidPiToolIdMock,
  resolvePiHarnessesMock,
  piHandlerMock,
  workflowsHandlerMock,
  dispatcherAlarmMock,
  liveStateClearMock,
} = vi.hoisted(() => ({
  migrateMock: vi.fn(async () => undefined),
  createPiRuntimeMock: vi.fn(),
  createPiBashCommandContextMock: vi.fn(),
  createPiRouteBashRuntimeMock: vi.fn((_input?: unknown) => ({})),
  createRouteBackedAutomationsBashRuntimeMock: vi.fn(),
  createOtpBashRuntimeMock: vi.fn(),
  loadDurableHookQueueMock: vi.fn(async () => ({
    configured: true,
    hooksEnabled: true,
    namespace: "pi",
    items: [],
    cursor: undefined,
    hasNextPage: false,
  })),
  isValidPiToolIdMock: vi.fn(() => true),
  resolvePiHarnessesMock: vi.fn((harnesses) => harnesses ?? []),
  piHandlerMock: vi.fn(async () => new Response("ok", { status: 200 })),
  workflowsHandlerMock: vi.fn(async () => new Response("ok", { status: 200 })),
  dispatcherAlarmMock: vi.fn(async () => undefined),
  liveStateClearMock: vi.fn(),
}));

vi.mock("cloudflare:workers", () => {
  class MockDurableObject {
    constructor(_state: unknown, _env: unknown) {}
  }

  return { DurableObject: MockDurableObject };
});

vi.mock("@fragno-dev/db", () => ({
  migrate: migrateMock,
}));

vi.mock("@fragno-dev/workflows", () => ({
  createWorkflowLiveStateStore: vi.fn(() => ({
    clear: liveStateClearMock,
  })),
}));

vi.mock("@/fragno/durable-hooks", () => ({
  loadDurableHookQueue: loadDurableHookQueueMock,
}));

vi.mock("@/fragno/pi", () => ({
  createPiBashCommandContext: createPiBashCommandContextMock,
  createPiRouteBashRuntime: createPiRouteBashRuntimeMock,
  createPiRuntime: createPiRuntimeMock,
  isValidPiToolId: isValidPiToolIdMock,
}));

vi.mock("@/fragno/pi-shared", () => ({
  resolvePiHarnesses: resolvePiHarnessesMock,
}));

vi.mock("@/fragno/automation/automations-bash-runtime", () => ({
  createRouteBackedAutomationsBashRuntime: createRouteBackedAutomationsBashRuntimeMock,
}));

vi.mock("@/fragno/automation/otp-bash-runtime", () => ({
  createOtpBashRuntime: createOtpBashRuntimeMock,
}));

import { Pi } from "./pi.do";

const CONFIG_KEY = "pi-config";

const VALID_CONFIG = {
  orgId: "acme",
  apiKeys: {
    openai: "sk-openai",
  },
  harnesses: [
    {
      id: "assistant",
      label: "Assistant",
      systemPrompt: "Help the user.",
      tools: [],
    },
  ],
};

const createState = (initialEntries?: Array<[string, unknown]>) => {
  const store = new Map<string, unknown>(initialEntries);
  const storage = {
    get: vi.fn(async (key: string) => store.get(key)),
    put: vi.fn(async (key: string, value: unknown) => {
      store.set(key, value);
    }),
  };

  const state = {
    storage,
    waitUntil: vi.fn(),
    blockConcurrencyWhile: vi.fn(async (callback: () => Promise<unknown>) => {
      await callback();
    }),
  } as unknown as DurableObjectState;

  return { state, store };
};

describe("Pi Durable Object", () => {
  beforeEach(() => {
    migrateMock.mockClear();
    createPiRuntimeMock.mockReset();
    createPiBashCommandContextMock.mockReset();
    createPiRouteBashRuntimeMock.mockClear();
    createRouteBackedAutomationsBashRuntimeMock.mockReset();
    createOtpBashRuntimeMock.mockReset();
    loadDurableHookQueueMock.mockClear();
    isValidPiToolIdMock.mockClear();
    resolvePiHarnessesMock.mockClear();
    piHandlerMock.mockReset();
    workflowsHandlerMock.mockReset();
    dispatcherAlarmMock.mockReset();
    liveStateClearMock.mockClear();

    piHandlerMock.mockImplementation(async () => new Response("ok", { status: 200 }));
    workflowsHandlerMock.mockImplementation(async () => new Response("ok", { status: 200 }));
    dispatcherAlarmMock.mockImplementation(async () => undefined);

    createPiRuntimeMock.mockImplementation(() => ({
      piFragment: {
        handler: piHandlerMock,
      },
      workflowsFragment: {
        handler: workflowsHandlerMock,
      },
      dispatcher: {
        alarm: dispatcherAlarmMock,
      },
    }));

    createRouteBackedAutomationsBashRuntimeMock.mockImplementation(({ env, orgId }) => ({
      lookupBinding: async (args: { source: string; key: string }) => {
        const query = new URLSearchParams(args);
        const automationsDo = env.AUTOMATIONS.get(env.AUTOMATIONS.idFromName(orgId));
        const response = await automationsDo.fetch(
          new Request(
            `https://automations.do/api/automations/bindings/identity-bindings/lookup?${query}&orgId=${encodeURIComponent(orgId)}`,
          ),
        );
        if (response.status === 404) {
          return null;
        }

        return await response.json();
      },
      bindActor: async (args: { source: string; key: string; value: string }) => {
        const automationsDo = env.AUTOMATIONS.get(env.AUTOMATIONS.idFromName(orgId));
        const response = await automationsDo.fetch(
          new Request(
            "https://automations.do/api/automations/bindings/identity-bindings/bind?orgId=" +
              encodeURIComponent(orgId),
            {
              method: "POST",
              headers: {
                "content-type": "application/json",
              },
              body: JSON.stringify(args),
            },
          ),
        );

        return await response.json();
      },
    }));

    createOtpBashRuntimeMock.mockImplementation(({ env, orgId }) => ({
      createClaim: async (args: {
        source: string;
        externalActorId: string;
        ttlMinutes?: number;
      }) => {
        const otpDo = env.OTP.get(env.OTP.idFromName(orgId));
        const issued = await otpDo.issueIdentityClaim({
          orgId,
          linkSource: args.source,
          externalActorId: args.externalActorId,
          expiresInMinutes: args.ttlMinutes,
          publicBaseUrl: env.DOCS_PUBLIC_BASE_URL,
        });

        return {
          url: issued.url,
          externalId: issued.externalId,
          code: issued.code,
          type: issued.type,
        };
      },
    }));

    createPiBashCommandContextMock.mockImplementation(({ env, orgId }) => ({
      pi: {
        runtime: createPiRouteBashRuntimeMock({ env, orgId }),
      },
      automations: {
        runtime: createRouteBackedAutomationsBashRuntimeMock({ env, orgId }),
      },
      otp: {
        runtime: createOtpBashRuntimeMock({ env, orgId }),
      },
    }));
  });

  test("stores orgId in config for later otp identity claims after cold start", async () => {
    const issueIdentityClaimMock = vi.fn(
      async ({ externalActorId }: { externalActorId: string }) => ({
        url: "https://docs.example.com/backoffice/claim",
        externalId: externalActorId,
        code: "123456",
        type: "otp",
      }),
    );
    const env = {
      DOCS_PUBLIC_BASE_URL: "https://docs.example.com",
      OTP: {
        idFromName: vi.fn((orgId: string) => `otp:${orgId}`),
        get: vi.fn(() => ({
          issueIdentityClaim: issueIdentityClaimMock,
        })),
      },
    } as unknown as CloudflareEnv;
    const initial = createState();
    const pi = new Pi(initial.state, env);

    await pi.setAdminConfig(VALID_CONFIG);

    expect(initial.store.get(CONFIG_KEY)).toMatchObject({
      orgId: "acme",
    });

    const rehydrated = createState(Array.from(initial.store.entries()));
    const coldStartPi = new Pi(rehydrated.state, env);

    await coldStartPi.alarm();

    const otpRuntime = createOtpBashRuntimeMock.mock.results.at(-1)?.value as {
      createClaim: (args: { source: string; externalActorId: string }) => Promise<unknown>;
    };

    await expect(
      otpRuntime.createClaim({ source: "telegram", externalActorId: "actor-1" }),
    ).resolves.toMatchObject({
      externalId: "actor-1",
      code: "123456",
    });

    expect(issueIdentityClaimMock).toHaveBeenCalledTimes(1);
    expect(issueIdentityClaimMock).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: "acme",
        linkSource: "telegram",
        externalActorId: "actor-1",
        publicBaseUrl: "https://docs.example.com",
      }),
    );
  });

  test("routes automations identity binding commands through the automations durable object", async () => {
    const automationsFetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            source: "telegram",
            key: "actor-1",
            value: "user-1",
            status: "linked",
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
    );
    const env = {
      AUTOMATIONS: {
        idFromName: vi.fn((orgId: string) => `automations:${orgId}`),
        get: vi.fn(() => ({
          fetch: automationsFetchMock,
        })),
      },
    } as unknown as CloudflareEnv;
    const { state } = createState();
    const pi = new Pi(state, env);

    await pi.setAdminConfig(VALID_CONFIG);

    const automationsRuntime = createRouteBackedAutomationsBashRuntimeMock.mock.results.at(-1)
      ?.value as {
      lookupBinding: (args: { source: string; key: string }) => Promise<unknown>;
    };

    await expect(
      automationsRuntime.lookupBinding({ source: "telegram", key: "actor-1" }),
    ).resolves.toMatchObject({
      value: "user-1",
      status: "linked",
    });

    const requestCall = automationsFetchMock.mock.calls.at(0);
    expect(requestCall).toBeDefined();
    const request = requestCall!.at(0) as unknown as Request;
    expect(request.url).toBe(
      "https://automations.do/api/automations/bindings/identity-bindings/lookup?source=telegram&key=actor-1&orgId=acme",
    );
  });

  test("returns a 409 response when the request orgId does not match the configured organisation", async () => {
    const env = {} as unknown as CloudflareEnv;
    const { state } = createState();
    const pi = new Pi(state, env);

    await pi.setAdminConfig(VALID_CONFIG);

    const response = await pi.fetch(
      new Request("https://docs.example.com/api/pi/sessions?orgId=other-org"),
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      message:
        'Pi Durable Object is bound to organisation "acme" and cannot serve requests for organisation "other-org".',
      code: "ORG_ID_MISMATCH",
      expectedOrgId: "acme",
      orgId: "other-org",
    });
  });

  test("includes both configured and supplied org ids when admin config tries to rebind", async () => {
    const env = {} as unknown as CloudflareEnv;
    const { state } = createState();
    const pi = new Pi(state, env);

    await pi.setAdminConfig(VALID_CONFIG);

    await expect(pi.setAdminConfig({ ...VALID_CONFIG, orgId: "other-org" })).rejects.toThrowError(
      'Pi Durable Object is bound to organisation "acme" and cannot serve requests for organisation "other-org".',
    );
  });

  test("treats stored config without an org id as not configured", async () => {
    const { state } = createState([
      [
        CONFIG_KEY,
        {
          apiKeys: VALID_CONFIG.apiKeys,
          harnesses: VALID_CONFIG.harnesses,
          createdAt: "2026-03-18T00:00:00.000Z",
          updatedAt: "2026-03-18T00:00:00.000Z",
        },
      ],
    ]);
    const pi = new Pi(state, {} as CloudflareEnv);

    await expect(pi.getAdminConfig()).resolves.toEqual({
      configured: false,
      config: {
        orgId: "",
        apiKeys: {
          openai: "sk-o…enai",
          anthropic: null,
          gemini: null,
        },
        harnesses: VALID_CONFIG.harnesses,
        createdAt: "2026-03-18T00:00:00.000Z",
        updatedAt: "2026-03-18T00:00:00.000Z",
      },
    });
    expect(createPiRuntimeMock).not.toHaveBeenCalled();
  });

  test("loads a stored org binding for background otp identity commands", async () => {
    const issueIdentityClaimMock = vi.fn(
      async ({ externalActorId }: { externalActorId: string }) => ({
        url: "https://docs.example.com/backoffice/claim",
        externalId: externalActorId,
        code: "123456",
        type: "otp",
      }),
    );
    const env = {
      DOCS_PUBLIC_BASE_URL: "https://docs.example.com",
      OTP: {
        idFromName: vi.fn((orgId: string) => `otp:${orgId}`),
        get: vi.fn(() => ({
          issueIdentityClaim: issueIdentityClaimMock,
        })),
      },
    } as unknown as CloudflareEnv;
    const { state } = createState([
      [
        CONFIG_KEY,
        {
          ...VALID_CONFIG,
          createdAt: "2026-03-18T00:00:00.000Z",
          updatedAt: "2026-03-18T00:00:00.000Z",
        },
      ],
    ]);
    const pi = new Pi(state, env);

    await pi.alarm();

    const otpRuntime = createOtpBashRuntimeMock.mock.results.at(-1)?.value as {
      createClaim: (args: { source: string; externalActorId: string }) => Promise<unknown>;
    };

    await otpRuntime.createClaim({ source: "telegram", externalActorId: "actor-1" });

    expect(issueIdentityClaimMock).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: "acme",
        linkSource: "telegram",
        externalActorId: "actor-1",
        publicBaseUrl: "https://docs.example.com",
      }),
    );
  });
});
