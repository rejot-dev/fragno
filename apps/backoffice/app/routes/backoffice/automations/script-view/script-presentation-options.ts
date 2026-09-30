import type { IconName } from "@fragno-private/design-system/icon";

import type { ScriptViewMode, WorkflowGraphDetailMode } from "./script-view-mode";

export const SCRIPT_VIEW_OPTIONS: Array<{
  mode: ScriptViewMode;
  label: string;
  icon: IconName;
}> = [
  { mode: "code", label: "Code", icon: "code" },
  { mode: "graph", label: "Graph", icon: "share-2" },
  { mode: "split", label: "Both", icon: "columns" },
];

export const WORKFLOW_GRAPH_DETAIL_OPTIONS: Array<{
  mode: WorkflowGraphDetailMode;
  label: string;
}> = [
  { mode: "simple", label: "Simple" },
  { mode: "verbose", label: "Verbose" },
  { mode: "ui", label: "UI" },
];
