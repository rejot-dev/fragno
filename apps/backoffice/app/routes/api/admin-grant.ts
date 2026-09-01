import { getAuthDurableObject } from "@/worker-runtime/durable-objects";

import type { Route } from "./+types/admin-grant";

async function forwardAdminGrantRequest({ request, context }: Route.ActionArgs | Route.LoaderArgs) {
  const response = await getAuthDurableObject(context).http.fetch(
    new Request(request, { redirect: "manual" }),
  );
  return new Response(response.body, response);
}

export function loader(args: Route.LoaderArgs) {
  return forwardAdminGrantRequest(args);
}

export function action(args: Route.ActionArgs) {
  return forwardAdminGrantRequest(args);
}
