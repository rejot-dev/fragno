import type { BackofficeContextScope } from "@fragno-dev/backoffice-api/v0/shared/scope";
import { WorkerEntrypoint } from "cloudflare:workers";

import type {
  SiteDataBinding,
  SiteDataQuery,
  SiteDataResult,
} from "../app/artifacts/sites/site-data";

export type SiteDataProps = { scope: BackofficeContextScope };

/**
 * The binding a site Worker's `env.DATA` reads through: the automation data of the scope its
 * props name, set by the host that loaded the Worker, read with the SQL pages read it with.
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
}
