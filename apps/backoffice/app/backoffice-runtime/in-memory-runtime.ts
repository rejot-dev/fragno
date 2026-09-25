import type { BackofficeRuntimeEnv } from "./backoffice-runtime-env";
import { defaultInMemoryBackofficeRuntimeEnv } from "./in-memory-runtime-env";
import {
  createLocalBackofficeRuntime,
  type CreateLocalBackofficeRuntimeOptions,
  type LocalBackofficeRuntime,
} from "./node/local-runtime";

export type InMemoryBackofficeRuntime = LocalBackofficeRuntime;

export type CreateInMemoryBackofficeRuntimeOptions = Omit<
  CreateLocalBackofficeRuntimeOptions,
  "runtimeEnv"
> & {
  env?: Partial<BackofficeRuntimeEnv>;
};

/** Creates the test-only Backoffice runtime with node:vm dynamic workers and default test secrets. */
export async function createInMemoryBackofficeRuntime(
  options: CreateInMemoryBackofficeRuntimeOptions = {},
): Promise<InMemoryBackofficeRuntime> {
  const { env, ...runtimeOptions } = options;
  return await createLocalBackofficeRuntime({
    ...runtimeOptions,
    runtimeEnv: {
      ...defaultInMemoryBackofficeRuntimeEnv(),
      ...env,
    },
  });
}
