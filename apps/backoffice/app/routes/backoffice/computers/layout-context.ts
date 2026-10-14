import type { BackofficeRoutableRouteScope } from "@/backoffice-runtime/route-scope";

import type { SandboxView } from "./sandbox-model";

export type ComputersLayoutContext = {
  routeScope: BackofficeRoutableRouteScope;
};

export type SandboxesLayoutContext = {
  routeScope: BackofficeRoutableRouteScope;
  sandboxes: SandboxView[];
};
