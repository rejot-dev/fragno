import type { Route } from "./+types/auth";
import { getAuthDurableObject } from "@/cloudflare/cloudflare-utils";

const forwardToAuth = async (request: Request, context: Route.LoaderArgs["context"]) => {
  const authDo = getAuthDurableObject(context);
  const proxyRequest = new Request(request, { redirect: "manual" });
  const response = await authDo.fetch(proxyRequest);
  return new Response(response.body, response);
};

/**
 * Catch-all route that forwards all /api/auth/* requests to the Auth Durable Object.
 */
export async function loader({ request, context }: Route.LoaderArgs) {
  return forwardToAuth(request, context);
}

export async function action({ request, context }: Route.ActionArgs) {
  return forwardToAuth(request, context);
}
