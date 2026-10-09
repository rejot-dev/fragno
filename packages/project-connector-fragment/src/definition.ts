import type { z } from "zod";

import { defineFragment } from "@fragno-dev/core";
import { withDatabase, type HookContext, type HookFn } from "@fragno-dev/db";

import {
  createProjectConnectorClient,
  type ProjectConnectorClientConfig,
} from "./project-connector-client";
import type { projectConnectorNamedConnectionSchema } from "./project-connector-contracts";
import { projectConnectorSchema } from "./schema";

export interface ProjectConnectorConnectionReadinessChangedPayload {
  externalUserId: string;
  /** Provider service of the named connection's configuration, e.g. gmail. */
  service: string;
  connection: z.output<typeof projectConnectorNamedConnectionSchema>;
  /** Whether a confirmed account exists under this name. */
  ready: boolean;
}

/** Integrators own authentication and restrict OAuth return URLs; project keys remain server-only. */
export type ProjectConnectorFragmentConfig = ProjectConnectorClientConfig & {
  getExternalUserId: (headers: Headers) => string | null | Promise<string | null>;
  allowedReturnUrls: (url: URL) => boolean;
  /**
   * Fires when a write changes whether a named connection has a confirmed account: not ready when
   * the first request for the name starts, ready when a refresh confirms its first account. The
   * gateway does not report consent or revocation, so both are noticed only through refresh.
   */
  onConnectionReadinessChanged?: (
    payload: ProjectConnectorConnectionReadinessChangedPayload,
    context: HookContext,
  ) => Promise<void> | void;
};

type ProjectConnectorHooksMap = {
  onConnectionReadinessChanged: HookFn<ProjectConnectorConnectionReadinessChangedPayload>;
};

/** OOMOL Project Connector dependencies and scoped account persistence. */
export const projectConnectorFragmentDefinition = defineFragment<ProjectConnectorFragmentConfig>(
  "project-connector-fragment",
)
  .extend(withDatabase(projectConnectorSchema))
  .withDependencies(({ config }) => ({
    projectConnector: createProjectConnectorClient(config),
  }))
  .provideHooks<ProjectConnectorHooksMap>(({ defineHook, config }) => ({
    onConnectionReadinessChanged: defineHook(async function (payload) {
      await config.onConnectionReadinessChanged?.(payload, this);
    }),
  }))
  .build();
