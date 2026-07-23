import { getUploadServers } from "~/uploads/upload-fragment.server";

type RequestHandlerArgs = { request: Request };

export async function loader({ request }: RequestHandlerArgs) {
  const servers = await getUploadServers();
  if (!servers.proxy) {
    return new Response(
      JSON.stringify({
        message: "Proxy uploads are not configured.",
        code: "PROXY_UPLOADS_DISABLED",
      }),
      {
        status: 503,
        headers: { "Content-Type": "application/json" },
      },
    );
  }
  return servers.proxy.handlersFor("react-router").loader({ request });
}

export async function action({ request }: RequestHandlerArgs) {
  const servers = await getUploadServers();
  if (!servers.proxy) {
    return new Response(
      JSON.stringify({
        message: "Proxy uploads are not configured.",
        code: "PROXY_UPLOADS_DISABLED",
      }),
      {
        status: 503,
        headers: { "Content-Type": "application/json" },
      },
    );
  }
  return servers.proxy.handlersFor("react-router").action({ request });
}
