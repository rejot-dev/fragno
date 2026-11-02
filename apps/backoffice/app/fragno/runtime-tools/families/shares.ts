import type { BackofficeStateBackend } from "@/fragno/codemode/state-backend";

import {
  backofficeApiOperationToolFields,
  defineBackofficeRuntimeTool,
  defineBackofficeRuntimeToolFamily,
  type BackofficeToolContext,
} from "../runtime-tools";
import type { ShareRuntime } from "../shares-runtime";

type SharesToolContext = BackofficeToolContext<{
  shares?: ShareRuntime;
  state?: BackofficeStateBackend;
}>;

// Shares exist only between scopes with an Upload workspace.
function getShareRuntime(context: SharesToolContext): ShareRuntime {
  const runtime = context.runtimes.shares;
  if (!runtime) {
    throw new Error("Shares are not available in this execution context.");
  }
  return runtime;
}

export const sharesToolFamily = defineBackofficeRuntimeToolFamily({
  namespace: "shares",
  tools: [
    defineBackofficeRuntimeTool({
      ...backofficeApiOperationToolFields("shares.create"),
      namespace: "shares",
      name: "create",
      getResource: ({ of }) =>
        of.kind === "folder" ? { path: of.path } : { kind: "blobs", prefix: of.prefix },
      execute: async (input, context: SharesToolContext) =>
        await getShareRuntime(context).create(input),
    }),
    defineBackofficeRuntimeTool({
      ...backofficeApiOperationToolFields("shares.accept"),
      namespace: "shares",
      name: "accept",
      execute: async (input, context: SharesToolContext) => {
        const accepted = await getShareRuntime(context).accept(input);
        // The mount may have been looked up, and missed, earlier in this execution.
        context.runtimes.state?.refreshMetadata();
        return accepted;
      },
    }),
    defineBackofficeRuntimeTool({
      ...backofficeApiOperationToolFields("shares.list"),
      namespace: "shares",
      name: "list",
      execute: async (_input, context: SharesToolContext) => await getShareRuntime(context).list(),
    }),
    defineBackofficeRuntimeTool({
      ...backofficeApiOperationToolFields("shares.revoke"),
      namespace: "shares",
      name: "revoke",
      execute: async (input, context: SharesToolContext) => {
        await getShareRuntime(context).revoke(input);
        context.runtimes.state?.refreshMetadata();
      },
    }),
  ],
  isAvailable: (context: SharesToolContext) => !!context.runtimes.shares,
});
