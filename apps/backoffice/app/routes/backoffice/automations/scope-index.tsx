import { redirect } from "react-router";

import type { Route } from "./+types/scope-index";

export async function loader({ request }: Route.LoaderArgs) {
  const url = new URL(request.url);
  return redirect(`${url.pathname.replace(/\/+$/, "")}/scripts`);
}

export default function BackofficeAutomationScopeIndex() {
  return null;
}
