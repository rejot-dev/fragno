import type { BackofficeContextScope } from "@/backoffice-runtime/context";
import type { NpmDependencyMap } from "@/backoffice-runtime/dynamic-workers/npm-dependencies";
import type { AutomationActors } from "@/fragno/automation/actors";

export type PiCodemodeWorkflowParams = {
  code: string;
  dependencies?: NpmDependencyMap;
  sessionId: string;
  toolCallId: string;
  scope: BackofficeContextScope;
  actors: AutomationActors;
};
