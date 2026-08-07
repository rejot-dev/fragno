import { defineRemoteWorkflow } from "@fragno-dev/workflows/workflow";
import { z } from "zod";

import { backofficeContextScopeSchema } from "@/backoffice-runtime/context-schema";
import type { UploadObject } from "@/backoffice-runtime/object-registry";
import type { BackofficeRuntimeServices } from "@/backoffice-runtime/runtime-services";
import { backofficeWorkflowActorMetadataSchema } from "@/fragno/automation/actors";
import type { AutomationFileSystemConfig } from "@/fragno/automation/catalog";
import type { AutomationEvent } from "@/fragno/automation/contracts";
import { automationEventSchema } from "@/fragno/automation/events";
import {
  UPLOAD_PROVIDER_DATABASE,
  UPLOAD_PROVIDER_R2,
  UPLOAD_PROVIDER_R2_BINDING,
} from "@/fragno/upload";
import { createUploadRouteCaller } from "@/fragno/upload-server";

import { executeAutomationWorkflowSource } from "./automation-codemode-workflow";
import type { AutomationPiBashContext } from "./runtime";
import { createAutomationRuntimeExecution } from "./runtime-execution";

export const UNTRUSTED_CODEMODE_WORKFLOW = "untrusted-codemode-script";

const uploadObjectReferenceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("scope"), scope: backofficeContextScopeSchema }),
  z.object({ kind: z.literal("name"), name: z.string().trim().min(1) }),
]);

const uploadWorkflowSourceSchema = z.object({
  object: uploadObjectReferenceSchema,
  provider: z.enum([UPLOAD_PROVIDER_DATABASE, UPLOAD_PROVIDER_R2, UPLOAD_PROVIDER_R2_BINDING]),
  key: z.string().trim().min(1),
});

const untrustedCodemodeWorkflowParamsSchema = z.object({
  source: uploadWorkflowSourceSchema,
  scriptPath: z.string().trim().min(1),
  automationEvent: automationEventSchema,
  workflowEventPayload: z.record(z.string(), z.unknown()),
  metadata: backofficeWorkflowActorMetadataSchema,
});

export type UntrustedCodemodeWorkflowParams = z.infer<typeof untrustedCodemodeWorkflowParamsSchema>;

const resolveUploadObject = (
  runtime: BackofficeRuntimeServices,
  reference: z.infer<typeof uploadObjectReferenceSchema>,
): UploadObject =>
  reference.kind === "name"
    ? runtime.objects.upload.forName(reference.name)
    : runtime.objects.upload.for(reference.scope);

const loadUploadWorkflowSource = async (
  runtime: BackofficeRuntimeServices,
  source: z.infer<typeof uploadWorkflowSourceSchema>,
) => {
  const callRoute = createUploadRouteCaller(resolveUploadObject(runtime, source.object));
  const response = await callRoute.raw("GET", "/files/by-key/content", {
    query: { provider: source.provider, key: source.key },
  });
  if (!response.ok) {
    throw new Error(
      `Failed to load untrusted workflow source '${source.key}' (${response.status}).`,
    );
  }

  const text = await response.text();
  return text;
};

export const defineUntrustedCodemodeWorkflow = (
  config: AutomationFileSystemConfig & {
    env?: CloudflareEnv;
    runtime?: BackofficeRuntimeServices;
    createPiAutomationContext?: (input: {
      event: AutomationEvent;
      idempotencyKey: string;
    }) => Promise<AutomationPiBashContext | undefined> | AutomationPiBashContext | undefined;
  },
) =>
  defineRemoteWorkflow({ name: UNTRUSTED_CODEMODE_WORKFLOW }, async (event, remote) => {
    const params = untrustedCodemodeWorkflowParamsSchema.parse(event.payload);
    if (!config.runtime) {
      throw new Error("Untrusted codemode workflows require Backoffice runtime services.");
    }
    const script = await loadUploadWorkflowSource(config.runtime, params.source);

    return await executeAutomationWorkflowSource({
      script,
      automationEvent: params.automationEvent,
      workflowScriptPath: params.scriptPath,
      workflowEvent: {
        instanceId: event.instanceId,
        timestamp: event.timestamp,
        payload: params.workflowEventPayload,
      },
      remote,
      config,
      execution: createAutomationRuntimeExecution(params.automationEvent),
    });
  });
