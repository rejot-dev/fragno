import type { RouterContextProvider } from "react-router";
import type { MailingList } from "workers/mailing-list.do";
import { CloudflareContext } from "./cloudflare-context";
import type { Forms } from "workers/forms.do";
import type { Auth } from "workers/auth.do";

export const MAILING_LIST_SINGLETON_ID = "MAILING_LIST_SINGLETON_ID" as const;
export const FORMS_SINGLETON_ID = "FORMS_SINGLETON_ID" as const;
export const AUTH_SINGLETON_ID = "AUTH_SINGLETON_ID" as const;

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
