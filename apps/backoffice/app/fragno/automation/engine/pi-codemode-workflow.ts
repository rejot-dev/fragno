import { defineRemoteWorkflow } from "@fragno-dev/workflows/workflow";

import type {
  BackofficeContextScope,
  BackofficeExecutionContext,
} from "@/backoffice-runtime/context";
import type { BackofficeRuntimeServices } from "@/backoffice-runtime/runtime-services";
import { MasterFileSystem } from "@/files/master-file-system";
import {
  automationActorsSchema,
  BACKOFFICE_WORKFLOW_ACTORS_METADATA_KEY,
} from "@/fragno/automation/actors";
import type { BackofficeCodemodeEnv } from "@/fragno/codemode/execute";
import type { PiCodemodeWorkflowParams } from "@/fragno/pi/pi-codemode-workflow";

export const PI_CODEMODE_WORKFLOW = "pi-codemode-script";

export const definePiCodemodeWorkflow = (config: {
  env?: BackofficeCodemodeEnv & CloudflareEnv;
  runtime?: BackofficeRuntimeServices;
  ownerScope: BackofficeContextScope;
}) =>
  defineRemoteWorkflow(
    { name: PI_CODEMODE_WORKFLOW, checkpoint: "step" },
    async (event, remote) => {
      if (!config.env?.LOADER) {
        throw new Error("Pi codemode workflow requires the Cloudflare Worker Loader.");
      }

      const params = event.payload as PiCodemodeWorkflowParams;
      const { executePiCodemodeWorkflow } = await import("./codemode");
      const execution: BackofficeExecutionContext = {
        scope: config.ownerScope,
        actors: automationActorsSchema.parse(
          params.metadata?.[BACKOFFICE_WORKFLOW_ACTORS_METADATA_KEY],
        ),
      };

      return await executePiCodemodeWorkflow({
        params,
        execution,
        masterFs: new MasterFileSystem({ mounts: [] }),
        env: config.env,
        runtime: config.runtime,
        workflowEvent: event,
        remote,
      });
    },
  );
