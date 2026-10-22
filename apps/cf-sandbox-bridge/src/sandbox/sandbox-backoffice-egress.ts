import { WorkerEntrypoint } from "cloudflare:workers";

const FILE_LINK_PATH_PREFIX = "/api/file-links/";

/**
 * Receives sandbox requests to `SANDBOX_BACKOFFICE_ORIGIN` and forwards only Backoffice file links,
 * whose signed tokens are their authority. Containers keep their own Internet access for the rest.
 */
export class SandboxBackofficeEgress extends WorkerEntrypoint<Env> {
  override async fetch(request: Request): Promise<Response> {
    if (!new URL(request.url).pathname.startsWith(FILE_LINK_PATH_PREFIX)) {
      return new Response("Sandboxes reach only Backoffice file links at this origin.", {
        status: 404,
      });
    }
    return await this.env.BACKOFFICE.fetch(request);
  }
}
