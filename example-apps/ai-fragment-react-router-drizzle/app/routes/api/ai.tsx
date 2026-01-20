import type { Route } from "./+types/ai";

import { getAiServer } from "~/ai/ai-fragment.server";

export async function loader(args: Route.LoaderArgs) {
  const { fragment } = await getAiServer();
  const handlers = fragment.handlersFor("react-router");
  return handlers.loader(args);
}

export async function action(args: Route.ActionArgs) {
  const { fragment } = await getAiServer();
  const handlers = fragment.handlersFor("react-router");
  return handlers.action(args);
}
