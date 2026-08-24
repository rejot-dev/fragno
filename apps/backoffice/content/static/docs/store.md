# Automation store reference

The automation store is a scope-local string key-value store owned by an Automations object.
Workflows use it for small durable coordination values, such as external identity mappings, workflow
instance references, and scoped configuration.

The store is not a document database or workflow history. Values have no server-side query structure
beyond their key, and each write replaces the complete string value.

## Entry shape

A stored entry has these fields:

| Field         | Type             | Description                                                                  |
| ------------- | ---------------- | ---------------------------------------------------------------------------- |
| `id`          | string           | Stable database identity. Updating a key reuses the existing record.         |
| `key`         | string           | Non-empty unique key within the Automations object.                          |
| `value`       | string           | Complete stored value. Structured values must be encoded by the caller.      |
| `description` | string or `null` | Optional human-readable purpose.                                             |
| `category`    | string[]         | Optional labels. Categories do not affect authorization or lookup.           |
| `createdAt`   | ISO timestamp    | Database creation time. Returned by get and list operations.                 |
| `updatedAt`   | ISO timestamp    | Database time of the most recent write. Returned by get and list operations. |

Keys are globally unique inside one scoped Automations object. Separate system, organization,
project, and user Automations objects have separate stores.

Use stable namespaced keys, for example:

```text
telegram/chat/chat-123
approval/workflow/request-456
pi/default-agent
```

## Operations

The store exposes the following runtime tools and fragment routes:

| Operation | Runtime tool   | Fragment route           | Result when missing                                                         |
| --------- | -------------- | ------------------------ | --------------------------------------------------------------------------- |
| Get       | `store.get`    | `GET /store/get?key=...` | Tool returns `null`; route returns `STORE_ENTRY_NOT_FOUND` with status 404. |
| Set       | `store.set`    | `POST /store/set`        | Creates or updates the entry.                                               |
| List      | `store.list`   | `GET /store`             | Returns an array, which may be empty.                                       |
| Delete    | `store.delete` | `POST /store/delete`     | Tool returns `null`; route returns `STORE_ENTRY_NOT_FOUND` with status 404. |

### Set

A set input has this shape:

```ts
{
  key: string;
  value: string;
  description?: string | null;
  category?: string[];
  verification?: Array<{
    type: "json-schema";
    schema: object | boolean;
  }>;
}
```

Set behaves as an upsert:

- A new key creates a record and sets both timestamps from database time.
- An existing key keeps its `id` and `createdAt`, replaces `value`, and updates `updatedAt`.
- Omitting `description` on update preserves the existing description.
- Passing `description: null` clears the description.
- Omitting `category` on update preserves the existing categories.
- Passing `category: []` clears all categories.

Category input removes blank values and duplicates while preserving the first occurrence of each
label.

The set result contains `id`, `key`, `value`, `description`, and `category`. It does not include
timestamps or verification rules.

### List

List accepts two optional fields:

```ts
{
  prefix?: string;
  limit?: number;
}
```

`prefix` performs an indexed key-prefix scan. `limit` must be a positive integer no greater
than 500. The list operation does not expose a cursor; callers that need bounded reads should always
supply a limit.

The implementation does not define a cross-query ordering contract. Do not use list position as
domain state.

### Delete

Delete removes the complete entry identified by its key. Categories and descriptions do not protect
an entry from deletion.

## JSON Schema verification

A set operation can verify a JSON-encoded string before writing it:

```json
{
  "key": "pi/default-agent",
  "value": "{\"harness\":\"h1\",\"model\":\"m1\"}",
  "verification": [
    {
      "type": "json-schema",
      "schema": {
        "type": "object",
        "required": ["harness", "model"],
        "properties": {
          "harness": { "type": "string" },
          "model": { "type": "string" }
        }
      }
    }
  ]
}
```

Verification uses JSON Schema draft 2020-12:

1. Parse `value` as JSON.
2. Compile each supplied schema.
3. Validate the parsed value against every verification item.
4. Reject the write when parsing, schema compilation, or validation fails.

Verification is a write-time guard. The store does not persist the schema or revalidate the value on
reads. A later write that omits verification can replace a previously verified value.

The fragment route reports verification failures as `STORE_VERIFICATION_FAILED` with status 400.

## Router snapshots

The event-ingestion hook retrieves all routes and all store entries in one read phase. It converts
store rows into an in-memory key-to-value map before executing routes.

A `send_workflow_event` action with a `stored_instance_id` target reads from this snapshot.
Consequently:

- every route selected for one ingested event sees the same store snapshot;
- store writes performed while processing an earlier route do not change a later route's target for
  that event;
- a missing or empty stored instance ID makes the send action a no-op.

Workflow code that calls `store.get`, `store.set`, `store.list`, or `store.delete` uses the live
store through the runtime tool boundary. The snapshot behavior applies only to router action
resolution.

## Authorization and provenance

Runtime tools declare two permissions:

- `store.read` for get and list;
- `store.modify` for set and delete.

Store mutation routes require a trusted Backoffice action context and authorize `store.modify`
against the target key. The input schema is strict and does not accept caller-supplied actor
attribution. The kernel derives provenance and authority from the execution context.

The store record itself does not retain creator or updater actors. Use event, workflow, and kernel
observability records when actor-level audit history is required.

## Persistence model

Entries live in the `kv_store` table of the scoped automation database. The table has a unique index
on `key`. Store writes use Fragno database transactions and optimistic checks for updates and
deletes.

There is no expiration, compare-and-set operation, multi-key transaction API, or automatic namespace
cleanup in the current store contract.

## Error reference

| Code                                  | Status | Condition                                                     |
| ------------------------------------- | ------ | ------------------------------------------------------------- |
| `KEY_REQUIRED`                        | 400    | Get route omitted an effective key.                           |
| `STORE_LIST_LIMIT_INVALID`            | 400    | List limit is not an integer from 1 through 500.              |
| `STORE_LIST_INPUT_INVALID`            | 400    | List query failed schema validation.                          |
| `STORE_VERIFICATION_FAILED`           | 400    | JSON parsing, schema compilation, or value validation failed. |
| `STORE_ENTRY_NOT_FOUND`               | 404    | Get or delete route could not find the key.                   |
| `AUTOMATIONS_ACTION_CONTEXT_REQUIRED` | 403    | A mutation did not carry trusted action context.              |

Authorization failures can return additional kernel reason codes and status values.

## Related documents

- [About automations](automations/README.md)
- [Automation router](automations/router.md)
- [About events](events/README.md)

## Implementation map

- `apps/backoffice/app/fragno/automation/store.ts` — schemas and JSON Schema verification.
- `apps/backoffice/app/fragno/automation/store-routes.ts` — fragment routes and route errors.
- `apps/backoffice/app/fragno/automation/bindings-storage-runtime.ts` — persistence operations.
- `apps/backoffice/app/fragno/runtime-tools/families/automations-bindings.ts` — runtime tools and
  permissions.
- `apps/backoffice/app/fragno/automation/schema.ts` — `kv_store` table.
- `apps/backoffice/app/fragno/automation/definition.ts` — router store snapshot.
- `apps/backoffice/app/fragno/automation/automations.ts` — mutation authorization.
