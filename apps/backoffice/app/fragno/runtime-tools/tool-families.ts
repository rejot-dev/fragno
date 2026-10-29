import type { BackofficeStateBackend } from "@/fragno/codemode/state-backend";
import type { PiManagerRuntime } from "@/fragno/pi/manager/pi-manager-runtime";

import { codemodeStateToolFamily } from "./codemode-state-runtime";
import { accountToolFamily, type AccountRuntime } from "./families/account";
import { adminToolFamily, type AdminRuntime } from "./families/admin";
import { adminEventsToolFamily } from "./families/admin-events";
import {
  adminMarketplaceCurationToolFamily,
  adminMarketplacePublicationToolFamily,
} from "./families/admin-marketplace";
import { appsToolFamily } from "./families/apps";
import type { AppsRuntime } from "./families/apps-runtime";
import type { ArtifactsRuntime } from "./families/artifacts";
import { artifactsToolFamily } from "./families/artifacts";
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
  type WorkflowRunPresenter,
} from "./families/automations-workflow";
import {
  backofficeCapabilitiesToolFamily,
  type BackofficeCapabilitiesRuntime,
} from "./families/backoffice-capabilities";
import { blobsToolFamily } from "./families/blobs";
import type { BlobsRuntime } from "./families/blobs-runtime";
import { cloudflareToolFamily, type CloudflareRuntime } from "./families/cloudflare";
import {
  eventFireToolFamily,
  eventReadToolFamily,
  eventRetryToolFamily,
  type EventRuntime,
} from "./families/event";
import { eventCatalogToolFamily, type EventCatalogRuntime } from "./families/event-catalog";
import { formsToolFamily, type FormsRuntime } from "./families/forms";
import { imageViewerToolFamily, type ImageViewer } from "./families/image-viewer";
import {
  integrationsToolFamily,
  type IntegrationsRuntime,
} from "./families/integrations/integration-tools";
import { internalWorkspaceToolFamily, type InternalRuntime } from "./families/internal";
import {
  javaScriptBuildToolFamily,
  javaScriptCheckToolFamily,
  javaScriptRunHistoryToolFamily,
  javaScriptRunToolFamily,
} from "./families/javascript";
import type { JavaScriptRuntime } from "./families/javascript-runtime";
import { marketplaceToolFamily } from "./families/marketplace";
import type { MarketplaceRuntime } from "./families/marketplace-runtime";
import { modelsToolFamily, type ModelsRuntime } from "./families/models";
import { organizationToolFamily, type OrganizationRuntime } from "./families/organization";
import { otpToolFamily, type OtpRuntime } from "./families/otp";
import { packagesToolFamily } from "./families/packages";
import type { PackagesRuntime } from "./families/packages-runtime";
import { piToolFamily } from "./families/pi";
import { projectsToolFamily } from "./families/projects";
import type { ProjectsRuntime } from "./families/projects-runtime";
import { reson8ToolFamily, type Reson8Runtime } from "./families/reson8";
import { sandboxToolFamily } from "./families/sandbox";
import type { SandboxRuntime } from "./families/sandbox-runtime";
import { webToolFamily, type WebRuntime } from "./families/web";
import type { FileLinkRuntime } from "./file-links-runtime";
import type { FileShareRuntime } from "./file-shares-runtime";
import { type BackofficeRuntimeToolFamily, type BackofficeToolContext } from "./runtime-tools";

export type CoreBackofficeRuntimeMap = {
  state?: BackofficeStateBackend;
  /** Only an agent's codemode call has one: its images go to the model. */
  imageViewer?: ImageViewer;
  workflowRunPresenter?: WorkflowRunPresenter;
  fileLinks?: FileLinkRuntime;
  fileShares?: FileShareRuntime;
  blobs?: BlobsRuntime;
  account?: AccountRuntime;
  admin?: AdminRuntime;
  org?: OrganizationRuntime;
  apps: AppsRuntime | undefined;
  artifacts?: ArtifactsRuntime;
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
  projects: ProjectsRuntime | undefined;
  reson8?: Reson8Runtime;
  sandbox?: SandboxRuntime;
  javascript?: JavaScriptRuntime;
  web?: WebRuntime;
  models?: ModelsRuntime;
};

export type CoreBackofficeToolContext = BackofficeToolContext<Partial<CoreBackofficeRuntimeMap>>;

export const runtimeToolFamilies = [
  codemodeStateToolFamily,
  imageViewerToolFamily,
  blobsToolFamily,
  accountToolFamily,
  adminToolFamily,
  adminEventsToolFamily,
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
  eventRetryToolFamily,
  eventCatalogToolFamily,
  formsToolFamily,
  cloudflareToolFamily,
  webToolFamily,
  modelsToolFamily,
  otpToolFamily,
  piToolFamily,
  projectsToolFamily,
  reson8ToolFamily,
  sandboxToolFamily,
  javaScriptCheckToolFamily,
  javaScriptRunToolFamily,
  javaScriptRunHistoryToolFamily,
  javaScriptBuildToolFamily,
  artifactsToolFamily,
  marketplaceToolFamily,
  packagesToolFamily,
  internalWorkspaceToolFamily,
] as const satisfies readonly BackofficeRuntimeToolFamily[];
