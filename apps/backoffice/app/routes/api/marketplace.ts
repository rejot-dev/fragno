import type { LoaderFunctionArgs } from "react-router";

import { getMarketplaceDurableObject } from "@/worker-runtime/durable-objects";

/** Public metadata API backed by the singleton Marketplace Durable Object. */
export async function loader({ request, context }: LoaderFunctionArgs) {
  return getMarketplaceDurableObject(context).http.fetch(request);
}
