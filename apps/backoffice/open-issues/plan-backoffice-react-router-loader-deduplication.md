# Backoffice React Router loader deduplication plan

Status: in progress

Created: August 30, 2026

Last updated: September 1, 2026

## Implementation progress

Completed:

- Request-scoped authentication state is installed for every HTTP request.
- JWT verification, principal derivation, and `getBackofficeMe` are lazy and promise-coalesced.
- Protected Backoffice authentication runs in layout middleware before descendant route handlers.
- Shell scope resolution, organization-switch redirects, authorization, and execution-context
  creation run in middleware.
- The layout returns `resolvedScope` as first-class data, and shell navigation no longer derives
  scope identity from an Automations adapter source.
- Automations collection-source loading is promise-coalesced by canonical scope within one HTTP
  request. Equivalent organization identities share an operation; organization and project scopes
  remain distinct; rejected operations are shared.

Pending:

- The global Backoffice layout still initializes Automations collection sources. Route ownership
  must move to Automations, Files, and Marketplace boundaries before unrelated pages issue zero
  `/_internal` requests.
- The project selector and workflow drawer still depend on layout-owned collection sources. They
  need focused resource routes and keyed fetchers before global loading can be removed.
- Project lookup, integration configuration, list/detail, and redirect cleanup remain outstanding.
- Representative traces have not yet been compared against the target operation counts.

Verification on September 1, 2026:

- Backoffice production build, type checking, and package lint pass.
- The full Backoffice suite passes: 308 test files, 1,944 passing tests, one expected failure, and
  one skipped test.

## Goal

Reduce duplicated authentication, scope resolution, Durable Object initialization, and integration
queries across matched Backoffice route loaders while preserving React Router's parallel loader
model, automatic revalidation, SSR, error boundaries, and route-level data ownership.

This plan covers:

- **P0:** request-scoped authoritative operations
- **P2:** separating resolved scope from Automations collection-source loading
- **P3:** assigning guards and data operations to the correct route boundaries

Revalidation policy tuning is deliberately deferred until these structural changes are measured.

## React Router assessment

Backoffice is a React Router **Framework Mode** application:

- `@react-router/dev` and the Vite route-module build are installed.
- Routes are declared in `apps/backoffice/app/routes.ts`.
- Route modules use generated `./+types/*` types.
- `react-router.config.ts` enables SSR.
- The installed React Router version is `8.2.0`.
- `workers/app.ts` creates one `RouterContextProvider` for each HTTP request.

The relevant installed documentation is:

- `react-router/docs/start/framework/routing.md`
- `react-router/docs/start/framework/route-module.md`
- `react-router/docs/start/framework/data-loading.md`
- `react-router/docs/how-to/middleware.md`
- `react-router/docs/how-to/suspense.md`
- `react-router/docs/how-to/fetchers.md`
- `react-router/docs/how-to/optimize-revalidation.md`
- `react-router/docs/how-to/resource-routes.md`
- `react-router/docs/explanation/form-vs-fetcher.md`
- `react-router/docs/explanation/state-management.md`

### Conclusions from the React Router model

1. **P0 is directly aligned with React Router.** `RouterContextProvider` exists to carry type-safe
   request state into middleware, loaders, and actions. Server middleware runs before route
   handlers, and the same request context is available to the matched loaders. A request-scoped
   object containing memoized promises is the correct place to coalesce authoritative server
   operations.

2. **Middleware should own prerequisites that must run before descendant loaders.** Parent loaders
   do not guard child loaders: matched loaders execute independently and may execute in parallel.
   Authentication, admin checks, scope establishment, and configured-integration gates belong in
   middleware when failure must prevent descendant loader work.

3. **Parent loader data is for rendering, not server-to-server loader dependencies.** Descendant
   components can consume ancestor loader data through component `matches`, `useRouteLoaderData`, or
   outlet context. Descendant loaders cannot depend on a parent loader completing first. Shared
   server operations must instead come from request context.

4. **P2 is sound only if route data remains in React Router.** The shell's resolved scope should be
   critical loader data. Non-critical visible data can be a loader-returned promise rendered under
   Suspense. Interaction-triggered global UI, such as a closed workflow drawer or unopened project
   selector, should use a typed fetcher/resource route instead of an ad hoc `useEffect` fetch or a
   permanent client cache.

5. **P3 needs both route ownership and request coalescing.** Moving a query between parent and child
   loaders does not by itself remove duplication because the loaders remain independent. UI data
   should have one route owner; shared prerequisites and operations should be promise-coalesced in
   request context.

