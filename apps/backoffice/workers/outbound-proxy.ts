import { WorkerEntrypoint } from "cloudflare:workers";

/**
 * Outbound egress capability for codemode sandboxes. Dynamically-loaded Workers
 * start with no network access, so their `globalOutbound` routes through this
 * host-controlled entrypoint for public internet access.
 */
export class OutboundProxy extends WorkerEntrypoint {
  override fetch(request: Request): Promise<Response> {
    return fetch(request);
  }
}
