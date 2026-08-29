import { createRequestHandler, RouterContextProvider } from "react-router";
import System from "typebox/system";
import * as serverBuild from "virtual:react-router/server-build";

import { BackofficeKernel } from "../app/backoffice-runtime/kernel";
import { createCloudflareBackofficeRuntimeServices } from "../app/backoffice-runtime/runtime-services";
import { BackofficeWorkerContext } from "../app/worker-runtime/router-context";
import { Api } from "./api.do";
import { Auth } from "./auth.do";
import { Automations } from "./automations.do";
import { Billing } from "./billing.do";
import { Cloudflare } from "./cloudflare.do";
import { Forms } from "./forms.do";
import { GitHubWebhookRouter } from "./github-webhook-router.do";
import { GitHub } from "./github.do";
import { Marketplace } from "./marketplace.do";
import { Mcp } from "./mcp.do";
import { Otp } from "./otp.do";
import { OutboundProxy } from "./outbound-proxy";
import { Resend } from "./resend.do";
import { Reson8 } from "./reson8.do";
import { Sandbox } from "./sandbox.do";
import { Telegram } from "./telegram.do";
import { Upload } from "./upload.do";

export { Api };
export { Auth };
export { Automations };
export { Billing };
export { Cloudflare };
export { Forms };
export { Marketplace };
export { Telegram };
export { Resend };
export { Upload };
export { Sandbox };
export { GitHub };
export { GitHubWebhookRouter };
export { Mcp };
export { Otp };
export { Reson8 };
export { OutboundProxy };

System.Settings.Set({ useAcceleration: false });

const requestHandler = createRequestHandler(serverBuild, import.meta.env.MODE);

export default {
  async fetch(request, env, ctx) {
    const requestId = crypto.randomUUID();

    return ctx.tracing.enterSpan("backoffice.request", async (span) => {
      span.setAttribute("backoffice.request_id", requestId);

      const runtime = createCloudflareBackofficeRuntimeServices(env);
      const context = new RouterContextProvider();
      context.set(BackofficeWorkerContext, {
        runtime,
        kernel: new BackofficeKernel(runtime),
        env,
        ctx,
      });
      const response = await requestHandler(request, context);
      const headers = new Headers(response.headers);
      headers.set("backoffice-request-id", requestId);

      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    });
  },
} satisfies ExportedHandler<CloudflareEnv>;
