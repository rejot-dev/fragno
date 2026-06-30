import { WorkerEntrypoint } from "cloudflare:workers";
import { createRequestHandler, RouterContextProvider } from "react-router";
import System from "typebox/system";

import { createCloudflareBackofficeRuntimeServices } from "../app/backoffice-runtime/runtime-services";
import { BackofficeWorkerContext } from "../app/worker-runtime/router-context";
import { Api } from "./api.do";
import { Auth } from "./auth.do";
import { Automations } from "./automations.do";
import { CloudflareWorkers } from "./cloudflare-wfp.do";
import { GitHubWebhookRouter } from "./github-webhook-router.do";
import { GitHub } from "./github.do";
import { Mcp } from "./mcp.do";
import { Otp } from "./otp.do";
import { Pi } from "./pi.do";
import { Resend } from "./resend.do";
import { Reson8 } from "./reson8.do";
import { Sandbox } from "./sandbox.do";
import { Telegram } from "./telegram.do";
import { Upload } from "./upload.do";

// Export Durable Object classes
export { Api };
export { Auth };
export { Automations };
export { Telegram };
export { Resend };
export { Upload };
export { CloudflareWorkers };
export { Sandbox };
export { GitHub };
export { GitHubWebhookRouter };
export { Mcp };
export { Pi };
export { Otp };
export { Reson8 };

/**
 * Outbound egress capability for codemode sandboxes. Dynamically-loaded Workers
 * (the codemode/workflow sandbox spawned via `env.LOADER`) start with no network
 * access — a bare `fetch()` throws "this worker is not permitted to access the
 * internet". Passing this entrypoint as the sandbox's `globalOutbound` routes its
 * `fetch()` calls back through the host worker, which can reach the public
 * internet. Forwarding here (rather than handing the sandbox raw internet) keeps
 * egress a host-controlled capability — add allowlisting/logging in one place.
 */
export class OutboundProxy extends WorkerEntrypoint {
  override fetch(request: Request): Promise<Response> {
    return fetch(request);
  }
}

const requestHandler = createRequestHandler(
  () => import("virtual:react-router/server-build"),
  import.meta.env.MODE,
);

System.Settings.Set({ useAcceleration: false });

export default {
  async fetch(request, env, ctx) {
    const context = new RouterContextProvider();
    context.set(BackofficeWorkerContext, {
      runtime: createCloudflareBackofficeRuntimeServices(env),
      env,
      ctx,
    });
    return requestHandler(request, context);
  },
} satisfies ExportedHandler<CloudflareEnv>;
