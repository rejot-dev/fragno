import { schema } from "@json-render/react/schema";

import { defineCatalog, type Spec } from "@json-render/core";

import { badgeDefinition } from "./components/badge";
import { calloutDefinition } from "./components/callout";
import { checkboxDefinition } from "./components/checkbox";
import { codeDefinition } from "./components/code";
import { dividerDefinition } from "./components/divider";
import { fileUploadDefinition } from "./components/file-upload";
import { gridDefinition } from "./components/grid";
import { headingDefinition } from "./components/heading";
import { keyValueDefinition } from "./components/key-value";
import { listDefinition } from "./components/list";
import { metricDefinition } from "./components/metric";
import { progressDefinition } from "./components/progress";
import { sectionDefinition } from "./components/section";
import { selectDefinition } from "./components/select";
import { stackDefinition } from "./components/stack";
import { tableDefinition } from "./components/table";
import { textDefinition } from "./components/text";
import { textAreaDefinition } from "./components/text-area";
import { textInputDefinition } from "./components/text-input";
import { workflowEventButtonDefinition } from "./components/workflow-event-button";

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
  TextInput: textInputDefinition,
  TextArea: textAreaDefinition,
  Select: selectDefinition,
  Checkbox: checkboxDefinition,
  FileUpload: fileUploadDefinition,
  WorkflowEventButton: workflowEventButtonDefinition,
};

export const backofficeUiCatalog = defineCatalog(schema, {
  components: backofficeUiComponentDefinitions,
  actions: {},
});

export type BackofficeUiSpec = Spec;
