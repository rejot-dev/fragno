import { getOtpDurableObject } from "@/cloudflare/cloudflare-utils";

import type { Route } from "./+types/otp";

const forwardToOtp = async (
  request: Request,
  context: Route.LoaderArgs["context"],
  orgId: string | undefined,
) => {
  if (!orgId) {
    return new Response("Missing organisation id", { status: 400 });
  }

  const otpDo = getOtpDurableObject(context, orgId);
  const url = new URL(request.url);
  const prefix = `/api/otp/${orgId}`;
  if (url.pathname.startsWith(prefix)) {
    const suffix = url.pathname.slice(prefix.length);
    url.pathname = `/api/otp${suffix}`;
  }
  url.searchParams.set("orgId", orgId);

  const proxyRequest = new Request(url.toString(), request);
  return otpDo.fetch(proxyRequest);
};

/**
 * Catch-all route that forwards all /api/otp/:orgId/* requests to the OTP Durable Object.
 * The org-specific prefix is stripped before the request reaches the fragment.
 */
export async function loader({ request, context, params }: Route.LoaderArgs) {
  return forwardToOtp(request, context, params.orgId);
}

export async function action({ request, context, params }: Route.ActionArgs) {
  return forwardToOtp(request, context, params.orgId);
}
