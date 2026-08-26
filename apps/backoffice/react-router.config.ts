import type { Config } from "@react-router/dev/config";

import { assignReactRouterServerBundle } from "./workers/react-router-worker-routing";

export default {
  ssr: true,
  splitRouteModules: true,
  // Lazy discovery batches `/__manifest` paths that can belong to different server bundles.
  // Shipping the complete browser manifest keeps cross-Worker client navigation self-contained.
  routeDiscovery: { mode: "initial" },
  serverBundles({ branch }) {
    return assignReactRouterServerBundle(branch);
  },
} satisfies Config;
