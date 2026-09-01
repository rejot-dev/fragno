import System from "typebox/system";

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

System.Settings.Set({ useAcceleration: false });

// Keep the object host in module-worker format even though public HTTP is disabled.
export default {
  fetch() {
    return new Response("Not Found", { status: 404 });
  },
} satisfies ExportedHandler<CloudflareEnv>;

export {
  Api,
  Auth,
  Automations,
  Billing,
  Cloudflare,
  Forms,
  GitHub,
  GitHubWebhookRouter,
  Marketplace,
  Mcp,
  Otp,
  OutboundProxy,
  Resend,
  Reson8,
  Sandbox,
  Telegram,
  Upload,
};
