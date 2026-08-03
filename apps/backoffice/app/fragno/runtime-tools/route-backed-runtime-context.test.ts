import { describe, expect, test } from "vitest";

import { BackofficeKernel, BackofficeUnavailableError } from "@/backoffice-runtime/kernel";
import type { BackofficeObjectRegistry } from "@/backoffice-runtime/object-registry";
import type { BackofficeRuntimeServices } from "@/backoffice-runtime/runtime-services";

import { createRouteBackedRuntimeContext } from "./route-backed-runtime-context";

const createRuntime = (): BackofficeRuntimeServices => {
  const automationsObject = { fetch: async () => new Response() };
  const objects = {
    automations: {
      singleton: () => automationsObject,
    },
    cloudflare: {
      singleton: () => {
        throw new BackofficeUnavailableError("CLOUDFLARE is unavailable");
      },
    },
  } as unknown as BackofficeObjectRegistry;

  return {
    objects,
    adapters: {} as BackofficeRuntimeServices["adapters"],
    config: {
      authEmailVerification: { enabled: false },
      bindings: {
        api: false,
        auth: false,
        automations: true,
        billing: false,
        marketplace: false,
        telegram: false,
        otp: false,
        pi: false,
        resend: false,
        reson8: false,
        mcp: false,
        upload: false,
        github: false,
        githubWebhookRouter: false,
        cloudflare: true,
        sandbox: false,
      },
    },
  };
};

describe("createRouteBackedRuntimeContext", () => {
  test("keeps the context available when the Cloudflare singleton cannot be resolved", () => {
    const context = createRouteBackedRuntimeContext({
      runtime: createRuntime(),
      kernel: new BackofficeKernel({}),
      execution: {
        actor: { type: "system", id: "system" },
        scope: { kind: "system" },
      },
    });

    expect(context.cloudflare).toBeNull();
    expect(context.event).not.toBeNull();
    expect(context.automations).not.toBeNull();
  });
});
