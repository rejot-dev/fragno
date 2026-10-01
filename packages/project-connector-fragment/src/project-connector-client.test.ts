import { expect, test } from "vitest";

import type { ProjectApi } from "@oomol-lab/connector";

import { createProjectConnectorClient } from "./project-connector-client";

function createThrowingProjectConnectorSdk(error: Error) {
  return {
    connect: {
      oauth: async () => {
        throw error;
      },
    },
    getConnectionRequest: async () => {
      throw error;
    },
    getUserProfile: async () => {
      throw error;
    },
    executeRaw: async () => {
      throw error;
    },
  } satisfies Pick<ProjectApi, "getConnectionRequest" | "getUserProfile" | "executeRaw"> & {
    connect: Pick<ProjectApi["connect"], "oauth">;
  };
}

const clientConfig = {
  baseUrl: "https://connector.example/v1",
  apiKey: "test-project-key",
};

test("unexpected SDK exceptions retain their identity and diagnostics", async () => {
  const unexpectedFailure = new Error("SDK invariant violated");
  const client = createProjectConnectorClient(clientConfig, () =>
    createThrowingProjectConnectorSdk(unexpectedFailure),
  );

  await expect(client.check()).rejects.toBe(unexpectedFailure);
  await expect(
    client.connect("user-1", {
      service: "gmail",
      connectionName: "work",
      returnUri: "https://backoffice.example/api/connector/user%3Auser-1/oauth/callback",
    }),
  ).rejects.toBe(unexpectedFailure);
});
