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
