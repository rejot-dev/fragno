import type { Route } from "./+types/site";
import { serveSiteRoute } from "./serve.server";

export async function loader({ request, context }: Route.LoaderArgs) {
  return await serveSiteRoute({ request, context });
}

export async function action({ request, context }: Route.ActionArgs) {
  return await serveSiteRoute({ request, context });
}
