import type { WorkerBundle } from "@fragno-dev/codemode/compiler/worker-bundle";

import { siteBuildDirectory } from "./site-path";

/**
 * The module a site's Worker is built from. It wraps the site's `worker.js`, or, for a site
 * without one, a Worker that serves its files, in an entrypoint whose `check` the build calls
 * before publishing: a `worker.js` that throws while loading, or exports no `fetch`, fails its
 * build instead of replacing a working one. It lives under `.build`, where no saved module can
 * take its path.
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

export default class Site extends WorkerEntrypoint {
  fetch(request) {
    return site.fetch(request, this.env, this.ctx);
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
