import { createExampleFragment } from "@fragno-dev/example-fragment";

const exampleFragment = createExampleFragment({});

export const { ALL } = exampleFragment.handlersFor("astro");
export const prerender = false;
