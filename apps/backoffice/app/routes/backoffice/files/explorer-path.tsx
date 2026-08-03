import type { Route } from "./+types/explorer-path";
import { loadFilesExplorerData } from "./data";

export { default } from "./explorer";

export async function loader({ request, params, context }: Route.LoaderArgs) {
  if (!params.orgId) {
    throw new Response("Not Found", { status: 404 });
  }

  return loadFilesExplorerData({
    request,
    context,
    orgId: params.orgId,
    requestedPath: readExplorerPath(params["*"]),
  });
}

export function meta({ loaderData }: Route.MetaArgs) {
  const selectedTitle = loaderData?.selectedPath?.split("/").filter(Boolean).at(-1);
  return [{ title: selectedTitle ? `Files · ${selectedTitle}` : "Files Explorer" }];
}

function readExplorerPath(splat: string | undefined): string | null {
  const path = splat?.replace(/^\/+|\/+$/gu, "");
  return path ? `/${path}` : null;
}