6. **Request sharing ends at the HTTP request boundary.** An SPA mutation can use separate action
   and loader/revalidation requests. Each request receives a new `RouterContextProvider`, so P0
   coalesces work within one document or `.data` request, not across requests. That is the desired
   consistency boundary.

7. **Do not begin with broad `shouldRevalidate` overrides.** Framework Mode intentionally
   revalidates server data aggressively, especially after mutations and search-param changes.
   Structural deduplication makes those revalidations cheap while preserving freshness.
   Route-specific opt-outs can follow measurements later.

## Target architecture

```text
Cloudflare Worker request
  -> create RouterContextProvider
  -> set BackofficeWorkerContext
  -> set BackofficeRequestStateContext
       -> credential()
       -> principal()
       -> me()
       -> shellScope()
       -> project(orgId, projectId)
       -> getAutomationCollectionSource(scope)
       -> integrationConfig(integration, scope)
       -> githubLinkedRepositories(orgId)
       -> ...named request operations
  -> React Router middleware chain
       -> establish protected shell context
       -> establish narrower route prerequisites
  -> matched loaders in parallel
       -> read established contexts
       -> await named request operations
       -> return only data owned by their route component
```

The request state is an imperative request boundary around named, authoritative operations. It is
not a generic cache and is not browser state.

## P0: Request-scoped authoritative operations

### P0.1 Define the request-state boundary

Add a focused server-only module, for example:

```text
apps/backoffice/app/worker-runtime/request-state.server.ts
```

Define:

- `BackofficeRequestStateContext` using React Router `createContext` with no default value.
- `createBackofficeRequestState(...)` at the Worker request boundary.
- A small interface exposing named operations rather than mutable fields or string-keyed cache APIs.

Initial operations:

```ts
type BackofficeRequestState = {
  resolveAuthentication(): Promise<BackofficeAuthenticationResult>;
  getPrincipal(): Promise<BackofficePrincipalResult>;
  getBackofficeMe(): Promise<BackofficeMeLookupResult>;
};
```

Implementation rules:

- Construct each promise lazily on first use.
- Share the same settled value or failure for the remainder of the request.
- Parse token transport once.
- Verify the JWT once.
- Derive principal and expiration from the canonical verification result.
- Call `authObject.commands.getBackofficeMe` at most once.
- Keep the JWKS isolate cache as the authority for key material; request state only coalesces one
  request's verification.
- Keep authentication failures explicit and preserve current cookie-expiry headers and error codes.
- Do not expose a generic `memo(key, callback)` API.

### P0.2 Seed the request state in the Worker

Update `apps/backoffice/workers/app.ts` alongside `BackofficeWorkerContext` setup:

- Construct one request state from the incoming `Request` and resolved runtime services.
- Store it in `RouterContextProvider` before calling `requestHandler`.
- Keep this initialization valid for HTML document, `.data`, action, fetcher, and API resource
  requests.

Tests that construct `RouterContextProvider` directly must use a canonical test helper that installs
both Worker and request-state contexts.

### P0.3 Route every authentication helper through request state

Refactor these modules to consume the canonical operations:

- `app/fragno/auth/request-auth.server.ts`
- `app/fragno/auth/auth-server.ts`
- `app/fragno/auth/backoffice-principal.server.ts`

Preserve the public behavior of:

- `getBackofficeMe`
- `findBackofficeMe`
- `requireBackofficeMe`
- `requireBackofficePrincipal`
- `authorizeBackofficePrincipal`
- `requireBackofficeContext`
- `authorizeBackofficeContext`

The helpers may retain their existing signatures during migration, but `request` must be validated
against or delegated to the request state rather than causing another credential resolution.

### P0.4 Establish protected Backoffice authentication in middleware

Add server middleware to `layouts/backoffice-layout.tsx`:

- Await the request state's authenticated `BackofficeMe` once.
- Preserve the current bootstrap redirect behavior.
- Store a typed authenticated-shell value in a second context, for example
  `BackofficeAuthenticatedRequestContext`.
- Keep the loader exported so server middleware runs on client navigations involving this layout.

The layout loader should read the established context rather than invoking `getBackofficeMe` again.

Do not place authentication middleware at `app/root.tsx`; login, sign-up, bootstrap, public forms,
and external API/resource routes have different authentication behavior.

### P0.5 Make nested authorization reuse the established principal

Update these helpers to derive executions from the cached principal:

