import { getResendDurableObject } from "@/cloudflare/cloudflare-utils";

import type { Route } from "./+types/resend";

const forwardToResend = async (
  request: Request,
  context: Route.LoaderArgs["context"],
  orgId: string | undefined,
) => {
  if (!orgId) {
    return new Response("Missing organisation id", { status: 400 });
  }

  const resendDo = getResendDurableObject(context, orgId);
  const url = new URL(request.url);
  const prefix = `/api/resend/${orgId}`;
  if (url.pathname.startsWith(prefix)) {
    const suffix = url.pathname.slice(prefix.length);
    url.pathname = `/api/resend${suffix}`;
  }
  url.searchParams.set("orgId", orgId);

  const proxyRequest = new Request(url.toString(), request);
  return resendDo.fetch(proxyRequest);
};

/**
 * Catch-all route that forwards all /api/resend/:orgId/* requests to the Resend Durable Object.
 * The org-specific prefix is stripped before the request reaches the fragment.
 */
export async function loader({ request, context, params }: Route.LoaderArgs) {
  return forwardToResend(request, context, params.orgId);
}

export async function action({ request, context, params }: Route.ActionArgs) {
  return forwardToResend(request, context, params.orgId);
}
