import { createExampleFragment } from "@fragno-dev/example-fragment";
import { toNextJsHandler } from "@fragno-dev/core/next-js";

const exampleFragment = createExampleFragment({});

export const { GET, POST, PUT, PATCH, DELETE } = toNextJsHandler(exampleFragment);
