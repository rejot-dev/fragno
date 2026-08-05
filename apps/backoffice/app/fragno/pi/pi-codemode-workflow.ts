import type { NpmDependencyMap } from "@/backoffice-runtime/dynamic-workers/npm-dependencies";
import type { BackofficeWorkflowActorMetadata } from "@/fragno/automation/actors";

export type PiCodemodeWorkflowParams = {
  code: string;
  dependencies?: NpmDependencyMap;
  sessionId: string;
  toolCallId: string;
  metadata: BackofficeWorkflowActorMetadata;
};
