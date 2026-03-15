import { createRequestHandler, RouterContextProvider } from "react-router";
import System from "typebox/system";

import { CloudflareContext } from "../app/cloudflare/cloudflare-context";
import { Auth } from "./auth.do";
import { CloudflareWorkers } from "./cloudflare-wfp.do";
import { Forms } from "./forms.do";
import { GitHubWebhookRouter } from "./github-webhook-router.do";
import { GitHub } from "./github.do";
import { MailingList } from "./mailing-list.do";
import { Pi } from "./pi.do";
import { Resend } from "./resend.do";
import { SandboxRegistry } from "./sandbox-registry.do";
import { Sandbox } from "./sandbox.do";
import { Telegram } from "./telegram.do";
import { Upload } from "./upload.do";

// Export Durable Object classes
export { MailingList };
export { Forms };
export { Auth };
export { Telegram };
export { Resend };
export { Upload };
export { CloudflareWorkers };
export { Sandbox };
export { SandboxRegistry };
export { GitHub };
export { GitHubWebhookRouter };
export { Pi };

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
