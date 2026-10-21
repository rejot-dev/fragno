import { useOutletContext } from "react-router";

import { PiAgentsWorkspace } from "./agents-workspace";
import type { PiLayoutContext } from "./shared";

export default function BackofficeOrganizationPiAgentsLayout() {
  const layoutContext = useOutletContext<PiLayoutContext>();
  return <PiAgentsWorkspace layoutContext={layoutContext} />;
}
