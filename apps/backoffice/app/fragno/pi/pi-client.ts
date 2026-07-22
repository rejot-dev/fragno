import { createPiFragmentClient } from "@fragno-dev/pi-harness/react";

import type { BackofficeContextScope } from "@/backoffice-runtime/context";
import { scopedPublicMountPath } from "@/fragno/scoped-public-fragment-routes";

export function createPiClient(
  scope: BackofficeContextScope,
): ReturnType<typeof createPiFragmentClient> {
  return createPiFragmentClient({
    mountRoute: scopedPublicMountPath({ publicPrefix: "/api/pi", scope }),
    debugActiveSession: true,
  });
}
