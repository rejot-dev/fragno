import { defineRegistry } from "@json-render/react";

import { backofficeUiCatalog } from "./catalog";
import { Heading } from "./components/heading.component";
import { Metric } from "./components/metric.component";
import { Stack } from "./components/stack.component";
import { Text } from "./components/text.component";

export const { registry: backofficeUiRegistry } = defineRegistry(backofficeUiCatalog, {
  components: {
    Stack,
    Heading,
    Text,
    Metric,
  },
});
