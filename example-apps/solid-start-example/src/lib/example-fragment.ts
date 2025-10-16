import { createExampleFragment } from "@fragno-dev/example-fragment";

function createExampleFragmentInstance() {
  return createExampleFragment({ initialData: "Server Side data" });
}

export const exampleFragment = createExampleFragmentInstance();
