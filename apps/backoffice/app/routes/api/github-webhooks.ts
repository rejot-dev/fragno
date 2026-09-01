import { getGitHubWebhookRouterDurableObject } from "@/worker-runtime/durable-objects";

import type { Route } from "./+types/github-webhooks";

async function forwardGitHubWebhookRequest({
  request,
  context,
}: Route.ActionArgs | Route.LoaderArgs) {
  const response = await getGitHubWebhookRouterDurableObject(context).http.fetch(
    new Request(request, { redirect: "manual" }),
  );
  return new Response(response.body, response);
}

export function action(args: Route.ActionArgs) {
  return forwardGitHubWebhookRequest(args);
}

export function loader(args: Route.LoaderArgs) {
  return forwardGitHubWebhookRequest(args);
}
