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
      activity: {
        label: "Share files",
        target: (input) => (input.of.kind === "folder" ? input.of.path : input.of.prefix),
      },
      getResource: ({ of }) =>
        of.kind === "folder" ? { path: of.path } : { kind: "blobs", prefix: of.prefix },
      execute: async (input, context: SharesToolContext) =>
        await getShareRuntime(context).create(input),
    }),
    defineBackofficeRuntimeTool({
      ...backofficeApiOperationToolFields("shares.accept"),
      namespace: "shares",
      name: "accept",
      activity: { label: "Accept share", target: (input) => input.name ?? null },
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
      activity: { label: "List shares", target: () => null },
      execute: async (_input, context: SharesToolContext) => await getShareRuntime(context).list(),
    }),
    defineBackofficeRuntimeTool({
      ...backofficeApiOperationToolFields("shares.revoke"),
      namespace: "shares",
      name: "revoke",
      activity: { label: "Revoke share", target: (input) => input.shareId },
      execute: async (input, context: SharesToolContext) => {
        await getShareRuntime(context).revoke(input);
        context.runtimes.state?.refreshMetadata();
      },
    }),
  ],
  isAvailable: (context: SharesToolContext) => !!context.runtimes.shares,
});
