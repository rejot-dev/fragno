import type { AutomationEventActor } from "@/fragno/automation/contracts";

import {
  automationStoreToolFamily,
  type AutomationStoreRuntime,
} from "./families/automations-bindings";
import {
  automationEventsToolFamily,
  hooksToolFamily,
  type DurableHooksRuntime,
} from "./families/automations-durable-hooks";
import {
  automationWorkflowToolFamily,
  type AutomationWorkflowRuntime,
} from "./families/automations-workflow";
import {
  backofficeCapabilitiesToolFamily,
  type BackofficeCapabilitiesRuntime,
} from "./families/backoffice-capabilities";
import { eventToolFamily, type EventRuntime } from "./families/event";
import { mcpToolFamily, type McpRuntime } from "./families/mcp";
import { otpToolFamily, type OtpRuntime } from "./families/otp";
import { piToolFamily, type PiRuntime } from "./families/pi";
import { resendToolFamily, type ResendRuntime } from "./families/resend";
import { reson8ToolFamily, type Reson8Runtime } from "./families/reson8";
import { sandboxToolFamily, type SandboxRuntime } from "./families/sandbox";
import { telegramToolFamily, type TelegramRuntime } from "./families/telegram";
import {
  getAvailableRuntimeTools,
  type BackofficeRuntimeToolFamily,
  type BackofficeToolContext,
} from "./runtime-tools";

export type CoreBackofficeRuntimeMap = {
  backoffice?: BackofficeCapabilitiesRuntime;
  automations?: AutomationStoreRuntime;
  workflow?: AutomationWorkflowRuntime;
  durableHooks?: DurableHooksRuntime;
  event?: EventRuntime;
  mcp?: McpRuntime;
  otp?: OtpRuntime;
  pi?: PiRuntime;
  resend?: ResendRuntime;
  reson8?: Reson8Runtime;
  sandbox?: SandboxRuntime;
  telegram?: TelegramRuntime;
};

export type CoreBackofficeToolContext = BackofficeToolContext<
  CoreBackofficeRuntimeMap,
  { actor?: AutomationEventActor | null }
>;

export const runtimeToolFamilies = [
  backofficeCapabilitiesToolFamily,
  automationStoreToolFamily,
  automationWorkflowToolFamily,
  hooksToolFamily,
  automationEventsToolFamily,
  eventToolFamily,
  mcpToolFamily,
  otpToolFamily,
  piToolFamily,
  resendToolFamily,
  reson8ToolFamily,
  sandboxToolFamily,
  telegramToolFamily,
] as const satisfies readonly BackofficeRuntimeToolFamily[];

export const getAvailableBackofficeRuntimeTools = (context: BackofficeToolContext) =>
  getAvailableRuntimeTools({ families: runtimeToolFamilies, context });

const namespaceCapabilityIds = {
  store: "automations",
  workflow: "automations",
  hooks: "automations",
  events: "automations",
  event: "automations",
  mcp: "mcp",
  otp: "otp",
  pi: "pi",
  resend: "resend",
  reson8: "reson8",
  sandbox: "pi",
  telegram: "telegram",
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