- `requireAutomationRouteExecution`
- `resolveAuthenticatedIntegrationRuntimeScope`
- `resolveAuthenticatedOrgIntegrationRuntimeScope`
- `resolveAuthenticatedIntegrationContext`
- `resolveAuthenticatedOrgIntegrationContext`
- `requireUploadRouteOrganization`
- `resolveAuthorizedFilesRouteScope`

Full membership loading remains available where a route genuinely needs organization discovery or
labels, but repeated callers receive the same `BackofficeMe` promise.

### P0 tests

Add focused tests around the request-state primitive:

- Concurrent principal and me requests perform one JWT verification.
- Concurrent `findBackofficeMe` and `requireBackofficeMe` calls perform one Auth DO command.
- Missing, malformed, expired, and invalid credentials preserve current results and headers.
- A rejected Auth DO command is shared and not retried inside the same request.
- Cookie and bearer transports retain precedence rules.
- Separate `RouterContextProvider` instances do not share request promises.

Update representative route tests to assert operation counts for:

- automations events catalog
- organization billing
- internals workflow detail

### P0 completion criteria

- One HTTP request verifies its Backoffice JWT at most once.
- One HTTP request calls `getBackofficeMe` at most once.
- Existing auth helper behavior and response headers remain unchanged.
- No loader-owned module-level request cache is introduced.
- Traces show one authentication operation regardless of matched-loader depth.

## P2: Separate resolved scope from collection-source loading

### P2.1 Establish shell scope before loaders

Extend Backoffice layout middleware to perform the current shell-scope work once:

- validate active-organization consistency
- resolve URL params against authenticated memberships
- select the default scope
- enforce organization-switch redirects
- create the Backoffice execution context

Store a serializable request value such as:

```ts
type BackofficeShellRequest = {
  me: BackofficeMeData;
  principal: BackofficeAuthPrincipal;
  resolvedScope: BackofficeResolvedScope<Organization>;
  runtimeScope: BackofficeContextScope;
  execution: BackofficeExecutionContext;
  accessTokenExpiresAt: Date;
};
```

The object should contain no Automations adapter identity.

### P2.2 Return resolved scope as first-class layout data

Change `layouts/backoffice-layout.tsx` to return:

- `me`
- `accessTokenExpiresAt`
- `resolvedScope`

Update:

- `layouts/backoffice-layout-ui.tsx`
- `components/backoffice/current-context-state.ts`
- `components/backoffice/shell.tsx`
- `components/backoffice/top-bar.tsx`

The shell, sidebar, account menu, terminal scope, current organization, and current project label
must derive from `resolvedScope`, not `automationCollectionSource`.

This makes scope identity available even when Automations synchronization is unavailable.

### P2.3 Move collection-source loading to named request operations

Add request-state operations keyed by canonical runtime scope:

```ts
getAutomationCollectionSource<TOrganization extends BackofficeOrganizationIdentity>(
  resolvedScope: BackofficeResolvedScope<TOrganization>,
): Promise<AutomationCollectionSource<TOrganization>>;
```

Implementation status: request-scoped coalescing is complete. The operation calls the underlying
Automations adapter-description loader once per canonical scope. Project and organization source
requests remain distinct keys, rejected promises are shared, and separate HTTP requests remain
isolated.

Route ownership remains pending:

- `automations/scope-layout.tsx` owns the current automation collection source.
- `files/scope-layout.tsx` owns the automation source needed for workflow file routing.
- `marketplace/detail.tsx` owns the installation source it already renders.
- Other routes do not initiate an Automations collection-source request merely because they use the
  Backoffice shell.

### P2.4 Load global widgets through React Router mechanisms

The global project selector and workflow drawer must not force every page loader to initialize
Automations.

Use focused resource routes and keyed fetchers:

- Project options load when the project selector opens.
- Recent workflows load when the workflow drawer opens.
- Fetcher keys are stable per scope so repeated mounts share the active fetcher state.
- Resource routes use the same request-state operations and authorization contexts.
- Resource responses contain only the data required by the widget.

If a widget becomes product-critical before interaction, use a loader-returned promise and Suspense
rather than awaiting it in the critical layout path. Streaming is a latency technique, not
permission to restore unconditional background work.

### P2.5 Remove collection source from global current-context authority

Replace the current context shape:

```ts
{
  automationCollectionSource,
  projectCollectionSource,
}
```

with a shape where scope and optional route-owned synchronization are distinct:

```ts
{
  resolvedScope,
  automationCollectionSource,
}
```

The exact client type should make loading ownership explicit. A route that does not own an
Automations source must not fabricate an unavailable source merely to carry scope identity.

### P2 tests

