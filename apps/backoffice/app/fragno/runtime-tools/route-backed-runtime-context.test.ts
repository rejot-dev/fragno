import { describe, expect, test } from "vitest";

import { unrestrictedBackofficeAuthorityResolver } from "@/backoffice-runtime/authority-resolver";
import { createBackofficeSystemExecution } from "@/backoffice-runtime/context";
import {
  BackofficeKernel,
  BackofficeUnavailableError,
  noopBackofficeKernelObserver,
} from "@/backoffice-runtime/kernel";
import type { BackofficeObjectRegistry } from "@/backoffice-runtime/object-registry";
import type { BackofficeRuntimeServices } from "@/backoffice-runtime/runtime-services";

import type { PiRuntime } from "./families/pi-runtime";
import { createRouteBackedRuntimeContext } from "./route-backed-runtime-context";

const createRuntime = (): BackofficeRuntimeServices => {
  const automationsObject = { fetch: async () => new Response() };
  const objects = {
    automations: {
      singleton: () => automationsObject,
      forOrg: () => automationsObject,
    },
    cloudflare: {
      singleton: () => {
        throw new BackofficeUnavailableError("CLOUDFLARE is unavailable");
      },
    },
  } as unknown as BackofficeObjectRegistry;

  return {
    objects,
    authorityResolver: unrestrictedBackofficeAuthorityResolver,
    kernelObserver: noopBackofficeKernelObserver,
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
  test("preserves an injected Pi runtime in scoped child contexts", () => {
    const runtime = createRuntime();
    const piRuntime = {} as PiRuntime;
    const context = createRouteBackedRuntimeContext({
      runtime,
      kernel: new BackofficeKernel(runtime),
      execution: createBackofficeSystemExecution({ kind: "system" }),
      pi: { runtime: piRuntime },
    });

    const scoped = context.createBackofficeScopedContext({ kind: "system" });

    expect(scoped.pi?.runtime).toBe(piRuntime);
  });

  test("keeps the context available when the Cloudflare singleton cannot be resolved", () => {
    const runtime = createRuntime();
    const context = createRouteBackedRuntimeContext({
      runtime,
      kernel: new BackofficeKernel(runtime),
      execution: createBackofficeSystemExecution({ kind: "system" }),
    });

    expect(context.cloudflare).toBeNull();
    expect(context.event).not.toBeNull();
    expect(context.automations).not.toBeNull();
  });
});
