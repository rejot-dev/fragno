import { createExampleFragment } from "@fragno-dev/example-fragment";
import { toSvelteHandler } from "@fragno-dev/core/svelte-kit";

const exampleFragment = createExampleFragment();

export const { GET, POST, PUT, PATCH, DELETE, OPTIONS } = toSvelteHandler(exampleFragment);

export const prerender = false;
