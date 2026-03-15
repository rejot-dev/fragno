import type { FragnoPublicClientConfig } from "@fragno-dev/core/client";
import { createTelegramFragmentClient } from "@fragno-dev/telegram-fragment/react";

export function createTelegramClient(
  orgId: string,
  config: FragnoPublicClientConfig = {},
): ReturnType<typeof createTelegramFragmentClient> {
  return createTelegramFragmentClient({
    ...config,
    mountRoute: `/api/telegram/${orgId}`,
  });
}
