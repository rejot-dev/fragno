import { defineRegistry } from "@json-render/react";

import { backofficeUiCatalog } from "./catalog";
import { Badge } from "./components/badge.component";
import { Callout } from "./components/callout.component";
import { Code } from "./components/code.component";
import { Divider } from "./components/divider.component";
import { Grid } from "./components/grid.component";
import { Heading } from "./components/heading.component";
import { KeyValue } from "./components/key-value.component";
import { List } from "./components/list.component";
import { Metric } from "./components/metric.component";
import { Progress } from "./components/progress.component";
import { Section } from "./components/section.component";
import { Stack } from "./components/stack.component";
import { Table } from "./components/table.component";
import { Text } from "./components/text.component";

export const { registry: backofficeUiRegistry } = defineRegistry(backofficeUiCatalog, {
  components: {
    Stack,
    Grid,
    Section,
    Divider,
    Heading,
    Text,
    Code,
    Callout,
    Metric,
    Badge,
    KeyValue,
    List,
    Table,
    Progress,
  },
});
