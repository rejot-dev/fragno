import { getWorkflowsServer } from "~/workflows/workflows-fragment.server";

type RequestHandlerArgs = { request: Request };

export async function loader({ request }: RequestHandlerArgs) {
  const { fragment } = await getWorkflowsServer();
  const handlers = fragment.handlersFor("react-router");
  return handlers.loader({ request });
}

export async function action({ request }: RequestHandlerArgs) {
  const { fragment } = await getWorkflowsServer();
  const handlers = fragment.handlersFor("react-router");
  return handlers.action({ request });
}
