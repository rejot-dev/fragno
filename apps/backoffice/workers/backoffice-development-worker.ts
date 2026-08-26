import * as serverBuild from "virtual:react-router/server-build";

import { Api } from "./api.do";
import { Auth } from "./auth.do";
import { Automations } from "./automations.do";
import { Billing } from "./billing.do";
import { Cloudflare } from "./cloudflare.do";
import { createReactRouterRouteService } from "./create-react-router-worker-handler";
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

// Production needs route-isolated Workers for platform limits; development keeps one
// live React Router graph so dependency optimization and HMR happen only once.
export default createReactRouterRouteService(serverBuild);
