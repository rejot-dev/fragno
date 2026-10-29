import { deliveryScopes } from "./delivery-scope.fixture";
import { StoryPage } from "./story-page";
import vodafonePageSource from "./vodafone.page.js?raw";

export default { title: "Pages/Production/Vodafone delivery" };

const scopes = deliveryScopes({
  workflow: "vodafone-delivery-monitor",
  routeId: "vodafone-delivery-hourly",
});

export function Tracking() {
  return <StoryPage source={vodafonePageSource} scope={scopes.tracking} />;
}

export function ChecksFailing() {
  return <StoryPage source={vodafonePageSource} scope={scopes.failing} />;
}

export function FirstCheck() {
  return <StoryPage source={vodafonePageSource} scope={scopes.firstCheck} />;
}
