import { integrationBasePath } from "../../integrations/connection-paths";
import { defineIntegrationConnection } from "../../integrations/connection.server";
import { fetchTelegramConfig } from "./data";

export const telegramConnection = defineIntegrationConnection({
  scopeKinds: ["system", "org", "user", "app", "project"],
  basePath: (scope) => integrationBasePath(scope, "telegram"),
  loadConfiguration: ({ context, scope }) => fetchTelegramConfig(context, scope),
  isConfigured: ({ configState }) => configState?.configured === true,
});
