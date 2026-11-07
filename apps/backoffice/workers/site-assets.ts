import { WorkerEntrypoint } from "cloudflare:workers";

import type { SiteAssetsProps } from "../app/artifacts/sites/assets.server";

/**
 * A site Worker's `env.ASSETS`: serves the files of the build its props name, set by the host that
 * loaded the Worker, so a site reaches only its own build.
 */
export class SiteAssets extends WorkerEntrypoint<CloudflareEnv, SiteAssetsProps> {
  async fetch(request: Request): Promise<Response> {
    // Imported on first use, so a Worker serving no site does not compile it.
    const [
      { serveSiteAssets, siteFilesCacheFor, siteStoreForServing },
      { createCloudflareBackofficeRuntimeServices },
    ] = await Promise.all([
      import("../app/artifacts/sites/assets.server"),
      import("../app/backoffice-runtime/runtime-services"),
    ]);
    const runtime = createCloudflareBackofficeRuntimeServices(this.env);
    const props = this.ctx.props;
    const store = siteStoreForServing({
      runtime,
      scope: props.scope,
      sitePath: props.sitePath,
      cache: siteFilesCacheFor(runtime, request, (promise) => {
        this.ctx.waitUntil(promise);
      }),
    });
    return await serveSiteAssets({ request, store, props });
  }
}
