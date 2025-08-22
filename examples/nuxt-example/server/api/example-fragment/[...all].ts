import { createExampleFragment } from "@rejot-dev/example-fragment";

const exampleFragment = createExampleFragment({});

export default fromWebHandler(exampleFragment.handler);
