import { schema } from "@json-render/react/schema";

import { defineCatalog, type Spec } from "@json-render/core";

import { headingDefinition } from "./components/heading";
import { metricDefinition } from "./components/metric";
import { stackDefinition } from "./components/stack";
import { textDefinition } from "./components/text";

export const backofficeUiComponentDefinitions = {
  Stack: stackDefinition,
  Heading: headingDefinition,
  Text: textDefinition,
  Metric: metricDefinition,
};

export const backofficeUiCatalog = defineCatalog(schema, {
  components: backofficeUiComponentDefinitions,
  actions: {},
});

export type BackofficeUiSpec = Spec;
