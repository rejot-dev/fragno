import { createExampleFragment } from "@rejot-dev/example-fragment";
import { toNextJsHandler } from "@rejot-dev/fragno";

const exampleFragment = createExampleFragment({});

export const { GET, POST, PUT, PATCH, DELETE } = toNextJsHandler(exampleFragment);
