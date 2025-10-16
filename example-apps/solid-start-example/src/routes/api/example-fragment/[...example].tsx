import { exampleFragment } from "~/lib/example-fragment";

// SolidStart lazy-loads the route handlers, which means that this file
// executes on the first request of each HTTP method
// Therefore it is crucial that the initialization of the fragment is handled in
// a central location
export const { GET, POST, PUT, DELETE, PATCH, HEAD, OPTIONS } =
  exampleFragment.handlersFor("solid-start");
