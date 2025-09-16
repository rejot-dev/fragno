import { createExampleFragmentClient } from "@fragno-dev/example-fragment";
import { useFragno } from "@fragno-dev/core/react";

const exampleFragmentClient = createExampleFragmentClient();
export const exampleFragment = useFragno(exampleFragmentClient);
