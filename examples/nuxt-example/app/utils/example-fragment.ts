import { createExampleFragmentClient } from "@fragno-dev/example-fragment";
import { useFragno } from "@fragno-dev/core/vue";

const exampleFragmentClient = createExampleFragmentClient();
export const exampleFragment = useFragno(exampleFragmentClient);
