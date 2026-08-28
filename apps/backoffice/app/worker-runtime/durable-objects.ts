import type { RouterContextProvider } from "react-router";

import type { BackofficeContextScope } from "@/backoffice-runtime/context";
import type {
  ApiObject,
  AuthObject,
  AutomationsObject,
  BackofficeObjectHandle,
  FormsObject,
  GitHubObject,
  GitHubWebhookRouterObject,
  MarketplaceObject,
  McpObject,
  OtpObject,
  ResendObject,
  Reson8Object,
  TelegramObject,
  UploadObject,
} from "@/backoffice-runtime/object-registry";

import { BackofficeWorkerContext } from "./router-context";

export const BACKOFFICE_ADMIN_OBJECT_NAME = "admin" as const;

export const getBackofficeObjects = (context: Readonly<RouterContextProvider>) =>
  context.get(BackofficeWorkerContext).runtime.objects;

export const getApiDurableObject = (
  context: Readonly<RouterContextProvider>,
  orgId: string,
): BackofficeObjectHandle<ApiObject> => getBackofficeObjects(context).api.forOrg(orgId);

export const getAuthDurableObject = (
  context: Readonly<RouterContextProvider>,
): BackofficeObjectHandle<AuthObject> => getBackofficeObjects(context).auth.singleton();

export const getAutomationsDurableObject = (
  context: Readonly<RouterContextProvider>,
  orgId: string,
): BackofficeObjectHandle<AutomationsObject> =>
  getBackofficeObjects(context).automations.forOrg(orgId);

export const getMarketplaceDurableObject = (
  context: Readonly<RouterContextProvider>,
): BackofficeObjectHandle<MarketplaceObject> =>
  getBackofficeObjects(context).marketplace.singleton();

export const getTelegramDurableObject = (
  context: Readonly<RouterContextProvider>,
  orgId: string,
): BackofficeObjectHandle<TelegramObject> => getBackofficeObjects(context).telegram.forOrg(orgId);

export const getMcpDurableObject = (
  context: Readonly<RouterContextProvider>,
  orgId: string,
): BackofficeObjectHandle<McpObject> => getBackofficeObjects(context).mcp.forOrg(orgId);

export const getSystemOtpDurableObject = (
  context: Readonly<RouterContextProvider>,
): BackofficeObjectHandle<OtpObject> => getBackofficeObjects(context).otp.singleton();

export const getOtpDurableObject = (
  context: Readonly<RouterContextProvider>,
  orgId: string,
): BackofficeObjectHandle<OtpObject> => getBackofficeObjects(context).otp.forOrg(orgId);

export const getResendDurableObject = (
  context: Readonly<RouterContextProvider>,
  orgId: string,
): BackofficeObjectHandle<ResendObject> => getBackofficeObjects(context).resend.forOrg(orgId);

export const getReson8DurableObject = (
  context: Readonly<RouterContextProvider>,
  orgId: string,
): BackofficeObjectHandle<Reson8Object> => getBackofficeObjects(context).reson8.forOrg(orgId);

export const getUploadDurableObject = (
  context: Readonly<RouterContextProvider>,
  orgId: string,
): BackofficeObjectHandle<UploadObject> => getBackofficeObjects(context).upload.forOrg(orgId);

export const getScopedAutomationsDurableObject = (
  context: Readonly<RouterContextProvider>,
  scope: BackofficeContextScope,
): BackofficeObjectHandle<AutomationsObject> =>
  getBackofficeObjects(context).automations.for(scope);

export const getFormsDurableObject = (
  context: Readonly<RouterContextProvider>,
): BackofficeObjectHandle<FormsObject> => getBackofficeObjects(context).forms.singleton();

export const getGitHubDurableObject = (
  context: Readonly<RouterContextProvider>,
  orgId: string,
): BackofficeObjectHandle<GitHubObject> => getBackofficeObjects(context).github.forOrg(orgId);

export const getGitHubWebhookRouterDurableObject = (
  context: Readonly<RouterContextProvider>,
): BackofficeObjectHandle<GitHubWebhookRouterObject> =>
  getBackofficeObjects(context).githubWebhookRouter.singleton();
