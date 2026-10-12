import type { WorkerBundle } from "../compiler/worker-bundle";
import type { DynamicWorkerExecutorOptions } from "../runtime-api";

/** RPC capabilities passed to a single loaded guest entrypoint. */
export type DynamicWorkerRpcTargetMap = Record<string, unknown>;

/** Preserves the disposable custom promise returned directly by a Cloudflare RPC call. */
export type DynamicWorkerRpcCall<TResult extends object> = Promise<TResult> & {
  [Symbol.dispose](): void;
};

/** Runs a compiled bundle; the caller owns guest source generation and compilation. */
export type DynamicWorkerEntrypointRunOptions<TEntrypoint, TResult extends object> = {
  bundle: WorkerBundle;
  rpcTargets?: DynamicWorkerRpcTargetMap;
  run: (
    entrypoint: TEntrypoint,
    rpcTargets: DynamicWorkerRpcTargetMap,
  ) => DynamicWorkerRpcCall<TResult>;
};

/** Owns dynamic Worker loading and disposal, not guest source generation or compilation. */
export class DynamicWorkerExecutor {
  readonly #loader: WorkerLoader;

  constructor(options: DynamicWorkerExecutorOptions) {
    this.#loader = options.loader;
  }

  async runEntrypoint<TEntrypoint, TResult extends object>(
    { bundle, rpcTargets = {}, run }: DynamicWorkerEntrypointRunOptions<TEntrypoint, TResult>,
    execution: {
      signal: AbortSignal | null;
      limits: { cpuMs: number; subRequests: number } | null;
    } = { signal: null, limits: null },
  ): Promise<TResult> {
    const { signal, limits } = execution;
    signal?.throwIfAborted();
    const worker = this.#loader.get(`codemode-${crypto.randomUUID()}`, () => ({
      mainModule: bundle.mainModule,
      modules: { ...bundle.modules },
      compatibilityDate: bundle.runtime.compatibilityDate,
      compatibilityFlags:
        bundle.runtime.compatibilityFlags.length > 0
          ? [...bundle.runtime.compatibilityFlags]
          : undefined,
      // Guests have no network egress; internet access goes through host-authorized tools.
      globalOutbound: null,
      limits: limits ?? undefined,
    }));

    const entrypoint = worker.getEntrypoint();
    try {
      const rpcResult = run(entrypoint as unknown as TEntrypoint, rpcTargets);
      const abort = () => (rpcResult as unknown as Partial<Disposable>)[Symbol.dispose]?.();
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) {
        abort();
      }
      try {
        return await rpcResult;
      } finally {
        signal?.removeEventListener("abort", abort);
        // The in-memory WorkerLoader returns native promises; production RPC calls are disposable.
        (rpcResult as unknown as Partial<Disposable>)[Symbol.dispose]?.();
      }
    } finally {
      (entrypoint as unknown as Partial<Disposable>)[Symbol.dispose]?.();
    }
  }
}
