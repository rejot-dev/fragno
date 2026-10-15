import type { BackofficeStateBackend } from "@/fragno/codemode/state-backend";
import type { PiManagerRuntime } from "@/fragno/pi/manager/pi-manager-runtime";

import { codemodeStateToolFamily } from "./codemode-state-runtime";
import { accountToolFamily, type AccountRuntime } from "./families/account";
import { adminToolFamily, type AdminRuntime } from "./families/admin";
import {
  adminMarketplaceCurationToolFamily,
  adminMarketplacePublicationToolFamily,
} from "./families/admin-marketplace";
import { appsToolFamily } from "./families/apps";
import type { AppsRuntime } from "./families/apps-runtime";
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
import { eventFireToolFamily, eventReadToolFamily, type EventRuntime } from "./families/event";
import { eventCatalogToolFamily, type EventCatalogRuntime } from "./families/event-catalog";
import { formsToolFamily, type FormsRuntime } from "./families/forms";
import {
  integrationsToolFamily,
  type IntegrationsRuntime,
} from "./families/integrations/integration-tools";
import { internalWorkspaceToolFamily, type InternalRuntime } from "./families/internal";
import {
  javaScriptBuildToolFamily,
  javaScriptCheckToolFamily,
  javaScriptLogsToolFamily,
  javaScriptRunToolFamily,
} from "./families/javascript";
import type { JavaScriptRuntime } from "./families/javascript-runtime";
import { marketplaceToolFamily } from "./families/marketplace";
import type { MarketplaceRuntime } from "./families/marketplace-runtime";
import { organizationToolFamily, type OrganizationRuntime } from "./families/organization";
import { otpToolFamily, type OtpRuntime } from "./families/otp";
import { packagesToolFamily } from "./families/packages";
import type { PackagesRuntime } from "./families/packages-runtime";
import { piToolFamily } from "./families/pi";
import { sandboxToolFamily, type SandboxRuntime } from "./families/sandbox";
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
  account?: AccountRuntime;
  admin?: AdminRuntime;
  org?: OrganizationRuntime;
  apps: AppsRuntime | undefined;
  backoffice?: BackofficeCapabilitiesRuntime;
  integrations: IntegrationsRuntime | undefined;
  automations?: AutomationStoreRuntime & AutomationRouterRuntime;
  identity?: AutomationIdentityRuntime;
  workflow?: AutomationWorkflowRuntime;
  durableHooks?: DurableHooksRuntime;
  event?: EventRuntime;
  eventCatalog?: EventCatalogRuntime;
  forms?: FormsRuntime;
  cloudflare?: CloudflareRuntime;
  internal?: InternalRuntime;
  marketplace: MarketplaceRuntime | undefined;
  packages: PackagesRuntime | undefined;
  otp?: OtpRuntime;
  pi?: PiManagerRuntime;
  sandbox?: SandboxRuntime;
  javascript?: JavaScriptRuntime;
  upload?: UploadRuntime;
  web?: WebRuntime;
};

export type CoreBackofficeToolContext = BackofficeToolContext<Partial<CoreBackofficeRuntimeMap>>;

export const runtimeToolFamilies = [
  codemodeStateToolFamily,
  accountToolFamily,
  adminToolFamily,
  adminMarketplaceCurationToolFamily,
  adminMarketplacePublicationToolFamily,
  organizationToolFamily,
  appsToolFamily,
  backofficeCapabilitiesToolFamily,
  integrationsToolFamily,
  automationStoreToolFamily,
  automationIdentityToolFamily,
  automationRouterToolFamily,
  automationWorkflowToolFamily,
  hooksToolFamily,
  eventFireToolFamily,
  eventReadToolFamily,
  eventCatalogToolFamily,
  formsToolFamily,
  cloudflareToolFamily,
  webToolFamily,
  otpToolFamily,
  piToolFamily,
  sandboxToolFamily,
  javaScriptCheckToolFamily,
  javaScriptRunToolFamily,
  javaScriptLogsToolFamily,
  javaScriptBuildToolFamily,
  uploadToolFamily,
  marketplaceToolFamily,
  packagesToolFamily,
  internalWorkspaceToolFamily,
] as const satisfies readonly BackofficeRuntimeToolFamily[];

export const getAvailableBackofficeRuntimeTools = (context: BackofficeToolContext) =>
  getAvailableRuntimeTools({ families: runtimeToolFamilies, context });
