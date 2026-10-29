import type { LofiSqliteClient } from "@fragno-dev/lofi/sqlite";
import { ClientOnly } from "@fragno-private/design-system/client-only";
import { BackofficeDownloadState } from "@fragno-private/design-system/download-state";
import { BackofficeSystemState } from "@fragno-private/design-system/system-state";
import { Fragment, Suspense, use, type ReactNode } from "react";

import { useCurrentBackofficeContext } from "@/components/backoffice/current-context";
import { getAutomationReplica } from "@/fragno/automation/lofi/replica";
import { describeAutomationReplicaSource } from "@/fragno/automation/lofi/replica-source";
import { LofiReplicaGate } from "@/fragno/lofi/replica-gate";

const DOWNLOAD_TITLE = "Downloading automation activity…";

/**
 * What a dashboard tab shows over the current scope's Automations replica, once the replica has
 * downloaded. The replica lives in the browser, so the tab renders nothing on the server.
 */
export function DashboardReplica({
  children,
}: {
  children: (replica: LofiSqliteClient) => ReactNode;
}) {
  // The replica's database opens before its download reports progress.
  const loading = <BackofficeDownloadState title={DOWNLOAD_TITLE} fraction={null} error={null} />;
  return (
    <ClientOnly fallback={loading}>
      <Suspense fallback={loading}>
        <DashboardReplicaClient>{children}</DashboardReplicaClient>
      </Suspense>
    </ClientOnly>
  );
}

function DashboardReplicaClient({
  children,
}: {
  children: (replica: LofiSqliteClient) => ReactNode;
}) {
  const { automationReplicaSource } = useCurrentBackofficeContext();
  if (automationReplicaSource.status === "unavailable") {
    return (
      <BackofficeSystemState
        tone="error"
        label="Unavailable"
        title="Automation activity could not be synchronized."
        description={automationReplicaSource.message}
      />
    );
  }
  const source = automationReplicaSource.source;
  const replica = use(getAutomationReplica(source));
  return (
    <LofiReplicaGate replica={replica} title={DOWNLOAD_TITLE}>
      {/* Another scope's replica starts the tab over rather than carrying its state across. */}
      <Fragment key={describeAutomationReplicaSource(source).resourceKey}>
        {children(replica)}
      </Fragment>
    </LofiReplicaGate>
  );
}
