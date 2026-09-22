import type { RouterContextProvider } from "react-router";

import type { BackofficeRoutableScope } from "@/backoffice-runtime/scope-codec";
import {
  createSandboxRuntime,
  type SandboxRuntime,
} from "@/fragno/runtime-tools/families/sandbox-runtime";

import { BackofficeWorkerContext } from "./router-context";

/**
 * Creates the sandbox runtime for route loaders/actions.
 */
export function getScopedSandboxRuntime(
  context: Readonly<RouterContextProvider>,
  scope: BackofficeRoutableScope,
): SandboxRuntime {
  const { runtime } = context.get(BackofficeWorkerContext);
  return createSandboxRuntime({
    lifecycle: runtime.objects.sandboxManager.for(scope).commands,
  });
}
