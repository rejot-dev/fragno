import type { BackofficeContextScope } from "@fragno-dev/backoffice-api/v0/shared/scope";
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
  orgId: string,
): BackofficeObjectHandle<ApiCommands> => getBackofficeObjects(context).api.forOrg(orgId);

export const getAuthDurableObject = (
  context: Readonly<RouterContextProvider>,
): BackofficeObjectHandle<AuthCommands> => getBackofficeObjects(context).auth.singleton();

export const getAutomationsDurableObject = (
  context: Readonly<RouterContextProvider>,
  orgId: string,
): BackofficeObjectHandle<AutomationsCommands> =>
  getBackofficeObjects(context).automations.forOrg(orgId);

export const getMarketplaceDurableObject = (
  context: Readonly<RouterContextProvider>,
): BackofficeObjectHandle<MarketplaceCommands> =>
  getBackofficeObjects(context).marketplace.singleton();

export const getTelegramDurableObject = (
  context: Readonly<RouterContextProvider>,
  orgId: string,
): BackofficeObjectHandle<TelegramCommands> => getBackofficeObjects(context).telegram.forOrg(orgId);

export const getMcpDurableObject = (
  context: Readonly<RouterContextProvider>,
  orgId: string,
): BackofficeObjectHandle<McpCommands> => getBackofficeObjects(context).mcp.forOrg(orgId);

export const getSystemOtpDurableObject = (
  context: Readonly<RouterContextProvider>,
): BackofficeObjectHandle<OtpCommands> => getBackofficeObjects(context).otp.singleton();

export const getOtpDurableObject = (
  context: Readonly<RouterContextProvider>,
  orgId: string,
): BackofficeObjectHandle<OtpCommands> => getBackofficeObjects(context).otp.forOrg(orgId);

export const getResendDurableObject = (
  context: Readonly<RouterContextProvider>,
  orgId: string,
): BackofficeObjectHandle<ResendCommands> => getBackofficeObjects(context).resend.forOrg(orgId);

export const getUploadDurableObject = (
  context: Readonly<RouterContextProvider>,
  orgId: string,
): BackofficeObjectHandle<UploadCommands> => getBackofficeObjects(context).upload.forOrg(orgId);

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
  orgId: string,
): BackofficeObjectHandle<GitHubCommands> => getBackofficeObjects(context).github.forOrg(orgId);

export const getGitHubWebhookRouterDurableObject = (
  context: Readonly<RouterContextProvider>,
): BackofficeObjectHandle<GitHubWebhookRouterCommands> =>
  getBackofficeObjects(context).githubWebhookRouter.singleton();