- Settings, billing, sessions, integrations, internals, and redirect-only routes do not call
  Automations `/_internal` during initial loading.
- Organization-scoped automation pages call it once.
- Project-scoped automation pages call only the sources their rendered local-first databases need.
- Files workflow routing receives the same source behavior after moving ownership.
- Marketplace installation source remains correct for user, organization, and project targets.
- The shell renders correct scope navigation when Automations is unavailable.
- Project selector and workflow drawer resource loaders authorize the requested scope.

### P2 completion criteria

- `BackofficeShell` receives `resolvedScope` directly.
- No shell component derives route identity from adapter identity.
- Unrelated Backoffice pages issue zero Automations `/_internal` calls.
- Route-owned collection sources are coalesced once per scope per request.
- Global widget loading uses loader promises or fetchers, not ad hoc effect fetching.

## P3: Assign guards and data to route boundaries

### Ownership rules

Apply these rules to every nested loader family:

1. **Middleware owns prerequisites.** Use middleware for auth, admin checks, scope validity, and
   configuration gates that must stop all descendant loader work.

2. **The lowest common route owns shared UI data.** Data rendered by a parent split view belongs to
   that parent loader. Descendant components read it from typed matches or outlet context.

3. **Leaf loaders own leaf data.** Detail, pagination, and selected-record queries remain in the
   leaf route that renders them.

4. **Request state owns repeated server operations.** If independent loaders need the same
   authoritative operation, both call the same named request operation and receive one promise.

5. **A parent loader is not a descendant-loader guard.** Do not rely on a parent redirect or error
   to prevent child loader execution.

6. **Redirect-only loaders perform no duplicated authorization or configuration I/O.** They rely on
   established middleware and return a deterministic redirect.

### P3.1 Consolidate Backoffice scope resolution

Introduce a named request operation for route scope selection, keyed by canonical route params:

- parse route scope once
- validate it against the cached `BackofficeMe`
- perform one project lookup when project-scoped
- return resolved selection, runtime scope, and project metadata

Migrate:

- automations scope layout
- marketplace scope layout and children
- files scope layout and explorer/download helpers
- sessions scope layout
- internals scope loaders
- integration scope helpers

The operation must preserve allowed-scope constraints at each boundary instead of weakening every
route to the broadest scope.

### P3.2 Add configured-integration middleware boundaries

Restructure integration route trees where configuration is a prerequisite for descendant data. Use
pathless layout routes when a middleware boundary should not add a URL segment.

Example shape:

```text
integration shell layout
├─ configuration
└─ configured boundary middleware
   ├─ list route
   │  └─ detail route
   └─ other configured routes
```

The configured middleware:

- resolves the authenticated integration scope
- obtains configuration through a named request-state operation
- redirects to configuration before descendant loaders run
- stores typed integration prerequisite data in context

Apply first to:

- Resend
- GitHub repositories
- Telegram messages
- Reson8 custom models and transcribe
- Upload files

### P3.3 Remove duplicated integration configuration calls

Define named request operations for:

- Resend config by runtime scope
- Telegram config by runtime scope
- GitHub admin config by organization and origin
- Reson8 config by organization
- Upload config by organization

Migrate parent layouts, middleware, children, and actions to these operations. Once coalescing is in
place, remove redundant child fetches whose data is already available through middleware or parent
loader data.

Expected route-specific cleanup:

- Resend outgoing index no longer performs a third config request.
- Telegram organization index does not repeat config solely to redirect.
- Upload files does not reload organization membership and config after the parent boundary.
- Reson8 children do not reload complete `BackofficeMe` for organization identity.

### P3.4 Give list/detail routes direct ownership

#### GitHub repositories

- Repositories layout owns the linked-repository list.
- Repository detail owns pull-request data.
- Add a direct linked-repository lookup by repository ID, or use one request-coalesced list lookup.
- Remove the current third full-list fetch from repository detail.

#### Resend

- Domains, incoming, outgoing, and threads layouts own their lists.
- Detail routes own only detail records.
- Configuration gates move to middleware.
- Index redirects do not fetch configuration again.

#### Telegram

- Messages layout owns chats.
- Message detail owns thread messages.
- Configuration gates move to middleware.

#### Internals workflows

- Workflow list route owns summaries.
- Workflow detail route owns detail.
- Both consume one established admin principal and scope.
- Do not merge list and detail queries merely to reduce loader count.

### P3.5 Simplify organization, files, marketplace, and Upload routes

- Organization billing obtains organization identity from established request scope instead of
  loading `BackofficeMe` independently of organization layout.
