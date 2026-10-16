import { redirect } from "react-router";

import type { Route } from "./+types/threads-index";
import { resendConnection } from "./connection.server";

export function loader({ request, context, url }: Route.LoaderArgs) {
  // A redirect would win over the 404 the parent route reports without a connection.
  resendConnection.require({ request, context });
  return redirect(`${url.pathname.replace(/\/+$/u, "")}/start`);
}

export default function BackofficeOrganizationResendThreadsIndex() {
  return null;
}
