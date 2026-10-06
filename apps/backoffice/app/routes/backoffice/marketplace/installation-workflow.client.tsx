import { Button, ButtonLink, IconButton } from "@fragno-private/design-system/button";
import { Icon } from "@fragno-private/design-system/icon";
import { use, type ReactNode } from "react";

import {
  backofficeRuntimeScopeFromResolvedScope,
  type BackofficeRoutableResolvedScope,
} from "@/backoffice-runtime/resolved-scope";
import { sendBackofficeWorkflowEvent } from "@/backoffice-ui/workflow-events.client";
import { CODEMODE_WORKFLOW } from "@/fragno/automation/engine/codemode-invocation";
import {
  MARKETPLACE_PACKAGE_INSTALL_WORKFLOW_NAME,
  marketplaceInstallationWorkflowInstanceId,
} from "@/fragno/automation/marketplace-package-install-identity";
import {
  getAutomationBrowserDatabase,
  type AutomationCollectionSource,
} from "@/fragno/automation/tanstack/browser-database";
import { useWorkflowRunRecords } from "@/routes/backoffice/automations/script-view/use-script-workflow-runs";
import { WorkflowGeneratedUi } from "@/routes/backoffice/automations/script-view/workflow-generated-ui";
import {
  currentWorkflowWaitingEventTypes,
  type AutomationWorkflowRun,
} from "@/routes/backoffice/automations/script-view/workflow-run-presentation";
import { WorkflowStepGeneratedUi } from "@/routes/backoffice/automations/script-view/workflow-step-generated-ui";

import {
  selectMarketplaceInstallationGeneratedUi,
  shouldShowMarketplaceInstallationStatus,
} from "./installation-workflow-presentation";

export function MarketplaceInstallationWorkflow({
  collectionSource,
  fallback,
  ingestionWorkflowInstanceId,
  installedFolderHref,
  onClose,
  requested,
  targetScope,
}: {
  collectionSource: AutomationCollectionSource | null;
  fallback: ReactNode;
  ingestionWorkflowInstanceId: string;
  installedFolderHref: string;
  onClose: () => void;
  requested: boolean;
  targetScope: BackofficeRoutableResolvedScope;
}) {
  if (!collectionSource) {
    return requested ? (
      <InstallationWorkflowSurface state="failed" onClose={onClose}>
        <InstallationWorkflowNotice message="Workflow synchronization is unavailable." />
      </InstallationWorkflowSurface>
    ) : (
      fallback
    );
  }

  return (
    <SynchronizedMarketplaceInstallationWorkflow
      key={ingestionWorkflowInstanceId}
      collectionSource={collectionSource}
      fallback={fallback}
      ingestionWorkflowInstanceId={ingestionWorkflowInstanceId}
      installedFolderHref={installedFolderHref}
      onClose={onClose}
      requested={requested}
      targetScope={targetScope}
    />
  );
}

