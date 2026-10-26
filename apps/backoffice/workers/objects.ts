import System from "typebox/system";

import { Api } from "./api.do";
import { AppInstallations } from "./app-installations.do";
import { Apps } from "./apps.do";
import { Auth } from "./auth.do";
import { Automations } from "./automations.do";
import { Billing } from "./billing.do";
import { Cloudflare } from "./cloudflare.do";
import { Codemode } from "./codemode.do";
import { Forms } from "./forms.do";
import { GitHubWebhookRouter } from "./github-webhook-router.do";
import { GitHub } from "./github.do";
import { Marketplace } from "./marketplace.do";
import { Mcp } from "./mcp.do";
import { Otp } from "./otp.do";
import { PiManager } from "./pi-manager.do";
import { Pi } from "./pi.do";
import { Presence } from "./presence.do";
import { ProjectConnectorDurableObject } from "./project-connector.do";
import { Resend } from "./resend.do";
import { SandboxManager } from "./sandbox-manager.do";
import { Telegram } from "./telegram.do";
import { Upload } from "./upload.do";

System.Settings.Set({ useAcceleration: false });

// Startup evaluates this module and every `*.do.ts` it imports, whichever object woke the isolate.
// Each object class imports its implementation (`*-object.ts`) on first use, so keep `*.do.ts`
// free of value imports.

// Keep the object host in module-worker format even though public HTTP is disabled.
export default {
  fetch() {
    return new Response("Not Found", { status: 404 });
  },
} satisfies ExportedHandler<CloudflareEnv>;

export {
  Api,
  Apps,
  AppInstallations,
  Auth,
  Automations,
  Billing,
  Cloudflare,
  Codemode,
  Forms,
  GitHub,
  GitHubWebhookRouter,
  Marketplace,
  Mcp,
  ProjectConnectorDurableObject,
  Otp,
  Pi,
  PiManager,
  Presence,
  Resend,
  SandboxManager,
  Telegram,
  Upload,
};
