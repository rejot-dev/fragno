import { createExampleFragment } from "@rejot-dev/example-fragment";
import { toAstroHandler } from "@rejot-dev/fragno";

const exampleFragment = createExampleFragment({
  mountRoute: "/api/example-fragment",
});

export const { ALL } = toAstroHandler(exampleFragment);
export const prerender = false;
