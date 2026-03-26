import { createRequestHandler, RouterContextProvider } from "react-router";
import System from "typebox/system";

import { CloudflareContext } from "../app/cloudflare/cloudflare-context";
import { Auth } from "./auth.do";
import { Automations } from "./automations.do";
import { CloudflareWorkers } from "./cloudflare-wfp.do";
import { GitHubWebhookRouter } from "./github-webhook-router.do";
import { GitHub } from "./github.do";
import { Otp } from "./otp.do";
import { Pi } from "./pi.do";
import { Resend } from "./resend.do";
import { Reson8 } from "./reson8.do";
import { SandboxRegistry } from "./sandbox-registry.do";
import { Sandbox } from "./sandbox.do";
import { Telegram } from "./telegram.do";
import { Upload } from "./upload.do";

// Export Durable Object classes
export { Auth };
export { Automations };
export { Telegram };
export { Resend };
export { Upload };
export { CloudflareWorkers };
export { Sandbox };
export { SandboxRegistry };
export { GitHub };
export { GitHubWebhookRouter };
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
    context.set(CloudflareContext, { env, ctx });
    return requestHandler(request, context);
  },
} satisfies ExportedHandler<CloudflareEnv>;
