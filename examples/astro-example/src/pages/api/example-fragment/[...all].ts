import { createExampleFragment } from "@fragno-dev/example-fragment";
import { toAstroHandler } from "@fragno-dev/core";

const exampleFragment = createExampleFragment({});

export const { ALL } = toAstroHandler(exampleFragment.handler);
export const prerender = false;
