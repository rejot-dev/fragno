import { AsyncLocalStorage } from "node:async_hooks";
import { runInNewContext } from "node:vm";

import type { BackofficeRuntimeEnv } from "./backoffice-runtime-env";
import { compileNodeWorker } from "./dynamic-workers/compile-node-worker";

type WorkerLoaderFactory = () => {
  mainModule: string;
  modules: Record<string, string>;
};

class InMemoryWorkerEntrypoint {}
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
  Entrypoint?: new () => unknown;
};

const createInMemoryWorkerLoader = (): WorkerLoader => {
  const instances = new Map<string, unknown>();

  return {
    get(name: string, factory: WorkerLoaderFactory) {
      let entrypoint = instances.get(name);
      if (!entrypoint) {
        const worker = factory();
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
          .replace(/export default class/u, "Entrypoint = class");
        const evaluationContext: InMemoryWorkerEvaluationContext = {
          WorkerEntrypoint: InMemoryWorkerEntrypoint,
          RpcTarget: InMemoryRpcTarget,
          AsyncLocalStorage,
          Error,
          setTimeout,
          clearTimeout,
          atob,
          btoa,
        };
        runInNewContext(transformed, evaluationContext);
        const Entrypoint = evaluationContext.Entrypoint;
        if (!Entrypoint) {
          throw new Error("In-memory WorkerLoader module did not export an entrypoint.");
        }
        const workerEntrypoint = new Entrypoint();
        if (
          workerEntrypoint === null ||
          (typeof workerEntrypoint !== "object" && typeof workerEntrypoint !== "function")
        ) {
          throw new Error("In-memory WorkerLoader entrypoint must be an object.");
        }
        // Cloudflare RPC detaches return values. Mirror that boundary so node:vm objects do not
        // leak foreign prototypes into persistence and JSON validation in the host process.
        entrypoint = new Proxy(workerEntrypoint, {
          get(target, property) {
            const member = (target as Record<PropertyKey, unknown>)[property];
            if (typeof member !== "function") {
              return member;
            }
            const workerMethod = member.bind(target) as (...args: unknown[]) => unknown;
            return async (...args: unknown[]) => structuredClone(await workerMethod(...args));
          },
        });
        instances.set(name, entrypoint);
      }

      return {
        getEntrypoint: () => entrypoint,
      };
    },
  } as unknown as WorkerLoader;
};

/** Creates the node:vm runtime environment used only by in-process tests. */
export const defaultInMemoryBackofficeRuntimeEnv = (): BackofficeRuntimeEnv => ({
  LOADER: createInMemoryWorkerLoader(),
  compileWorker: compileNodeWorker,
  DOCS_PUBLIC_BASE_URL: "https://example.com",
  TURNSTILE_SITEKEY: "0x4AAAAAACEAKTUMl498hZ6v",
  GITHUB_CLIENT_ID: "in-memory-github-client-id",
  GITHUB_CLIENT_SECRET: "in-memory-github-client-secret",
  AUTH_ACCESS_TOKEN_SECRET: "in-memory-auth-access-token-secret",
  BACKOFFICE_INTERNAL_REQUEST_SECRET: "in-memory-backoffice-internal-request-secret",
  AUTH_ADMIN_GRANT_TOKEN: "in-memory-admin-grant-token",
  AUTH_EMAIL_VERIFICATION_ENABLED: "false",
  SIGN_UP_INVITATIONS_ENABLED: "true",
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
