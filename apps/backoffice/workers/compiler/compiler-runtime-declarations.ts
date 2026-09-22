/** Compiler-owned declarations for runtime modules available to generated Workers. */
export const WORKER_COMPILER_RUNTIME_DECLARATIONS = `
declare module "cloudflare:workers" {
  export class WorkerEntrypoint<Env = unknown> {
    readonly env: Env;
  }
  export class RpcTarget {}
}
declare module "node:async_hooks" {
  export class AsyncLocalStorage<T = unknown> {
    getStore(): T | undefined;
    run<TResult>(store: T, callback: () => TResult): TResult;
  }
}
`;
