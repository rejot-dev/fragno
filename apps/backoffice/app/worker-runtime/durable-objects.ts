import type {
  BackofficeContextScope,
  BackofficeOrganizationContextScope,
} from "@fragno-dev/backoffice-api/v0/shared/scope";
import type { RouterContextProvider } from "react-router";

import type {
  ApiCommands,
  AuthCommands,
  AutomationsCommands,
  BackofficeObjectHandle,
  FormsCommands,
  GitHubCommands,
  GitHubWebhookRouterCommands,
  MarketplaceCommands,
  McpCommands,
  OtpCommands,
  ResendCommands,
  TelegramCommands,
  UploadCommands,
} from "@/backoffice-runtime/object-registry";

import { BackofficeWorkerContext } from "./router-context";

export const BACKOFFICE_ADMIN_OBJECT_NAME = "admin" as const;

export const getBackofficeObjects = (context: Readonly<RouterContextProvider>) =>
  context.get(BackofficeWorkerContext).runtime.objects;

export const getApiDurableObject = (
  context: Readonly<RouterContextProvider>,
  organization: BackofficeOrganizationContextScope,
): BackofficeObjectHandle<ApiCommands> => getBackofficeObjects(context).api.for(organization);

export const getAuthDurableObject = (
  context: Readonly<RouterContextProvider>,
): BackofficeObjectHandle<AuthCommands> => getBackofficeObjects(context).auth.singleton();

export const getAutomationsDurableObject = (
  context: Readonly<RouterContextProvider>,
  organization: BackofficeOrganizationContextScope,
): BackofficeObjectHandle<AutomationsCommands> =>
  getBackofficeObjects(context).automations.for(organization);

export const getMarketplaceDurableObject = (
  context: Readonly<RouterContextProvider>,
): BackofficeObjectHandle<MarketplaceCommands> =>
  getBackofficeObjects(context).marketplace.singleton();

export const getTelegramDurableObject = (
  context: Readonly<RouterContextProvider>,
  organization: BackofficeOrganizationContextScope,
): BackofficeObjectHandle<TelegramCommands> =>
  getBackofficeObjects(context).telegram.for(organization);

export const getMcpDurableObject = (
  context: Readonly<RouterContextProvider>,
  organization: BackofficeOrganizationContextScope,
): BackofficeObjectHandle<McpCommands> => getBackofficeObjects(context).mcp.for(organization);

export const getSystemOtpDurableObject = (
  context: Readonly<RouterContextProvider>,
): BackofficeObjectHandle<OtpCommands> => getBackofficeObjects(context).otp.singleton();

export const getOtpDurableObject = (
  context: Readonly<RouterContextProvider>,
  organization: BackofficeOrganizationContextScope,
): BackofficeObjectHandle<OtpCommands> => getBackofficeObjects(context).otp.for(organization);

export const getResendDurableObject = (
  context: Readonly<RouterContextProvider>,
  organization: BackofficeOrganizationContextScope,
): BackofficeObjectHandle<ResendCommands> => getBackofficeObjects(context).resend.for(organization);

export const getUploadDurableObject = (
  context: Readonly<RouterContextProvider>,
  organization: BackofficeOrganizationContextScope,
): BackofficeObjectHandle<UploadCommands> => getBackofficeObjects(context).upload.for(organization);

export const getScopedAutomationsDurableObject = (
  context: Readonly<RouterContextProvider>,
  scope: BackofficeContextScope,
): BackofficeObjectHandle<AutomationsCommands> =>
  getBackofficeObjects(context).automations.for(scope);

export const getFormsDurableObject = (
  context: Readonly<RouterContextProvider>,
): BackofficeObjectHandle<FormsCommands> => getBackofficeObjects(context).forms.singleton();

export const getGitHubDurableObject = (
  context: Readonly<RouterContextProvider>,
  organization: BackofficeOrganizationContextScope,
): BackofficeObjectHandle<GitHubCommands> => getBackofficeObjects(context).github.for(organization);

export const getGitHubWebhookRouterDurableObject = (
  context: Readonly<RouterContextProvider>,
): BackofficeObjectHandle<GitHubWebhookRouterCommands> =>
  getBackofficeObjects(context).githubWebhookRouter.singleton();
