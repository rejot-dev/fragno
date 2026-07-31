import { schema } from "@json-render/react/schema";

import { defineCatalog, type Spec } from "@json-render/core";

import { badgeDefinition } from "./components/badge";
import { calloutDefinition } from "./components/callout";
import { codeDefinition } from "./components/code";
import { dividerDefinition } from "./components/divider";
import { gridDefinition } from "./components/grid";
import { headingDefinition } from "./components/heading";
import { keyValueDefinition } from "./components/key-value";
import { listDefinition } from "./components/list";
import { metricDefinition } from "./components/metric";
import { progressDefinition } from "./components/progress";
import { sectionDefinition } from "./components/section";
import { stackDefinition } from "./components/stack";
import { tableDefinition } from "./components/table";
import { textDefinition } from "./components/text";

export const backofficeUiComponentDefinitions = {
  Stack: stackDefinition,
  Grid: gridDefinition,
  Section: sectionDefinition,
  Divider: dividerDefinition,
  Heading: headingDefinition,
  Text: textDefinition,
  Code: codeDefinition,
  Callout: calloutDefinition,
  Metric: metricDefinition,
  Badge: badgeDefinition,
  KeyValue: keyValueDefinition,
  List: listDefinition,
  Table: tableDefinition,
  Progress: progressDefinition,
};

export const backofficeUiCatalog = defineCatalog(schema, {
  components: backofficeUiComponentDefinitions,
  actions: {},
});

export type BackofficeUiSpec = Spec;
