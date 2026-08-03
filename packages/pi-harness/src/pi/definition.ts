import { selectWorkflowStepCommittedEpochs } from "@fragno-dev/workflows/step-emission-control";
import type { InstanceStatus } from "@fragno-dev/workflows/workflow";

import { defineFragment } from "@fragno-dev/core";
import { serviceCalls, withDatabase, type HookFn } from "@fragno-dev/db";
import type { WorkflowsFragmentServices } from "@fragno-dev/workflows";

import type { AgentMessage, SessionTreeEntry } from "@earendil-works/pi-agent-core";

import { piSchema } from "../schema";
import {
  PiSessionDataUnavailableError,
  projectPiSessionFromWorkflowInstance,
  type PiFragmentConfig,
  type PiSession,
  type PiOperationCompletedHookPayload,
} from "./types";
import {
  latestCompletedPiHarnessEntries,
  projectPiWorkflowSession,
  type PiWorkflowSessionProjectionStep,
} from "./workflow-session-projection";
import type { PiHarnessStepResult } from "./workflows/workflow-agent-harness";

export type PiHarnessHooksMap = {
  onOperationCompleted: HookFn<PiOperationCompletedHookPayload>;
};

export type PiSessionDetailSnapshot = {
  session: PiSession;
  workflowStatus: InstanceStatus;
  messages: AgentMessage[];
  sessionEntries: readonly SessionTreeEntry[];
  /** Step keys whose persisted results are already represented in `messages`. */
  completedStepKeys: ReadonlySet<string>;
};

export const piHarnessDefinition = defineFragment<PiFragmentConfig>("pi-harness")
  .extend(withDatabase(piSchema))
  .usesService<"workflows", WorkflowsFragmentServices>("workflows")
  .provideHooks<PiHarnessHooksMap>(({ defineHook, config }) => ({
    onOperationCompleted: defineHook<PiOperationCompletedHookPayload>(async function (payload) {
      await config.onOperationCompleted?.(payload, this);
    }),
  }))
  .providesBaseService(({ defineService, serviceDeps }) =>
    defineService({
      getSessionDetailSnapshot: function (workflowName: string, sessionId: string) {
        return this.serviceTx(piSchema)
          .withServiceCalls(() =>
            serviceCalls(
              serviceDeps.workflows.getInstanceMetadata(workflowName, sessionId),
              serviceDeps.workflows.getInstanceStatus(workflowName, sessionId),
              serviceDeps.workflows.listHistory({ workflowName, instanceId: sessionId }),
            ),
          )
          .transform(({ serviceResult }) => {
            const [instanceMetadata, workflowStatus, history] = serviceResult;
            const session = projectPiSessionFromWorkflowInstance({
              id: sessionId,
              workflowName,
              params: instanceMetadata.params,
              createdAt: instanceMetadata.createdAt,
              updatedAt: instanceMetadata.updatedAt,
            });
            if (!session) {
              throw new PiSessionDataUnavailableError(workflowName, sessionId);
            }
            const workflowSteps: PiWorkflowSessionProjectionStep[] = history.steps.map((step) => ({
              stepKey: step.stepKey,
              type: step.type,
              status: step.status,
              waitEventType: step.waitEventType,
              result: (step.result ?? null) as PiHarnessStepResult | null,
            }));
            const selectedEpochs = selectWorkflowStepCommittedEpochs(history.emissions);
            const selectedEmissions = history.emissions.filter((emission) => {
              const selectedEpoch = selectedEpochs.get(emission.stepKey);
              return !selectedEpoch || selectedEpoch === emission.epoch;
            });
            const projection = projectPiWorkflowSession({
              workflowName,
              sessionId,
              instance: workflowStatus,
              workflowSteps,
              workflowStepEmissions: selectedEmissions.map((emission) => ({
                stepKey: emission.stepKey,
                payload:
                  typeof emission.payload === "object" && emission.payload !== null
                    ? (emission.payload as never)
                    : null,
                createdAt: emission.createdAt,
              })),
            });
            return {
              session,
              workflowStatus,
              messages: projection.state.messages,
              sessionEntries: latestCompletedPiHarnessEntries(workflowSteps),
              completedStepKeys: new Set(projection.completedStepKeys),
            };
          })
          .build();
      },
      createWorkflowSession: function (values: {
        id: string;
        workflowName: string;
        name?: string;
        params?: Record<string, unknown>;
      }) {
        return this.serviceTx(piSchema)
          .withServiceCalls(() => [
            serviceDeps.workflows.createInstance(values.workflowName, {
              id: values.id,
              params: {
                ...values.params,
                __piSession: {
                  name: values.name ?? null,
                },
              },
            }),
          ])
          .build();
      },
    }),
  )
  .build();
