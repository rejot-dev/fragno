import { Code2, Columns2, Workflow as WorkflowIcon } from "lucide-react";
import type { ComponentType } from "react";

import type { ScriptViewMode, WorkflowGraphDetailMode } from "./script-view-mode";

export const SCRIPT_VIEW_OPTIONS: Array<{
  mode: ScriptViewMode;
  label: string;
  icon: ComponentType<{ className?: string }>;
}> = [
  { mode: "code", label: "Code", icon: Code2 },
  { mode: "graph", label: "Graph", icon: WorkflowIcon },
  { mode: "split", label: "Both", icon: Columns2 },
];

export const WORKFLOW_GRAPH_DETAIL_OPTIONS: Array<{
  mode: WorkflowGraphDetailMode;
  label: string;
}> = [
  { mode: "simple", label: "Simple" },
  { mode: "verbose", label: "Verbose" },
];
