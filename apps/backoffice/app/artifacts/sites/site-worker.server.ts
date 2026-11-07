import type { WorkerBundle } from "@fragno-dev/codemode/compiler/worker-bundle";

import { siteDataClientSource } from "./site-data-client";
import { siteBuildDirectory } from "./site-path";

/**
 * The module a site's Worker is built from. It wraps the site's `worker.js`, or, for a site
 * without one, a Worker that serves its files, in an entrypoint whose `check` the build calls
 * before publishing: a `worker.js` that throws while loading, or exports no `fetch`, fails its
 * build instead of replacing a working one. The site gets `env.DATA` as `sql`, which reads through
 * the binding the host gave it; a request that reads while the scope's data is still being copied
 * is answered 503. It lives under `.build`, where no saved module can take its path.
 */
export function siteWorkerEntry(
  sitePath: string,
  worker: "worker.js" | "files only",
): { path: string; source: string } {
  const site =
    worker === "worker.js"
      ? `import site from ${JSON.stringify(`${sitePath}/worker.js`)};`
      : "const site = { fetch: (request, env) => env.ASSETS.fetch(request) };";
  return {
    path: `${siteBuildDirectory(sitePath)}/entry.js`,
    source: `import { WorkerEntrypoint } from "cloudflare:workers";
${site}

const siteData = ${siteDataClientSource};

const UNAVAILABLE = "This site is unavailable while its data is copied. Try again in a moment.";

export default class Site extends WorkerEntrypoint {
  async fetch(request) {
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
  };
}

/** How every site Worker is loaded: without network, and with the bindings it is given. */
export function siteWorkerCode(
  bundle: WorkerBundle,
  env: Record<string, unknown>,
): WorkerLoaderWorkerCode {
  return {
    compatibilityDate: bundle.runtime.compatibilityDate,
    compatibilityFlags: [...bundle.runtime.compatibilityFlags],
    mainModule: bundle.mainModule,
    modules: { ...bundle.modules },
    env,
    // Sites reach no network until an egress policy says what they may call.
    globalOutbound: null,
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
