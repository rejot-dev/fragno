import homePageSource from "@backoffice-static/skills/building-pages/examples/home.page.js?raw";

import { BUSY_SCOPE, EMPTY_SCOPE } from "./backoffice-scope.fixture";
import { StoryPage } from "./story-page";

export default { title: "Pages/Home page" };

export function Busy() {
  return <StoryPage source={homePageSource} scope={BUSY_SCOPE} />;
}

export function Empty() {
  return <StoryPage source={homePageSource} scope={EMPTY_SCOPE} />;
}
