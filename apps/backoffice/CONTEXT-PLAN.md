# Backoffice context, scoped handles, and filesystem permissions

This is the implementation plan. It intentionally only describes work we are going to do.

## Goals

1. Keep Durable Object scope policy as the physical sharding rule.
2. Add a Backoffice context/kernel layer integrated with `app/fragno/auth/auth.ts` and the auth
   access-token system.
3. Authorize runtime tools at operation level, not only object level.
4. Replace org-only runtime creation with scope-aware runtime creation.
5. Rework codemode around scoped handles.
6. Make the UI operate in one selected context at a time.
7. Implement Unix-like filesystem permissions in `packages/fragment-upload`.

We do not preserve backward compatibility while doing this.

## Physical object policy stays low-level

`app/backoffice-runtime/object-scope-policy.ts` remains the physical Durable Object instantiation
policy.

It answers:

> Can binding X be instantiated with scope kind Y?

It does not answer:

> May this actor perform this operation in this context?

The runtime/kernel layer answers that second question.

## Backoffice context types

Add shared Backoffice context types used by auth, runtime tools, codemode, UI loaders, and
filesystem mapping.

Suggested location:

```txt
apps/backoffice/app/backoffice-runtime/context.ts
```

Core types:

```ts
export type BackofficeContextScope =
  | { kind: "system" }
  | { kind: "org"; orgId: string }
  | { kind: "user"; userId: string }
  | { kind: "project"; projectId: string };

export type BackofficePrincipal = {
  type: "user" | "automation" | "object" | "system";
  id: string;
  userId?: string;
  email?: string;
  role?: string;
  activeOrganizationId?: string | null;
  organizationIds?: string[];
};

export type BackofficeExecutionContext = {
  actor: BackofficePrincipal;
  scope: BackofficeContextScope;
};
```

`singleton` is not a `BackofficeContextScope`. It is only a physical DO address kind. Product code
uses `system` when it means platform-level behavior.

## Auth integration

The context/kernel work must integrate with `app/fragno/auth/auth.ts` and the auth system in
general.

### Access-token context

`app/fragno/auth/auth.ts` currently defines:

```ts
export const backofficeAccessTokenContextSchema = z.object({
  organizationIds: z.array(z.string()),
});
```

Keep this as the auth snapshot used for authorization. The token context records which orgs the user
may access. It should not store the UI-selected context; selected context changes too often and
belongs to request/session/UI state, not access-token claims.

We should extend the schema only when we have durable data to include. The immediate shape remains:

```ts
export const backofficeAccessTokenContextSchema = z.object({
  organizationIds: z.array(z.string()),
});
```

### Principal creation

Add a conversion from `BackofficeAuthPrincipal` to `BackofficePrincipal`.

Suggested location:

```txt
apps/backoffice/app/fragno/auth/backoffice-principal.server.ts
```

Shape:

```ts
export const createBackofficePrincipal = (auth: BackofficeAuthPrincipal): BackofficePrincipal => ({
  type: "user",
  id: auth.user.id,
  userId: auth.user.id,
  email: auth.user.email,
  role: auth.user.role,
  activeOrganizationId: auth.auth.activeOrganizationId,
  organizationIds: auth.auth.sessionContext.organizationIds,
});
```

Consequences we implement:

- routes do not pass raw `AuthPrincipal` into runtime tools;
- routes resolve auth once, convert to `BackofficePrincipal`, then create a scoped kernel/runtime;
- automation/object/system callers create explicit non-user principals;
- audit records and tool calls can record one principal shape.

### Context authorization helpers

Replace org-only helpers like `requireOrganizationAccess(...)` /
`authorizeAccessTokenForOrganization(...)` for new code with context-aware helpers.

Suggested APIs:

```ts
export const requireBackofficePrincipal = async (request, routerContext) => {
  const auth = await requireAuthPrincipal(request, routerContext);
  return createBackofficePrincipal(auth);
};

export const requireBackofficeContext = async (
  request,
  routerContext,
  scope: BackofficeContextScope,
): Promise<BackofficeExecutionContext> => {
  const actor = await requireBackofficePrincipal(request, routerContext);
  kernel.assertContextAccess({ actor, scope });
  return { actor, scope };
};
```

Initial context-access rules:

```txt
system scope: system actor only
org scope: user token context must include orgId
user scope: userId must equal actor.userId, unless actor is system
project scope: not exposed until project records exist
```

