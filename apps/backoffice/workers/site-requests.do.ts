import type {
  ArtifactSiteLogEntry,
  ArtifactSiteRequestInput,
  ArtifactSiteResponse,
} from "@fragno-dev/backoffice-api/v0/artifacts";
import type { BackofficeContextScope } from "@fragno-dev/backoffice-api/v0/shared/scope";
import { DurableObject } from "cloudflare:workers";

import type { SiteProbeReport } from "@/artifacts/sites/site-logs";
import type { SiteRequestsCommands, SiteRequestsQuery } from "@/backoffice-runtime/object-registry";

import type { SiteRequestsObject } from "./site-requests-object";

export class SiteRequests extends DurableObject<CloudflareEnv> implements SiteRequestsCommands {
  #object!: SiteRequestsObject;

  constructor(state: DurableObjectState, env: CloudflareEnv) {
    super(state, env);
    // Imported on first use so that a cold isolate only evaluates the objects it wakes.
    void state.blockConcurrencyWhile(async () => {
      const [
        { SiteRequestsObject },
        { createCloudflareBackofficeObjectContext },
        { exportedSiteWorkerBindings },
      ] = await Promise.all([
        import("./site-requests-object"),
        import("./lib/cloudflare-backoffice-object-implementation"),
        import("@/artifacts/sites/serve.server"),
      ]);
      const context = createCloudflareBackofficeObjectContext(state, env);
      this.#object = new SiteRequestsObject({
        ...context,
        // The site Workers it loads are bound to this Worker's exports.
        siteWorkerBindings: exportedSiteWorkerBindings(context.runtime.workerLoader, state.exports),
      });
    });
  }

  async request(
    scope: BackofficeContextScope,
    input: ArtifactSiteRequestInput,
  ): Promise<ArtifactSiteResponse> {
    return await this.#object.request(scope, input);
  }

  async append(
    scope: BackofficeContextScope,
    sitePath: string,
    entries: ArtifactSiteLogEntry[],
    probe: SiteProbeReport | null,
  ): Promise<void> {
    await this.#object.append(scope, sitePath, entries, probe);
  }

  async read(
    scope: BackofficeContextScope,
    query: SiteRequestsQuery,
  ): Promise<ArtifactSiteLogEntry[]> {
    return await this.#object.read(scope, query);
  }

  async alarm(): Promise<void> {
    await this.#object.alarm();
  }
}
