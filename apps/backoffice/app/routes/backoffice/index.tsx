import { redirect } from "react-router";

import { getBackofficeShellRequest } from "@/layouts/backoffice-shell-request.server";

import type { Route } from "./+types/index";
import { mainPiAgentPath } from "./agents/path";
import { dashboardPath } from "./dashboard/path";

export function loader({ request, context }: Route.LoaderArgs) {
  const { me } = getBackofficeShellRequest(context);
  const scope = { kind: "user", userId: me.user.id } as const;
  // Phones start in a conversation with the assistant. The server cannot see the viewport, so the
  // user agent stands in for the phone layout: phone browsers name themselves "Mobi(le)", tablets
  // do not.
  if (request.headers.get("user-agent")?.includes("Mobi")) {
    return redirect(mainPiAgentPath(scope));
  }
  return redirect(dashboardPath(scope));
}

export default function BackofficeIndex() {
  return null;
}
