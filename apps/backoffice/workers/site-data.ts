import { WorkerEntrypoint } from "cloudflare:workers";

import type {
  SiteDataBinding,
  SiteDataProps,
  SiteDataQuery,
  SiteDataResult,
} from "../app/artifacts/sites/site-data";
import type { SiteEvent, SiteFireResult } from "../app/artifacts/sites/site-events";

/**
 * The binding a site Worker's `env.DATA` goes through: it reads the automation data of the scope
 * its props name, with the SQL pages read it with, and fires events into that scope's automations
 * as the site. The host that loaded the Worker sets its props.
 */
export class SiteData
  extends WorkerEntrypoint<CloudflareEnv, SiteDataProps>
  implements SiteDataBinding
{
  async query(query: SiteDataQuery): Promise<SiteDataResult> {
    const { scope } = this.ctx.props;
    // Imported on first use, so a Worker serving no site does not compile it.
    const { createCloudflareBackofficeObjectRegistry } =
      await import("../app/backoffice-runtime/cloudflare-durable-object-factory");
    return await createCloudflareBackofficeObjectRegistry(this.env)
      .siteReplica.for(scope)
      .commands.query(scope, query);
  }

  async fire(event: SiteEvent): Promise<SiteFireResult> {
    const [
      { createCloudflareBackofficeObjectRegistry },
      { cloudflareSiteEventLimiter },
      { fireSiteEvent },
    ] = await Promise.all([
      import("../app/backoffice-runtime/cloudflare-durable-object-factory"),
      import("../app/artifacts/sites/site-event-limiter"),
      import("../app/artifacts/sites/site-events.server"),
    ]);
    return await fireSiteEvent({
      objects: createCloudflareBackofficeObjectRegistry(this.env),
      limiter: cloudflareSiteEventLimiter(this.env.SITE_EVENTS),
      props: this.ctx.props,
      event,
    });
  }
}
