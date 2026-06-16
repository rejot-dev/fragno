# Backoffice context plan implementation slices

Each slice is a vertical, independently testable implementation step. Full breaking changes are
allowed. Do not keep old APIs alive unless the slice explicitly needs a short-lived internal adapter
while updating call sites.

A slice is only valid if it can be tested through real plumbing: route-backed runtime tools,
codemode, UI/dev routes, upload fragment routes, automation scenarios, or Durable Object-backed
route callers. Unit tests can support the slice, but are not the proof that the slice is complete.

## [x] Slice 1 — Auth-backed selected context + scoped runtime kernel

### Goal

Replace org-only route-backed runtime construction with an explicit selected execution context and a
Backoffice kernel that owns context access and scoped object resolution.

This slice established the selected-context foundation. While implementing it, we also pulled a
small amount of Slice 2 groundwork forward: runtime tool families now declare family-scoped
permissions, and object-backed runtime constructors accept concrete Backoffice object types instead
of loose `{ objects, orgId }` inputs.

### Implemented

- Added shared context types in `apps/backoffice/app/backoffice-runtime/context.ts`:
  - `BackofficeContextScope`;
  - `BackofficePrincipal`;
  - `BackofficeExecutionContext`;
  - `SYSTEM_BACKOFFICE_PRINCIPAL` for internal/system call sites.
- Kept `backofficeAccessTokenContextSchema` as the org-membership source. Selected UI/runtime
  context is not stored in the access token.
- Added auth conversion/helpers in `apps/backoffice/app/fragno/auth/backoffice-principal.server.ts`:
  - `createBackofficePrincipal(auth)` converts `BackofficeAuthPrincipal` to `BackofficePrincipal`;
  - `requireBackofficePrincipal(request, routerContext)`;
  - `requireBackofficeContext(request, routerContext, scope)`.
- Added `BackofficeKernel` in `apps/backoffice/app/backoffice-runtime/kernel.ts`:
  - validates selected-context access;
  - validates object/scope support via `object-scope-policy.ts`;
  - resolves scoped objects through `kernel.scoped(...)`;
  - returns explicit forbidden/unavailable errors, including `Project context is not available.`
- Replaced org-only route-backed runtime construction with:

```ts
createRouteBackedRuntimeContext({
  runtime,
  kernel,
  execution: { actor, scope },
});
```

- Updated all `createRouteBackedRuntimeContext(...)` call sites.
  - Authenticated dev codemode now creates an org selected context from the request principal.
  - Existing automation/Pi/scenario internal call sites use explicit system actors with org scopes
    until later automation slices make those contexts fully selected-scope aware.
- Implemented selected-scope runtime behavior for the route-backed runtime context:
  - org-supported families continue to work in org scope;
  - MCP resolves through the kernel and can target org/user scoped MCP objects;
  - project scope is gated with `Project context is not available.`;
  - unsupported family/scope combinations return unavailable runtimes before calling their Durable
    Objects, e.g. Telegram in user scope.
- Aligned object-backed runtime constructors so callers pass the concrete object they intend to use:
  - `createMcpRuntime(mcpObject)`;
  - `createTelegramRuntime({ object: TelegramObject })`;
  - `createOtpRuntime({ object: OtpObject, ... })`;
  - `createPiRouteRuntime({ object: PiObject, ... })`;
  - `createResendRouteRuntime({ object: ResendObject })`;
  - `createReson8RouteRuntime({ object: Reson8Object })`.
- Added the runtime-tool permission metadata shape for the next slice:
  - tool families require a `permissions` catalog;
  - tools declare `requiredPermissions: string[]`;
  - permission names are local to the family namespace;
  - permissions were simplified to broad actions such as `read`, `modify`, `send`, `manage`, etc.

Initial context rules now enforced by the kernel:

```txt
system scope: system actor only
org scope: token context must include orgId for user actors
user scope: userId must equal actor.userId, unless actor is system
project scope: unavailable until project model exists
```

### Verified

Ran the Backoffice package through real project plumbing and checks:

