import { createExampleFragment } from "@fragno-dev/example-fragment";

const exampleFragment = createExampleFragment({});

export default fromWebHandler(exampleFragment.handler);
