import type { IntegrationConnectionDetails } from "@/fragno/runtime-tools/families/integrations/integration-implementation";

import { AutomationDetailRows } from "../automations/detail-rows";
import { DetailSection } from "./connection-display";

export function ConnectorConnectionDetails({
  details,
}: {
  details: Extract<IntegrationConnectionDetails, { kind: "connector" }>;
}) {
  return (
    <DetailSection title="Connector account">
      <AutomationDetailRows
        layout="inspector"
        rows={[
          { label: "Name", value: details.connectionName },
          { label: "Account", value: details.accountId ?? "not connected" },
          { label: "Provider config", value: details.providerConfigId },
          { label: "Project", value: details.projectId },
        ]}
      />
    </DetailSection>
  );
}