Existing org-only routes can be rewritten directly to context-aware routes because we do not need
backward compatibility.

## Kernel

Add a Backoffice kernel that owns authorization and scoped runtime/object resolution.

Suggested location:

```txt
apps/backoffice/app/backoffice-runtime/kernel.ts
```

Core API:

```ts
export type BackofficeOperation =
  | "mcp.servers.read"
  | "mcp.servers.create"
  | "mcp.servers.delete"
  | "mcp.tools.call"
  | "files.read"
  | "files.write"
  | "files.managePermissions"
  | "files.manageExecutable"
  | "automations.read"
  | "automations.write"
  | "automations.trigger"
  | "automations.routeEvent"
  | "capabilities.use"
  | "capabilities.manage";

export type BackofficeAuthorizationRequest = {
  actor: BackofficePrincipal;
  scope: BackofficeContextScope;
  operation: BackofficeOperation;
  resource?: unknown;
};
```

Kernel responsibilities:

1. validate context access from auth principal/session context;
2. validate physical object scope against `object-scope-policy.ts`;
3. enforce operation-level runtime-tool permissions;
4. resolve scoped objects/runtimes;
5. map Backoffice principals to upload `FilePrincipal`s.

Initial policy is intentionally simple:

```txt
system actor: allowed everywhere
user actor in own user scope: allowed for user-scoped supported operations
user actor in org scope: allowed if access-token context contains orgId
project scope: unavailable until minimal project model exists
unsupported object/scope combinations: denied
```

Even when the first rules are permissive, every route/tool must call the kernel so enforcement can
be tightened without another rewrite.

## Runtime tools

Runtime tools must declare the operation they perform.

Extend `BackofficeRuntimeTool` in:

```txt
apps/backoffice/app/fragno/runtime-tools/runtime-tools.ts
```

Add:

```ts
requiredOperation: BackofficeOperation;
```

Execution wrapper:

```ts
kernel.assertAllowed({
  actor: context.actor,
  scope: context.scope,
  operation: tool.requiredOperation,
  resource: toolResourceFromInput(tool, input),
});
```

Concrete behavior:

- `mcp.listServers` uses `mcp.servers.read`;
- `mcp.createServer` uses `mcp.servers.create`;
- `mcp.deleteServer` uses `mcp.servers.delete`;
- `mcp.callTool` uses `mcp.tools.call`;
- file read/write tools use `files.read` / `files.write`;
- writing automation router/workflow files additionally requires `files.manageExecutable`.

Object resolution happens after authorization and uses the selected scope.

Unsupported scope examples:

```txt
TELEGRAM in user scope -> unavailable
MCP in project scope -> unavailable today
UPLOAD in org/user/project scope -> available according to object policy
AUTOMATIONS in org/user/project/system scope -> available according to object policy
```

## Scoped runtime creation

Replace org-only runtime creation:

```ts
createRouteBackedRuntimeContext({ runtime, orgId });
```

with:

```ts
createRouteBackedRuntimeContext({
  runtime,
  kernel,
  execution: { actor, scope },
});
```

The resulting runtime context includes exactly one selected scope. Tool families that are not
supported in that scope return an unavailable runtime with a clear error.

Example:

```ts
const execution = await requireBackofficeContext(request, routerContext, {
  kind: "org",
  orgId,
});

const runtimeContext = createRouteBackedRuntimeContext({
  runtime,
  kernel,
  execution,
});
```

## Codemode scoped handles

Codemode becomes one actor-scoped execution surface with scoped handles.

Generated codemode API shape:

```ts
const fragno = context.org("org-fragno");
const personal = context.user("wilco");

await fragno.mcp.listServers();
await personal.files.readFile("/workspace/notes.md");
```

Default-scope shortcuts are allowed:

```ts
await mcp.listServers();
await files.readFile("/workspace/readme.md");
```

They mean:

```ts
await context.current.mcp.listServers();
await context.current.files.readFile("/workspace/readme.md");
```

Implementation work:

1. Add a `context` codemode provider.
2. `context.current`, `context.org(id)`, `context.user(id)`, and later `context.project(id)` create
   scoped handles.
3. A scoped handle is a façade over kernel-created scoped runtimes.
4. Every handle operation calls the same runtime-tool authorization wrapper.
5. Generated `codemode.d.ts` documents scoped handles as the primary API.

