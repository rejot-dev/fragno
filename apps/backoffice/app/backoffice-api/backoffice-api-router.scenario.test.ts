import { assert, describe, expect, test, vi } from "vitest";

import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";

import { createBackofficeApiClient } from "@fragno-dev/backoffice-api/v0/client";
import { BACKOFFICE_PERMISSION } from "@fragno-dev/backoffice-api/v0/shared/permissions";
import * as ts from "typescript";
import { z } from "zod";

import { toNodeHandler } from "@modelcontextprotocol/node";
import { createMcpHandler, fromJsonSchema, McpServer } from "@modelcontextprotocol/server";

const workers = vi.hoisted(() => ({
  DurableObject: class {},
  RpcTarget: class {},
  WorkerEntrypoint: class {},
}));
vi.mock("cloudflare:workers", () => workers);

import { createBackofficeSystemExecution } from "@/backoffice-runtime/context";
import { BackofficeKernel } from "@/backoffice-runtime/kernel";
import type { LocalBackofficeObjects } from "@/backoffice-runtime/local-object-factory";
import { backofficeExecutionTokenResultSchema } from "@/fragno/auth/execution-token";
import {
  defineBackofficeScenario,
  runBackofficeScenario,
  type BackofficeScenarioContext,
  type BackofficeScenarioStep,
} from "@/fragno/automation/scenario";
import { codemodeRunnerFor } from "@/fragno/codemode/codemode-object-execute";
import { runBackofficeCodemode } from "@/fragno/codemode/execute";
import { createCodemodeStaticArtifacts } from "@/fragno/codemode/static-codemode-artifacts";
import type { McpListServersOutput } from "@/fragno/runtime-tools/families/mcp-runtime";
import { createCodemodeRouteBackedRuntimeContext } from "@/fragno/runtime-tools/route-backed-runtime-context";
import { createBackofficeToolContext } from "@/fragno/runtime-tools/tool-context";
import { runtimeToolFamilies } from "@/fragno/runtime-tools/tool-families";
import { action as exchangeAction } from "@/routes/api/backoffice-execution-token";
import { createBackofficeRouterContextProvider } from "@/worker-runtime/router-context-provider.server";

import { InMemoryApiObject } from "../../workers/api.do";
import { InMemoryAppInstallationsObject } from "../../workers/app-installations.do";
import { InMemoryAppsObject } from "../../workers/apps.do";
import { InMemoryAuthObject } from "../../workers/auth.do";
import { InMemoryAutomationsObject } from "../../workers/automations.do";
import { InMemoryCodemodeObject } from "../../workers/codemode.do";
import { InMemoryFormsObject } from "../../workers/forms.do";
import { InMemoryMcpObject } from "../../workers/mcp.do";
import { InMemoryOtpObject } from "../../workers/otp.do";
import { InMemoryUploadObject } from "../../workers/upload.do";
import { backofficeApiRouter } from "./backoffice-api-router";

const scenarioObjects = {
  API: (input) => new InMemoryApiObject(input),
  APPS: (input) => new InMemoryAppsObject(input),
  APP_INSTALLATIONS: (input) => new InMemoryAppInstallationsObject(input),
  AUTH: (input) => new InMemoryAuthObject({ ...input, database: input.getAuthDatabase() }),
  AUTOMATIONS: (input) => new InMemoryAutomationsObject(input),
  CODEMODE: (input) => new InMemoryCodemodeObject(input),
  FORMS: (input) => new InMemoryFormsObject(input),
  MCP: (input) => new InMemoryMcpObject(input),
  OTP: (input) => new InMemoryOtpObject(input),
  UPLOAD: (input) => new InMemoryUploadObject(input),
} satisfies LocalBackofficeObjects;

const origin = "https://backoffice.example";
const redirectUri = "https://bookkeeping.example/api/auth/oauth2/callback/backoffice";

type Vars = {
  ownerCookie: string;
  memberCookie: string;
  ownerId: string;
  memberId: string;
  orgId: string;
  memberOrgId: string;
  ownerCredential: string;
  memberCredential: string;
  clientId: string;
  clientSecret: string;
  appId: string;
  delegatedCredential: string;
};
type Ctx = BackofficeScenarioContext<Vars>;