```sh
pnpm exec turbo types:check --filter=./apps/backoffice --output-logs=errors-only
pnpm exec turbo test --filter=./apps/backoffice --output-logs=errors-only
pnpm exec turbo build --filter=./apps/backoffice --output-logs=errors-only
pnpm run lint:fix
pnpm run format:changed
```

### Acceptance status

- Route-backed runtime context is no longer org-only.
- Runtime object resolution for selected-context object-backed families goes through the kernel.
- Auth/access-token context remains the source for org access.
- Dev codemode route now operates from an authenticated selected org context.
- Project context and unsupported object/scope combinations fail with explicit unavailable errors.

## [x] Slice 2 — Permission-authorized runtime tools + scoped codemode handles

### Goal

Runtime tools become permission-authorized, and codemode gets scoped handles as the canonical API.

Slice 1 already introduced the permission metadata shape and added broad family-scoped permissions
for existing tool families. This slice wires those declarations into runtime execution and makes
codemode multi-scope. Scoped handles are only safe once every handle operation goes through the same
runtime-tool authorization path.

### Existing groundwork from Slice 1

- `BackofficeRuntimeToolFamily` now requires a `permissions` catalog.
- `BackofficeRuntimeTool` can declare `requiredPermissions: string[]`.
- Permission names are local to the family namespace, e.g. MCP uses `servers.read`,
  `servers.create`, `servers.delete`, and `tools.call` instead of a global `mcp.servers.read` enum.
- The kernel no longer owns a hardcoded `BackofficeOperation` union. Authorization requests use
  normalized permission requirements:

```ts
requiredPermissions: Array<{
  namespace: string;
  permission: string;
}>;
```

### Implement

- Make `requiredPermissions` explicit for every runtime tool. Empty arrays are allowed only for
  tools that are intentionally public within an already-authorized context.
- Keep each family permission catalog broad and human-oriented, not one-per-method unless that is
  actually the permission boundary. Examples:
  - store: `read`, `modify`;
  - workflow: `read`, `modify`;
  - telegram/resend: `read`, `send`;
  - sandbox/pi: `read`, `modify`;
  - backoffice capabilities: `read`, `manage`;
  - MCP: `servers.read`, `servers.create`, `servers.delete`, `tools.call`.
- Normalize tool permissions before authorization:

```ts
const requiredPermissions = tool.requiredPermissions.map((permission) => ({
  namespace: tool.namespace,
  permission,
}));

kernel.assertAllowed({
  actor: context.actor,
  scope: context.scope,
  requiredPermissions,
  resource,
});
```

- Extend `BackofficeToolContext` / route-backed tool context so every runtime tool execution has:
  - `actor`;
  - selected `scope`;
  - `kernel`.
- Enforce permissions in both codemode provider execution and bash command execution.
- Add resource extraction where needed, e.g. MCP slug, file path, workflow name, capability id,
  sandbox id.
- Add a kernel test-policy hook so end-to-end tests can deny a specific normalized permission for a
  scope/resource. This hook is for tests and development policy simulation; production policy can
  remain permissive after context access succeeds.
- Rework codemode providers around scoped handles:

```ts
const fragno = context.org("org-fragno");
const personal = context.user("user-1");

await fragno.mcp.listServers();
await personal.mcp.listServers();
```

- Add default-scope shortcuts:

```ts
await mcp.listServers();
// same as context.current.mcp.listServers()
```

- The scoped codemode runtime should create a selected route-backed runtime context per handle using
  the same actor and kernel:

```ts
createRouteBackedRuntimeContext({
  runtime,
  kernel,
  execution: { actor, scope: handleScope },
});
```

- Update generated `codemode.d.ts`, codemode prompts, starter automation files, and tests.
- Bash remains selected-context only. Do not add cross-context bash flags in this slice.

### End-to-end test

Use `runBackofficeCodemode(...)` with route-backed runtime context:

1. `context.org("org-1").mcp.listServers()` hits org MCP object;
2. `context.user("user-1").mcp.listServers()` hits user MCP object;
3. default `mcp.listServers()` hits `context.current` scope;
4. `context.project("project-1").mcp.listServers()` throws project unavailable;
5. with kernel policy denying `{ namespace: "mcp", permission: "servers.delete" }` in org scope:
   - `context.org("org-1").mcp.listServers()` succeeds because it requires `servers.read`;
   - `context.org("org-1").mcp.deleteServer(...)` returns an authorization error;
   - MCP DO delete route is not called.

