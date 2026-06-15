# Backoffice context plan implementation slices

Each slice is a vertical, independently testable implementation step. Full breaking changes are
allowed. Do not keep old APIs alive unless the slice explicitly needs a short-lived internal adapter
while updating call sites.

A slice is only valid if it can be tested through real plumbing: route-backed runtime tools,
codemode, UI/dev routes, upload fragment routes, automation scenarios, or Durable Object-backed
route callers. Unit tests can support the slice, but are not the proof that the slice is complete.

## [ ] Slice 1 — Auth-backed selected context + scoped runtime kernel

### Goal

Replace org-only runtime creation with an auth-backed selected-context model and a kernel that owns
object/routing authorization.

This merges the foundational context, auth integration, kernel, and route-backed runtime changes
because none of those are useful or meaningfully testable alone.

### Implement

- Add shared context types:
  - `BackofficeContextScope`
  - `BackofficePrincipal`
  - `BackofficeExecutionContext`
- Integrate with `apps/backoffice/app/fragno/auth/auth.ts`:
  - keep `backofficeAccessTokenContextSchema` as the org-membership source;
  - do not store selected UI context in the access token.
- Add auth conversion/helpers:
  - convert `BackofficeAuthPrincipal` to `BackofficePrincipal`;
  - `requireBackofficePrincipal(...)`;
  - `requireBackofficeContext(request, routerContext, scope)`.
- Add Backoffice kernel:
  - validates context access;
  - validates object/scope support using `object-scope-policy.ts`;
  - resolves scoped objects;
  - returns clear unavailable/forbidden errors.
- Replace `createRouteBackedRuntimeContext({ orgId })` with:

```ts
createRouteBackedRuntimeContext({
  runtime,
  kernel,
  execution: { actor, scope },
});
```

- Update all route-backed runtime context call sites.
- Implement selected-scope runtime behavior:
  - org scope: org-supported families work;
  - user scope: user-supported families work;
  - project scope: gated with clear unavailable error;
  - unsupported object/scope combinations are unavailable.
- Change dev/UI routes touched by runtime creation to require an authenticated selected context.

Initial context rules:

```txt
system scope: system actor only
org scope: token context must include orgId
user scope: userId must equal actor.userId, unless actor is system
project scope: unavailable until project model exists
```

### End-to-end test

Use route-backed runtime tools via dev route or scenario harness:

1. authenticated user with `organizationIds: [org-1]` can run org-context MCP list;
2. same user is rejected for org-context runtime in `org-2`;
3. same user can run user-context MCP list for their own user id;
4. same user is rejected for another user id;
5. user-context Telegram call fails as unavailable before hitting the Telegram DO;
6. project context fails with `Project context is not available`.

### Acceptance

- Route-backed runtime context is no longer org-only.
- Runtime object resolution goes through the kernel.
- Auth/access-token context is the source for org access.
- UI/dev routes can operate from one selected context.

## [ ] Slice 2 — Operation-authorized runtime tools + scoped codemode handles

### Goal

Runtime tools become operation-authorized, and codemode gets scoped handles as the canonical API.

These belong together because scoped handles are only safe once every handle operation goes through
the same runtime-tool authorization path.

### Implement

- Extend `BackofficeRuntimeTool` with:

```ts
requiredOperation: BackofficeOperation;
```

- Add operation names for existing runtime tools, including:
  - MCP read/create/delete/call;
  - file read/write;
  - automation read/write/trigger/route;
  - capability use/manage.
- Wrap runtime tool execution with:

```ts
kernel.assertAllowed({
  actor: context.actor,
  scope: context.scope,
  operation: tool.requiredOperation,
  resource,
});
```

- Add resource extraction where needed, e.g. MCP slug, file path, workflow name.
- Add a kernel test-policy hook so e2e tests can deny a specific operation.
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

- Update generated `codemode.d.ts`, codemode prompts, starter automation files, and tests.
- Bash remains selected-context only. Do not add cross-context bash flags in this slice.

### End-to-end test

Use `runBackofficeCodemode(...)` with route-backed runtime context:

1. `context.org("org-1").mcp.listServers()` hits org MCP object;
2. `context.user("user-1").mcp.listServers()` hits user MCP object;
3. default `mcp.listServers()` hits `context.current` scope;
4. `context.project("project-1").mcp.listServers()` throws project unavailable;
5. with kernel policy denying `mcp.servers.delete` in org scope:
   - `context.org("org-1").mcp.listServers()` succeeds;
   - `context.org("org-1").mcp.deleteServer(...)` returns authorization error;
   - MCP DO delete route is not called.

### Acceptance

- Every runtime tool declares an operation.
- Every runtime tool call is kernel-authorized.
- Codemode can address multiple scopes through handles in one session.
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