Unavailable scoped handles throw clear errors at operation time:

```ts
await context.project("backoffice").mcp.listServers();
// MCP is not available for project scope.
```

## Bash tools

Bash tools run in the selected/default execution context only.

We do not implement cross-context bash addressing in this pass.

Consequences:

- `mcp.servers.list` lists MCP servers for the selected scope only;
- no `--scope`, `--org`, `--user`, or `--project` flags are added now;
- cross-context work is done through codemode scoped handles.

## UI context switching

The UI carries one selected `BackofficeContextScope`.

The selected context is not stored in the access token. It is UI/router state.

Concrete behavior:

```txt
Personal / Wilco selected
  user-scoped resources operate
  org-only resources show unavailable

Org / Fragno selected
  org-scoped resources operate
  user-only resources show unavailable
```

Project context is not exposed in the UI until a minimal project model exists.

Pages/loaders create scoped runtimes from the selected context:

```ts
const execution = await requireBackofficeContext(request, routerContext, selectedScope);
const runtimeContext = createRouteBackedRuntimeContext({ runtime, kernel, execution });
```

We do not implement merged multi-context resource views.

## MCP behavior

MCP remains scoped to the physical MCP object.

Current object policy:

```ts
MCP: ["org", "user"];
```

Implemented behavior:

```txt
Org context      -> objects.mcp.forOrg(orgId)
User context     -> objects.mcp.forUser({ userId })
Project context  -> unavailable
```

`mcp.listServers()` never merges scopes. It lists servers for the selected/scoped handle only.

MCP slugs are unique only inside one scoped MCP object. Cross-context references use scoped handles,
not global slug names.

## Automations and event routing

Automations use the selected execution scope.

Current object policy already allows:

```ts
AUTOMATIONS: ["singleton", "org", "user", "project"];
```

Implemented behavior:

- system execution uses singleton automations;
- org execution uses org automations;
- user execution uses user automations;
- project execution waits until project model exists.

Event flow is explicit router behavior.

Example:

```txt
Telegram org DO receives update
org automation router handles event
router explicitly emits/forwards a project event later, once project support exists
```

The kernel authorizes `automations.routeEvent` for cross-scope emits. Router/workflow files are
protected by filesystem permissions and `files.manageExecutable` checks.

## Upload fragment filesystem permissions

Unix-like filesystem permissions are implemented in:

```txt
packages/fragment-upload
```

This is not only a Backoffice wrapper. The upload fragment itself enforces permissions so every
caller path is protected:

- upload fragment routes;
- upload fragment services;
- Backoffice file browser;
- codemode file APIs;
- automation file APIs;
- direct internal DO route calls.

### FilePrincipal

Add to `packages/fragment-upload/src/types.ts`:

```ts
export type FilePrincipal = {
  uid: string;
  gids?: string[];
};

export const ROOT_FILE_PRINCIPAL: FilePrincipal = {
  uid: "root",
  gids: ["root"],
};
```

Every permission-checked upload/filesystem operation accepts an optional `filePrincipal`.

If omitted, it defaults to root.

Use the name `filePrincipal` in public/service APIs. `fsPrincipal` is acceptable for short internal
locals. Do not use `unixUser`.

### Upload schema changes

Update `packages/fragment-upload/src/schema.ts` to store filesystem permission metadata.

Because Unix-like directory checks require directory metadata, add first-class filesystem nodes
instead of relying only on virtual prefixes.

Implement a node table for filesystem entries:

```ts
fs_node: id;
provider;
key;
kind: "file" | "directory";
ownerUid;
groupId;
mode;
createdAt;
updatedAt;
deletedAt;
```

The existing `file` table remains the file-content/upload metadata table. File nodes reference file
records or share the same `provider` + `key` identity. The exact reference shape can be chosen while
implementing, but permission checks must be based on `fs_node`.

Required constraints/indexes:

```txt
unique(provider, key)
index(provider, key, kind)
index(provider, key, deletedAt)
```

Root directory behavior:

- every provider has an implicit `/` directory;
- if no node exists for `/`, it behaves as root-owned with mode `0755`;
- creating top-level entries checks write+execute on `/`.

Default metadata:

