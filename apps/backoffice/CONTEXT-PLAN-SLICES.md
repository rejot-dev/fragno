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

## [x] Slice 3 — Backoffice filesystem principals + simple write permissions

### Goal

Add Backoffice-owned filesystem principals and upload-backed node metadata without making the
workspace behave like a full Unix filesystem.

`packages/fragment-upload` stays a generic upload/blob fragment. Backoffice owns the filesystem view
(`/workspace`, `/system`, `/tmp`, mounted upload providers, codemode, automations), so selected
actor/scope mapping, owner/group/mode metadata, and write enforcement live in Backoffice's
filesystem layer.

During implementation we intentionally simplified the original Unix-like plan:

- read and traversal permissions are always available inside an accessible mount;
- directory execute bits are not enforced;
- directory read bits are not enforced;
- creating new files/folders does not require parent directory write/execute checks;
- existing file mutation checks only whether the current principal can write that specific file;
- `/system` and other read-only mounts are protected by mount-level `readOnly`, not by path policy;
- `/workspace/**` is ordinary workspace content, including `codemode.d.ts`, automation routers, and
  workflow files.

### Implemented

- Added Backoffice filesystem principal types under `apps/backoffice/app/files/permissions.ts`.
  Typed objects are the model; colon-delimited strings exist only as helper-produced keys for
  comparisons/logging if needed.

```ts
type FileSubject =
  | { kind: "root" }
  | { kind: "user"; userId: string }
  | { kind: "automation"; automationId: string; scope: BackofficeContextScope }
  | { kind: "object"; objectType: string; objectId: string; scope: BackofficeContextScope };

type FileGroup =
  | { kind: "root" }
  | { kind: "user"; userId: string }
  | { kind: "org"; orgId: string };

export type FilePrincipal = {
  subject: FileSubject;
  primaryGroup: FileGroup;
  groups: FileGroup[];
};
```

- Added typed comparison helpers instead of stringifying/parsing principals:

```ts
sameFileSubject(left: FileSubject, right: FileSubject): boolean;
sameFileGroup(left: FileGroup, right: FileGroup): boolean;
```

- Added kernel-backed principal mapping:

```ts
kernel.resolveFilePrincipal({ actor, scope }): FilePrincipal
```

Initial mapping:

```txt
user actor in org scope -> subject { kind: "user", userId }, primaryGroup { kind: "org", orgId }, groups [org, user]
user actor in user scope -> subject { kind: "user", userId }, primaryGroup { kind: "user", userId }, groups [user]
system actor -> ROOT_FILE_PRINCIPAL
automation actor -> subject { kind: "automation", automationId, scope }, primaryGroup from selected scope
object actor -> subject { kind: "object", objectType, objectId, scope }, primaryGroup from selected scope
```

- Made filesystem contexts explicit and breaking-change strict:
  - `FilesContext.execution` is required;
  - `FilesContext.kernel` is required;
  - `FilesContext.filePrincipal` is required;
  - `CreateOrgFileSystemOptions.execution` is required;
  - `CreateOrgFileSystemOptions.kernel` is required.
- Added `createSystemFilesContext(...)` for internal seed/setup/test paths that intentionally need a
  system/root filesystem context.
- Threaded the resolved `filePrincipal` into Backoffice filesystem construction and operations:
  - UI file actions/routes;
  - dev codemode state file reads/writes;
  - dashboard/Pi bash master filesystem access;
  - automation script browsing routes;
  - automation Durable Object filesystem access;
  - Pi session filesystems;
  - scenario diagnostics that resolve org filesystems.
- Stored upload-backed filesystem node metadata in Backoffice's upload filesystem layer, extending
  the existing `metadata.__docsFs` shape:

```txt
owner: FileSubject
group: FileGroup
mode: number
mtime?: string
```

- Parsed persisted `__docsFs.owner` and `__docsFs.group` through Zod schemas instead of bespoke
  object parsers.
- File create/write creates metadata when no file exists:
  - owner: `filePrincipal.subject`;
  - group: `filePrincipal.primaryGroup`;
  - mode: `0664` default.
- Directory marker creation creates metadata:
  - owner: `filePrincipal.subject`;
  - group: `filePrincipal.primaryGroup`;
  - mode: `0755` default.
- Owner/group/mode are preserved across rewrites unless an explicit chmod/chown operation changes
  them.
- Simplified permission helpers to write-only semantics:

```ts
hasFileWritePermission(principal, node): boolean;
assertFileWritable({ principal, node, operation, path }): void;
```

- Upload-backed enforcement now checks only existing file mutations:

```txt
read file: always allowed within accessible mount
list directory: always allowed within accessible mount
traverse directory: always allowed within accessible mount
create file/folder: allowed if mount is writable; creates metadata for the new node
write existing file: requires write permission on that file's owner/group/other write bits
append existing file: same as write through writeFile
utimes existing node: requires write permission on that node
remove existing file: requires write permission on that file
recursive remove directory: requires write permission for each real file being deleted
chmod: root or owner
chown: root only
root: bypasses write permission bits
```

