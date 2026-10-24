# @fragno-dev/backoffice-api

The contract for the Backoffice HTTP API: its operations, their zod input and output schemas, and an
OpenAPI description generated from them. Backoffice implements this contract; other applications
import it to call Backoffice with checked types.

## Versions

Each version is a separate module (`@fragno-dev/backoffice-api/v0`) served under `/api/<version>`.
`v0` is unstable: its operations and schemas may change without a new version.

Everything a version's requests and responses contain lives inside that version's directory, so a
new version starts as a copy and the old one stays frozen:

- `v0/<family>` (`@fragno-dev/backoffice-api/v0/organization`, …): one family's operations and the
  records they use.
- `v0/shared/<module>` (`@fragno-dev/backoffice-api/v0/shared/scope`, …): schemas used across
  families, such as scopes, permissions, timestamps, and page inputs.

`api`, `errors`, and `openapi` are version-independent: how any version is defined, how errors are
reported, and how a version is described as OpenAPI.

## Lazy schemas

Every module-level schema except an operation's `z.void()` is a `z.lazy(() => …)`, so importing the
contract builds no schemas until they are used. Backoffice imports it on every Durable Object
activation, and a request uses only a few of its schemas. Parse, infer, describe, and convert them
like any schema. For object- or enum-specific members such as `.extend`, `.shape`, `.pick`, or
`.options`, use the built schema, `schema._zod.innerType`, which is built once and shared;
`unwrap()` builds a new copy on every call. Keep a schema lazy when you derive from it at module
level: `z.lazy(() => schema._zod.innerType.extend({ … }))`. Put a schema's `.meta({ id })` on the
lazy, not inside it, so references to the schema resolve to that id.

## Calling an operation

Every operation is `POST /api/<version>/scopes/<scope>/<operationId>` with a bearer token and the
operation's input as the JSON body. Operations whose input is `z.void()` take no body. The scope is
`system`, `user:<userId>`, `org:<orgId>`, `app:<owner>:<appId>`, or `project:<owner>:<projectId>`,
with each id URI-encoded. An app's `<owner>` is the organization or user scope that installed it; a
project's may also be an app scope, e.g. `project:app:org:<orgId>:<appId>:<projectId>`. Owning a
scope does not reach into owned apps: an organization's credential cannot act in its apps'
workspaces, and an event emitted in an app's workspace only reaches that workspace's routes. An
operation that is not available to the credential in that scope, such as an organization operation
in a project scope, answers `404`. Each operation lists the permissions it requires in the request's
scope (`permissions`, from `v0/shared/permissions`); the OpenAPI document repeats them as the roles
of the operation's `bearer` security requirement. A credential lacking one answers `403`.

Successful calls return `200` with the operation's output, or `204` when the output is `z.void()`.
Bytes travel as standard base64 strings (`v0/shared/bytes`). This is temporary: dedicated file
transfer APIs will replace it for large files. Errors return `{ error: { code, message } }`
(`@fragno-dev/backoffice-api/errors`), where the code determines the status: `invalid_request` 400,
`authentication_failed` 401, `forbidden` 403, `not_found` 404, `conflict` 409, and
`operation_failed` 422. `not_found` also covers things the request names, such as an unknown id, and
`operation_failed` is reserved for failures no other code describes.

## Watching an agent

`pi.agent.watch` follows an agent's conversation and queue live over a WebSocket, which is not an
operation: open it with `GET /api/<version>/scopes/<scope>/pi.agent.watch?agentName=<agentName>`, an
upgrade, and a bearer token. It needs `pi.read` in the scope. Since browsers cannot send a
WebSocket's headers, it is for servers:

```ts
import { applyImmutable, type Op } from "@earendil-works/chord/delta";
import type { ConversationView } from "@earendil-works/pi-durable";
import { PI_AGENT_WATCH_REFUSED, type PiAgentWatchFrame } from "@fragno-dev/backoffice-api/v0/pi";

const socket = new WebSocket(
  `${origin}/api/v0/scopes/org:${orgId}/pi.agent.watch?agentName=assistant`,
  {
    headers: { authorization: `Bearer ${token}` },
  },
);
let view: ConversationView;
socket.addEventListener("message", ({ data }) => {
  const frame = JSON.parse(data) as PiAgentWatchFrame<ConversationView, Op>;
  if (frame.type === "view") view = frame.view;
  if (frame.type === "ops") view = applyImmutable(view, frame.ops);
});
socket.addEventListener("close", ({ code, reason }) => {
  if (code >= PI_AGENT_WATCH_REFUSED) throw new Error(reason);
  // Otherwise reconnect, which starts again from a whole view.
});
```

