import type { RouterContextProvider } from "react-router";

import { getSandbox } from "@cloudflare/sandbox";

import {
  createSandboxRuntime,
  type SandboxRuntime,
} from "@/fragno/runtime-tools/families/sandbox-runtime";
import { createCloudflareSandboxProvider } from "@/sandbox/cloudflare-sandbox-provider";

import { getAutomationsDurableObject } from "./durable-objects";
import { BackofficeWorkerContext } from "./router-context";

/**
 * Creates the sandbox runtime for route loaders/actions.
 */
export function getSandboxRuntime(
  context: Readonly<RouterContextProvider>,
  organizationId: string,
): SandboxRuntime {
  const { env } = context.get(BackofficeWorkerContext);

  return createSandboxRuntime({
    lifecycle: getAutomationsDurableObject(context, organizationId),
    provider: createCloudflareSandboxProvider({
      sandboxNamespace: env.SANDBOX,
      sdk: {
        getSandbox(namespace, id, options) {
          return getSandbox(namespace, id, options) as never;
        },
      },
    }),
    sandboxIdScope: organizationId,
    ownerScope: { kind: "org", orgId: organizationId },
  });
}
