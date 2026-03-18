export { Auth } from "./auth.do";
export { Automations } from "./automations.do";
export { CloudflareWorkers } from "./cloudflare-wfp.do";
export { Forms } from "./forms.do";
export { GitHubWebhookRouter } from "./github-webhook-router.do";
export { GitHub } from "./github.do";
export { MailingList } from "./mailing-list.do";
export { Otp } from "./otp.do";
export { Pi } from "./pi.do";
export { Resend } from "./resend.do";
export { SandboxRegistry } from "./sandbox-registry.do";
export { Sandbox } from "./sandbox.do";
export { Telegram } from "./telegram.do";
export { Upload } from "./upload.do";

import { handleReactRouterRequest } from "./react-router-handler";

export default {
  fetch: handleReactRouterRequest,
} satisfies ExportedHandler<CloudflareEnv>;
