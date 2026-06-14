import { CloudflareContext } from "@/cloudflare/cloudflare-context";
import { getAuthDurableObject } from "@/cloudflare/cloudflare-utils";
import { createOrgFileSystem } from "@/files/create-file-system";

import type { Route } from "./+types/codemode-agents-org";

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

const assertOrganizationExists = async (context: Route.LoaderArgs["context"], orgId: string) => {
  const organizations = await getAuthDurableObject(context).getDevOrganizations();

  if (!organizations.some((organization) => organization.id === orgId)) {
    throw Response.json(
      {
        error: "Organization not found",
        orgId,
      },
      { status: 404, headers: { "cache-control": "no-store" } },
    );
  }
};

const readOrgSystemGuidance = async (context: Route.LoaderArgs["context"], orgId: string) => {
  const { env } = context.get(CloudflareContext);
  const fs = await createOrgFileSystem({ env, orgId });
  return await fs.readFile("/system/SYSTEM.md");
};

export async function loader({ request, context, params }: Route.LoaderArgs) {
  assertDevOnlyLocalRequest(request);

  const orgId = params.orgId?.trim();
  if (!orgId) {
    throw new Response("Missing organisation id", { status: 400 });
  }

  await assertOrganizationExists(context, orgId);
  const systemGuidance = await readOrgSystemGuidance(context, orgId);

  return new Response(systemGuidance, {
    headers: {
      "cache-control": "no-store",
      "content-type": "text/markdown; charset=utf-8",
    },
  });
}
