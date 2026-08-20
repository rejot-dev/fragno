import { getBackofficeMe } from "@/fragno/auth/auth-server";

import type { Route } from "./+types/backoffice-me";

const authenticationFailureResponse = (reason: "missing" | "expired" | "invalid") =>
  new Response(
    reason === "missing"
      ? "Authentication required"
      : reason === "expired"
        ? "Authentication expired"
        : "Invalid credential",
    {
      status: 401,
      headers: { "cache-control": "no-store" },
    },
  );

export async function loader({ request, context }: Route.LoaderArgs) {
  const result = await getBackofficeMe(request, context);
  if (result.status === "missing") {
    return authenticationFailureResponse("missing");
  }
  if (result.status === "invalid") {
    return authenticationFailureResponse(result.reason);
  }

  return Response.json(result.me, { headers: { "cache-control": "no-store" } });
}
