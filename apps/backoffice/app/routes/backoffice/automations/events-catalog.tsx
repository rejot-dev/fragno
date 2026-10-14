import { AutomationSwimlanes } from "./orchestration";

export { loader, shouldRevalidate } from "./orchestration";

export default function BackofficeAutomationEventsMap() {
  return <AutomationSwimlanes view="events" />;
}
