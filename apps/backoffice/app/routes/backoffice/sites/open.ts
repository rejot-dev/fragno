import type { Route } from "./+types/open";
import { openSiteHost } from "./open.server";

export async function loader({ request, context, url }: Route.LoaderArgs) {
  return await openSiteHost({ request, context, url });
}
