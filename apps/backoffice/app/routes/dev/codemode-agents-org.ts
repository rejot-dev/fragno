import { BackofficeKernel } from "@/backoffice-runtime/kernel";
import { createBackofficeFileSystem } from "@/files/create-file-system";
import { authorizeAccessTokenForOrganization } from "@/fragno/auth/access-token.server";
import { requireBackofficeContext } from "@/fragno/auth/backoffice-principal.server";
import { BackofficeWorkerContext } from "@/worker-runtime/router-context";

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

const readOrgSystemGuidance = async ({
  context,
  execution,
}: {
  context: Route.LoaderArgs["context"];
  execution: Awaited<ReturnType<typeof requireBackofficeContext>>;
}) => {
  const { runtime } = context.get(BackofficeWorkerContext);
  const kernel = new BackofficeKernel({ objects: runtime.objects });
  const fs = await createBackofficeFileSystem({ objects: runtime.objects, kernel, execution });
  return await fs.readFile("/system/SYSTEM.md");
};

export async function loader({ request, context, params }: Route.LoaderArgs) {
  assertDevOnlyLocalRequest(request);

  const orgId = params.orgId?.trim();
  if (!orgId) {
    throw new Response("Missing organisation id", { status: 400 });
  }

  const auth = await authorizeAccessTokenForOrganization(request, context, orgId);
  if (!auth.ok) {
    return auth.response;
  }

  const execution = await requireBackofficeContext(request, context, { kind: "org", orgId });

  const systemGuidance = await readOrgSystemGuidance({ context, execution });
  const headers = new Headers({
    "cache-control": "no-store",
    "content-type": "text/markdown; charset=utf-8",
  });
  for (const [name, value] of auth.headers) {
    headers.append(name, value);
  }

  return new Response(systemGuidance, { headers });
}