### Verified

Implemented and tested through the route-backed codemode path and bash command path:

- every runtime tool has explicit `requiredPermissions`;
- runtime tool execution normalizes tool permissions to `{ namespace, permission }` before calling
  `kernel.assertAllowed(...)`;
- kernel authorization accepts a policy hook without reintroducing a global operation enum;
- codemode exposes `context.current`, `context.org(...)`, `context.user(...)`, and
  `context.project(...)` scoped handles;
- default providers such as `mcp.listServers()` still target the selected current scope;
- generated `codemode.d.ts` now documents scoped handles as the canonical multi-context API;
- bash runtime commands also authorize before calling runtime implementations;
- denial of `{ namespace: "mcp", permission: "servers.delete" }` prevents the route-backed MCP
  Durable Object call.

### Acceptance status

- Every runtime tool has explicit `requiredPermissions`.
- Every runtime tool call is kernel-authorized using family-scoped permissions.
- Kernel authorization has no hardcoded global operation enum.
- Codemode can address multiple scopes through handles in one session.
- Default codemode providers still target the selected current scope.
- Old org-only codemode assumptions are removed from generated declarations/prompts.

## [ ] Slice 3 — Upload fragment Unix-like filesystem permissions

### Goal

Implement Unix-like filesystem permissions in `packages/fragment-upload` itself and wire request
principals through upload routes/services.

This is one slice because metadata without enforcement is not valuable, and enforcement cannot be
validated without metadata and route/service plumbing.

### Implement

In `packages/fragment-upload`:

- Add to `src/types.ts`:

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

- Add `fs_node` table to `src/schema.ts`:

```txt
provider
key
kind: "file" | "directory"
ownerUid
groupId
mode
createdAt
updatedAt
deletedAt
```

- Keep existing `file` table for upload/file metadata.
- Add node helpers and permission helpers, e.g. `src/permissions.ts`.
- Treat provider root `/` as implicit root-owned `0755` when no node exists.
- File upload/create creates a file node:
  - owner: `filePrincipal.uid`;
  - group: first `filePrincipal.gids`, else owner uid;
  - mode: `0644` default.
- Directory create creates a directory node with mode `0755` default.
- Add `filePrincipal?: FilePrincipal` to all file-affecting service inputs:
  - list;
  - get/read/download;
  - create upload;
  - complete upload;
  - update file;
  - delete file;
  - directory create/list/delete where present.
- If omitted, principal defaults to root.
- Enforce:

```txt
read file: read bit on file + execute bit on parent directories
write file: write bit on file + execute bit on parent directories
create file: write+execute on parent directory
list directory: read+execute on directory
rename/delete: write+execute on parent directory
chmod: root or owner
chown: root only
root bypasses permission bits
```

- Add upload config resolver:

```ts
permissions?: {
  resolveFilePrincipal?(input: { request: Request }):
    | FilePrincipal
    | null
    | undefined
    | Promise<FilePrincipal | null | undefined>;
};
```

- Routes call the resolver and default to root when it returns nothing.
- Do not trust arbitrary public headers as principals.

### End-to-end test

Through upload fragment routes, not just services:

1. upload/create a file as `user:1`; verify `fs_node.ownerUid === "user:1"`, group and mode;
2. request without a resolver/principal creates root-owned file;
3. owner can write their `0644` file;
4. different user can read but cannot write `0644` file;
5. group member can write `0664` file;
6. user without execute on parent cannot read child;
7. root can read/write regardless of mode;
8. non-root cannot chown.

### Acceptance

- `packages/fragment-upload` enforces permissions independently of Backoffice.
- All upload route/service paths accept and honor `filePrincipal`.
- Omitted principal means root.

## [ ] Slice 4 — Backoffice filesystem principal mapping + protected executable paths

### Goal

Backoffice maps authenticated/runtime actors to upload `FilePrincipal`s and adds semantic protection
for executable/system paths.

