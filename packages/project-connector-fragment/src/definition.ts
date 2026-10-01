import { defineFragment } from "@fragno-dev/core";
import { withDatabase } from "@fragno-dev/db";

import {
  createProjectConnectorClient,
  type ProjectConnectorClientConfig,
} from "./project-connector-client";
import { projectConnectorSchema } from "./schema";

/** Integrators own authentication and restrict OAuth return URLs; project keys remain server-only. */
export type ProjectConnectorFragmentConfig = ProjectConnectorClientConfig & {
  getExternalUserId: (headers: Headers) => string | null | Promise<string | null>;
  allowedReturnUrls: (url: URL) => boolean;
};

/** OOMOL Project Connector dependencies and scoped account persistence. */
export const projectConnectorFragmentDefinition = defineFragment<ProjectConnectorFragmentConfig>(
  "project-connector-fragment",
)
  .extend(withDatabase(projectConnectorSchema))
  .withDependencies(({ config }) => ({
    projectConnector: createProjectConnectorClient(config),
  }))
  .build();
