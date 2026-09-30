import type {
  MountBucketOptions as CloudflareSdkMountBucketOptions,
  SandboxOptions as CloudflareSdkSandboxOptions,
} from "@cloudflare/sandbox";

import type { Sandbox as BackofficeSandbox } from "../../workers/sandbox.do";
import type {
  MountBucketOptions,
  SandboxRuntimeHandle,
  SandboxRuntimeHandleOptions,
  SandboxRuntimeProvider,
} from "./contracts";
import { CLOUDFLARE_SANDBOX_PROVIDER } from "./contracts";
import { executeSandboxRuntimeCommand } from "./sandbox-command-result";

type CloudflareSandboxNamespace = CloudflareEnv["SANDBOX"];
type CloudflareSandboxOptions = Pick<CloudflareSdkSandboxOptions, "keepAlive" | "sleepAfter">;

export type CloudflareSandboxHandle = BackofficeSandbox;

type CloudflareSandboxSdkClient = {
  getSandbox(
    namespace: CloudflareSandboxNamespace,
    id: string,
    options?: CloudflareSandboxOptions,
  ): CloudflareSandboxHandle | Promise<CloudflareSandboxHandle>;
};

export type CloudflareSandboxProviderOptions = {
  sandboxNamespace: CloudflareSandboxNamespace;
  sdk: CloudflareSandboxSdkClient;
};

/** Adapts the Cloudflare Worker Sandbox SDK to the Backoffice sandbox runtime provider. */
export function createCloudflareSandboxProvider({
  sandboxNamespace,
  sdk,
}: CloudflareSandboxProviderOptions): SandboxRuntimeProvider {
  return {
    provider: CLOUDFLARE_SANDBOX_PROVIDER,
    async getHandle(id: string, options: SandboxRuntimeHandleOptions = {}) {
      const rawHandle = await sdk.getSandbox(sandboxNamespace, id, stripUndefined(options));
      return adaptCloudflareSandboxHandle(id, rawHandle);
    },
  };
}

function adaptCloudflareSandboxHandle(
  id: string,
  rawHandle: CloudflareSandboxHandle,
): SandboxRuntimeHandle {
  return {
    id,
    exec: async (command, options) => await rawHandle.exec(command, options),
    destroy: async () => {
      await rawHandle.destroy();
    },
    mountBucket: async (bucket, mountPoint, options) => {
      await rawHandle.mountBucket(bucket, mountPoint, toCloudflareMountBucketOptions(options));
    },
    mkdir: async (path, options) => {
      await rawHandle.mkdir(path, options);
    },
    writeFile: async (path, content, options) => {
      await rawHandle.writeFile(path, content, options);
    },
    exists: async (path) => await rawHandle.exists(path),
    executeCommand: async (command, options) =>
      await executeSandboxRuntimeCommand(
        async (runtimeCommand, runtimeOptions) =>
          await rawHandle.exec(runtimeCommand, runtimeOptions),
        command,
        options,
      ),
  };
}

function toCloudflareMountBucketOptions(
  options: MountBucketOptions,
): CloudflareSdkMountBucketOptions {
  const unsupportedOptions = [
    ...(options.region !== undefined ? ["region"] : []),
    ...(options.credentials?.sessionToken !== undefined ? ["credentials.sessionToken"] : []),
  ];

  if (unsupportedOptions.length > 0) {
    throw new Error(
      `Cloudflare sandbox bucket mounts do not support ${unsupportedOptions.join(
        ", ",
      )}; these options would be ignored by the Cloudflare SDK.`,
    );
  }

  return {
    endpoint: options.endpoint,
    ...(options.provider ? { provider: options.provider } : {}),
    ...(options.credentials
      ? {
          credentials: {
            accessKeyId: options.credentials.accessKeyId,
            secretAccessKey: options.credentials.secretAccessKey,
          },
        }
      : {}),
    ...(options.prefix ? { prefix: options.prefix } : {}),
    ...(options.pathStyle ? { s3fsOptions: ["use_path_request_style"] } : {}),
  };
}

function stripUndefined<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, propertyValue]) => propertyValue !== undefined),
  ) as Partial<T>;
}
