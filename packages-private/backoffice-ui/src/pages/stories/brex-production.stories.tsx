import { bankScopes } from "./bank-scope.fixture";
import brexPageSource from "./brex.page.js?raw";
import { StoryPage } from "./story-page";

export default { title: "Pages/Production/Brex finance" };

const scopes = bankScopes({
  source: "brex",
  healthKey: "brex:sync-health",
  routeId: "brex-sync-hourly",
  workerInstanceId: "brex-sync-worker-v1",
});

export function Synced() {
  return <StoryPage source={brexPageSource} scope={scopes.synced} />;
}

export function SyncFailing() {
  return <StoryPage source={brexPageSource} scope={scopes.failing} />;
}

export function FirstSync() {
  return <StoryPage source={brexPageSource} scope={scopes.firstSync} />;
}
