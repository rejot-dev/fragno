import { schema } from "@json-render/react/schema";

import { defineCatalog, type Spec } from "@json-render/core";

import { badgeDefinition } from "./components/badge";
import { barChartDefinition } from "./components/bar-chart";
import { calloutDefinition } from "./components/callout";
import { checkboxDefinition } from "./components/checkbox";
import { codeDefinition } from "./components/code";
import { dividerDefinition } from "./components/divider";
import { fileUploadDefinition } from "./components/file-upload";
import { gridDefinition } from "./components/grid";
import { headingDefinition } from "./components/heading";
import { iconDefinition } from "./components/icon";
import { imageDefinition } from "./components/image";
import { keyValueDefinition } from "./components/key-value";
import { linkDefinition } from "./components/link";
import { listDefinition } from "./components/list";
import { listRowDefinition } from "./components/list-row";
import { metricDefinition } from "./components/metric";
import { numberDefinition } from "./components/number";
import { panelDefinition } from "./components/panel";
import { panelTableDefinition } from "./components/panel-table";
import { panelTableRowDefinition } from "./components/panel-table-row";
import { progressDefinition } from "./components/progress";
import { relativeTimeDefinition } from "./components/relative-time";
import { rowListDefinition } from "./components/row-list";
import { sectionDefinition } from "./components/section";
import { selectDefinition } from "./components/select";
import { sparkBarsDefinition } from "./components/spark-bars";
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
  Panel: panelDefinition,
  PanelTable: panelTableDefinition,
  PanelTableRow: panelTableRowDefinition,
  RowList: rowListDefinition,
  ListRow: listRowDefinition,
  Divider: dividerDefinition,
  Heading: headingDefinition,
  Text: textDefinition,
  Code: codeDefinition,
  Image: imageDefinition,
  Callout: calloutDefinition,
  Metric: metricDefinition,
  Number: numberDefinition,
  Badge: badgeDefinition,
  Icon: iconDefinition,
  Link: linkDefinition,
  RelativeTime: relativeTimeDefinition,
  KeyValue: keyValueDefinition,
  List: listDefinition,
  Table: tableDefinition,
  Progress: progressDefinition,
  SparkBars: sparkBarsDefinition,
  BarChart: barChartDefinition,
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