This is separate from Slice 3 because Slice 3 makes upload safe in isolation; this slice proves
Backoffice uses it correctly.

### Implement

- Kernel method:

```ts
kernel.resolveFilePrincipal({ actor, scope }): FilePrincipal
```

Initial mapping:

```txt
user -> uid user:<userId>, gids [user:<userId>, org:<each organizationId>]
system -> root
automation -> uid automation:<id>
object -> uid object:<id>
```

- Update Backoffice upload/file runtimes to pass kernel-derived `filePrincipal` into the upload
  fragment for every file operation.
- Internal seed/setup paths intentionally omit `filePrincipal` or use system actor to write as root.
- Add protected path classifier:

```txt
/workspace/automations/router.cm.js
/workspace/automations/**/*.workflow.js
/workspace/codemode.d.ts
/system/**
```

- Writes to protected paths require both:
  - `files.write`
  - `files.manageExecutable`
- Apply checks in:
  - UI file actions/routes;
  - codemode file writes;
  - Backoffice route-backed file runtime;
  - automation file writes if they can mutate workspace files.
- Upload fragment still performs mode checks after Backoffice semantic authorization.

### End-to-end test

Through Backoffice file/codemode APIs against the upload fragment:

1. authenticated user writes `/workspace/notes.md`; resulting `fs_node.ownerUid` is `user:<id>`;
2. another user in same org can read/write only according to upload mode bits;
3. internal seed path creates root-owned file;
4. actor with `files.write` but not `files.manageExecutable` can write notes but cannot write
   `/workspace/automations/router.cm.js`;
5. actor with both Backoffice permissions is still denied if upload Unix mode denies write;
6. codemode `context.user(userId).files.writeFile(...)` writes as that user principal, not root.

### Acceptance

- Backoffice request paths no longer accidentally write as root.
- Protected executable/system paths require semantic Backoffice permission and upload write access.
- Errors distinguish Backoffice authorization failure from upload filesystem permission failure.

## [ ] Slice 5 — Scoped automations and explicit event routing

### Goal

Make automation execution selected-scope aware and authorize explicit cross-scope routing.

This is last because it depends on selected context, operation authorization, codemode/runtime
updates, and protected router files.

### Implement

- Replace automation org-only context with `BackofficeExecutionContext`.
- Automation object resolution:
  - system execution -> singleton automations;
  - org execution -> org automations;
  - user execution -> user automations;
  - project execution -> gated until project model exists.
- Automation filesystem resolution uses the selected scope and Backoffice file principal mapping.
- Event emit/forward API accepts explicit target scope.
- Cross-scope emit checks `automations.routeEvent`.
- Router/workflow files are already protected by Slice 4.
- Update automation scenario helpers/content to use scoped handles and selected execution context.

### End-to-end test

Automation scenario test:

1. org-scoped event runs org automation router;
2. user-scoped event runs user automation router;
3. org router emits user-scoped event only when kernel allows `automations.routeEvent`;
4. denied cross-scope route does not enqueue target automation;
5. automation codemode script can call `context.current` and explicit scoped handles under the same
   actor permissions.

### Acceptance

- Automations are no longer hard-coded to org scope.
- Event flow is explicit router behavior.
- Cross-scope routing is operation-authorized.

## [ ] Slice 6 — Cleanup: remove org-only model remnants

### Goal

Delete old org-only APIs/docs/prompts after the vertical behavior works.

### Implement

- Remove leftover `orgId`-only runtime context helpers.
- Remove obsolete codemode examples and generated declarations.
- Update:
  - starter files;
  - system prompt content;
  - skills content;
  - codemode declaration tests;
  - runtime tool reference tests;
  - automation scenario docs.
- Ensure project handles are documented as gated/unavailable until project model exists.

### End-to-end test

Run the scenario suite that exercises generated starter/system content:

1. codemode reads new `codemode.d.ts`;
2. starter automation uses scoped handles;
3. no old org-only helper names appear in generated declarations/prompts;
4. selected-context dev route still runs org and user context codemode successfully.

### Acceptance

- There is one supported context model.
- Old org-only compatibility surfaces are gone.
