import { createPiFragmentClient } from "@fragno-dev/pi-harness/react";
import { useMemo } from "react";

import type { BackofficeContextScope } from "@/backoffice-runtime/context";
import { scopedPublicMountPath } from "@/fragno/scoped-public-fragment-routes";

export function usePiClient(
  scope: BackofficeContextScope,
): ReturnType<typeof createPiFragmentClient> {
  const mountRoute = scopedPublicMountPath({ publicPrefix: "/api/pi", scope });
  return useMemo(
    () =>
      createPiFragmentClient({
        mountRoute,
        debugActiveSession: true,
      }),
    [mountRoute],
  );
}
