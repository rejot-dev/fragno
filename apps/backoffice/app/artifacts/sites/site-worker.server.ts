import type { WorkerBundle } from "@fragno-dev/codemode/compiler/worker-bundle";
import {
  CODEMODE_GUEST_API_SOURCE,
  createCodemodeProviderGlobalsSource,
  createCodemodeProviderProxySource,
} from "@fragno-dev/codemode/guest/codemode-guest-api-source";

import { siteDataClientSource } from "./site-data-client";
import { siteBuildDirectory } from "./site-path";
import { SITE_TOOL_NAMESPACES } from "./site-tools.server";

/**
 * The module a site's Worker is built from. It wraps the site's `worker.js`, or, for a site
 * without one, a Worker that serves its files, in an entrypoint whose `check` the build calls
 * before publishing: a `worker.js` that throws while loading, or exports no `fetch`, fails its
 * build instead of replacing a working one. The site gets `env.DATA` as `sql` and `fire`, which
 * read and fire through the binding the host gave it; a request that reads while the scope's data
 * is still being copied is answered 503. Each namespace of the tools sites call, such as `state`,
 * is a global as in programs, so saved modules a site imports call tools as they do there. The
 * entry and the module that sets those globals live under `.build`, where no saved module can take
 * their paths.
 */
export function siteWorkerEntry(
  sitePath: string,
  worker: "worker.js" | "files only",
): { path: string; modules: Record<string, string> } {
  const directory = siteBuildDirectory(sitePath);
  const tools = `${directory}/tools.js`;
  const path = `${directory}/entry.js`;
  const site =
    worker === "worker.js"
      ? `import site from ${JSON.stringify(`${sitePath}/worker.js`)};`
      : "const site = { fetch: (request, env) => env.ASSETS.fetch(request) };";
  return {
    path,
    modules: {
      [tools]: siteToolsSource(),
      // Imports run in order: the globals are set before worker.js and the modules it imports load.
      [path]: `import { WorkerEntrypoint } from "cloudflare:workers";
import { useSiteTools } from ${JSON.stringify(tools)};
${site}

const siteData = ${siteDataClientSource};

const UNAVAILABLE = "This site is unavailable while its data is copied. Try again in a moment.";

export default class Site extends WorkerEntrypoint {
  async fetch(request) {
    // Every request of this Worker calls tools as the one builder, so they share the globals.
    if (this.env.DATA) useSiteTools(this.env.DATA);
    const data = this.env.DATA ? siteData(this.env.DATA) : null;
    const env = data ? { ...this.env, DATA: data.data } : this.env;
    let response;
    try {
      response = await site.fetch(request, env, this.ctx);
    } catch (error) {
      if (!data?.catchingUp()) {
        throw error;
      }
    }
    // A Worker may catch the read's error and answer on; the site is unavailable all the same.
    if (data?.catchingUp()) {
      return new Response(UNAVAILABLE, {
        status: 503,
        headers: { "content-type": "text/plain; charset=utf-8", "retry-after": "5" },
      });
    }
    return response;
  }

  check() {
    if (typeof site?.fetch !== "function") {
      throw new Error("worker.js must default-export an object with a fetch(request) method.");
    }
  }
}
`,
    },
  };
}

/**
 * Codemode's guest API, whose dispatchers call each namespace's tools through the binding of the
 * Worker's requests. Modules take tool functions while they load, as in programs, but call them
 * only once a request has given the binding.
 */
function siteToolsSource(): string {
  // Only the names reach the guest; the tools stay with the host, which `env.DATA` calls.
  const providers = SITE_TOOL_NAMESPACES.map((name) => ({ name, fns: {} }));
  return `let binding = null;

export function useSiteTools(next) {
  binding = next;
}

const __dispatchers = Object.fromEntries(
  ${JSON.stringify(SITE_TOOL_NAMESPACES)}.map((namespace) => [
    namespace,
    {
      call: async (tool, args) => {
        if (binding === null) {
          throw new Error(\`\${namespace}.\${tool} can only be called while the site answers a request.\`);
        }
        return await binding.call(namespace, tool, args);
      },
    },
  ]),
);
${CODEMODE_GUEST_API_SOURCE}
${createCodemodeProviderProxySource(providers)}
${createCodemodeProviderGlobalsSource(providers)}
`;
}

/**
 * How every site Worker is loaded: without network, with the bindings it is given, and with the
 * tails that receive what each of its requests logged and threw.
 */
export function siteWorkerCode(
  bundle: WorkerBundle,
  env: Record<string, unknown>,
  tails: Fetcher[] = [],
): WorkerLoaderWorkerCode {
  return {
    compatibilityDate: bundle.runtime.compatibilityDate,
    compatibilityFlags: [...bundle.runtime.compatibilityFlags],
    mainModule: bundle.mainModule,
    modules: { ...bundle.modules },
    env,
    // Sites reach no network until an egress policy says what they may call.
    globalOutbound: null,
    tails,
  };
}

/** Loads a built site Worker once, without bindings, or says why it cannot serve. */
export async function checkSiteWorker(
  workerLoader: WorkerLoader,
  bundle: WorkerBundle,
): Promise<string | null> {
  const worker = workerLoader.get(`site-check:${crypto.randomUUID()}`, () =>
    siteWorkerCode(bundle, {}),
  );
  try {
    await (worker.getEntrypoint() as unknown as { check(): Promise<void> }).check();
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}
