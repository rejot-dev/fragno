import type { BackofficeStateBackend } from "@/fragno/codemode/state-backend";

import { codemodeStateToolFamily } from "./codemode-state-runtime";
import { apiToolFamily, type ApiRuntime } from "./families/api";
import {
  automationStoreToolFamily,
  type AutomationStoreRuntime,
} from "./families/automations-bindings";
import { hooksToolFamily, type DurableHooksRuntime } from "./families/automations-durable-hooks";
import {
  automationIdentityToolFamily,
  type AutomationIdentityRuntime,
} from "./families/automations-identities";
import {
  automationRouterToolFamily,
  type AutomationRouterRuntime,
} from "./families/automations-routing";
import {
  automationWorkflowToolFamily,
  type AutomationWorkflowRuntime,
} from "./families/automations-workflow";
import {
  backofficeCapabilitiesToolFamily,
  type BackofficeCapabilitiesRuntime,
} from "./families/backoffice-capabilities";
import { cloudflareToolFamily, type CloudflareRuntime } from "./families/cloudflare";
import { eventCatalogToolFamily, eventFireToolFamily, type EventRuntime } from "./families/event";
import { internalToolFamily, type InternalRuntime } from "./families/internal";
import { mcpToolFamily, type McpRuntime } from "./families/mcp";
import { otpToolFamily, type OtpRuntime } from "./families/otp";
import { piToolFamily, type PiRuntime } from "./families/pi";
import { resendToolFamily, type ResendRuntime } from "./families/resend";
import { reson8ToolFamily, type Reson8Runtime } from "./families/reson8";
import { sandboxToolFamily, type SandboxRuntime } from "./families/sandbox";
import { telegramToolFamily, type TelegramRuntime } from "./families/telegram";
import { uploadToolFamily } from "./families/upload";
import type { UploadRuntime } from "./families/upload-runtime";
import { webToolFamily, type WebRuntime } from "./families/web";
import {
  getAvailableRuntimeTools,
  type BackofficeRuntimeToolFamily,
  type BackofficeToolContext,
} from "./runtime-tools";

export type CoreBackofficeRuntimeMap = {
  state?: BackofficeStateBackend;
  backoffice?: BackofficeCapabilitiesRuntime;
  automations?: AutomationStoreRuntime & AutomationRouterRuntime;
  identity?: AutomationIdentityRuntime;
  workflow?: AutomationWorkflowRuntime;
  durableHooks?: DurableHooksRuntime;
  event?: EventRuntime;
  cloudflare?: CloudflareRuntime;
  internal?: InternalRuntime;
  api?: ApiRuntime;
  mcp?: McpRuntime;
  otp?: OtpRuntime;
  pi?: PiRuntime;
  resend?: ResendRuntime;
  reson8?: Reson8Runtime;
  sandbox?: SandboxRuntime;
  telegram?: TelegramRuntime;
  upload?: UploadRuntime;
  web?: WebRuntime;
};

export type CoreBackofficeToolContext = BackofficeToolContext<CoreBackofficeRuntimeMap>;

export const runtimeToolFamilies = [
  codemodeStateToolFamily,
  backofficeCapabilitiesToolFamily,
  automationStoreToolFamily,
  automationIdentityToolFamily,
  automationRouterToolFamily,
  automationWorkflowToolFamily,
  hooksToolFamily,
  eventFireToolFamily,
  eventCatalogToolFamily,
  cloudflareToolFamily,
  webToolFamily,
  apiToolFamily,
  mcpToolFamily,
  otpToolFamily,
  piToolFamily,
  resendToolFamily,
  reson8ToolFamily,
  sandboxToolFamily,
  telegramToolFamily,
  uploadToolFamily,
  internalToolFamily,
] as const satisfies readonly BackofficeRuntimeToolFamily[];

export const getAvailableBackofficeRuntimeTools = (context: BackofficeToolContext) =>
  getAvailableRuntimeTools({ families: runtimeToolFamilies, context });

const namespaceCapabilityIds = {
  store: "automations",
  identity: "automations",
  router: "automations",
  workflow: "automations",
  hooks: "automations",
  events: "automations",
  api: "api",
  mcp: "mcp",
  otp: "otp",
  pi: "pi",
  resend: "resend",
  reson8: "reson8",
  sandbox: "sandbox",
  telegram: "telegram",
  upload: "upload",
} as const;

export const getRuntimeToolNamespacesByCapability = () => {
  const namespacesByCapability = new Map<string, Set<string>>();
  for (const family of runtimeToolFamilies) {
    for (const tool of family.tools) {
      const capabilityId = tool.capabilityId ?? namespaceCapabilityIds[tool.namespace as never];
      if (!capabilityId) {
        continue;
      }
      const namespaces = namespacesByCapability.get(capabilityId) ?? new Set<string>();
      namespaces.add(tool.namespace);
      namespacesByCapability.set(capabilityId, namespaces);
    }
  }
  return new Map(
    [...namespacesByCapability].map(([capabilityId, namespaces]) => [
      capabilityId,
      [...namespaces].sort(),
    ]),
  );
};
