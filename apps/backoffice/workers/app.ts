import System from "typebox/system";

import {
  BACKOFFICE_WORKER_TOPOLOGY,
  type BackofficeRouteServiceBinding,
} from "../backoffice-worker-topology";
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
import { selectReactRouterServerBundle } from "./react-router-worker-routing";
import { Resend } from "./resend.do";
import { Reson8 } from "./reson8.do";
import { Sandbox } from "./sandbox.do";
import { Telegram } from "./telegram.do";
import { Upload } from "./upload.do";

// Export Durable Object classes
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

export default {
  fetch(request, env) {
    const serverBundleId = selectReactRouterServerBundle(new URL(request.url).pathname);
    const routeWorker = BACKOFFICE_WORKER_TOPOLOGY.reactRouterWorkers[serverBundleId];
    const routeServices = env as CloudflareEnv & Record<BackofficeRouteServiceBinding, Fetcher>;
    return routeServices[routeWorker.serviceBinding].fetch(request);
  },
} satisfies ExportedHandler<CloudflareEnv>;
