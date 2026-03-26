import { createReson8FragmentClient } from "@fragno-dev/reson8-fragment/react";

import type { Reson8FragmentClientConfig } from "@fragno-dev/reson8-fragment";

export function createReson8Client(
  orgId: string,
  config: Omit<Reson8FragmentClientConfig, "mountRoute"> = {},
): ReturnType<typeof createReson8FragmentClient> {
  return createReson8FragmentClient({
    ...config,
    mountRoute: `/api/reson8/${orgId}`,
  });
}
