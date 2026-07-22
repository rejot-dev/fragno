import type { RouterContextProvider } from "react-router";

import type { BackofficeContextScope } from "@/backoffice-runtime/context";
import type {
  ApiObject,
  AuthObject,
  AutomationsObject,
  GitHubObject,
  GitHubWebhookRouterObject,
  McpObject,
  OtpObject,
  PiObject,
  ResendObject,
  Reson8Object,
  TelegramObject,
  UploadObject,
  BackofficeRpcObject,
} from "@/backoffice-runtime/object-registry";

import { BackofficeWorkerContext } from "./router-context";

export const BACKOFFICE_ADMIN_OBJECT_NAME = "admin" as const;

const getBackofficeObjects = (context: Readonly<RouterContextProvider>) =>
  context.get(BackofficeWorkerContext).runtime.objects;

export const getApiDurableObject = (
  context: Readonly<RouterContextProvider>,
  orgId: string,
): ApiObject => getBackofficeObjects(context).api.forOrg(orgId);

export const getAuthDurableObject = (context: Readonly<RouterContextProvider>): AuthObject =>
  getBackofficeObjects(context).auth.singleton();

export const getAutomationsDurableObject = (
  context: Readonly<RouterContextProvider>,
  orgId: string,
): BackofficeRpcObject<AutomationsObject> =>
  getBackofficeObjects(context).automations.forOrg(orgId);

export const getTelegramDurableObject = (
  context: Readonly<RouterContextProvider>,
  orgId: string,
): BackofficeRpcObject<TelegramObject> => getBackofficeObjects(context).telegram.forOrg(orgId);

export const getMcpDurableObject = (
  context: Readonly<RouterContextProvider>,
  orgId: string,
): McpObject => getBackofficeObjects(context).mcp.forOrg(orgId);

export const getOtpDurableObject = (
  context: Readonly<RouterContextProvider>,
  orgId: string,
): OtpObject => getBackofficeObjects(context).otp.forOrg(orgId);

export const getResendDurableObject = (
  context: Readonly<RouterContextProvider>,
  orgId: string,
): ResendObject => getBackofficeObjects(context).resend.forOrg(orgId);

export const getReson8DurableObject = (
  context: Readonly<RouterContextProvider>,
  orgId: string,
): Reson8Object => getBackofficeObjects(context).reson8.forOrg(orgId);

export const getUploadDurableObject = (
  context: Readonly<RouterContextProvider>,
  orgId: string,
): UploadObject => getBackofficeObjects(context).upload.forOrg(orgId);

export const getPiDurableObject = (
  context: Readonly<RouterContextProvider>,
  scope: BackofficeContextScope,
): PiObject => getBackofficeObjects(context).pi.for(scope);

export const getGitHubDurableObject = (
  context: Readonly<RouterContextProvider>,
  orgId: string,
): GitHubObject => getBackofficeObjects(context).github.forOrg(orgId);

export const getGitHubWebhookRouterDurableObject = (
  context: Readonly<RouterContextProvider>,
): GitHubWebhookRouterObject => getBackofficeObjects(context).githubWebhookRouter.singleton();
