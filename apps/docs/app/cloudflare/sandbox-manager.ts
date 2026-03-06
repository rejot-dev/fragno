import type { RouterContextProvider } from "react-router";
import { getSandbox } from "@cloudflare/sandbox";
import { CloudflareContext } from "./cloudflare-context";
import { getSandboxRegistryDurableObject } from "./cloudflare-utils";
import { createCloudflareSandboxManager } from "@/sandbox/cloudflare-sandbox-manager";
import type { SandboxManager } from "@/sandbox/contracts";

/**
 * Creates the Cloudflare sandbox manager for route loaders/actions.
 */
export function getSandboxManager(
  context: Readonly<RouterContextProvider>,
  organizationId: string,
): SandboxManager {
  const { env } = context.get(CloudflareContext);

  return createCloudflareSandboxManager({
    sandboxNamespace: env.SANDBOX,
    sandboxIdScope: organizationId,
    registry: getSandboxRegistryDurableObject(context, organizationId),
    sdk: {
      getSandbox(namespace, id, options) {
        return getSandbox(namespace, id, options);
      },
    },
  });
}
