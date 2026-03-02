import type { Route } from "./+types/telegram";
import { getTelegramDurableObject } from "@/cloudflare/cloudflare-utils";

const forwardToTelegram = async (
  request: Request,
  context: Route.LoaderArgs["context"],
  orgId: string | undefined,
) => {
  if (!orgId) {
    return new Response("Missing organisation id", { status: 400 });
  }

  const telegramDo = getTelegramDurableObject(context, orgId);
  const url = new URL(request.url);
  const prefix = `/api/telegram/${orgId}`;
  if (url.pathname.startsWith(prefix)) {
    const suffix = url.pathname.slice(prefix.length);
    url.pathname = `/api/telegram${suffix}`;
  }
  url.searchParams.set("orgId", orgId);

  const proxyRequest = new Request(url.toString(), request);
  return telegramDo.fetch(proxyRequest);
};

/**
 * Catch-all route that forwards all /api/telegram/:orgId/* requests to the Telegram Durable Object.
 * The org-specific prefix is stripped before the request reaches the fragment.
 */
export async function loader({ request, context, params }: Route.LoaderArgs) {
  return forwardToTelegram(request, context, params.orgId);
}

export async function action({ request, context, params }: Route.ActionArgs) {
  return forwardToTelegram(request, context, params.orgId);
}