```txt
directory owner: root unless provided
file owner: uploading filePrincipal.uid
file group: first filePrincipal.gids entry, else owner uid
regular file mode: 0644
created directory mode: 0755
system/executable paths: root-owned unless explicitly created by root/admin flow
```

### Permission checks

Implement permission helpers in `packages/fragment-upload`, e.g.:

```txt
packages/fragment-upload/src/permissions.ts
```

Required checks:

```txt
read file: read bit on file + execute bit on parent directories
write file: write bit on file + execute bit on parent directories
create file: write+execute on parent directory
list directory: read+execute on directory
create directory: write+execute on parent directory
rename/delete: write+execute on parent directory
chmod: root or owner
chown: root only
```

Mode semantics:

```txt
owner bits apply when principal.uid === ownerUid
group bits apply when principal.gids includes groupId
other bits apply otherwise
root bypasses permission bits
```

### Route/service integration

All file/upload service inputs that read, create, update, delete, list, or complete files must carry
`filePrincipal?: FilePrincipal`.

Examples:

```ts
listFiles({ provider, prefix, filePrincipal })
getFileByKey({ provider, fileKey, filePrincipal })
createUpload({ provider, fileKey, filePrincipal, ... })
completeUpload({ uploadId, filePrincipal })
markFileDeleted({ provider, fileKey, filePrincipal })
```

Routes resolve a `filePrincipal` through upload config, not by trusting arbitrary public headers.

Add to upload config:

```ts
permissions?: {
  resolveFilePrincipal?(input: {
    request: Request;
  }): FilePrincipal | null | undefined | Promise<FilePrincipal | null | undefined>;
};
```

If the resolver returns `null`/`undefined`, use root.

Backoffice internal route callers set up this resolver so authenticated Backoffice requests map to
non-root file principals. Direct unauthenticated/public upload routes only get root if the host
chooses to omit a resolver.

### Backoffice principal to FilePrincipal mapping

The Backoffice kernel maps `BackofficePrincipal` to upload `FilePrincipal`.

Initial mapping:

```ts
user principal -> {
  uid: `user:${userId}`,
  gids: [`user:${userId}`, ...organizationIds.map((id) => `org:${id}`)],
}

system principal -> root
object/automation principal -> service uid, e.g. `automation:<id>` or `object:<id>`
```

The scoped upload runtime passes this `filePrincipal` to `packages/fragment-upload` for every file
operation.

### Backoffice semantic file checks

Upload permissions are necessary but not enough for Backoffice executable behavior.

Backoffice kernel also checks semantic operations for protected paths:

```txt
/workspace/automations/router.cm.js
/workspace/automations/**/*.workflow.js
/workspace/codemode.d.ts
/system/**
```

Writing these paths requires:

```txt
files.write
files.manageExecutable
```

The upload fragment still enforces Unix-like write permissions after the Backoffice semantic check.

## Minimal project model gate

Project context is represented in types and object policy, but UI/codemode project handles are only
made functional after a minimal project model exists.

Implement the gate as:

```txt
context.project(id) exists in declarations
operations throw "Project context is not available" until project lookup is implemented
UI does not show project switching yet
```

This lets object scope policy and tests keep project support visible without exposing a fake product
concept.

## Implementation order

1. Add `BackofficeContextScope`, `BackofficePrincipal`, and `BackofficeExecutionContext`.
2. Add auth-to-Backoffice-principal conversion and context-aware auth helpers.
3. Add the Backoffice kernel with context access checks and object/scope resolution.
4. Change `createRouteBackedRuntimeContext` to accept `{ kernel, execution }` instead of `orgId`.
5. Add `requiredOperation` to runtime tools and wrap execution with kernel authorization.
6. Rework MCP runtime resolution for org/user selected scopes.
7. Rework codemode providers and `codemode.d.ts` around scoped handles.
8. Change dev codemode and UI routes to require a selected context and authenticated principal.
9. Implement `FilePrincipal`, `fs_node`, mode checks, and config-based principal resolution in
   `packages/fragment-upload`.
10. Pass kernel-derived `FilePrincipal`s from Backoffice upload/file runtimes into the upload
    fragment.
11. Add Backoffice semantic protected-path checks for executable/system files.
12. Add tests for:
    - auth principal conversion;
    - org/user context access;
    - unsupported scope/object combinations;
    - runtime-tool operation authorization;
    - codemode scoped handles;
    - upload Unix mode checks;
    - Backoffice protected path checks.
