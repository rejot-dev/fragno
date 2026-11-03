import { AsyncLocalStorage } from "node:async_hooks";
import { runInNewContext } from "node:vm";

import { createCodemodeInProcessExecutor } from "@fragno-dev/codemode/remote/codemode-service-executor";

import type { BackofficeRuntimeEnv } from "./backoffice-runtime-env";
import { compileNodeWorker } from "./dynamic-workers/compile-node-worker";

// Mirrors Cloudflare's WorkerLoaderWorkerCode, whose callers give bindings only when they have some.
type InMemoryWorkerCode = {
  mainModule: string;
  modules: Record<string, string>;
  env?: Record<string, unknown>;
};

/** Like Cloudflare's, it keeps the context and bindings it is constructed with. */
class InMemoryWorkerEntrypoint {
  constructor(
    readonly ctx: { props: Record<string, never>; waitUntil(promise: Promise<unknown>): void },
    readonly env: Record<string, unknown>,
  ) {}
}
class InMemoryRpcTarget {}

type InMemoryWorkerEvaluationContext = {
  WorkerEntrypoint: typeof InMemoryWorkerEntrypoint;
  RpcTarget: typeof InMemoryRpcTarget;
  AsyncLocalStorage: typeof AsyncLocalStorage;
  Error: ErrorConstructor;
  setTimeout: typeof setTimeout;
  clearTimeout: typeof clearTimeout;
  atob: typeof atob;
  btoa: typeof btoa;
  TextEncoder: typeof TextEncoder;
  Request: typeof Request;
  Response: typeof Response;
  Headers: typeof Headers;
  URL: typeof URL;
  Entrypoint?: unknown;
};

/**
 * Evaluates a Worker's main module, a `WorkerEntrypoint` class, whose methods return values the way
 * Cloudflare RPC does.
 */
