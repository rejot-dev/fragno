import { defineFragment } from "@fragno-dev/core";

import { createReson8Client } from "./lib/reson8-client";

export interface Reson8FragmentConfig {
  /**
   * API key used when no Authorization header is forwarded by the incoming request.
   */
  apiKey?: string;
  /**
   * Optional default Authorization header value, e.g. `Bearer <token>`.
   * This takes precedence over `apiKey` when no request Authorization header is present.
   */
  defaultAuthorization?: string;
  /**
   * Override the Reson8 API base URL.
   *
   * @default "https://api.reson8.dev/v1"
   */
  baseUrl?: string;
  /**
   * Optional server-side fetch implementation for tests or custom runtimes.
   */
  fetch?: typeof globalThis.fetch;
}

export const reson8FragmentDefinition = defineFragment<Reson8FragmentConfig>("reson8")
  .withDependencies(({ config }) => ({
    reson8: createReson8Client(config),
  }))
  .build();
