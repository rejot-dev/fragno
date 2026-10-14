import type { IntegrationConnectionDetails } from "@/fragno/runtime-tools/families/integrations/integration-implementation";

import { AutomationDetailRows } from "../automations/detail-rows";
import { DetailSection, describeAuthStatus, formatSourceTimestamp } from "./connection-display";

export function ApiConnectionDetails({
  details: { connection, authStatus },
}: {
  details: Extract<IntegrationConnectionDetails, { kind: "api" }>;
}) {
  return (
    <DetailSection title="API connection">
      {connection === null ? (
        <p className="px-3 py-2.5 text-xs text-[var(--bo-muted)]">
          No API connection is stored at this address.
        </p>
      ) : (
        <AutomationDetailRows
          layout="inspector"
          rows={[
            { label: "Base URL", value: connection.baseUrl },
            { label: "Auth", value: describeAuthStatus(authStatus) },
            { label: "Status", value: connection.status },
            { label: "Created", value: formatSourceTimestamp(connection.createdAt) },
            { label: "Updated", value: formatSourceTimestamp(connection.updatedAt) },
          ]}
        />
      )}
    </DetailSection>
  );
}
