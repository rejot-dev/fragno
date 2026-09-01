# Automation route PATCH authorization needs a Fragment-defined policy hook

Status: Open Date: 2026-09-01

## Summary

Automation routes support partial updates through `PATCH /routes/:routeId`. Authorizing a PATCH
requires the persisted route because omitted fields retain their current values, including trusted
workflow grants.

The current implementation closes the immediate privilege-escalation bug, but bridges Backoffice
middleware and Fragment route handlers through module-scoped `WeakMap<Request, ...>` state in
`app/fragno/automation/route-routes.ts`. That is not an acceptable permanent boundary.

Keep PATCH. Replace the ambient bridge with a Fragment-defined route mutation policy. The Fragment
must own route merge semantics and determine the authority required by the resulting transition. The
integrator must own identity, permission resolution, and mutation attribution.

## The PATCH problem

A persisted route can contain authority that is absent from the request:

```json
{
  "enabled": false,
  "action": {
    "kind": "start_workflow",
    "authority": {
      "kind": "organization-automation",
      "grants": [{ "namespace": "internal", "permission": "manage" }]
    }
  }
}
```

A caller can submit only:

```json
{ "enabled": true }
```

Authorizing `patch.action` is insufficient because it is undefined. The authorization decision must
use the route produced by merging the persisted route with the patch.

The required operation is:

```text
read current route
  -> plan current-to-next transition
  -> authorize the transition and final grants
  -> mutate the authorized plan
```

The authorization must run inside the same optimistic-concurrency attempt as the mutation so a retry
cannot authorize one route state and commit another.

## Current workaround

`app/fragno/automation/route-routes.ts` currently contains request-keyed ambient state:

```ts
const mutationActorsByRequest = new WeakMap<Request, AutomationActors>();
const mutationActionAuthorizerByRequest = new WeakMap<Request, AuthorizeAutomationRouteAction>();
```

Middleware in `app/fragno/automation/automations.ts` installs trusted actors and an authorization
callback. The Fragment route handler retrieves them later using the `Request` object as the key.

The WeakMaps avoid cross-request collisions and do not retain completed requests, but the design has
security and maintenance problems:

- Route correctness depends on hidden middleware execution.
- The data flow does not appear in route or service signatures.
- Correctness depends on middleware and handlers receiving the same `Request` identity.
- Missing state currently falls back to system actors and a no-op authorizer.
- Fragment authors and integrators have no explicit authorization contract.
- Direct route or service usage can accidentally bypass the intended Backoffice boundary.

## Ownership boundary

The permanent design must preserve these responsibilities.

### Fragment author

The Fragment author owns:

- the PATCH schema;
- persisted route retrieval;
- current-to-next merge semantics;
- route transition classification;
- calculation of required route grants;
- scheduling side effects;
- optimistic concurrency;
- invocation of the configured mutation policy before writing.

### Integrator

The integrator owns:

- the concrete request context;
- principal, delegation, and role resolution;
- current permission and revocation checks;
- resource policy;
- authorization denial details;
- trusted mutation actors.

The contract must be inversion of control:

```text
Fragment defines when and what must be authorized.
Integrator defines what authorization means.
```

Integrator middleware must not reimplement Fragment route behavior. Fragment route handlers must not
know about the Backoffice kernel.

## Target policy API

Parameterize the automation fragment config by its application-owned request context and require a
route mutation policy:

```ts
type AutomationRouteMutationPolicy<TRequestContext> = {
  authorize(
    input: AutomationRouteMutationAuthorizationInput<TRequestContext>,
  ): Promise<AutomationRouteMutationAuthorizationResult>;
};

type AutomationRouteMutationAuthorizationInput<TRequestContext> =
  | {
      kind: "create";
      requestContext: TRequestContext;
      routeId: string;
      next: AutomationAuthoredRoute;
      requiredGrants: readonly BackofficePermissionRequirement[];
    }
  | {
      kind: "update";
      requestContext: TRequestContext;
      routeId: string;
      current: AutomationRouteDefinition;
      next: AutomationAuthoredRoute;
      requiredGrants: readonly BackofficePermissionRequirement[];
    };

type AutomationRouteMutationAuthorizationResult =
  | {
      kind: "authorized";
      actors: AutomationActors;
    }
  | {
      kind: "denied";
      code: string;
      message: string;
      status: 403 | 503;
    };
```

