import { getAuthDurableObject } from "@/worker-runtime/durable-objects";

import type { Route } from "./+types/backoffice-cli-config";

export async function loader({ request, context }: Route.LoaderArgs) {
  const config = await getAuthDurableObject(context).commands.getBackofficeCliOAuthConfig({
    requestUrl: request.url,
  });
  return Response.json(config, { headers: { "cache-control": "no-store" } });
}
