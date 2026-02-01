import type { Route } from "./+types/uploads-proxy";
import { getUploadServers } from "~/uploads/upload-fragment.server";

export async function loader(args: Route.LoaderArgs) {
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
  return servers.proxy.handlersFor("react-router").loader(args);
}

export async function action(args: Route.ActionArgs) {
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
  return servers.proxy.handlersFor("react-router").action(args);
}
