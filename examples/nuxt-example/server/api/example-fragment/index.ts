// A generic catch-all, specifically for /api/example-fragment

import { createExampleFragment } from "@rejot-dev/example-fragment";

const exampleFragment = createExampleFragment({
  mountRoute: "/api/example-fragment",
});

export default fromWebHandler(exampleFragment.handler);
