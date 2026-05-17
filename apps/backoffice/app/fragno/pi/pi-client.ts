import { createPiFragmentClient } from "@fragno-dev/pi-fragment/react";

export function createOrgPiClient(orgId: string): ReturnType<typeof createPiFragmentClient> {
  return createPiFragmentClient({
    mountRoute: `/api/pi/${orgId}`,
    debugActiveSession: true,
  });
}
