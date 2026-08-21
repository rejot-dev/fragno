import { AutomationSwimlaneDashboard } from "./dashboard";

export { loader, shouldRevalidate } from "./dashboard";

export default function BackofficeAutomationEventsMap() {
  return <AutomationSwimlaneDashboard view="events" />;
}