function evaluateInMemoryWorker(worker: InMemoryWorkerCode): object {
  const source = worker.modules[worker.mainModule];
  if (!source) {
    throw new Error(`In-memory WorkerLoader could not find ${worker.mainModule}.`);
  }

  const transformed = source
    .replace(
      /^\s*import\s+\{\s*(?:RpcTarget\s*,\s*)?WorkerEntrypoint\s*\}\s+from\s+["']cloudflare:workers["'];\s*$/gmu,
      "",
    )
    .replace(
      /^\s*import\s+\{\s*AsyncLocalStorage\s*\}\s+from\s+["']node:async_hooks["'];\s*$/gmu,
      "",
    )
    .replace(/export default class/u, "Entrypoint = class")
    // Bundled output declares its entrypoint and exports it at the end.
    .replace(/^export\s*\{\s*([\w$]+)\s+as\s+default\s*\};?\s*$/mu, "Entrypoint = $1;");
  const evaluationContext: InMemoryWorkerEvaluationContext = {
    WorkerEntrypoint: InMemoryWorkerEntrypoint,
    RpcTarget: InMemoryRpcTarget,
    AsyncLocalStorage,
    Error,
    setTimeout,
    clearTimeout,
    atob,
    btoa,
    // Guests count log bytes with it.
    TextEncoder,
    // Workers answer fetch with them.
    Request,
    Response,
    Headers,
    URL,
  };
  runInNewContext(transformed, evaluationContext);
  const Entrypoint = evaluationContext.Entrypoint;
  if (typeof Entrypoint !== "function") {
    throw new Error("In-memory WorkerLoader module did not export an entrypoint.");
  }
  const workerEntrypoint: unknown = new (Entrypoint as typeof InMemoryWorkerEntrypoint)(
    { props: {}, waitUntil: () => {} },
    worker.env ?? {},
  );
  if (
    workerEntrypoint === null ||
    (typeof workerEntrypoint !== "object" && typeof workerEntrypoint !== "function")
  ) {
    throw new Error("In-memory WorkerLoader entrypoint must be an object.");
  }
  // Cloudflare RPC detaches return values. Mirror that boundary so node:vm objects do not
  // leak foreign prototypes into persistence and JSON validation in the host process.
  return new Proxy(workerEntrypoint, {
    get(target, property) {
      const member = (target as Record<PropertyKey, unknown>)[property];
      if (typeof member !== "function") {
        return member;
      }
      const workerMethod = member.bind(target) as (...args: unknown[]) => unknown;
      // `fetch` answers with a Response, which crosses the boundary as a stream, not a clone.
      if (property === "fetch") {
        return workerMethod;
      }
      return async (...args: unknown[]) => structuredClone(await workerMethod(...args));
    },
  });
}

const createInMemoryWorkerLoader = (): WorkerLoader => {
  const workers = new Map<string, Promise<object>>();

  return {
    get(name: string, getCode: () => InMemoryWorkerCode | Promise<InMemoryWorkerCode>) {
      // Like Cloudflare, the code is requested once per name, when its entrypoint is first called.
      const worker = () => {
        let loaded = workers.get(name);
        if (!loaded) {
          loaded = Promise.resolve().then(getCode).then(evaluateInMemoryWorker);
          workers.set(name, loaded);
        }
        return loaded;
      };
      const entrypoint = new Proxy(
        {},
        {
          get(_target, property) {
            // A stub has no `then`, or awaiting it would call the Worker, and no disposer.
            if (typeof property !== "string" || property === "then") {
              return undefined;
            }
            return async (...args: unknown[]) => {
              const target = (await worker()) as Record<string, unknown>;
              const member = target[property];
              if (typeof member !== "function") {
                throw new TypeError(`In-memory Worker has no method '${property}'.`);
              }
              return await (member as (...args: unknown[]) => unknown).apply(target, args);
            };
          },
        },
      );

      return {
        getEntrypoint: () => entrypoint,
      };
    },
  } as unknown as WorkerLoader;
};

/** Creates the node:vm runtime environment used only by in-process tests. */
export const defaultInMemoryBackofficeRuntimeEnv = (): BackofficeRuntimeEnv => ({
  codemode: createCodemodeInProcessExecutor({
    loader: createInMemoryWorkerLoader(),
    compile: compileNodeWorker,
  }),
  workerLoader: createInMemoryWorkerLoader(),
  siteStorage: null,
  DOCS_PUBLIC_BASE_URL: "https://example.com",
  TURNSTILE_SITEKEY: "0x4AAAAAACEAKTUMl498hZ6v",
  GITHUB_CLIENT_ID: "in-memory-github-client-id",
  GITHUB_CLIENT_SECRET: "in-memory-github-client-secret",
  AUTH_ACCESS_TOKEN_SECRET: "in-memory-auth-access-token-secret",
  BACKOFFICE_INTERNAL_REQUEST_SECRET: "in-memory-backoffice-internal-request-secret",
  AUTH_ADMIN_GRANT_TOKEN: "in-memory-admin-grant-token",
  AUTH_EMAIL_VERIFICATION_ENABLED: "false",
  SIGN_UP_ACCESS_CODES_REQUIRED: "true",
  GITHUB_APP_ID: "1",
  GITHUB_APP_SLUG: "in-memory-github-app",
  GITHUB_APP_CLIENT_ID: "in-memory-github-app-client-id",
  GITHUB_APP_CLIENT_SECRET: "in-memory-github-app-client-secret",
  GITHUB_APP_WEBHOOK_SECRET: "in-memory-github-app-webhook-secret",
  GITHUB_APP_PRIVATE_KEY: "in-memory-github-app-private-key",
  CLOUDFLARE_WORKERS_ACCOUNT_ID: "in-memory-cloudflare-account-id",
  CLOUDFLARE_WORKERS_API_TOKEN: "in-memory-cloudflare-api-token",
  OPENAI_API_KEY: "in-memory-openai-api-key",
});
