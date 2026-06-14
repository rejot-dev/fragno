import { AsyncLocalStorage } from "node:async_hooks";

export type InMemoryBackofficeRuntimeEnv = {
  LOADER?: WorkerLoader;
  DOCS_PUBLIC_BASE_URL?: string;
  TURNSTILE_SITEKEY?: string;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  AUTH_ACCESS_TOKEN_SECRET?: string;
  CLOUDFLARE_WORKERS_ACCOUNT_ID?: string;
  CLOUDFLARE_WORKERS_API_TOKEN?: string;
  GITHUB_APP_ID?: string;
  GITHUB_APP_SLUG?: string;
  GITHUB_APP_CLIENT_ID?: string;
  GITHUB_APP_CLIENT_SECRET?: string;
  GITHUB_APP_WEBHOOK_SECRET?: string;
  GITHUB_APP_PRIVATE_KEY?: string;
};

type WorkerLoaderFactory = () => {
  mainModule: string;
  modules: Record<string, string>;
};

class InMemoryWorkerEntrypoint {}

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
            /^\s*import\s+\{\s*WorkerEntrypoint\s*\}\s+from\s+["']cloudflare:workers["'];\s*$/gmu,
            "",
          )
          .replace(
            /^\s*import\s+\{\s*AsyncLocalStorage\s*\}\s+from\s+["']node:async_hooks["'];\s*$/gmu,
            "",
          )
          .replace(/export default class/u, "return class");
        const createEntrypoint = new Function(
          "WorkerEntrypoint",
          "AsyncLocalStorage",
          transformed,
        ) as (
          WorkerEntrypoint: typeof InMemoryWorkerEntrypoint,
          als: typeof AsyncLocalStorage,
        ) => new () => unknown;
        const Entrypoint = createEntrypoint(InMemoryWorkerEntrypoint, AsyncLocalStorage);
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
  DOCS_PUBLIC_BASE_URL: "https://example.com",
  TURNSTILE_SITEKEY: "0x4AAAAAACEAKTUMl498hZ6v",
  GITHUB_CLIENT_ID: "in-memory-github-client-id",
  GITHUB_CLIENT_SECRET: "in-memory-github-client-secret",
  AUTH_ACCESS_TOKEN_SECRET: "in-memory-auth-access-token-secret",
  CLOUDFLARE_WORKERS_ACCOUNT_ID: "in-memory-cloudflare-account-id",
  CLOUDFLARE_WORKERS_API_TOKEN: "in-memory-cloudflare-api-token",
  GITHUB_APP_ID: "1",
  GITHUB_APP_SLUG: "in-memory-github-app",
  GITHUB_APP_CLIENT_ID: "in-memory-github-app-client-id",
  GITHUB_APP_CLIENT_SECRET: "in-memory-github-app-client-secret",
  GITHUB_APP_WEBHOOK_SECRET: "in-memory-github-app-webhook-secret",
  GITHUB_APP_PRIVATE_KEY: "in-memory-github-app-private-key",
});
