import { createExampleFragment } from "@rejot-dev/example-fragment";
import { toAstroHandler } from "@rejot-dev/fragno";

const exampleFragment = createExampleFragment({});

export const { ALL } = toAstroHandler(exampleFragment.handler);
export const prerender = false;
