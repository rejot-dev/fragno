import type { Route } from "./+types/uploads-direct";
import { getUploadServers } from "~/uploads/upload-fragment.server";

export async function loader(args: Route.LoaderArgs) {
  const servers = await getUploadServers();
  if (!servers.direct) {
    return new Response(
      JSON.stringify({
        message: servers.directError ?? "Direct uploads are not configured.",
        code: "DIRECT_UPLOADS_DISABLED",
      }),
      {
        status: 503,
        headers: { "Content-Type": "application/json" },
      },
    );
  }
  return servers.direct.handlersFor("react-router").loader(args);
}

export async function action(args: Route.ActionArgs) {
  const servers = await getUploadServers();
  if (!servers.direct) {
    return new Response(
      JSON.stringify({
        message: servers.directError ?? "Direct uploads are not configured.",
        code: "DIRECT_UPLOADS_DISABLED",
      }),
      {
        status: 503,
        headers: { "Content-Type": "application/json" },
      },
    );
  }
  return servers.direct.handlersFor("react-router").action(args);
}
