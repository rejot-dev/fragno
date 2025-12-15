import type { Route } from "./+types/forms";
import { getFormsDurableObject } from "@/cloudflare/cloudflare-utils";

/**
 * Catch-all route that forwards all /api/forms/* requests to the Forms Durable Object.
 * The DO handles the actual routing internally (including turnstile validation in middleware).
 */

export async function loader({ request, context }: Route.LoaderArgs) {
  const formsDo = getFormsDurableObject(context);
  return formsDo.fetch(request);
}

export async function action({ request, context }: Route.ActionArgs) {
  const formsDo = getFormsDurableObject(context);
  return formsDo.fetch(request);
}
