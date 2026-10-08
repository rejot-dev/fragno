import { redirect } from "react-router";

import { completeBackofficeInstall } from "../lib/backoffice.server";
import { requireSession } from "../lib/session.server";
import type { Route } from "./+types/backoffice-callback";

/** Backoffice's install page returns here with a code, or with `error=access_denied`. */
export async function loader({ request, url }: Route.LoaderArgs) {
  await requireSession(request);
  const result = await completeBackofficeInstall(request, url);
  const destination = new URL("/dashboard/backoffice", url);
  destination.searchParams.set("link", result.status);
  if (result.status === "failed") {
    destination.searchParams.set("message", result.message);
  }
  return redirect(`${destination.pathname}${destination.search}`, {
    headers: { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" },
  });
}
