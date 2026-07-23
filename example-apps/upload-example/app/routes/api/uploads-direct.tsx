import { getUploadServers } from "~/uploads/upload-fragment.server";

type RequestHandlerArgs = { request: Request };

export async function loader({ request }: RequestHandlerArgs) {
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
  return servers.direct.handlersFor("react-router").loader({ request });
}

export async function action({ request }: RequestHandlerArgs) {
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
  return servers.direct.handlersFor("react-router").action({ request });
}
