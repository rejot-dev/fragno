import { createExampleFragment } from "@fragno-dev/example-fragment";

export function createExampleFragmentInstance() {
  return createExampleFragment({ initialData: "Server Side data" });
}
