import registry from "@/components/form-builder/form-builder.json";

import type { Route } from "./+types/shadcn-registry";

export function loader(_args: Route.LoaderArgs) {
  return Response.json(registry);
}
