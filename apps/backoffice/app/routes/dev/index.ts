import { getAuthDurableObject } from "@/worker-runtime/durable-objects";

import type { Route } from "./+types/index";

const localHostnames = new Set(["localhost", "127.0.0.1", "[::1]"]);

const assertDevOnlyLocalRequest = (request: Request) => {
  if (import.meta.env.MODE !== "development") {
    throw new Response("Not Found", { status: 404 });
  }

  const hostname = new URL(request.url).hostname;
  if (!localHostnames.has(hostname)) {
    throw new Response("Not Found", { status: 404 });
  }
};

export async function loader({ request, context }: Route.LoaderArgs) {
  assertDevOnlyLocalRequest(request);

  const organizations = await getAuthDurableObject(context).getDevOrganizations();

  return Response.json(
    {
      ok: true,
      service: "backoffice-dev",
      mode: import.meta.env.MODE,
      organizations,
    },
    { headers: { "cache-control": "no-store" } },
  );
}