function SynchronizedMarketplaceInstallationWorkflow({
  collectionSource,
  fallback,
  ingestionWorkflowInstanceId,
  installedFolderHref,
  onClose,
  requested,
  targetScope,
}: {
  collectionSource: AutomationCollectionSource;
  fallback: ReactNode;
  ingestionWorkflowInstanceId: string;
  installedFolderHref: string;
  onClose: () => void;
  requested: boolean;
  targetScope: BackofficeRoutableResolvedScope;
}) {
  const database = use(getAutomationBrowserDatabase(collectionSource));
  const collections = database.collections;
  const ingestionRecords = useWorkflowRunRecords({
    collections,
    selector: {
      type: "instance",
      workflowName: MARKETPLACE_PACKAGE_INSTALL_WORKFLOW_NAME,
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
  const ingestionInProgress = ingestion ? isWorkflowInProgress(ingestion.status) : false;
  const showInstallationStatus = shouldShowMarketplaceInstallationStatus({
    requested,
    synchronizationFailed: synchronizationError !== null,
    ingestionStatus: ingestion?.status ?? null,
    installerStatus: installer?.status ?? null,
  });

  if (synchronizationError) {
    return (
      <InstallationWorkflowSurface state="failed" onClose={onClose}>
        <InstallationWorkflowNotice message={synchronizationError} />
      </InstallationWorkflowSurface>
    );
  }
  if (!ingestion) {
    return showInstallationStatus ? (
      <InstallationWorkflowSurface state="running" onClose={null}>
        <InstallationWorkflowNotice message="Preparing installation workflow…" />
      </InstallationWorkflowSurface>
    ) : (
      fallback
    );
  }
  if (ingestion.status === "errored" || ingestion.status === "terminated") {
    return (
      <InstallationWorkflowSurface state="failed" onClose={onClose}>
        <InstallationWorkflowNotice message={marketplaceInstallationFailureMessage(ingestion)} />
      </InstallationWorkflowSurface>
    );
  }
  if (!installer) {
    if (ingestion.status === "complete") {
      return requested ? (
        <InstallationWorkflowSurface state="complete" onClose={onClose}>
          <InstallationWorkflowNotice message="Installation complete." />
          <ButtonLink to={installedFolderHref} variant="secondary" className="mt-4">
            Open folder
          </ButtonLink>
        </InstallationWorkflowSurface>
      ) : (
        fallback
      );
    }
    return showInstallationStatus ? (
      <InstallationWorkflowSurface state="running" onClose={null}>
        <InstallationWorkflowNotice message="Preparing installation workflow…" />
      </InstallationWorkflowSurface>
    ) : (
      fallback
    );
  }
  const generatedUi = selectMarketplaceInstallationGeneratedUi(installer);
  if (!showInstallationStatus) {
    return fallback;
  }

  return (
    <InstallationWorkflowSurface
      state={
        ingestion.status === "complete"
          ? "complete"
          : installer.status === "errored" || installer.status === "terminated"
            ? "failed"
            : "running"
      }
      onClose={
        ingestion.status === "complete" ||
        installer.status === "errored" ||
        installer.status === "terminated"
          ? onClose
          : null
      }
    >
      {ingestionInProgress && installer.status === "complete" && !generatedUi ? (
        <InstallationWorkflowNotice message="Finalizing installation…" />
      ) : (
        <MarketplaceInstallerGeneratedUi
          collectionSource={collectionSource}
          instance={installer}
          targetScope={targetScope}
        />
      )}
      {ingestion.status === "complete" ? (
        <ButtonLink to={installedFolderHref} variant="secondary" className="mt-4">
          Open folder
        </ButtonLink>
      ) : null}
    </InstallationWorkflowSurface>
  );
}

export function MarketplaceInstallerGeneratedUi({
  collectionSource,
  instance,
  targetScope,
}: {
  collectionSource: AutomationCollectionSource;
  instance: AutomationWorkflowRun;
  targetScope: BackofficeRoutableResolvedScope;
}) {
  const coordinatorRuntimeScope = backofficeRuntimeScopeFromResolvedScope(
    collectionSource.resolvedScope,
  );
  const generatedUi = selectMarketplaceInstallationGeneratedUi(instance);
  if (instance.status === "complete" && generatedUi?.kind !== "output") {
    return <InstallationWorkflowNotice message="Installation complete." />;
  }
  if (instance.status === "errored" || instance.status === "terminated") {
    return <InstallationWorkflowNotice message={marketplaceInstallationFailureMessage(instance)} />;
  }
  if (!generatedUi) {
    return <InstallationWorkflowNotice message="Installer is running…" />;
  }

  return generatedUi.kind === "output" ? (
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
      workflowEventSender={async ({ eventId, workflowName, instanceId, eventType, payload }) => {
        await sendBackofficeWorkflowEvent({
          eventId,
          reference: { scope: coordinatorRuntimeScope, workflowName, instanceId },
          eventType,
          payload,
        });
      }}
      workflowName={instance.workflowName}
      workflowInstanceId={instance.instanceId}
      waitingEventTypes={currentWorkflowWaitingEventTypes(instance.workflowSteps)}
    />
  );
}

function InstallationWorkflowSurface({
  children,
  state,
  onClose,
}: {
  children: ReactNode;
  state: "running" | "failed" | "complete";
  onClose: (() => void) | null;
}) {
  const status =
    state === "running"
      ? {
          label: "Running",
          title: "Installation in progress",
          className:
            "bg-[var(--bo-waiting-bg)] text-[var(--bo-waiting)] shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--bo-waiting)_35%,transparent)]",
        }
      : state === "failed"
        ? {
            label: "Failed",
            title: "Installation needs attention",
            className:
              "bg-[var(--bo-failed-bg)] text-[var(--bo-failed)] shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--bo-failed)_35%,transparent)]",
          }
        : {
            label: "Complete",
            title: "Installation complete",
            className:
              "bg-[var(--bo-live-bg)] text-[var(--bo-live)] shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--bo-live)_35%,transparent)]",
          };

  return (
    <section className="min-w-0">
      <div className="mb-5 flex items-center justify-between gap-4 border-b border-[color:var(--bo-border)] pb-4">
        <div>
          <p className="text-[9px] font-semibold tracking-[0.16em] text-[var(--bo-muted-2)] uppercase">
            Installation
          </p>
          <h3 className="mt-1 text-lg font-semibold tracking-tight text-balance text-[var(--bo-fg)]">
            {status.title}
          </h3>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <span
            className={`inline-flex min-h-6 items-center px-2 text-[9px] tracking-[0.12em] uppercase ${status.className}`}
          >
            {status.label}
          </span>
          {onClose ? (
            <IconButton label="Close installation result" title="Close" onClick={onClose}>
              <Icon name="x" className="size-4" />
            </IconButton>
          ) : null}
        </div>
      </div>
      {children}
      {state === "failed" && onClose ? (
        <Button type="button" variant="secondary" onClick={onClose} className="mt-4">
          Back to install form
        </Button>
      ) : null}
    </section>
  );
}

function InstallationWorkflowNotice({ message }: { message: string }) {
  return (
    <p
      aria-live="polite"
      className="text-sm leading-6 text-pretty break-words whitespace-pre-wrap text-[var(--bo-muted)]"
    >
      {message}
    </p>
  );
}

function marketplaceInstallationFailureMessage(instance: AutomationWorkflowRun): string {
  return instance.errorMessage ?? instance.errorName ?? `Installation ${instance.status}.`;
}

function isWorkflowInProgress(status: AutomationWorkflowRun["status"]): boolean {
  return status === "active" || status === "paused" || status === "waiting";
}
