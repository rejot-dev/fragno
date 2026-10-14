import { redirect } from "react-router";

import type { Route } from "./+types/scope-index";

export async function loader({ params, url }: Route.LoaderArgs) {
  // The layout explains why the system scope has no computers instead of opening a kind.
  if (params.scopeKind === "system") {
    return null;
  }
  return redirect(`${url.pathname.replace(/\/+$/, "")}/sandboxes`);
}

export default function BackofficeComputersScopeIndex() {
  return null;
}
