import { redirect } from "react-router";

import { backofficeRouteScopeFromResolvedScope } from "@/backoffice-runtime/resolved-scope";
import { backofficeRouteScopePath } from "@/backoffice-runtime/route-scope";
import { getBackofficeShellRequest } from "@/layouts/backoffice-shell-request.server";

import type { Route } from "./+types/index";

export async function loader({ context }: Route.LoaderArgs) {
  const { me } = getBackofficeShellRequest(context);
  const scope = backofficeRouteScopeFromResolvedScope({
    kind: "user",
    userId: me.user.id,
    jurisdiction: me.user.jurisdiction,
  });
  return redirect(`/backoffice/artifacts/${backofficeRouteScopePath(scope)}`);
}

export default function BackofficeArtifactsIndex() {
  return null;
}
