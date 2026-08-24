import { getOtpDurableObject } from "@/worker-runtime/durable-objects";

import type { Route } from "./+types/otp";
import { requireApiOrganization } from "./organization.server";

const forwardToOtp = async (
  request: Request,
  context: Route.LoaderArgs["context"],
  orgSlug: string | undefined,
) => {
  const organization = await requireApiOrganization(request, context, orgSlug);
  const orgId = organization.id;

  const otpDo = getOtpDurableObject(context, orgId);
  const url = new URL(request.url);
  const prefix = `/api/otp/${orgSlug}`;
  if (url.pathname.startsWith(prefix)) {
    const suffix = url.pathname.slice(prefix.length);
    url.pathname = `/api/otp${suffix}`;
  }
  url.searchParams.set("orgId", orgId);

  const proxyRequest = new Request(url.toString(), request);
  return otpDo.fetch(proxyRequest);
};

/**
 * Catch-all route that forwards all /api/otp/:orgSlug/* requests to the OTP Durable Object.
 * The org-specific prefix is stripped before the request reaches the fragment.
 */
export async function loader({ request, context, params }: Route.LoaderArgs) {
  return forwardToOtp(request, context, params.orgSlug);
}

export async function action({ request, context, params }: Route.ActionArgs) {
  return forwardToOtp(request, context, params.orgSlug);
}
