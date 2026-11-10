import type { Route } from "./+types/site";
import { redirectToSiteHost } from "./redirect.server";

export async function loader({ request, context }: Route.LoaderArgs) {
  return await redirectToSiteHost({ request, context });
}
