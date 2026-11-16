import { getAuthDurableObject } from "@/worker-runtime/durable-objects";

import type { Route } from "./+types/leyway-cli-config";

export async function loader({ request, context }: Route.LoaderArgs) {
  const config = await getAuthDurableObject(context).commands.getLeywayCliOAuthConfig({
    requestUrl: request.url,
  });
  return Response.json(config, { headers: { "cache-control": "no-store" } });
}
