import type { RouterContextProvider } from "react-router";

import { getSandbox } from "@cloudflare/sandbox";

import {
  backofficeScopeSinglePathSegment,
  type BackofficeRoutableScope,
} from "@/backoffice-runtime/scope-codec";
import {
  createSandboxRuntime,
  type SandboxRuntime,
} from "@/fragno/runtime-tools/families/sandbox-runtime";
import { createCloudflareSandboxProvider } from "@/sandbox/cloudflare-sandbox-provider";

import { BackofficeWorkerContext } from "./router-context";

const sandboxIdScopeForBackofficeScope = (scope: BackofficeRoutableScope) =>
  scope.kind === "org" ? scope.orgId : backofficeScopeSinglePathSegment(scope);

/**
 * Creates the sandbox runtime for route loaders/actions.
 */
export function getScopedSandboxRuntime(
  context: Readonly<RouterContextProvider>,
  scope: BackofficeRoutableScope,
): SandboxRuntime {
  const { env, runtime } = context.get(BackofficeWorkerContext);
  const sandboxNamespace = (env as { SANDBOX?: CloudflareEnv["SANDBOX"] }).SANDBOX;

  if (!sandboxNamespace) {
    throw new Error("Sandbox runtime unavailable: Cloudflare SANDBOX binding is not configured.");
  }

  return createSandboxRuntime({
    lifecycle: runtime.objects.automations.for(scope),
    provider: createCloudflareSandboxProvider({
      sandboxNamespace,
      sdk: {
        getSandbox(namespace, id, options) {
          return getSandbox(namespace, id, options);
        },
      },
    }),
    sandboxIdScope: sandboxIdScopeForBackofficeScope(scope),
    ownerScope: scope,
  });
}
