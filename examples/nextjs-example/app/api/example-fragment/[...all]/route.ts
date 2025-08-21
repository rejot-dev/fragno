import { createExampleFragment } from "@rejot-dev/example-fragment";
import { toNextJsHandler } from "@rejot-dev/fragno";

const exampleFragment = createExampleFragment({
  mountRoute: "/api/example-fragment",
});

export const { GET, POST, PUT, PATCH, DELETE } = toNextJsHandler(exampleFragment);