The socket sends a `queue` frame, then a `view` frame with the whole conversation view, then an
`ops` frame with each commit's changes, including partial answers while the agent generates, and a
`queue` frame whenever the queue changes (`PiAgentWatchFrame`). A request that cannot upgrade, such
as one with an invalid credential, answers with an error like an operation's. A missing permission,
an agent that has had no turns, and a name no agent has close the socket with
`PI_AGENT_WATCH_REFUSED` and the reason. The credential is only checked on connecting, so an open
socket outlives it.

## Client

```ts
import { createBackofficeApiClient } from "@fragno-dev/backoffice-api/v0/client";

const backoffice = createBackofficeApiClient({
  origin: "https://backoffice.example",
  accessToken,
  fetch,
});
const receipt = await backoffice.call({ kind: "org", orgId }, "events.fire", {
  eventType: "bookkeeping.connection.tested",
  payload: { message: "Hello" },
});
```

`call` checks the operation id and input at compile time and parses the output with the operation's
schema. Error responses reject with `BackofficeApiRequestError`, whose `code` is the error
envelope's code, or `null` when the response was not an API error (for example a server failure), so
the outcome is unknown. Network failures reject with `BackofficeApiUnreachableError`, whose outcome
is also unknown. Anything else, such as a success body that does not match the client's contract, is
a bug and rejects unchanged.

## Projects

### Listing

`projects.list` lists projects in the selected organization or personal scope. It requires a user
principal and `projects.read`; personal-scope users and organization members receive that
permission, and delegated agents must also be granted it.

```ts
const page = await backoffice.call({ kind: "user", userId }, "projects.list", { pageSize: 25 });
// page: { projects, nextCursor, hasNextPage }
```

```sh
projects.list --format json
projects.list --page-size 10 --cursor CURSOR --format json
```

Codemode exposes the same operation as `projects.list({ pageSize: 25 })`. Results are ordered by
slug and include archived projects, identified by a non-null `archivedAt`. Each project has a
`projectId`, slug, name, description, creator ID, and ISO timestamps. Pages default to 25 records
(maximum 100); resume using `nextCursor` with the same page size. The final page has
`nextCursor: null` and `hasNextPage: false`. Listing does not move from a project scope to its
owner.

### Creating

`projects.create` creates a project in the selected owner scope and returns `{ projectId, slug }`.
It requires a user principal and the `projects.create` permission. Personal-scope users and
organization members receive this permission; delegated agents must also be granted it. The creator
is derived from the principal, never supplied in the input.

```ts
const project = await backoffice.call({ kind: "org", orgId }, "projects.create", {
  name: "Customer Support",
  slug: "support",
  description: "Support workflows",
});
```

The same operation is available as `projects.create(...)` in Codemode and in the terminal:

```sh
projects.create --name "Customer Support" --slug support --format json
```

Omitting `slug` derives it from the name; omitting `description` stores `null`. A duplicate slug
within the owner returns `conflict`. Select an organization or personal scope—not System, an app
workspace, or a project. Creating a sibling from a project requires explicitly selecting its owner
scope, which project-restricted credentials cannot do.

## Provisioning

`v0/provisioning` is a separate contract for apps Backoffice operates. Its operations are
`POST /api/<version>/provisioning/<operationId>` with the app's OAuth client-credentials token, not
a scope: they create the organizations and projects that scopes then name, and bring the app's users
into them. Users are those who authorized the app with OAuth. Each operation requires the
provisioning permission of the same name, which only a Backoffice administrator grants, and is
idempotent, so a call whose outcome is unknown can be repeated.

```ts
import { createBackofficeProvisioningClient } from "@fragno-dev/backoffice-api/v0/client";

const provisioning = createBackofficeProvisioningClient({ origin, accessToken, fetch });
const { organizationId } = await provisioning.call("organizations.provision", {
  externalOrganizationId: "workspace_123",
  name: "Acme",
  // The OAuth subject of a user who signed in to the app.
  ownerUserId,
});
```

`organizations.provisionForInvitee` creates one for an owner who need not have a Backoffice account
yet: the organization has no members and a pending owner invitation, which the app sends with
`invitations.send` and accepts with `invitations.accept` once the owner signs in.

Errors reject like `createBackofficeApiClient`'s.

## OpenAPI

```ts
import { createOpenApiDocument } from "@fragno-dev/backoffice-api/openapi";
import { backofficeApiV0 } from "@fragno-dev/backoffice-api/v0";

const document = createOpenApiDocument(backofficeApiV0, {
  serverUrl: "https://backoffice.example",
});
```

`zod` is a peer dependency: schemas share one zod instance with your application so `.meta({ id })`
names resolve consistently.
