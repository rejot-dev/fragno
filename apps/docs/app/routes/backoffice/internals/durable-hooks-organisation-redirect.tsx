import { redirect } from "react-router";
import type { Route } from "./+types/durable-hooks-organisation-redirect";

export async function loader({ params, request }: Route.LoaderArgs) {
  if (!params.orgId) {
    throw new Response("Not Found", { status: 404 });
  }

  const url = new URL(request.url);
  const fragment = url.searchParams.get("fragment") === "resend" ? "resend" : "telegram";
  return redirect(`/backoffice/internals/durable-hooks/${params.orgId}/${fragment}`);
}

export default function BackofficeDurableHooksOrganisationRedirect() {
  return null;
}
