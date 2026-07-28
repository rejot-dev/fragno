import { Outlet, useOutletContext } from "react-router";

import type { MarketplaceLayoutContext } from "./layout-context";

export default function BackofficeMarketplaceView() {
  const context = useOutletContext<MarketplaceLayoutContext>();
  return <Outlet context={context} />;
}
