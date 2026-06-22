import type { LofiRuntime } from "./runtime";

export type LofiRuntimeRegistry<TScope> = {
  get: (scope: TScope) => LofiRuntime;
  has: (scope: TScope) => boolean;
  delete: (scope: TScope) => boolean;
  clear: () => void;
  entries: () => Array<[string, LofiRuntime]>;
};

export type LofiRuntimeRegistryOptions<TScope> = {
  getKey: (scope: TScope) => string;
  createRuntime: (scope: TScope) => LofiRuntime;
};

export const createLofiRuntimeRegistry = <TScope>(
  options: LofiRuntimeRegistryOptions<TScope>,
): LofiRuntimeRegistry<TScope> => {
  const runtimes = new Map<string, LofiRuntime>();

  const get = (scope: TScope): LofiRuntime => {
    const key = options.getKey(scope);
    const existing = runtimes.get(key);
    if (existing) {
      return existing;
    }

    const runtime = options.createRuntime(scope);
    runtimes.set(key, runtime);
    return runtime;
  };

  const has = (scope: TScope): boolean => runtimes.has(options.getKey(scope));

  const deleteRuntime = (scope: TScope): boolean => {
    const key = options.getKey(scope);
    const runtime = runtimes.get(key);
    if (!runtime) {
      return false;
    }

    runtime.stop();
    return runtimes.delete(key);
  };

  const clear = (): void => {
    for (const runtime of runtimes.values()) {
      runtime.stop();
    }
    runtimes.clear();
  };

  return {
    get,
    has,
    delete: deleteRuntime,
    clear,
    entries: () => [...runtimes.entries()],
  };
};
