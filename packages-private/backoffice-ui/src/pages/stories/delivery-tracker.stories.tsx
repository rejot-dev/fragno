import deliveryTrackerSource from "@backoffice-static/skills/building-pages/examples/delivery-tracker.page.js?raw";

import { deliveryScopes } from "./delivery-scope.fixture";
import { StoryPage } from "./story-page";

export default { title: "Pages/Examples/Delivery tracker" };

const scopes = deliveryScopes({
  workflow: "order-delivery-monitor",
  routeId: "order-delivery-hourly",
});

export function Tracking() {
  return <StoryPage source={deliveryTrackerSource} scope={scopes.tracking} />;
}

export function ChecksFailing() {
  return <StoryPage source={deliveryTrackerSource} scope={scopes.failing} />;
}

export function FirstCheck() {
  return <StoryPage source={deliveryTrackerSource} scope={scopes.firstCheck} />;
}
