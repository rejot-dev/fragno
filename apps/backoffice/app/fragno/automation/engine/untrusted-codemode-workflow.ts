import { defineRemoteWorkflow } from "@fragno-dev/workflows/workflow";
import { z } from "zod";

import { withBackofficeActorCapabilityGrants } from "@/backoffice-runtime/authority-resolver";
import type { BackofficeExecutionContext } from "@/backoffice-runtime/context";
import { backofficeContextScopeSchema } from "@/backoffice-runtime/context-schema";
import type { UploadObject } from "@/backoffice-runtime/object-registry";
import {
  isBackofficePermissionRequirement,
  type BackofficePermissionRequirement,
} from "@/backoffice-runtime/permissions";
import type { BackofficeRuntimeServices } from "@/backoffice-runtime/runtime-services";
import {
  backofficeWorkflowActorMetadataSchema,
  type AutomationActors,
} from "@/fragno/automation/actors";
import type { AutomationFileSystemConfig } from "@/fragno/automation/catalog";
import type { AutomationEvent } from "@/fragno/automation/contracts";
import { automationEventSchema } from "@/fragno/automation/events";
import {
  UPLOAD_PROVIDER_DATABASE,
  UPLOAD_PROVIDER_R2,
  UPLOAD_PROVIDER_R2_BINDING,
} from "@/fragno/upload";
import { createUploadRouteCaller } from "@/fragno/upload-server";

import { appendAutomationDelegate, createAutomationExecutionFromActors } from "../authority";
import { executeAutomationWorkflowSource } from "./automation-codemode-workflow";
import type { AutomationPiBashContext } from "./runtime";

export const UNTRUSTED_CODEMODE_WORKFLOW = "untrusted-codemode-script";

const UNTRUSTED_CODEMODE_WORKFLOW_DELEGATE = {
  scope: "internal",
  type: "capability",
  id: UNTRUSTED_CODEMODE_WORKFLOW,
  role: "delegate",
} as const satisfies AutomationActors["delegation"][number];

const uploadObjectReferenceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("scope"), scope: backofficeContextScopeSchema }),
  z.object({ kind: z.literal("name"), name: z.string().trim().min(1) }),
]);

const uploadWorkflowSourceSchema = z.object({
  object: uploadObjectReferenceSchema,
  provider: z.enum([UPLOAD_PROVIDER_DATABASE, UPLOAD_PROVIDER_R2, UPLOAD_PROVIDER_R2_BINDING]),
  key: z.string().trim().min(1),
});

const backofficePermissionRequirementSchema = z
  .strictObject({
    namespace: z.string().trim().min(1),
    permission: z.string().trim().min(1),
  })
  .refine(isBackofficePermissionRequirement, "Unknown Backoffice permission.")
  .transform((permission): BackofficePermissionRequirement => permission);

const untrustedCodemodeWorkflowParamsSchema = z.object({
  source: uploadWorkflowSourceSchema,
  scriptPath: z.string().trim().min(1),
  automationEvent: automationEventSchema,
  workflowEventPayload: z.record(z.string(), z.unknown()),
  permissions: z.array(backofficePermissionRequirementSchema),
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
      execution: BackofficeExecutionContext;
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
    const execution = appendAutomationDelegate({
      execution: createAutomationExecutionFromActors({
        scope: params.automationEvent.scope,
        actors: params.automationEvent.actors,
      }),
      delegate: UNTRUSTED_CODEMODE_WORKFLOW_DELEGATE,
    });
    const runtime: BackofficeRuntimeServices = {
      ...config.runtime,
      authorityResolver: withBackofficeActorCapabilityGrants({
        resolver: config.runtime.authorityResolver,
        actor: UNTRUSTED_CODEMODE_WORKFLOW_DELEGATE,
        grants: params.permissions,
      }),
    };

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
      config: { ...config, runtime },
      metadata: params.metadata,
      execution,
    });
  });
