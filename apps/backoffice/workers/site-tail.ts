import { WorkerEntrypoint } from "cloudflare:workers";

import type { SiteTailProps } from "../app/artifacts/sites/site-logs";

/**
 * The tail of a site's Worker: after each request the Worker handled, the runtime hands it what
 * the request logged and threw, and it keeps that in the scope's site logs. The host sets its
 * props when it loads the Worker, so a site cannot write another's logs.
 */
export class SiteTail extends WorkerEntrypoint<CloudflareEnv, SiteTailProps> {
  override async tail(events: TraceItem[]): Promise<void> {
    const { scope } = this.ctx.props;
    // Imported on first use, so a Worker serving no site does not compile it.
    const [{ recordSiteTraces }, { createCloudflareBackofficeObjectRegistry }] = await Promise.all([
      import("../app/artifacts/sites/site-logs"),
      import("../app/backoffice-runtime/cloudflare-durable-object-factory"),
    ]);
    const logs = createCloudflareBackofficeObjectRegistry(this.env).siteRequests.for(
      scope,
    ).commands;
    await recordSiteTraces(events, this.ctx.props, logs);
  }
}