The exact names may change. The important properties are:

- The Fragment supplies canonical `current`, `next`, and `requiredGrants` values.
- The integrator receives an opaque generic request context.
- Successful authorization returns trusted actors for persistence.
- Expected denial is an explicit result, not ambient state or an untyped exception.
- There is no allow-all default.

## Plan

### 1. Expose application request context to Fragment route handlers

Fragno currently accepts application context through:

```ts
fragment.handler(request, { requestContext });
fragment.callRoute(method, path, input, { requestContext });
```

Only middleware can read it. Thread `TRequestContext` through route execution so route handlers can
receive:

```ts
handler: async function ({ requestContext, input, pathParams }, output) {
  // requestContext: TRequestContext | undefined
}
```

The change must cover:

- `RequestInputContext`;
- route handler types;
- route factories;
- `handler()` execution;
- `callRoute()` and `callRouteRaw()` execution;
- middleware and handler agreement on the same context value.

`requestContext` remains application-owned and out-of-band. Fragno must never derive it from request
headers or bodies.

Completion criterion: middleware and route handlers receive the same typed context for HTTP and
direct route calls, while an omitted context remains `undefined`.

### 2. Add the route mutation policy to automation fragment configuration

Make `AutomationFragmentConfig` generic over `TRequestContext` and require an
`AutomationRouteMutationPolicy<TRequestContext>` for public route mutations.

There must be no implicit system or allow-all policy. Trusted internal installations must select an
explicit system policy at the call site.

Completion criterion: creating an automation fragment with mutation routes establishes an explicit
policy, and route mutation cannot proceed without request context and policy authorization.

### 3. Extract a canonical route update planner

Create a pure domain operation:

```ts
planAutomationRouteUpdate(current, patch);
```

It must be the single source of truth for:

- applying every PATCH field;
- validating self-reclassification;
- detecting unchanged routes;
- calculating schedule state transitions;
- calculating the grants required by the transition.

Initial grant rules:

| Transition                                      | Required route grants  |
| ----------------------------------------------- | ---------------------- |
| Create a workflow route                         | Final grants           |
| Replace a workflow action                       | Final grants           |
| Change a route trigger                          | Final grants           |
| Enable a disabled route                         | Final grants           |
| Disable a route without changing trigger/action | None                   |
| Change only name or description                 | None                   |
| Remove grants                                   | Remaining final grants |

Completion criterion: storage mutation code consumes the plan and does not independently reimplement
PATCH merge or transition classification.

### 4. Authorize the plan inside the OCC attempt

Update route storage must:

1. Retrieve the persisted route and schedule state.
2. Build the canonical update plan.
3. Invoke the configured policy with the request context and plan requirements.
4. Return a denial without scheduling any writes when authorization fails.
5. Commit the plan using the actors returned by successful authorization.

An OCC retry must retrieve, plan, and authorize again.

Completion criterion: the state authorized by the policy is the state committed by the mutation,
with at most one retrieval round trip and one mutation round trip.

### 5. Apply the policy to route creation

POST route creation must use the same policy contract:

```text
validate complete route
  -> calculate required grants
  -> authorize
  -> create with returned actors
```

Completion criterion: create and update use the same kernel semantics and attribution path.

### 6. Implement the Backoffice policy

Backoffice provides the concrete policy using `BackofficeKernel`:

- require `BACKOFFICE_PERMISSION.router.modify`;
- require every canonical permission in `requiredGrants`;
- resolve principal and delegate authority live;
- observe role changes and revocation;
- map `BackofficeForbiddenError` to an explicit denial result;
- return `requestContext.actors` after successful authorization.

