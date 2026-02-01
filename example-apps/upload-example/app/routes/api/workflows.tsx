import type { Route } from "./+types/workflows";

import { getWorkflowsServer } from "~/workflows/workflows-fragment.server";

export async function loader(args: Route.LoaderArgs) {
  const { fragment } = await getWorkflowsServer();
  const handlers = fragment.handlersFor("react-router");
  return handlers.loader(args);
}

export async function action(args: Route.ActionArgs) {
  const { fragment } = await getWorkflowsServer();
  const handlers = fragment.handlersFor("react-router");
  return handlers.action(args);
}
