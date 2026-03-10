import type { RouterContextProvider } from "react-router";
import type { Auth } from "workers/auth.do";
import type { Forms } from "workers/forms.do";
import type { GitHub } from "workers/github.do";
import type { GitHubWebhookRouter } from "workers/github-webhook-router.do";
import type { MailingList } from "workers/mailing-list.do";
import type { Telegram } from "workers/telegram.do";
import type { Resend } from "workers/resend.do";
import type { Upload } from "workers/upload.do";
import type { SandboxRegistry } from "workers/sandbox-registry.do";
import { CloudflareContext } from "./cloudflare-context";

export const MAILING_LIST_SINGLETON_ID = "MAILING_LIST_SINGLETON_ID" as const;
export const FORMS_SINGLETON_ID = "FORMS_SINGLETON_ID" as const;
export const AUTH_SINGLETON_ID = "AUTH_SINGLETON_ID" as const;
const SANDBOX_REGISTRY_ORG_KEY_PREFIX = "SANDBOX_REGISTRY_ORG:";
export const GITHUB_WEBHOOK_ROUTER_SINGLETON_ID = "GITHUB_WEBHOOK_ROUTER_SINGLETON_ID" as const;

/**
 * Helper to get the Mailing List Durable Object stub from the router context.
 * This can be safely imported in route loaders/actions.
 */
export function getMailingListDurableObject(
  context: Readonly<RouterContextProvider>,
): DurableObjectStub<MailingList> {
  const { env } = context.get(CloudflareContext);

  const mailingListDo = env.MAILING_LIST.get(
    env.MAILING_LIST.idFromName(MAILING_LIST_SINGLETON_ID),
  );

  return mailingListDo;
}

/**
 * Helper to get the Forms Durable Object stub from the router context.
 * This can be safely imported in route loaders/actions.
 */
export function getFormsDurableObject(
  context: Readonly<RouterContextProvider>,
): DurableObjectStub<Forms> {
  const { env } = context.get(CloudflareContext);

  return env.FORMS.get(env.FORMS.idFromName(FORMS_SINGLETON_ID));
}

/**
 * Helper to get the Auth Durable Object stub from the router context.
 * This can be safely imported in route loaders/actions.
 */
export function getAuthDurableObject(
  context: Readonly<RouterContextProvider>,
): DurableObjectStub<Auth> {
  const { env } = context.get(CloudflareContext);

  return env.AUTH.get(env.AUTH.idFromName(AUTH_SINGLETON_ID));
}

/**
 * Helper to get the Telegram Durable Object stub from the router context.
 * Each organization gets its own Durable Object instance, keyed by org id.
 */
export function getTelegramDurableObject(
  context: Readonly<RouterContextProvider>,
  orgId: string,
): DurableObjectStub<Telegram> {
  const { env } = context.get(CloudflareContext);

  return env.TELEGRAM.get(env.TELEGRAM.idFromName(orgId));
}

/**
 * Helper to get the Resend Durable Object stub from the router context.
 * Each organization gets its own Durable Object instance, keyed by org id.
 */
export function getResendDurableObject(
  context: Readonly<RouterContextProvider>,
  orgId: string,
): DurableObjectStub<Resend> {
  const { env } = context.get(CloudflareContext);

  return env.RESEND.get(env.RESEND.idFromName(orgId));
}

/**
 * Helper to get the Upload Durable Object stub from the router context.
 * Each organization gets its own Durable Object instance, keyed by org id.
 */
export function getUploadDurableObject(
  context: Readonly<RouterContextProvider>,
  orgId: string,
): DurableObjectStub<Upload> {
  const { env } = context.get(CloudflareContext);

  return env.UPLOAD.get(env.UPLOAD.idFromName(orgId));
}

/**
 * Helper to get the Sandbox Registry Durable Object stub from the router context.
 * Each organization gets its own registry instance.
 */
export function getSandboxRegistryDurableObject(
  context: Readonly<RouterContextProvider>,
  orgId: string,
): DurableObjectStub<SandboxRegistry> {
  const { env } = context.get(CloudflareContext);
  const registryKey = `${SANDBOX_REGISTRY_ORG_KEY_PREFIX}${orgId}`;

  return env.SANDBOX_REGISTRY.get(env.SANDBOX_REGISTRY.idFromName(registryKey));
}

/**
 * Helper to get the GitHub Durable Object stub from the router context.
 * Each organization gets its own Durable Object instance, keyed by org id.
 */
export function getGitHubDurableObject(
  context: Readonly<RouterContextProvider>,
  orgId: string,
): DurableObjectStub<GitHub> {
  const { env } = context.get(CloudflareContext);

  return env.GITHUB.get(env.GITHUB.idFromName(orgId));
}

/**
 * Helper to get the global GitHub webhook router Durable Object.
 * This singleton stores installation -> organisation routing metadata.
 */
export function getGitHubWebhookRouterDurableObject(
  context: Readonly<RouterContextProvider>,
): DurableObjectStub<GitHubWebhookRouter> {
  const { env } = context.get(CloudflareContext);

  return env.GITHUB_WEBHOOK_ROUTER.get(
    env.GITHUB_WEBHOOK_ROUTER.idFromName(GITHUB_WEBHOOK_ROUTER_SINGLETON_ID),
  );
}
