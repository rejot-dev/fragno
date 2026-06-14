import type { RouterContextProvider } from "react-router";

import type {
  AuthObject,
  AutomationsObject,
  CloudflareWorkersObject,
  GitHubObject,
  GitHubWebhookRouterObject,
  McpObject,
  OtpObject,
  PiObject,
  ResendObject,
  Reson8Object,
  SandboxRegistryObject,
  TelegramObject,
  UploadObject,
} from "@/backoffice-runtime/object-registry";

import { BackofficeWorkerContext } from "./router-context";

export const AUTH_SINGLETON_ID = "AUTH_SINGLETON_ID" as const;
export const SANDBOX_REGISTRY_ORG_KEY_PREFIX = "SANDBOX_REGISTRY_ORG:" as const;
export const GITHUB_WEBHOOK_ROUTER_SINGLETON_ID = "GITHUB_WEBHOOK_ROUTER_SINGLETON_ID" as const;

const getBackofficeObjects = (context: Readonly<RouterContextProvider>) =>
  context.get(BackofficeWorkerContext).runtime.objects;

export const getAuthDurableObject = (context: Readonly<RouterContextProvider>): AuthObject =>
  getBackofficeObjects(context).auth.get();

export const getAutomationsDurableObject = (
  context: Readonly<RouterContextProvider>,
  orgId: string,
): AutomationsObject => getBackofficeObjects(context).automations.forOrg(orgId);

export const getTelegramDurableObject = (
  context: Readonly<RouterContextProvider>,
  orgId: string,
): TelegramObject => getBackofficeObjects(context).telegram.forOrg(orgId);

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

export const getCloudflareWorkersDurableObject = (
  context: Readonly<RouterContextProvider>,
  orgId: string,
): CloudflareWorkersObject => getBackofficeObjects(context).cloudflareWorkers.forOrg(orgId);

export const getPiDurableObject = (
  context: Readonly<RouterContextProvider>,
  orgId: string,
): PiObject => getBackofficeObjects(context).pi.forOrg(orgId);

export const getSandboxRegistryDurableObject = (
  context: Readonly<RouterContextProvider>,
  orgId: string,
): SandboxRegistryObject => getBackofficeObjects(context).sandboxRegistry.forOrg(orgId);

export const getGitHubDurableObject = (
  context: Readonly<RouterContextProvider>,
  orgId: string,
): GitHubObject => getBackofficeObjects(context).github.forOrg(orgId);

export const getGitHubWebhookRouterDurableObject = (
  context: Readonly<RouterContextProvider>,
): GitHubWebhookRouterObject => getBackofficeObjects(context).githubWebhookRouter.get();