/** Calls the API the way both hosts do: the Hono router with this request's services. */
async function callApi(
  ctx: Ctx,
  input: { path: string; credential?: string; body?: unknown; method?: "GET" | "POST" },
): Promise<Response> {
  const headers = new Headers({ "content-type": "application/json" });
  if (input.credential !== undefined) {
    headers.set("authorization", `Bearer ${input.credential}`);
  }
  return await backofficeApiRouter.fetch(
    new Request(`${origin}${input.path}`, {
      method: input.method ?? "POST",
      headers,
      body:
        input.body === undefined
          ? undefined
          : typeof input.body === "string"
            ? input.body
            : JSON.stringify(input.body),
    }),
    { runtime: ctx.runtime.services, kernel: new BackofficeKernel(ctx.runtime.services) },
  );
}

function orgOperation(orgId: string, operationId: string) {
  return `/api/v0/scopes/org:${encodeURIComponent(orgId)}/${operationId}`;
}

async function expectOk(response: Response): Promise<unknown> {
  assert.equal(response.status, 200, await response.clone().text());
  return await response.json();
}

async function expectError(response: Response, status: number, code: string) {
  assert.equal(response.status, status, await response.clone().text());
  expect(await response.json()).toMatchObject({ error: { code, message: expect.any(String) } });
}

function authRequest(ctx: Ctx, pathname: string, cookie: string, body?: unknown) {
  return ctx.runtime.objects.auth.singleton().http.fetch(
    new Request(`${origin}/api/auth${pathname}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        origin,
        cookie,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
}

async function sessionUserId(ctx: Ctx, cookie: string) {
  const response = await authRequest(ctx, "/get-session", cookie);
  return z.object({ user: z.object({ id: z.string() }) }).parse(await response.json()).user.id;
}

/** The browser's session exchange issues the same user credential the CLI exchange does. */
async function userCredential(ctx: Ctx, cookie: string, organizationId: string) {
  const issued = await authRequest(ctx, "/backoffice-token", cookie, {
    selection: "required",
    organizationId,
  });
  assert(issued.ok, await issued.clone().text());
  const credential = /fragno-backoffice\.access_token=([^;]+)/u.exec(
    issued.headers.get("set-cookie") ?? "",
  )?.[1];
  assert(credential);
  return credential;
}

/** Plays Bookkeeping's server: authorization code + PKCE for the Backoffice resource. */
async function authorizeBookkeeping(ctx: Ctx, cookie: string): Promise<string> {
  const codeVerifier = "b".repeat(64);
  const challenge = Buffer.from(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(codeVerifier)),
  ).toString("base64url");
  const query = new URLSearchParams({
    client_id: ctx.vars.clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "openid profile email offline_access backoffice",
    state: "bookkeeping-login",
    code_challenge: challenge,
    code_challenge_method: "S256",
    resource: origin,
    prompt: "consent",
  });
  const authorization = await authRequest(ctx, `/oauth2/authorize?${query}`, cookie);
  assert.equal(authorization.status, 302, await authorization.clone().text());
  const location = authorization.headers.get("location");
  assert(location);
  const approved = await authRequest(ctx, "/oauth2/consent", cookie, {
    accept: true,
    oauth_query: new URL(location, origin).search.slice(1),
  });
  assert.equal(approved.status, 200, await approved.clone().text());
  const code = new URL(
    z.object({ url: z.string() }).parse(await approved.json()).url,
  ).searchParams.get("code");
  assert(code);
  return await requestOAuthToken(ctx, {
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    code_verifier: codeVerifier,
    resource: origin,
  });
}

async function requestOAuthToken(ctx: Ctx, body: Record<string, string>): Promise<string> {
  const response = await ctx.runtime.objects.auth.singleton().http.fetch(
    new Request(`${origin}/api/auth/oauth2/token`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        authorization: `Basic ${btoa(`${ctx.vars.clientId}:${ctx.vars.clientSecret}`)}`,
      },
      body: new URLSearchParams(body),
    }),
  );
  assert.equal(response.status, 200, await response.clone().text());
  return z.object({ access_token: z.string() }).parse(await response.json()).access_token;
}

/** Exchanges an OAuth token for Bookkeeping's app-bound credential in the owner's organization. */
async function installedAppCredential(ctx: Ctx, oauthAccessToken: string): Promise<string> {
  const request = new Request(`${origin}/api/backoffice/execution-token`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${oauthAccessToken}` },
    body: JSON.stringify({ scope: { kind: "org", orgId: ctx.vars.orgId } }),
  });
  const response = await exchangeAction({
    request,
    context: createBackofficeRouterContextProvider(request, {
      runtime: ctx.runtime.services,
      kernel: new BackofficeKernel(ctx.runtime.services),
      env: ctx.runtime.env as unknown as CloudflareEnv,
      ctx: {} as ExecutionContext,
    }),
    params: {},
    url: new URL(request.url),
    pattern: "/api/backoffice/execution-token",
  });
  assert.equal(response.status, 200, await response.clone().text());
  return backofficeExecutionTokenResultSchema.parse(await response.json()).accessToken;
}

