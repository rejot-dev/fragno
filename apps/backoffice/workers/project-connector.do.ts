import { DurableObject } from "cloudflare:workers";

import type { ProjectConnectorCommands } from "@/backoffice-runtime/object-registry";

import type { ProjectConnectorObject } from "./project-connector-object";

/** Cloudflare and Node use the same user-owned Connector host and migrations. */
export class ProjectConnectorDurableObject
  extends DurableObject<CloudflareEnv>
  implements ProjectConnectorCommands
{
  #object!: ProjectConnectorObject;
  constructor(state: DurableObjectState, env: CloudflareEnv) {
    super(state, env);
    // Imported on first use so that a cold isolate only evaluates the objects it wakes.
    void state.blockConcurrencyWhile(async () => {
      const { ProjectConnectorObject } = await import("./project-connector-object");
      const { createCloudflareBackofficeObjectContext } =
        await import("./lib/cloudflare-backoffice-object-implementation");
      this.#object = new ProjectConnectorObject(
        createCloudflareBackofficeObjectContext(state, env),
      );
    });
  }
  async alarm(): Promise<void> {
    await this.#object.alarm();
  }
  async fetch(request: Request): Promise<Response> {
    return await this.#object.fetch(request);
  }
}
