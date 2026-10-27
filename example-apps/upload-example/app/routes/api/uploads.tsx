import { getUploadServer } from "~/uploads/upload-fragment.server";

type RequestHandlerArgs = { request: Request };

export async function loader({ request }: RequestHandlerArgs) {
  const server = await getUploadServer();
  return server.handlersFor("react-router").loader({ request });
}

export async function action({ request }: RequestHandlerArgs) {
  const server = await getUploadServer();
  return server.handlersFor("react-router").action({ request });
}
