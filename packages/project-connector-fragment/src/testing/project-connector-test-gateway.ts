import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { z } from "zod";

const connectSchema = z.object({
  userId: z.string(),
  service: z.string().default("gmail"),
  providerConfigId: z.string().default("gmail-provider"),
  alias: z.string(),
  returnUri: z.string(),
});
const actionSchema = z.object({
  userId: z.string(),
  providerConfigId: z.string(),
  connectedAccountId: z.string(),
  input: z.record(z.string(), z.unknown()),
});

type ConnectionRequest = {
  id: string;
  projectId: string;
  providerConfigId: string;
  externalUserId: string;
  service: string;
  alias: string;
  authorizationUrl: string;
  expiresAt: string;
  status: "initiated" | "connected" | "failed" | "expired";
  connectedAccountId: string | null;
  errorCode: string | null;
  errorMessage: string | null;
};

/** Stateful local SaaS gateway: real HTTP, OAuth completion, account ownership, and action failures. */
export async function startProjectConnectorTestGateway() {
  const requests = new Map<string, ConnectionRequest>();
  const links: z.infer<typeof connectSchema>[] = [];
  const accounts = new Map<string, ConnectionRequest>();
  const executions: {
    externalUserId: string;
    providerConfigId: string;
    connectedAccountId: string;
    input: Record<string, unknown>;
  }[] = [];
  const control: {
    actionFailure: "flat" | "envelope" | "text" | "malformed" | null;
    profileUserId: string | null;
    requestReads: number;
  } = {
    actionFailure: null,
    profileUserId: null,
    requestReads: 0,
  };
  let origin = "";
  async function handleRequest(req: IncomingMessage, res: ServerResponse) {
    function json(data: unknown, status = 200) {
      res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(data));
    }
    function failure(code: string, status: number) {
      json({ errorCode: code, errorMessage: code }, status);
    }
    if (req.headers.authorization !== "Bearer test-project-key") {
      res.writeHead(401).end("Unauthorized");
      return;
    }
    const url = new URL(req.url ?? "/", "http://localhost");
    const segments = url.pathname.split("/");
    const route = segments[3];
    const id = decodeURIComponent(segments[4] ?? "");
    let payload: unknown = null;
    if (req.method === "POST") {
      req.setEncoding("utf8");
      const chunks: string[] = [];
      for await (const chunk of req) {
        chunks.push(chunk as string);
      }
      payload = JSON.parse(chunks.join(""));
    }
    if (route === "connected-accounts" && id === "link") {
      const input = connectSchema.parse(payload);
      links.push(input);
      const requestId = `request-${requests.size + 1}`;
      const connection: ConnectionRequest = {
        id: requestId,
        projectId: "project-1",
        providerConfigId: input.providerConfigId,
        externalUserId: input.userId,
        service: input.service,
        alias: input.alias,
        authorizationUrl: `${origin}/authorize/${requestId}`,
        expiresAt: "2030-01-01T00:00:00.000Z",
        status: "initiated",
        connectedAccountId: null,
        errorCode: null,
        errorMessage: null,
      };
      requests.set(requestId, connection);
      json({ success: true, data: connection });
      return;
    }
    if (route === "connection-requests") {
      control.requestReads += 1;
      const connection = requests.get(id);
      if (!connection) {
        failure("connection_request_not_found", 404);
        return;
      }
      json({ success: true, data: connection });
      return;
    }
    if (route === "connected-accounts" && segments[5] === "profile") {
      const account = accounts.get(id);
      if (!account) {
        failure("connected_account_not_found", 404);
        return;
      }
      json({
        success: true,
        data: {
          connectedAccountId: id,
          externalUserId: control.profileUserId ?? account.externalUserId,
          service: account.service,
          profile: {
            id: "google-user",
            kind: "user",
            username: null,
            displayName: "Test Gmail User",
            avatarUrl: null,
            email: "gmail-user@example.test",
            metadata: {},
          },
          fetchedAt: 1234,
        },
      });
      return;
    }
    if (route === "actions") {
      const input = actionSchema.parse(payload);
      const account = accounts.get(input.connectedAccountId);
      if (
        !account ||
        input.userId !== account.externalUserId ||
        input.providerConfigId !== account.providerConfigId
      ) {
        failure("connected_account_not_found", 404);
        return;
      }
      executions.push({
        externalUserId: input.userId,
        providerConfigId: input.providerConfigId,
        connectedAccountId: input.connectedAccountId,
        input: input.input,
      });
      if (control.actionFailure === "flat") {
        failure("credential_expired", 403);
        return;
      }
      if (control.actionFailure === "envelope") {
        json({ success: false, errorCode: "rate_limited", message: "Rate limit" }, 429);
        return;
      }
      if (control.actionFailure === "text") {
        res.writeHead(502).end("test-project-key upstream HTML error");
        return;
      }
      if (control.actionFailure === "malformed") {
        json({ success: true, data: { result: "wrong" } });
        return;
      }
      json({
        success: true,
        data: {
          executionId: `execution-${executions.length}`,
          actionId: id,
          output: { threads: [], query: input.input["query"] },
        },
      });
      return;
    }
    failure("not_found", 404);
  }
  const server = createServer((req, res) => {
    void handleRequest(req, res).catch(() => {
      res.writeHead(500).end("Test connector gateway request failed");
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    baseUrl: `${origin}/v1`,
    links,
    requests,
    accounts,
    executions,
    control,
    authorize(requestId: string, accountId: string) {
      const connection = requests.get(requestId);
      if (!connection) {
        throw new Error("Test connector request does not exist");
      }
      connection.status = "connected";
      connection.connectedAccountId = accountId;
      accounts.set(accountId, { ...connection });
    },
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        });
      });
    },
  };
}