async function runApiScenario(
  name: string,
  steps: (
    then: (label: string, assertion: (ctx: Ctx) => Promise<void>) => BackofficeScenarioStep,
  ) => BackofficeScenarioStep[],
) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "backoffice-api-"));
  try {
    await runBackofficeScenario(
      defineBackofficeScenario<Vars>({
        name,
        objects: scenarioObjects,
        options: { sqliteDataDirectory: directory },
        env: { AUTH_EMAIL_VERIFICATION_ENABLED: "false" },
        vars: () => ({
          ownerCookie: "",
          memberCookie: "",
          ownerId: "",
          memberId: "",
          orgId: "",
          memberOrgId: "",
          ownerCredential: "",
          memberCredential: "",
          clientId: "",
          clientSecret: "",
          appId: "",
          delegatedCredential: "",
        }),
        setup: ({ given }) => [given.auth.user({ id: "platform-admin", role: "admin" })],
        steps: ({ when, then }) => [
          when.auth.signUp({ email: "owner@acme.test", captureSessionCookieAs: "ownerCookie" }),
          when.auth.signUp({ email: "member@acme.test", captureSessionCookieAs: "memberCookie" }),
          then.assert(
            "the owner's organization has the member, and both hold user credentials for it",
            async (ctx) => {
              const auth = ctx.runtime.objects.auth.singleton().commands;
              ctx.vars.ownerId = await sessionUserId(ctx, ctx.vars.ownerCookie);
              ctx.vars.memberId = await sessionUserId(ctx, ctx.vars.memberCookie);
              const organizations = await auth.getAllOrganizations();
              const ownerOrganization = organizations.find(
                ({ createdBy }) => createdBy === ctx.vars.ownerId,
              );
              const memberOrganization = organizations.find(
                ({ createdBy }) => createdBy === ctx.vars.memberId,
              );
              assert(ownerOrganization && memberOrganization);
              ctx.vars.orgId = ownerOrganization.id;
              ctx.vars.memberOrgId = memberOrganization.id;
              await auth.applyScenarioFixture({
                members: [
                  { organizationId: ctx.vars.orgId, userId: ctx.vars.memberId, roles: ["member"] },
                ],
              });
              ctx.vars.ownerCredential = await userCredential(
                ctx,
                ctx.vars.ownerCookie,
                ctx.vars.orgId,
              );
              ctx.vars.memberCredential = await userCredential(
                ctx,
                ctx.vars.memberCookie,
                ctx.vars.orgId,
              );
            },
          ),
          ...steps((label, assertion) => then.assert(label, assertion)),
        ],
      }),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

describe("Backoffice API v0 SQLite scenarios", () => {
  test("MCP metadata survives refresh and listing, and Codemode types match tool results", async () => {
    const tools: {
      name: string;
      outputSchema: Record<string, unknown> | undefined;
      value: unknown;
    }[] = [
      {
        name: "object",
        outputSchema: {
          $ref: "#/$defs/Entry",
          $defs: {
            Entry: {
              type: "object",
              properties: { value: { type: "string" } },
              required: ["value"],
            },
          },
        },
        value: { value: "hello" },
      },
      {
        name: "array",
        outputSchema: {
          type: "array",
          items: { $ref: "#/$defs/Entry" },
          $defs: { Entry: { type: "number" } },
        },
        value: [1, 2],
      },
      { name: "flag", outputSchema: { type: "boolean" }, value: false },
      { name: "nil", outputSchema: { type: "null" }, value: null },
      {
        name: "tree",
        outputSchema: {
          type: "object",
          properties: {
            value: { type: "string" },
            next: { anyOf: [{ $ref: "#" }, { type: "null" }] },
          },
          required: ["value", "next"],
        },
        value: { value: "root", next: null },
      },
      { name: "untyped", outputSchema: undefined, value: "text-only" },
    ];
    const icons = [
      {
        src: "https://example.test/tool.svg",
        mimeType: "image/svg+xml",
        sizes: ["48x48"],
        theme: "dark" as const,
      },
    ];
    const handler = createMcpHandler(
      () => {
        const server = new McpServer({ name: "metadata-tools", version: "1.0.0" });
        for (const tool of tools) {
          server.registerTool(
            tool.name,
            {
              inputSchema: z.object({}),
              ...(tool.outputSchema === undefined
                ? {}
                : { outputSchema: fromJsonSchema(tool.outputSchema) }),
              icons,
              annotations: { readOnlyHint: true },
              _meta: { "example.test/category": "metadata" },
            },
            async () => ({
              content: [{ type: "text", text: JSON.stringify(tool.value) }],
              ...(tool.outputSchema === undefined ? {} : { structuredContent: tool.value }),
            }),
          );
        }
        return server;
      },
      { legacy: "reject" },
    );
    const handleRequest = toNodeHandler(handler);
    const http = createServer((request, response) => {
      void handleRequest(request, response);
    });
    await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
    const address = http.address();
    assert(address && typeof address !== "string");
    const endpointUrl = `http://127.0.0.1:${address.port}/mcp`;

    function clientFor(ctx: Ctx) {
      return createBackofficeApiClient({
        origin,
        accessToken: ctx.vars.ownerCredential,
        fetch: async (url, init) =>
          await backofficeApiRouter.fetch(new Request(url, init), {
            runtime: ctx.runtime.services,
            kernel: new BackofficeKernel(ctx.runtime.services),
          }),
      });
    }

    try {
      await runApiScenario("MCP metadata through the public API and generated Codemode", (then) => [
        then("connect and verify a real MCP server through the public client", async (ctx) => {
          const client = clientFor(ctx);
          const scope = { kind: "org" as const, orgId: ctx.vars.orgId };
          const target = { connectionId: "mcp#metadata" };
          const setup = await client.call(scope, "integrations.setup", {
            ...target,
            kind: "input",
            input: { type: "none", name: "Metadata", endpointUrl },
          });
          expect(setup).toMatchObject({ status: "ready" });
          const verified = await client.call(scope, "integrations.verify", target);
          expect(verified).toMatchObject({ checks: [{ id: "tools.list", status: "passed" }] });
          const actions = await client.call(scope, "integrations.actions", target);
          expect(actions.map(({ id }) => id)).toEqual(tools.map(({ name }) => name));
        }),
        then("cached metadata survives, and calls return every structured content", async (ctx) => {
          const execution = createBackofficeSystemExecution({ kind: "org", orgId: ctx.vars.orgId });
          const listed = await ctx.runtime.objects.mcp
            .for(execution.scope)
            .http.fetchAuthorized(new Request("https://mcp.do/api/mcp/servers"), { execution });
          assert(listed.ok, await listed.clone().text());
          const { servers } = (await listed.json()) as McpListServersOutput;
          const cached = servers.find(({ slug }) => slug === "metadata")?.cache?.tools;
          assert(cached);
          expect(cached).toHaveLength(tools.length);
          const client = clientFor(ctx);
          const scope = { kind: "org" as const, orgId: ctx.vars.orgId };
          for (const tool of tools) {
            const advertised = cached.find(({ name }) => name === tool.name);
            expect(advertised).toMatchObject({
              icons,
              annotations: { readOnlyHint: true },
              _meta: { "example.test/category": "metadata" },
            });
            expect(advertised?.outputSchema).toEqual(tool.outputSchema);
            const called = await client.call(scope, "integrations.execute", {
              connectionId: "mcp#metadata",
              actionId: tool.name,
              input: {},
            });
            expect(called).toEqual({
              isError: false,
              content: [{ type: "text", text: JSON.stringify(tool.value) }],
              structuredContent: tool.outputSchema === undefined ? null : tool.value,
            });
          }
        }),
        then(
          "generated declarations type the structured content and isolate schema references",
          async (ctx) => {
            const generated = await createCodemodeStaticArtifacts({
              objects: ctx.runtime.objects,
              execution: createBackofficeSystemExecution({ kind: "org", orgId: ctx.vars.orgId }),
            });
            const declarations = generated.artifacts["codemode/sources/mcp.d.ts"];
            assert(declarations);
            const files = new Map([
              ["/mcp.d.ts", declarations],
              [
                "/check.ts",
                `async function check() {
              const object = await mcp_metadata.object({});
              const value: string = object.structuredContent.value;
              const array: number[] = (await mcp_metadata.array({})).structuredContent;
              const flag: boolean = (await mcp_metadata.flag({})).structuredContent;
              const nil: null = (await mcp_metadata.nil({})).structuredContent;
              const tree = (await mcp_metadata.tree({})).structuredContent;
              const nested: string = tree.next?.value ?? tree.value;
              // @ts-expect-error The object schema's Entry must not collide with the array's Entry.
              const wrong: number = object.structuredContent.value;
              // @ts-expect-error outputSchema describes structuredContent, not the whole result.
              const unwrapped: string = object.value;
              const untyped = await mcp_metadata.untyped({});
              // @ts-expect-error Tools without outputSchema retain unknown result fields.
              const invented: string = untyped.structuredContent;
            }`,
              ],
            ]);
            const options: ts.CompilerOptions = {
              noEmit: true,
              strict: true,
              target: ts.ScriptTarget.ESNext,
              types: [],
            };
            const host = ts.createCompilerHost(options);
            const program = ts.createProgram([...files.keys()], options, {
              ...host,
              getSourceFile: (name, languageVersion, onError) => {
                const source = files.get(name);
                return source === undefined
                  ? host.getSourceFile(name, languageVersion, onError)
                  : ts.createSourceFile(name, source, languageVersion);
              },
            });
            expect(
              ts
                .getPreEmitDiagnostics(program)
                .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")),
            ).toEqual([]);
          },
        ),
        then("generated providers return the same result envelopes at runtime", async (ctx) => {
          const execution = createBackofficeSystemExecution({ kind: "org", orgId: ctx.vars.orgId });
          const toolContext = createBackofficeToolContext(
            createCodemodeRouteBackedRuntimeContext({
              runtime: ctx.runtime.services,
              kernel: new BackofficeKernel(ctx.runtime.services),
              execution,
              billingOrganizationId: null,
            }),
          );
          const result = await runBackofficeCodemode({
            codemode: codemodeRunnerFor(
              ctx.runtime.objects.codemode.for(execution.scope).commands,
              execution,
            ),
            toolContext,
            families: runtimeToolFamilies,
            code: `async () => ({
              object: (await mcp_metadata.object({})).structuredContent,
              array: (await mcp_metadata.array({})).structuredContent,
              flag: (await mcp_metadata.flag({})).structuredContent,
              nil: (await mcp_metadata.nil({})).structuredContent,
              tree: (await mcp_metadata.tree({})).structuredContent,
              untyped: (await mcp_metadata.untyped({})).content,
            })`,
          });
          expect(result.error).toBeUndefined();
          expect(result.result).toEqual({
            object: { value: "hello" },
            array: [1, 2],
            flag: false,
            nil: null,
            tree: { value: "root", next: null },
            untyped: [{ type: "text", text: JSON.stringify("text-only") }],
          });
        }),
      ]);
    } finally {
      await handler.close();
      await new Promise<void>((resolve, reject) =>
        http.close((error) => (error ? reject(error) : resolve())),
      );
    }
  }, 30_000);

  test("owners manage and members read their organization with user credentials", async () => {
    await runApiScenario("organization operations through the v0 API", (then) => [
      then("the served OpenAPI document describes the organization operations", async (ctx) => {
        const document = z
          .object({
            paths: z.record(z.string(), z.unknown()),
            components: z.object({ schemas: z.record(z.string(), z.unknown()) }),
          })
          .parse(
            await expectOk(await callApi(ctx, { path: "/api/v0/openapi.json", method: "GET" })),
          );
        expect(Object.keys(document.paths)).toEqual(
          expect.arrayContaining([
            "/api/v0/scopes/{scope}/org.get",
            "/api/v0/scopes/{scope}/org.update",
            "/api/v0/scopes/{scope}/org.members.list",
            "/api/v0/scopes/{scope}/org.invitations.list",
            "/api/v0/scopes/{scope}/org.invitations.create",
          ]),
        );
        expect(document.components.schemas).toHaveProperty("BackofficeApiError");
      }),
      then("the owner renames the organization and invites someone", async (ctx) => {
        const credential = ctx.vars.ownerCredential;
        expect(
          await expectOk(
            await callApi(ctx, {
              path: orgOperation(ctx.vars.orgId, "org.update"),
              credential,
              body: { name: "  Acme Books  " },
            }),
          ),
        ).toMatchObject({ organizationId: ctx.vars.orgId, name: "Acme Books" });
        expect(
          await expectOk(
            await callApi(ctx, { path: orgOperation(ctx.vars.orgId, "org.get"), credential }),
          ),
        ).toMatchObject({ organization: { name: "Acme Books" }, roles: ["owner"] });

        const invitation = z
          .object({ invitationId: z.string(), email: z.string(), url: z.string() })
          .parse(
            await expectOk(
              await callApi(ctx, {
                path: orgOperation(ctx.vars.orgId, "org.invitations.create"),
                credential,
                body: { email: " New.Person@Example.com ", roles: ["member"] },
              }),
            ),
          );
        assert.equal(invitation.email, "new.person@example.com");
        expect(
          await expectOk(
            await callApi(ctx, {
              path: orgOperation(ctx.vars.orgId, "org.invitations.list"),
              credential,
              body: {},
            }),
          ),
        ).toMatchObject({
          invitations: [{ invitationId: invitation.invitationId, url: invitation.url }],
          hasNextPage: false,
        });
      }),
      then("a member reads the organization but cannot manage it", async (ctx) => {
        const credential = ctx.vars.memberCredential;
        expect(
          await expectOk(
            await callApi(ctx, { path: orgOperation(ctx.vars.orgId, "org.get"), credential }),
          ),
        ).toMatchObject({ roles: ["member"] });
        const members = z.object({ members: z.array(z.object({ userId: z.string() })) }).parse(
          await expectOk(
            await callApi(ctx, {
              path: orgOperation(ctx.vars.orgId, "org.members.list"),
              credential,
              body: { pageSize: 10 },
            }),
          ),
        );
        expect(new Set(members.members.map(({ userId }) => userId))).toEqual(
          new Set([ctx.vars.ownerId, ctx.vars.memberId]),
        );
        await expectError(
          await callApi(ctx, {
            path: orgOperation(ctx.vars.orgId, "org.update"),
            credential,
            body: { name: "Member Books" },
          }),
          403,
          "forbidden",
        );
        await expectError(
          await callApi(ctx, {
            path: orgOperation(ctx.vars.orgId, "org.invitations.create"),
            credential,
            body: { email: "friend@example.com", roles: ["member"] },
          }),
          403,
          "forbidden",
        );
      }),
      then("a credential does not reach an organization it was not issued for", async (ctx) => {
        await expectError(
          await callApi(ctx, {
            path: orgOperation(ctx.vars.memberOrgId, "org.get"),
            credential: ctx.vars.ownerCredential,
          }),
          403,
          "forbidden",
        );
      }),
    ]);
  });

  test("bytes travel as base64 while the state tools keep raw bytes", async () => {
    await runApiScenario("byte transport through the v0 API", (then) => [
      then("the owner writes, appends to, and reads back a binary file", async (ctx) => {
        const credential = ctx.vars.ownerCredential;
        const path = "/workspace/api-bytes.bin";
        const written = await callApi(ctx, {
          path: orgOperation(ctx.vars.orgId, "state.writeFileBytes"),
          credential,
          body: { path, content: Buffer.from([0, 1, 2, 255]).toString("base64") },
        });
        assert.equal(written.status, 204, await written.clone().text());
        for (const body of [
          { path, content: "hi" },
          { path, content: Buffer.from([254]).toString("base64"), encoding: "base64" },
        ]) {
          const appended = await callApi(ctx, {
            path: orgOperation(ctx.vars.orgId, "state.appendFile"),
            credential,
            body,
          });
          assert.equal(appended.status, 204, await appended.clone().text());
        }
        const read = z.string().parse(
          await expectOk(
            await callApi(ctx, {
              path: orgOperation(ctx.vars.orgId, "state.readFileBytes"),
              credential,
              body: { path },
            }),
          ),
        );
        expect([...Buffer.from(read, "base64")]).toEqual([0, 1, 2, 255, 104, 105, 254]);
      }),
      then("malformed base64 is an invalid request", async (ctx) => {
        await expectError(
          await callApi(ctx, {
            path: orgOperation(ctx.vars.orgId, "state.writeFileBytes"),
            credential: ctx.vars.ownerCredential,
            body: { path: "/workspace/broken.bin", content: "not base64!" },
          }),
          400,
          "invalid_request",
        );
      }),
    ]);
  });

  test("requests outside the contract receive the error envelope", async () => {
    await runApiScenario("v0 API request validation", (then) => [
      then("credentials are required and verified", async (ctx) => {
        const operation = orgOperation(ctx.vars.orgId, "org.get");
        await expectError(await callApi(ctx, { path: operation }), 401, "authentication_failed");
        await expectError(
          await callApi(ctx, { path: operation, credential: "not-a-jwt" }),
          401,
          "authentication_failed",
        );
      }),
      then(
        "unknown operations, versions, and operations unavailable in the scope are not found",
        async (ctx) => {
          const credential = ctx.vars.ownerCredential;
          await expectError(
            await callApi(ctx, { path: orgOperation(ctx.vars.orgId, "org.delete"), credential }),
            404,
            "not_found",
          );
          await expectError(
            await callApi(ctx, {
              path: `/api/v9/scopes/org:${ctx.vars.orgId}/org.get`,
              credential,
            }),
            404,
            "not_found",
          );
          await expectError(
            await callApi(ctx, {
              path: `/api/v0/scopes/project:${ctx.vars.orgId}:books/org.get`,
              credential,
            }),
            404,
            "not_found",
          );
        },
      ),
      then("malformed scopes and bodies are invalid requests", async (ctx) => {
        const credential = ctx.vars.ownerCredential;
        await expectError(
          await callApi(ctx, { path: "/api/v0/scopes/org/org.get", credential }),
          400,
          "invalid_request",
        );
        for (const body of [{ name: "" }, { name: "Acme", slug: "acme" }, "not json"]) {
          await expectError(
            await callApi(ctx, {
              path: orgOperation(ctx.vars.orgId, "org.update"),
              credential,
              body,
            }),
            400,
            "invalid_request",
          );
        }
      }),
    ]);
  });

  test("domain failures report what went wrong instead of a generic failure", async () => {
    await runApiScenario("v0 API domain errors", (then) => [
      then("missing files are not found, and existing directories conflict", async (ctx) => {
        const credential = ctx.vars.ownerCredential;
        await expectError(
          await callApi(ctx, {
            path: orgOperation(ctx.vars.orgId, "state.readFile"),
            credential,
            body: { path: "/workspace/missing.txt" },
          }),
          404,
          "not_found",
        );
        const mkdir = { path: orgOperation(ctx.vars.orgId, "state.mkdir"), credential };
        assert.equal(
          (await callApi(ctx, { ...mkdir, body: { path: "/workspace/books" } })).status,
          204,
        );
        await expectError(
          await callApi(ctx, { ...mkdir, body: { path: "/workspace/books" } }),
          409,
          "conflict",
        );
      }),
      then("an event definition cannot be defined twice", async (ctx) => {
        const create = {
          path: orgOperation(ctx.vars.orgId, "events.catalog.create"),
          credential: ctx.vars.ownerCredential,
          body: { source: "books", eventType: "invoice.paid", label: "Invoice paid" },
        };
        expect(await expectOk(await callApi(ctx, create))).toMatchObject({
          source: "books",
          eventType: "invoice.paid",
        });
        await expectError(await callApi(ctx, create), 409, "conflict");
      }),
      then(
        "unknown apps are not found, and malformed cursors are invalid requests",
        async (ctx) => {
          const credential = ctx.vars.ownerCredential;
          await expectError(
            await callApi(ctx, {
              path: orgOperation(ctx.vars.orgId, "apps.uninstall"),
              credential,
              body: { appId: "no-such-app" },
            }),
            404,
            "not_found",
          );
          await expectError(
            await callApi(ctx, {
              path: orgOperation(ctx.vars.orgId, "apps.installations.list"),
              credential,
              body: { cursor: "not-a-cursor" },
            }),
            400,
            "invalid_request",
          );
        },
      ),
    ]);
  });

  test("installed apps act within their grants, and never manage the organization", async () => {
    await runApiScenario("installed-app credentials on the v0 API", (then) => [
      then(
        "an administrator provisions Bookkeeping, and the owner grants it organization read and manage",
        async (ctx) => {
          const client = await ctx.runtime.objects.auth
            .singleton()
            .commands.createAdminOAuthClient({
              administratorUserId: "platform-admin",
              name: "Bookkeeping",
              redirectUris: [redirectUri],
              scopes: ["openid", "profile", "email", "offline_access", "backoffice"],
              clientType: "confidential",
              applicationType: "web",
              clientCredentials: true,
            });
          assert(client.clientType === "confidential");
          ctx.vars.clientId = client.clientId;
          ctx.vars.clientSecret = client.clientSecret;
          const permissions = [BACKOFFICE_PERMISSION.org.read, BACKOFFICE_PERMISSION.org.manage];
          const registered = await ctx.runtime.objects.apps.singleton().commands.registerApp({
            oauthClientId: client.clientId,
            requestedPermissions: permissions,
          });
          assert(registered.ok);
          ctx.vars.appId = registered.value.appId;
          const installed = await ctx.runtime.objects.appInstallations
            .forOrg(ctx.vars.orgId)
            .commands.installApp({
              appId: ctx.vars.appId,
              grantedPermissions: permissions,
              installedByUserId: ctx.vars.ownerId,
              resourceScope: { kind: "organization" },
            });
          assert(installed.ok);
        },
      ),
      then("the owner's own credential cannot send events as Bookkeeping", async (ctx) => {
        const fire = {
          path: orgOperation(ctx.vars.orgId, "events.fire"),
          credential: ctx.vars.ownerCredential,
        };
        await expectError(
          await callApi(ctx, {
            ...fire,
            body: { eventType: "invoice.paid", source: `app:${ctx.vars.appId}` },
          }),
          403,
          "forbidden",
        );
        expect(
          await expectOk(
            await callApi(ctx, { ...fire, body: { eventType: "invoice.paid", source: "owner" } }),
          ),
        ).toMatchObject({ accepted: true, source: "owner" });
      }),
      then(
        "acting for the owner, Bookkeeping reads the organization but cannot rename it",
        async (ctx) => {
          ctx.vars.delegatedCredential = await installedAppCredential(
            ctx,
            await authorizeBookkeeping(ctx, ctx.vars.ownerCookie),
          );
          const credential = ctx.vars.delegatedCredential;
          expect(
            await expectOk(
              await callApi(ctx, { path: orgOperation(ctx.vars.orgId, "org.get"), credential }),
            ),
          ).toMatchObject({ organization: { organizationId: ctx.vars.orgId }, roles: ["owner"] });
          await expectError(
            await callApi(ctx, {
              path: orgOperation(ctx.vars.orgId, "org.update"),
              credential,
              body: { name: "Renamed by Bookkeeping" },
            }),
            403,
            "forbidden",
          );
          await expectError(
            await callApi(ctx, {
              path: orgOperation(ctx.vars.memberOrgId, "org.get"),
              credential,
            }),
            403,
            "forbidden",
          );
        },
      ),
      then(
        "acting as the installation, Bookkeeping has no user to read the organization as",
        async (ctx) => {
          const credential = await installedAppCredential(
            ctx,
            await requestOAuthToken(ctx, {
              grant_type: "client_credentials",
              scope: "backoffice",
              resource: origin,
            }),
          );
          await expectError(
            await callApi(ctx, { path: orgOperation(ctx.vars.orgId, "org.get"), credential }),
            404,
            "not_found",
          );
        },
      ),
      then("uninstalling revokes the delegated credential immediately", async (ctx) => {
        const uninstalled = await ctx.runtime.objects.appInstallations
          .forOrg(ctx.vars.orgId)
          .commands.uninstallApp({ appId: ctx.vars.appId });
        assert(uninstalled.ok);
        await expectError(
          await callApi(ctx, {
            path: orgOperation(ctx.vars.orgId, "org.get"),
            credential: ctx.vars.delegatedCredential,
          }),
          403,
          "forbidden",
        );
      }),
    ]);
  });
});
