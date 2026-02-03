import type { Route } from "./+types/shadcn-registry";
import registry from "@/components/form-builder/form-builder.json";

export function loader(_args: Route.LoaderArgs) {
  return Response.json(registry);
}
