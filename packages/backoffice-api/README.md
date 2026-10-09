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

## Calling an operation

Every operation is `POST /api/<version>/scopes/<scope>/<operationId>` with a bearer token and the
operation's input as the JSON body. Operations whose input is `z.void()` take no body. The scope is
`system`, `user:<userId>`, `org:<orgId>`, or `project:<orgId>:<projectId>`, with each id
URI-encoded. An operation that is not available to the credential in that scope, such as an
organization operation in a project scope, answers `404`.

Successful calls return `200` with the operation's output, or `204` when the output is `z.void()`.
Bytes travel as standard base64 strings (`v0/shared/bytes`). This is temporary: dedicated file
transfer APIs will replace it for large files. Errors return `{ error: { code, message } }`
(`@fragno-dev/backoffice-api/errors`), where the code determines the status: `invalid_request` 400,
`authentication_failed` 401, `forbidden` 403, `not_found` 404, and `operation_failed` 422.

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
