/*
 * Visual metadata for workflow node kinds — the single source of truth shared by
 * the workflow preview card (in the stream) and the build-mode playground. Each
 * kind gets an icon, an accent colour token, and a human label.
 */

import { Bell, Clock, GitBranch, Send, Zap } from "lucide-react";
import type { LucideIcon } from "lucide-react";

import type { WorkflowNodeKind } from "./output-model";

export type NodeKindMeta = {
  label: string;
  icon: LucideIcon;
  /** CSS color token for the node's accent (border / icon). */
  accent: string;
  /** CSS color token for the node's tinted background. */
  accentBg: string;
};

export const NODE_KIND_META: Record<WorkflowNodeKind, NodeKindMeta> = {
  trigger: {
    label: "Trigger",
    icon: Bell,
    accent: "var(--cad-brass)",
    accentBg: "var(--cad-brass-bg)",
  },
  action: {
    label: "Action",
    icon: Zap,
    accent: "var(--cad-verdigris)",
    accentBg: "var(--cad-verdigris-bg)",
  },
  condition: {
    label: "Condition",
    icon: GitBranch,
    accent: "var(--cad-brass-strong)",
    accentBg: "var(--cad-brass-bg)",
  },
  delay: {
    label: "Delay",
    icon: Clock,
    accent: "var(--cad-muted)",
    accentBg: "var(--cad-panel-2)",
  },
  output: {
    label: "Output",
    icon: Send,
    accent: "var(--cad-rose)",
    accentBg: "var(--cad-rose-bg)",
  },
};
