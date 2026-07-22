import type { BackofficeContextScope } from "@/backoffice-runtime/context";

export type PiCodemodeWorkflowParams = {
  code: string;
  /** Worker Loader modules for rewritten npm imports used by `code`. */
  modules?: Record<string, string>;
  sessionId: string;
  toolCallId: string;
  scope: BackofficeContextScope;
};
