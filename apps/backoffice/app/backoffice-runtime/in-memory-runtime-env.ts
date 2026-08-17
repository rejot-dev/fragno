import { AsyncLocalStorage } from "node:async_hooks";
import { runInNewContext } from "node:vm";

import type { WorkerCompiler } from "./dynamic-workers/compile-worker";
import { compileInMemoryWorker } from "./dynamic-workers/compile-worker.in-memory";

export type InMemoryBackofficeRuntimeEnv = {
  LOADER?: WorkerLoader;
  compileWorker?: WorkerCompiler;
  DOCS_PUBLIC_BASE_URL?: string;
  TURNSTILE_SITEKEY?: string;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  AUTH_ACCESS_TOKEN_SECRET?: string;
  AUTH_EMAIL_VERIFICATION_ENABLED?: string;
  GITHUB_APP_ID?: string;
  GITHUB_APP_SLUG?: string;
  GITHUB_APP_CLIENT_ID?: string;
  GITHUB_APP_CLIENT_SECRET?: string;
  GITHUB_APP_WEBHOOK_SECRET?: string;
  GITHUB_APP_PRIVATE_KEY?: string;
  CLOUDFLARE_WORKERS_ACCOUNT_ID?: string;
  CLOUDFLARE_WORKERS_API_TOKEN?: string;
  OPENAI_API_KEY?: string;
  ANTHROPIC_API_KEY?: string;
  GEMINI_API_KEY?: string;
};

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
        entrypoint = new Entrypoint();
        instances.set(name, entrypoint);
      }

      return {
        getEntrypoint: () => entrypoint,
      };
    },
  } as unknown as WorkerLoader;
};

export const defaultInMemoryBackofficeRuntimeEnv = (): InMemoryBackofficeRuntimeEnv => ({
  LOADER: createInMemoryWorkerLoader(),
  compileWorker: compileInMemoryWorker,
  DOCS_PUBLIC_BASE_URL: "https://example.com",
  TURNSTILE_SITEKEY: "0x4AAAAAACEAKTUMl498hZ6v",
  GITHUB_CLIENT_ID: "in-memory-github-client-id",
  GITHUB_CLIENT_SECRET: "in-memory-github-client-secret",
  AUTH_ACCESS_TOKEN_SECRET: "in-memory-auth-access-token-secret",
  AUTH_EMAIL_VERIFICATION_ENABLED: "false",
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