- Directory marker modes are metadata/display only. They do not gate reading, traversal, creation,
  or deletion.
- Kept `chown` support only where the Backoffice filesystem needs it. Unsupported POSIX surface area
  was not added just to be complete.
- Removed the protected executable/system path classifier from the filesystem layer:
  - `/system/**` is already protected by read-only mounts;
  - `/workspace/codemode.d.ts`, `/workspace/automations/router.cm.js`, and
    `/workspace/automations/**/*.workflow.js` are normal workspace files;
  - successful mutation of those files requires the same write metadata as any other workspace file,
    not an extra `files.manageExecutable` semantic permission.
- Raw upload fragment routes remain generic. Backoffice workspace/system files are expected to be
  mutated through Backoffice file APIs, codemode, runtime tools, or internal system setup paths
  rather than by trusting arbitrary public upload headers.

### Verified

Tested the simplified model through the Backoffice mounted filesystem and upload-backed workspace
contributor:

```sh
pnpm run format:changed
pnpm exec turbo types:check --filter=./apps/backoffice --output-logs=errors-only
pnpm exec turbo test --filter=./apps/backoffice -- --run app/files/master-file-system.test.ts app/files/contributors/upload.test.ts --reporter=dot
```

Covered by tests/plumbing:

1. authenticated user writes `/workspace/notes.md`; stored filesystem metadata has owner
   `{ kind: "user", userId }`, expected group object, and default file mode `0664`;
2. internal seed/setup paths can use explicit system/root filesystem contexts;
3. owner can write their file;
4. different user in the same org can write a group-writable `0664` file;
5. user outside the owning group cannot write unless other-write allows it;
6. reads and directory traversal ignore read/execute bits, including directories with mode `0000`;
7. root can read/write regardless of write bits;
8. non-root cannot chown;
9. chmod remains owner/root-only;
10. executable-looking workspace paths such as `/workspace/automations/router.cm.js` are normal
    writable files and do not trigger semantic protected-path authorization.

### Acceptance status

- Backoffice request/runtime paths that represent a selected user/object/automation now pass an
  execution context and no longer accidentally write as root.
- Backoffice's mounted filesystem stores owner/group/mode metadata for upload-backed workspace
  files.
- Upload-backed workspace enforcement is intentionally simple: reads/traversal are allowed, while
  existing file mutations require write permission on the specific file being mutated.
- `/system` protection comes from read-only mounts.
- `/workspace/**` remains modifiable workspace content as long as the mount is writable and the
  file's write metadata allows the mutation.
- `packages/fragment-upload` remains generic upload storage and does not own Backoffice filesystem
  principals.

## [x] Slice 4 — Scoped automations and explicit event routing

### Goal

Make automation execution selected-scope aware and authorize explicit cross-scope routing.

This slice makes automation events explicitly scoped. `AutomationEvent.scope` is now the required
selected-context source of truth for runtime execution, object routing, filesystem access, and
emitted events. Top-level automation-event `orgId` compatibility has been removed.

### Implemented

- Made selected `scope` required on `AutomationEvent` and added `targetScope` to `event.emit`
  inputs.
- Removed top-level automation-event `orgId` compatibility. Event producers, tests, scenarios, and
  generated emitted events now use explicit scoped events.
- Added automation execution helpers that turn `event.scope` into `BackofficeExecutionContext`.
- Runtime automation contexts now use `BackofficeExecutionContext` instead of constructing an
  org-only context from event metadata.
- Automation object resolution for emitted events now targets the selected scope through the kernel:
  - org scope -> org automations;
  - user scope -> user automations;
  - system scope -> singleton automations;
  - project scope -> kernel-gated unavailable context.
- Automation filesystem resolver inputs now receive the selected execution context instead of an
  org-id-only input. In-memory/scenario plumbing resolves org filesystems from that context.
- `event.emit` defaults to the current event scope and accepts explicit `targetScope` for routing.
- Cross-scope emits perform an additional authorization check for
  `{ namespace: "event", permission: "route" }` before enqueueing the target automation event.
- Denied cross-scope emits fail before calling the target Automations Durable Object.
- Router/workflow files remain normal workspace files. Editing them stays controlled by workspace
  write metadata; routing authorization is runtime behavior.

### Verified

```sh
pnpm --dir apps/backoffice exec vitest run app/fragno/runtime-tools/families/event-runtime.test.ts
pnpm --dir apps/backoffice exec vitest run app/fragno/automation/scenario-system-automations.test.ts
pnpm exec turbo types:check --filter=@fragno-apps/backoffice-rr --output-logs=errors-only
pnpm exec turbo test --filter=@fragno-apps/backoffice-rr --output-logs=errors-only
```

### Acceptance status

- Automation execution is no longer hard-coded to org scope; every automation event has an explicit
  selected scope.
- Event flow supports explicit router behavior through `targetScope`.
- Cross-scope routing is operation-authorized with `event.route`.
- Legacy top-level `orgId` automation events are no longer supported.

## [ ] Slice 5 — Cleanup: remove org-only model remnants

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
