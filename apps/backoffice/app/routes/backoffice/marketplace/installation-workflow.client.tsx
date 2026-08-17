import { use } from "react";

import type { BackofficeContextScope } from "@/backoffice-runtime/context";
import type { BackofficeRoutableScope } from "@/backoffice-runtime/scope-codec";
import { parseBackofficeUiResult } from "@/backoffice-ui/result";
import { sendBackofficeWorkflowEvent } from "@/backoffice-ui/workflow-events.client";
import { CODEMODE_WORKFLOW } from "@/fragno/automation/engine/codemode-invocation";
import {
  MARKETPLACE_INGEST_WORKFLOW_NAME,
  marketplaceInstallationWorkflowInstanceId,
} from "@/fragno/automation/marketplace-ingest-identity";
import {
  getAutomationBrowserDatabase,
  type AutomationCollectionSource,
} from "@/fragno/automation/tanstack/browser-database";
import { useWorkflowRunRecords } from "@/routes/backoffice/automations/script-view/use-script-workflow-runs";
import { WorkflowGeneratedUi } from "@/routes/backoffice/automations/script-view/workflow-generated-ui";
import {
  currentWorkflowWaitingEventTypes,
  type AutomationWorkflowRun,
  type WorkflowRunStep,
} from "@/routes/backoffice/automations/script-view/workflow-run-presentation";
import { WorkflowStepGeneratedUi } from "@/routes/backoffice/automations/script-view/workflow-step-generated-ui";

type MarketplaceInstallationGeneratedUi =
  | { kind: "output"; value: unknown }
  | { kind: "step"; step: WorkflowRunStep };

export function selectMarketplaceInstallationGeneratedUi(
  instance: AutomationWorkflowRun,
): MarketplaceInstallationGeneratedUi | null {
  if (
    instance.status === "complete" &&
    parseBackofficeUiResult(instance.output).kind !== "ordinary"
  ) {
    return { kind: "output", value: instance.output };
  }

  const step = [...instance.workflowSteps]
    .reverse()
    .find((candidate) => parseBackofficeUiResult(candidate.result).kind !== "ordinary");
  return step ? { kind: "step", step } : null;
}

export function MarketplaceInstallationWorkflow({
  collectionSource,
  coordinatorScope,
  ingestionWorkflowInstanceId,
  requested,
  targetScope,
}: {
  collectionSource: AutomationCollectionSource | null;
  coordinatorScope: BackofficeContextScope;
  ingestionWorkflowInstanceId: string;
  requested: boolean;
  targetScope: BackofficeRoutableScope;
}) {
  if (!collectionSource) {
    return requested ? (
      <InstallationWorkflowNotice message="Workflow synchronization is unavailable." />
    ) : null;
  }

  return (
    <SynchronizedMarketplaceInstallationWorkflow
      collectionSource={collectionSource}
      coordinatorScope={coordinatorScope}
      ingestionWorkflowInstanceId={ingestionWorkflowInstanceId}
      requested={requested}
      targetScope={targetScope}
    />
  );
}

function SynchronizedMarketplaceInstallationWorkflow({
  collectionSource,
  coordinatorScope,
  ingestionWorkflowInstanceId,
  requested,
  targetScope,
}: {
  collectionSource: AutomationCollectionSource;
  coordinatorScope: BackofficeContextScope;
  ingestionWorkflowInstanceId: string;
  requested: boolean;
  targetScope: BackofficeRoutableScope;
}) {
  const database = use(getAutomationBrowserDatabase(collectionSource));
  const collections = database.collections;
  const ingestionRecords = useWorkflowRunRecords({
    collections,
    selector: {
      type: "instance",
      workflowName: MARKETPLACE_INGEST_WORKFLOW_NAME,
      instanceId: ingestionWorkflowInstanceId,
    },
  });
  const installerInstanceId = marketplaceInstallationWorkflowInstanceId(
    ingestionWorkflowInstanceId,
  );
  const installerRecords = useWorkflowRunRecords({
    collections,
    selector: {
      type: "instance",
      workflowName: CODEMODE_WORKFLOW,
      instanceId: installerInstanceId,
    },
  });
  const ingestion = ingestionRecords.instances[0];
  const installer = installerRecords.instances[0];
  const synchronizationError = ingestionRecords.error ?? installerRecords.error;

  if (synchronizationError) {
    return <InstallationWorkflowNotice message={synchronizationError} />;
  }
  if (!ingestion) {
    return requested || ingestionRecords.isLoading ? (
      <InstallationWorkflowNotice message="Preparing installation workflow…" />
    ) : null;
  }
  if (!installer) {
    return (
      <InstallationWorkflowNotice
        message={
          ingestion.status === "complete"
            ? "Installation complete."
            : ingestion.status === "errored" || ingestion.status === "terminated"
              ? `Installation ${ingestion.status}.`
              : "Preparing installation workflow…"
        }
      />
    );
  }

  return (
    <MarketplaceInstallerGeneratedUi
      coordinatorScope={coordinatorScope}
      instance={installer}
      targetScope={targetScope}
    />
  );
}

export function MarketplaceInstallerGeneratedUi({
  coordinatorScope,
  instance,
  targetScope,
}: {
  coordinatorScope: BackofficeContextScope;
  instance: AutomationWorkflowRun;
  targetScope: BackofficeRoutableScope;
}) {
  const generatedUi = selectMarketplaceInstallationGeneratedUi(instance);
  if (instance.status === "complete" && generatedUi?.kind !== "output") {
    return <InstallationWorkflowNotice message="Installer complete." />;
  }
  if (instance.status === "errored" || instance.status === "terminated") {
    return <InstallationWorkflowNotice message={`Installer ${instance.status}.`} />;
  }
  if (!generatedUi) {
    return <InstallationWorkflowNotice message="Installer is running…" />;
  }

  return (
    <div className="mt-4 border-t border-[color:var(--bo-border)] pt-4">
      <p className="mb-3 text-[10px] font-semibold tracking-[0.14em] text-[var(--bo-muted-2)] uppercase">
        Installer
      </p>
      {generatedUi.kind === "output" ? (
        <WorkflowGeneratedUi value={generatedUi.value} />
      ) : (
        <WorkflowStepGeneratedUi
          state={{
            stepRecordId: generatedUi.step.id,
            status: "completed",
            attempts: generatedUi.step.attempts,
            completedAt: generatedUi.step.updatedAt,
            result: generatedUi.step.result,
            emissionCount: 0,
            current: false,
          }}
          workflowEvents={instance.workflowEvents}
          workflowRunRecordId={instance.id}
          currentScope={targetScope}
          workflowEventSender={async ({
            eventId,
            workflowName,
            instanceId,
            eventType,
            payload,
          }) => {
            await sendBackofficeWorkflowEvent({
              eventId,
              reference: { scope: coordinatorScope, workflowName, instanceId },
              eventType,
              payload,
            });
          }}
          workflowName={instance.workflowName}
          workflowInstanceId={instance.instanceId}
          waitingEventTypes={currentWorkflowWaitingEventTypes(instance.workflowSteps)}
        />
      )}
    </div>
  );
}

function InstallationWorkflowNotice({ message }: { message: string }) {
  return (
    <p aria-live="polite" className="mt-4 text-xs leading-5 text-[var(--bo-muted)]">
      {message}
    </p>
  );
}
