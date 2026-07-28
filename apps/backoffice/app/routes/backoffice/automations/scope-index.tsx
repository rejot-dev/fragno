import { redirect } from "react-router";

import type { Route } from "./+types/scope-index";

export async function loader({ url }: Route.LoaderArgs) {
  return redirect(`${url.pathname.replace(/\/+$/, "")}/dashboard`);
}

export default function BackofficeAutomationScopeIndex() {
  return null;
}
