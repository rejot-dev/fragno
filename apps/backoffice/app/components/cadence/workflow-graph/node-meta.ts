/*
 * Visual metadata for the *derived* automation pipeline graph (the one produced
 * by `@fragno-dev/workflow-visualizer`). Distinct from the planner's design-mode
 * node kinds in ../prompt/output/node-kinds.ts — this graph is read from real
 * automation source, so its kinds are event / router / workflow / step / script.
 */

import {
  Bell,
  Clock,
  FileCode,
  GitBranch,
  Hourglass,
  Repeat,
  Send,
  ShieldAlert,
  Workflow,
  Zap,
  type LucideIcon,
} from "lucide-react";

import type { EdgeType, NodeKind, StepType } from "@fragno-dev/workflow-visualizer";

export type NodeKindMeta = {
  label: string;
  icon: LucideIcon;
  accent: string;
  accentBg: string;
};

export const PIPELINE_NODE_META: Record<NodeKind, NodeKindMeta> = {
  event: {
    label: "Event",
    icon: Bell,
    accent: "var(--cad-brass)",
    accentBg: "var(--cad-brass-bg)",
  },
  router: {
    label: "Route",
    icon: GitBranch,
    accent: "var(--cad-brass-strong)",
    accentBg: "var(--cad-brass-bg)",
  },
  workflow: {
    label: "Workflow",
    icon: Workflow,
    accent: "var(--cad-verdigris)",
    accentBg: "var(--cad-verdigris-bg)",
  },
  loop: {
    label: "Loop",
    icon: Repeat,
    accent: "var(--cad-brass-strong)",
    accentBg: "var(--cad-brass-bg)",
  },
  step: { label: "Step", icon: Zap, accent: "var(--cad-fg)", accentBg: "var(--cad-panel-2)" },
  script: {
    label: "Script",
    icon: FileCode,
    accent: "var(--cad-muted)",
    accentBg: "var(--cad-panel-2)",
  },
};

/** Step nodes get a sub-icon by their step type. */
export const STEP_TYPE_ICON: Record<StepType, LucideIcon> = {
  do: Zap,
  sleep: Clock,
  sleepUntil: Clock,
  waitForEvent: Hourglass,
  emit: Send,
  spawn: GitBranch,
  guard: ShieldAlert,
};

export const STEP_TYPE_LABEL: Record<StepType, string> = {
  do: "do",
  sleep: "sleep",
  sleepUntil: "sleep until",
  waitForEvent: "wait for event",
  emit: "emit",
  spawn: "spawn",
  guard: "guard",
};

export type EdgeStyle = { stroke: string; animated: boolean; dashed: boolean };

export const EDGE_STYLE: Record<EdgeType, EdgeStyle> = {
  matches: { stroke: "var(--cad-brass)", animated: false, dashed: false },
  spawns: { stroke: "var(--cad-verdigris)", animated: false, dashed: false },
  contains: { stroke: "var(--cad-line-strong)", animated: false, dashed: true },
  sequence: { stroke: "var(--cad-muted-2)", animated: false, dashed: false },
  sends: { stroke: "var(--cad-rose)", animated: true, dashed: false },
  waits: { stroke: "var(--cad-brass-strong)", animated: false, dashed: true },
  emits: { stroke: "var(--cad-rose)", animated: true, dashed: false },
};