- Files scope and explorer use one request-scoped scope selection and one project lookup.
- Marketplace scope and `my-listings` use one project lookup.
- Marketplace detail reuses an existing organization collection-source operation when its
  installation organization matches an already requested source.
- Upload organization layout and files share one organization/config prerequisite.

### P3.6 Remove redundant redirect work

Audit these redirect families:

- `/backoffice`
- automations, files, marketplace, sessions, and internals entry routes
- automation and marketplace scope indexes
- integration organization indexes
- Resend threads/outgoing indexes
- Upload uploads redirect

Keep redirect loaders where the redirect is URL behavior, but remove auth/config calls already
established by middleware. Where a redirect depends on configuration, put the condition in the
configured middleware or the one route that owns that decision.

### P3 tests

Use existing route and data-helper tests rather than one giant route-tree integration test.

Add scenario assertions for:

- middleware failure prevents descendant data operations
- configured integration executes one config operation
- GitHub repository detail executes one linked-repository operation
- project-scoped files execute one project lookup
- project-scoped marketplace `my-listings` executes one project lookup
- internals workflow detail executes one auth snapshot while preserving separate list/detail calls
- redirect-only routes perform no domain reads beyond the redirect prerequisite

### P3 completion criteria

- Parent/child loaders do not issue duplicate configuration commands.
- Project lookup occurs once per project per request.
- GitHub linked repositories are loaded at most once per request.
- Middleware guards prevent unauthorized or unconfigured descendant loader work.
- Parent loader data is consumed by components through typed React Router match/outlet APIs.
- No descendant loader waits for or attempts to read another loader's server result.

## Delivery sequence

Implement as independently deployable slices:

1. [x] P0 request-state primitive and auth coalescing.
2. [x] Backoffice authentication middleware using the coalesced state.
3. [x] First-class shell `resolvedScope` with existing collection-source behavior retained
       temporarily.
4. [ ] Route-owned Automations collection sources. Request-state coalescing is complete; ownership
       migration is pending.
5. [ ] Fetcher/resource loading for project selector and workflow drawer.
6. [ ] Request-scoped project and integration config operations.
7. [ ] Configured-integration middleware boundaries, one integration family at a time.
8. [ ] List/detail and redirect cleanup.
9. [ ] Deploy and compare traces after every slice.

Do not combine all route-tree changes into one migration.

## Measurement plan

Use the named React Router route spans and Fragno database transaction spans to compare:

- JWT verification count
- Auth `getBackofficeMe` command count
- Automations `/_internal` count
- project lookup count
- integration config command count
- list-fetch count
- Worker and Durable Object invocation count
- page wall time and CPU time

Representative traces:

1. `/backoffice/automations/org/:slug/events-catalog`
2. `/backoffice/automations/project/:scopeId/dashboard`
3. GitHub repository detail
4. Resend outgoing index and email detail
5. project-scoped files explorer
6. project-scoped marketplace `my-listings`
7. internals workflow detail
8. organization billing
9. settings
10. sessions detail

Target steady-state counts:

| Route                     | JWT verification | `BackofficeMe` | Automations `/_internal` |
| ------------------------- | ---------------: | -------------: | -----------------------: |
| Events catalog            |                1 |              1 |                        1 |
| GitHub repository detail  |                1 |              1 |                        0 |
| Organization billing      |                1 |              1 |                        0 |
| Settings                  |                1 |              1 |                        0 |
| Internals workflow detail |                1 |              1 |                        0 |

Project-scoped automation and files routes may legitimately require both project and organization
collection sources. Each canonical source must still execute at most once per request.

## Non-goals

- Browser caching of JWKS or trusted authorization state.
- Cross-request caching of user memberships or authorization decisions.
- Replacing React Router loaders with component `useEffect` fetching.
- Serializing child loaders behind parent loaders.
- Disabling automatic revalidation globally.
- Combining independently useful list and detail queries into one oversized response.
- Introducing a generic request cache with arbitrary string keys.

## Final acceptance criteria

- Every request has one authoritative credential verification and one membership snapshot.
- Protected Backoffice prerequisites are established through React Router middleware/context.
- Resolved scope is independent from Automations adapter identity.
- Unrelated pages no longer initialize the Automations Durable Object.
- Shared server operations are named, typed, and promise-coalesced per request.
- Route components receive data from the route that owns it.
- Descendant loaders are protected by middleware rather than parent-loader timing.
- Representative traces confirm the predicted operation-count reductions.
- Backoffice type checks and targeted route/auth tests pass after each delivery slice.
