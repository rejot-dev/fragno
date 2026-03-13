import { createTelegramFragmentClient } from "@fragno-dev/telegram-fragment/react";
import type { FragnoPublicClientConfig } from "@fragno-dev/core/client";

export function createTelegramClient(
  orgId: string,
  config: FragnoPublicClientConfig = {},
): ReturnType<typeof createTelegramFragmentClient> {
  return createTelegramFragmentClient({
    ...config,
    mountRoute: `/api/telegram/${orgId}`,
  });
}
