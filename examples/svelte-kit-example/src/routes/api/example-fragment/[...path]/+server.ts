import { createExampleFragment } from "@fragno-dev/example-fragment";

const exampleFragment = createExampleFragment();

export const { GET, POST, PUT, PATCH, DELETE, OPTIONS } = exampleFragment.handlersFor("svelte-kit");

export const prerender = false;
