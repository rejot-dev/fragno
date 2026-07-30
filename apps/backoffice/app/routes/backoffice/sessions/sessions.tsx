import { useOutletContext } from "react-router";

import { PiSessionsWorkspace } from "./session-workspace";
import type { PiLayoutContext } from "./shared";

export { createSessionAction as action } from "./create-session-action";

export default function BackofficeOrganisationPiSessionsLayout() {
  const layoutContext = useOutletContext<PiLayoutContext>();
  return <PiSessionsWorkspace layoutContext={layoutContext} />;
}
