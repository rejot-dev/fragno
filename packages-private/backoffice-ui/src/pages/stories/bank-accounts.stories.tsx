import bankAccountsSource from "@backoffice-static/skills/building-pages/examples/bank-accounts.page.js?raw";

import { bankScopes } from "./bank-scope.fixture";
import { StoryPage } from "./story-page";

export default { title: "Pages/Examples/Bank accounts" };

const scopes = bankScopes({
  source: "bank",
  healthKey: "bank:sync-health",
  routeId: "bank-sync-hourly",
  workerInstanceId: "bank-sync-worker",
});

export function Synced() {
  return <StoryPage source={bankAccountsSource} scope={scopes.synced} />;
}

export function SyncFailing() {
  return <StoryPage source={bankAccountsSource} scope={scopes.failing} />;
}

export function FirstSync() {
  return <StoryPage source={bankAccountsSource} scope={scopes.firstSync} />;
}
