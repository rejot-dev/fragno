import { redirect } from "react-router";

import { getBackofficeShellRequest } from "@/layouts/backoffice-shell-request.server";

import type { Route } from "./+types/index";
import { sandboxesPath } from "./paths";

export async function loader({ context }: Route.LoaderArgs) {
  const { me } = getBackofficeShellRequest(context);
  return redirect(sandboxesPath({ kind: "user", userId: me.user.id }));
}

export default function BackofficeComputersIndex() {
  return null;
}
