import { env } from "cloudflare:workers";
import { redirect } from "react-router";

import { requireSessionUser } from "../lib/session.server";
import type { Route } from "./+types/start";

/** Where signing in lands: the wizard for someone without a workspace, else their first one. */
export async function loader({ request }: Route.LoaderArgs) {
  const user = await requireSessionUser(request);
  const [first] = await env.WORKSPACES.getByName("workspaces").listMemberships(
    user.backofficeUserId,
  );
  throw redirect(first ? `/w/${first.workspace.slug}` : "/welcome");
}
