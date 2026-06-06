import {
  createCloudflareSandboxManager,
  type CloudflareSandboxManagerOptions,
} from "@/sandbox/cloudflare-sandbox-manager";

import { createSandboxRuntime, type SandboxRuntime } from "./sandbox-runtime";

const SANDBOX_REGISTRY_ORG_KEY_PREFIX = "SANDBOX_REGISTRY_ORG:";

type SandboxRouteOptions = {
  keepAlive?: boolean;
  sleepAfter?: string | number;
};

type SandboxRouteConfiguration = SandboxRouteOptions & {
  sandboxName: { name: string };
};

type SandboxRouteHandle = Awaited<ReturnType<CloudflareSandboxManagerOptions["sdk"]["getSandbox"]>>;

type ConfigurableSandboxRouteStub = SandboxRouteHandle & {
  configure?(configuration: SandboxRouteConfiguration): Promise<void>;
  setSandboxName?(name: string): Promise<void>;
  setKeepAlive?(keepAlive: boolean): Promise<void>;
  setSleepAfter?(sleepAfter: string | number): Promise<void>;
};

const applySandboxRouteConfiguration = async (
  stub: ConfigurableSandboxRouteStub,
  id: string,
  options: SandboxRouteOptions | undefined,
) => {
  const configuration: SandboxRouteConfiguration = {
    sandboxName: { name: id },
    ...(typeof options?.keepAlive === "undefined" ? {} : { keepAlive: options.keepAlive }),
    ...(typeof options?.sleepAfter === "undefined" ? {} : { sleepAfter: options.sleepAfter }),
  };

  if (stub.configure) {
    await stub.configure(configuration);
    return;
  }

  await Promise.all([
    stub.setSandboxName?.(id) ?? Promise.resolve(),
    typeof options?.keepAlive === "undefined"
      ? Promise.resolve()
      : (stub.setKeepAlive?.(options.keepAlive) ?? Promise.resolve()),
    typeof options?.sleepAfter === "undefined"
      ? Promise.resolve()
      : (stub.setSleepAfter?.(options.sleepAfter) ?? Promise.resolve()),
  ]);
};

export const createSandboxRouteRuntime = ({
  env,
  orgId,
}: {
  env: CloudflareEnv;
  orgId: string;
}): SandboxRuntime => {
  const normalizedOrgId = orgId.trim();
  if (!normalizedOrgId) {
    throw new Error("Sandbox runtime requires an organisation id");
  }

  const registryKey = `${SANDBOX_REGISTRY_ORG_KEY_PREFIX}${normalizedOrgId}`;
  const manager = createCloudflareSandboxManager({
    sandboxNamespace: env.SANDBOX,
    sandboxIdScope: normalizedOrgId,
    registry: env.SANDBOX_REGISTRY.get(env.SANDBOX_REGISTRY.idFromName(registryKey)),
    sdk: {
      async getSandbox(namespace, id, options) {
        const stub = namespace.get(
          namespace.idFromName(id),
        ) as unknown as ConfigurableSandboxRouteStub;
        await applySandboxRouteConfiguration(stub, id, options);
        return stub;
      },
    },
  });

  return createSandboxRuntime(manager);
};
