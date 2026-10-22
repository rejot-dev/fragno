import { Callout } from "@fragno-private/design-system/callout";

import { defineRegistry, type ComponentFn, type Components } from "@json-render/react";

import { backofficeUiCatalog, backofficeUiComponentDefinitions } from "./catalog";
import { Badge } from "./components/badge.component";
import { BarChart } from "./components/bar-chart.component";
import { Callout as CalloutComponent } from "./components/callout.component";
import { Checkbox } from "./components/checkbox.component";
import { Code } from "./components/code.component";
import { Divider } from "./components/divider.component";
import { FileUpload } from "./components/file-upload.component";
import { Grid } from "./components/grid.component";
import { Heading } from "./components/heading.component";
import { Icon } from "./components/icon.component";
import { Image } from "./components/image.component";
import { KeyValue } from "./components/key-value.component";
import { Link } from "./components/link.component";
import { ListRow } from "./components/list-row.component";
import { List } from "./components/list.component";
import { Metric } from "./components/metric.component";
import { NumberValue } from "./components/number.component";
import { Orchestration } from "./components/orchestration.component";
import { PanelTable, PanelTableRow } from "./components/panel-table.component";
import { Panel } from "./components/panel.component";
import { Progress } from "./components/progress.component";
import { RelativeTime } from "./components/relative-time.component";
import { RowList } from "./components/row-list.component";
import { RunStatus } from "./components/run-status.component";
import { Section } from "./components/section.component";
import { Select } from "./components/select.component";
import { SparkBars } from "./components/spark-bars.component";
import { Stack } from "./components/stack.component";
import { Table } from "./components/table.component";
import { TextArea } from "./components/text-area.component";
import { TextInput } from "./components/text-input.component";
import { Text } from "./components/text.component";
import { WorkflowEventButton } from "./components/workflow-event-button.component";
import { WorkflowResponse } from "./components/workflow-response.component";
import { renderedPropsSchema } from "./rendered-props";

type BackofficeUiComponentType = keyof typeof backofficeUiComponentDefinitions;

type BackofficeUiComponents = Components<typeof backofficeUiCatalog>;

const components: BackofficeUiComponents = {
  Stack,
  Grid,
  Section,
  Panel,
  PanelTable,
  PanelTableRow,
  RowList,
  ListRow,
  Divider,
  Heading,
  Text,
  Code,
  Image,
  Callout: CalloutComponent,
  Metric,
  Number: NumberValue,
  Badge,
  RunStatus,
  Icon,
  Link,
  RelativeTime,
  KeyValue,
  List,
  Table,
  Progress,
  SparkBars,
  BarChart,
  TextInput,
  TextArea,
  Select,
  Checkbox,
  FileUpload,
  WorkflowEventButton,
  Orchestration,
  WorkflowResponse,
};

const MAX_REPORTED_ISSUES = 3;

/**
 * Props read from state, such as a page query's rows, reach a component unchecked, so each one
 * checks its resolved props first and explains a mismatch in place of itself.
 */
function checked(
  type: BackofficeUiComponentType,
  Component: ComponentFn<typeof backofficeUiCatalog, BackofficeUiComponentType>,
): ComponentFn<typeof backofficeUiCatalog, BackofficeUiComponentType> {
  const schema = renderedPropsSchema(backofficeUiComponentDefinitions[type].props);
  return function Checked(context) {
    const parsed = schema.safeParse(context.props);
    if (!parsed.success) {
      const issues = parsed.error.issues.slice(0, MAX_REPORTED_ISSUES).map((issue) => {
        const path = issue.path.map(String).join(".");
        return path ? `${path}: ${issue.message}` : issue.message;
      });
      return (
        <Callout tone="failed" title={`${type} cannot show its data`}>
          {issues.join("; ")}
        </Callout>
      );
    }
    return <Component {...context} props={parsed.data as typeof context.props} />;
  };
}

export const { registry: backofficeUiRegistry } = defineRegistry(backofficeUiCatalog, {
  components: Object.fromEntries(
    Object.entries(components).map(([type, Component]) => [
      type,
      checked(
        type as BackofficeUiComponentType,
        Component as ComponentFn<typeof backofficeUiCatalog, BackofficeUiComponentType>,
      ),
    ]),
  ) as BackofficeUiComponents,
});
