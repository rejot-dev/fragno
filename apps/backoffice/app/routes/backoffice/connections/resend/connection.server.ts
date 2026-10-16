import { integrationBasePath } from "../../integrations/connection-paths";
import { defineIntegrationConnection } from "../../integrations/connection.server";
import { fetchResendConfig } from "./data";

export const resendConnection = defineIntegrationConnection({
  scopeKinds: ["org", "system"],
  basePath: (scope) => integrationBasePath(scope, "resend"),
  loadConfiguration: ({ context, scope }) => fetchResendConfig(context, scope),
  isConfigured: ({ configState }) => configState?.configured === true,
});