The policy does not accept actors, user IDs, or permission claims from route input.

Completion criterion: Backoffice authorization code is supplied through automation fragment config,
not route-specific ambient state or duplicated HTTP handlers.

### 7. Remove route mutation authorization from outer middleware

After the policy path is active, remove POST/PATCH route authorization and actor attachment from
`app/fragno/automation/automations.ts`.

Store and workflow authorization middleware remain separate concerns.

Completion criterion: Backoffice middleware does not parse or execute automation route creation or
update behavior.

### 8. Remove the top-level ambient items

Delete these items from `app/fragno/automation/route-routes.ts`:

- `SYSTEM_ROUTE_MUTATION_ACTORS`;
- `mutationActorsByRequest`;
- `mutationActionAuthorizerByRequest`;
- `AutomationRouteMutationAuthorizationError`;
- `setAutomationRouteMutationActors()`;
- `setAutomationRouteMutationActionAuthorizer()`;
- `getAutomationRouteMutationActors()`;
- `getAutomationRouteMutationActionAuthorizer()`.

Route handlers must receive request context structurally and services must receive policy results
and actors explicitly.

Completion criterion: `route-routes.ts` contains no module-scoped mutation context and no fail-open
fallback.

### 9. Prevent alternate mutation paths from bypassing policy

Audit direct uses of:

- `automationFragment.services.createRoute()`;
- `automationFragment.services.updateRoute()`;
- route `callRoute()` helpers;
- runtime-tool router adapters;
- starter and Marketplace installation paths.

Public mutation services must require policy authorization or become private commit primitives that
only an authorized route operation can call. Trusted system writes must be explicit.

Completion criterion: every route create/update path either passes through the configured policy or
uses a named, trusted internal operation.

### 10. Add scenario coverage

Required scenarios:

- A caller lacking retained grants cannot reactivate a disabled route.
- A caller lacking retained grants cannot retarget its trigger.
- A caller lacking retained grants cannot replace its script while retaining them.
- A caller can disable a privileged route with `router.modify`.
- A caller can remove authority they no longer hold when the final route requires no such grant.
- A caller holding every final grant can activate and retarget the route.
- Denial leaves route and schedule state unchanged.
- Missing request context fails closed.
- Revocation is observed during an already-running workflow and during later route mutation.
- An OCC retry re-plans and reauthorizes the latest persisted route.
- Direct route and service calls cannot obtain implicit system authorization.

Completion criterion: tests assert final persisted state, not only HTTP status.

## Rejected permanent designs

### Replace PATCH with PUT

A complete PUT body makes grant authorization simpler, but changes the route API, increases stale
full-document overwrite risk, and still does not solve trusted actor propagation by itself.

### Reimplement POST and PATCH in Backoffice middleware

This removes the WeakMaps, but makes the integrator shadow Fragment-owned HTTP behavior, including
validation, service execution, schedule errors, conflict handling, and response shapes. The two
route implementations can drift.

### Shared middleware-to-handler request locals

A request-local primitive is better than a module-global WeakMap, but a shared key would make the
integrator and Fragment coordinate through a hidden transport contract. The explicit Fragment policy
is the contract; request context propagation is framework plumbing.

### Require a complete action on sensitive PATCH requests

This avoids a persisted read during authorization, but gives PATCH a conditional and fragile
contract. Clients must resend unchanged actions, and every execution-affecting field must remain
correctly classified at the HTTP schema boundary.

## Acceptance criteria

This issue is complete when:

- `PATCH /routes/:routeId` remains a partial update API.
- Authorization uses the canonical merged route.
- The Fragment computes transition requirements.
- The integrator supplies authorization policy through explicit configuration.
- Trusted actors come from successful policy authorization.
- Authorization and mutation participate in the same OCC attempt.
- Route creation uses the same policy boundary.
- Route mutation has no module-global request bridge.
- Missing context and missing policy fail closed.
- Existing live revocation behavior remains intact.
- Relevant Backoffice tests, type checks, lint, formatting, and generated codemode checks pass.
