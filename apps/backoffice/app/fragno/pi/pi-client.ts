import { createPiFragmentClient } from "@fragno-dev/pi-harness/react";

export function createPiClient(orgId: string): ReturnType<typeof createPiFragmentClient> {
  return createPiFragmentClient({
    mountRoute: `/api/pi/${orgId}`,
    debugActiveSession: true,
  });
}
