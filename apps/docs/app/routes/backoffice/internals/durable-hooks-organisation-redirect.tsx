import { redirect } from "react-router";
import type { Route } from "./+types/durable-hooks-organisation-redirect";

export async function loader({ params, request }: Route.LoaderArgs) {
  if (!params.orgId) {
    throw new Response("Not Found", { status: 404 });
  }

  const url = new URL(request.url);
  const fragmentParam = url.searchParams.get("fragment");
  const fragment =
    fragmentParam === "resend" || fragmentParam === "github" ? fragmentParam : "telegram";
  return redirect(`/backoffice/internals/durable-hooks/${params.orgId}/${fragment}`);
}

export default function BackofficeDurableHooksOrganisationRedirect() {
  return null;
}
