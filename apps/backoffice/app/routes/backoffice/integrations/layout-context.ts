import type { LofiSqliteClient } from "@fragno-dev/lofi/sqlite";

import type { BackofficeScopeSelection } from "@/backoffice-runtime/resolved-scope";

export type IntegrationsLayoutContext = {
  selectedScope: BackofficeScopeSelection;
  /** The scope's Automations replica, which connections and their events are read from. */
  replica: LofiSqliteClient;
};
