import { redirect } from "react-router";

import { getBackofficeShellRequest } from "@/layouts/backoffice-shell-request.server";

import type { Route } from "./+types/index";
import { filesScopeBasePath } from "./scope";

export async function loader({ context }: Route.LoaderArgs) {
  const { me } = getBackofficeShellRequest(context);
  return redirect(
    filesScopeBasePath({ kind: "user", userId: me.user.id, jurisdiction: me.user.jurisdiction }),
  );
}

export default function BackofficeFilesIndex() {
  return null;
}
