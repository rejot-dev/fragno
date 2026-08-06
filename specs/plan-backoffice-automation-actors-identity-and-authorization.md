# Plan: Backoffice automation actors, identity bindings, tracing, and authorization

## Goal

Make actor provenance a trusted execution property rather than user-authored input.

A Telegram action should remain attributable through this complete flow:

```text
Telegram chat
  -> automation workflow
  -> resolved Backoffice user
  -> Pi session/agent
  -> runtime tool call
  -> Durable Object RPC
  -> durable hook and retry
```

The same execution context should eventually drive authorization decisions such as:

```text
May this linked user, through this automation and Pi agent, call telegram.sendChatAction for this
chat in this organization?
```

The implementation must preserve Fragno's existing trace propagation, remain testable without a
Cloudflare trace backend, and be delivered as independently useful vertical slices covered by the
Backoffice scenario utilities.

## Fixed decisions

- Actor and provenance-object types remain owned by the Automations domain.
- `AutomationEvent.actor` is removed. `AutomationEvent.actors` is the only event provenance field
  and is a structured `AutomationActors` object, not a heterogeneous array.
- The Backoffice kernel validates and authorizes the trusted `BackofficeExecutionContext` used for
  actual function and tool calls; callers cannot replace or enrich its actor provenance.
- User-authored workflows cannot supply or override actors, principals, execution context, or trace
  metadata.
- `store.set` no longer accepts an actor.
- Store categories are labels, not authorization or protection mechanisms.
- External identity bindings belong to one dedicated Automations table. Domain workflows keep their
  own claim-to-workflow correlation as ordinary orchestration state.
- Trace propagation and trusted execution propagation are separate concepts. W3C
  `traceparent`/`tracestate` remain opaque telemetry. `BackofficeRpcContext` carries telemetry only;
  sensitive RPCs use `BackofficeActionRpcContext`, which additionally requires trusted execution.
  Actor provenance otherwise crosses durable boundaries only in typed Backoffice-owned envelopes.
- Production authority resolution is mandatory for sensitive actions. Missing, unavailable, or
  failed resolution denies with a stable reason; observers and tracing never substitute for it.
- Public HTTP headers and request bodies cannot carry trusted Backoffice execution context. Pi and
  other internal boundaries use explicit Durable Object RPC methods that accept typed context.
- Deferred external effects are reauthorized immediately before every attempt, including retries.
  Enqueue authorization alone never authorizes the later side effect.
- Pi sessions persist trusted execution authority: a user principal for user-created sessions, a
  stable automation principal for organization-owned automation sessions, or an explicit service
  principal for trusted infrastructure. The session stores actors, never a permission snapshot.
  Public request flows resolve the requested Pi permission from a verified JWT's role and
  organization snapshot. Trusted internal calls resolve current authority from explicit execution
  context. Pi operations do not compare the caller with the persisted principal. Sensitive tools
  resolve the persisted principal's current permissions whenever they execute.
- External identity bind, active-resolution, and revoke operations execute through `kernel.invoke()`
  inside the owning Automations object; persistence services are not standalone authorization
  boundaries.
- Trusted Automations route calls use one generic `fetchWithContext(request, context)` RPC. The
  route caller carries `BackofficeActionRpcContext` as a separate RPC argument, never as HTTP
  headers. The Automations object derives operation and resource policy for sensitive routes before
  executing the ordinary route handler. The scope-aware Automations proxy exposes outbox routes only
  and cannot forward raw fragment mutation routes. The separate organization workflow proxy forwards
  directly to the workflows fragment.
- The Worker constructs one immutable request kernel in `BackofficeWorkerContext`; each Durable
  Object retains its own kernel. `BackofficeRuntimeServices` contains dependencies, not the kernel.
- Immediate authenticated user actions trust the role and organization snapshot from the verified
  Backoffice access token until its 15-minute expiry. System authority requires the token's `admin`
  role. Executions without token authority, including deferred work and retries, resolve current
  authority from Auth; actor provenance never grants user authority.
- User-delegated work retains the user as principal and stops when that user is banned or loses the
  required membership. Organization-owned automations execute as their own stable automation
  principal and continue independently of the user who created or configured them. Creator identity
  is attribution, not runtime authority. Disabling the automation or revoking its grants stops it.
- Missing principal provenance never implicitly promotes an execution into organization-owned
  authority. The automation definition or another trusted runtime-owned record must explicitly name
  its authority mode before execution begins.
- Scenario tests exercise the same trusted RPC and retry entry points as production. Fakes cannot
  accept context through a channel that production ignores.

## Baseline problems and remaining debt

This section records the problems that motivated the plan. Items marked resolved describe historical
behavior retained for review context; unchecked vertical slices below remain the source of truth for
outstanding work.

### Event actor duplication — resolved in Slice 1

[`AutomationEvent`](../apps/backoffice/app/fragno/automation/contracts.ts) previously contained both
`actor` and `actors`. Producers and consumers had to keep them synchronized, and many workflows read
only `event.actor`.

The duplicate field appeared in:

- event persistence in [`schema.ts`](../apps/backoffice/app/fragno/automation/schema.ts);
- event ingestion in [`definition.ts`](../apps/backoffice/app/fragno/automation/definition.ts);
- event APIs in [`event-routes.ts`](../apps/backoffice/app/fragno/automation/event-routes.ts);
- emitted-event inheritance in
  [`event-runtime.ts`](../apps/backoffice/app/fragno/runtime-tools/families/event-runtime.ts);
- starter workflow source in
  [`starter-automations.ts`](../apps/backoffice/app/files/content/starter-automations.ts);
- route matchers such as `$.actor.source` in
  [`starter-routing.ts`](../apps/backoffice/app/fragno/automation/content/starter-routing.ts).

### User-controlled attribution — resolved in Slice 3

`store.set` previously accepted `actor` in its public schema and command-line adapter:

- [`store.ts`](../apps/backoffice/app/fragno/automation/store.ts)
- [`automation-types.ts`](../apps/backoffice/app/fragno/runtime-tools/automation-types.ts)
- [`automations-bindings.ts`](../apps/backoffice/app/fragno/runtime-tools/families/automations-bindings.ts)

A user-authored automation could therefore attribute a write to any user or external actor.

### Categories acting as security metadata — resolved in Slice 3

The generic store previously protected entries containing the `system` category in
[`bindings-storage-runtime.ts`](../apps/backoffice/app/fragno/automation/bindings-storage-runtime.ts).
The category itself was supplied by callers, making it unsuitable for protecting identity, workflow
coordination, ownership, or other trusted state.

### Identity binding remains stored as user-writable KV state

The Telegram starter workflow stores:

```text
telegram/<chatId> -> <userId>
```

inside the generic automation store. The same user-authored workflow performs the binding after OTP
confirmation. This gives editable automation code control over a security-relevant identity
association.

### Single-actor authorization — structurally resolved; authority-mode implementation remains

Workflow and tool execution now carry the complete `BackofficeExecutionContext`, so the initiator,
principal, and ordered delegation are available to the kernel. The target ownership rule is now
explicit: user-delegated work preserves the user principal, while organization-owned automations use
a stable automation principal independent of their creator. The remaining debt is to persist or
otherwise establish that authority mode at a trusted automation-definition boundary. Until then,
`createAutomationRuntimeExecution()` still infers automation authority when a non-system event has
no principal, which must not become the final ownership rule. See **Automation authority ownership**
under Open decisions.

## Failure modes this plan must prevent

These are acceptance constraints, not implementation details that may be deferred:

1. **Unavailable authority cannot allow.** Every kernel requires an authority resolver. A resolver
   that fails or cannot reach its authority source denies every sensitive
   principal/delegate/assistant action, and production wiring proves current membership revocation
   is observed.
2. **Pi provenance cannot use a public header.** Production and fake Pi objects consume execution
   context through the same trusted internal RPC. Public `fetch()` neither trusts nor forwards
   `x-backoffice-execution-context` or an equivalent actor header.
3. **Session routing does not replace Pi permissions.** Automations may select and persist Pi
   session IDs according to their routing semantics, but public callers must still present a
   verified JWT whose role grants the requested Pi permission at the current scope. The referenced
   session retains the trusted execution principal established at creation, and sensitive tools
   resolve that principal's current permissions. Pi operations do not require equality between the
   caller and the persisted principal.
4. **Deferred Telegram delivery is a fresh authorization attempt.** Every send/edit attempt restores
   its typed execution envelope and wraps the external API call in `kernel.invoke()`. Revocation
   after enqueue prevents delivery.
5. **Actor shape is structural.** `actors.initiator` and nullable `actors.principal` are dedicated
   fields; only `actors.delegation` is ordered. Routing matches an explicit participation slot and
   never searches a heterogeneous actor array.
6. **Identity mutations cannot bypass the kernel.** Bind/revoke RPCs require trusted execution
   context and authorize inside the Automations object before persistence.
7. **Generic tracing never inspects arbitrary hook payloads.** Actor diagnostics come from explicit
   typed kernel observations, not `Reflect.get()` or shape guessing over `unknown` payloads.

Each corresponding negative test must be introduced in the same slice as the relevant production
boundary. Scenario-only tests are insufficient when a fake can accidentally implement a more trusted
channel than production.

## Target actor model

Actor types remain in the Automations domain. Extract their canonical definitions into:

```text
apps/backoffice/app/fragno/automation/actors.ts
```

The canonical provenance representation is an object, not a heterogeneous actor array:

```ts
export type AutomationActorRole = "initiator" | "principal" | "delegate" | "assistant";

export type AutomationEntityRef =
  | {
      scope: "internal";
      type: string;
      id: string;
    }
  | {
      scope: "external";
      source: string;
      type: string;
      id: string;
    };

export type AutomationActor<TRole extends AutomationActorRole> = AutomationEntityRef & {
  role: TRole;
};

export type AutomationActors = Readonly<{
  initiator: AutomationActor<"initiator">;
  principal: AutomationActor<"principal"> | null;
  delegation: readonly (AutomationActor<"delegate"> | AutomationActor<"assistant">)[];
}>;

export type BackofficeExecutionContext = {
  scope: BackofficeContextScope;
  actors: AutomationActors;
  userAuthority?: BackofficeVerifiedAccessTokenAuthority;
};
```

`principal` is a required nullable field so every serialized value has the same shape. `delegation`
is the only ordered sequence because workflow and agent delegation order is meaningful. Initiator
and principal access is direct and never requires `find()`, index conventions, or role filtering.

`system` and `capability` describe actor identity types, not participation roles. A trusted system
actor is an initiator or delegate according to how it participates in the action; there is no
separate `system` role.

### Actor-object invariants

- `initiator` is always present and has role `initiator`.
- `principal` is either `null` or has role `principal`.
- `delegation` contains only `delegate` and `assistant` actors in execution order.
- A principal can never be hidden in `delegation`.
- The initiator never changes once execution starts.
- Actor entries contain durable identity references, not authorization claims.
- The principal names the runtime authority owner, not necessarily the user who created, installed,
  configured, or triggered the automation.
- Internal identities structurally reject `source`; external identities structurally require it.
- Email addresses, access tokens, organization-membership arrays, and similar claims are not stored
  in the actor object.
- The same actor identity cannot appear in multiple slots or delegation entries unless a future use
  case explicitly defines why one identity occupies distinct participation roles.

`automationActorsSchema` owns validation at trust and construction boundaries. Internal consumers
read `actors.initiator` and `actors.principal` directly. They do not open-code array searches.
Callers construct actor provenance visibly and parse the resulting object whenever untrusted input
or a delegation change must re-establish the duplicate-identity and slot invariants. The schema
rejects malformed slot/role combinations rather than silently normalizing them.

Routing is slot-aware and never depends on array offsets or searching a heterogeneous list.

## Target event model

```ts
export type AutomationEvent = {
  id: string;
  scope: BackofficeContextScope;
  source: string;
  eventType: string;
  occurredAt: string;
  payload: AutomationEventPayload;
  actors: AutomationActors;
  subject?: AutomationEventSubject | null;
};
```

`source`, `actors`, and `subject` retain distinct meanings:

- `source`: which system produced the current event;
- `actors`: who initiated, owns authority for, and delegated the action;
- `subject`: which entity the event concerns or affects.

Routing should receive first-class slot matching instead of depending on duplicated `actor`, array
offsets, or role searches. For example:

```ts
matcher: {
  actor: {
    participation: "initiator",
    scope: "external",
    source: "telegram",
    type: "chat",
  },
}
```

Every actor matcher names its `scope`; internal matchers reject `source`, while external matchers
may additionally constrain `source`. Delegated actors can use `participation: "delegation"` plus
`role: "delegate" | "assistant"` when needed. The routing evaluator, schemas, starter route
definitions, and scenario assertions should all use this canonical form.

## Kernel-controlled execution

The kernel should authorize and instrument complete `BackofficeExecutionContext` values.

Target operation boundary:

```ts
await kernel.invoke({
  execution,
  operation: {
    namespace: "telegram",
    permission: "send",
  },
  resource: { chatId },
  execute: () => telegram.sendChatAction(input),
});
```

`kernel.invoke()` owns:

1. actor-object validation;
2. scope validation;
3. principal resolution;
4. current permission evaluation;
5. delegate and agent restrictions;
6. resource-level checks;
7. action observation/instrumentation;
8. invocation of `execute()` exactly once;
9. backpressure on the exact promise returned by `execute()`;
10. preservation of its result or error even when an observer detaches or catches it.

Propagation context is installed by the Fragno service/RPC or durable-action boundary that owns the
work. The kernel neither derives trusted execution from tracing nor owns W3C carrier installation.

### Fail-closed authority contract

Authority resolution is a required production dependency, not optional best-effort enrichment. Every
sensitive invocation resolves principal permissions and every delegate/assistant capability grant
before evaluating resource policy. Immediate authenticated user actions use short-lived authority
copied from an already verified access token, avoiding an Auth round-trip. Executions without token
authority perform one current Auth lookup for user existence, banned status, global role, and
optional organization membership. Expired token authority fails closed and does not fall back to a
live lookup that could outlive the credential.

The kernel requires a resolver at construction and denies with stable reasons when:

- a resolver throws or cannot reach its authority source (`authority-unavailable`);
- a principal has no current permission (`principal-permission-denied`);
- a delegate or assistant has no current grant (`actor-capability-denied`).

Explicit bootstrap policy for an unlinked external initiator is the only path that may operate
without a principal. It still uses a configured resolver and a narrowly defined resource policy.
Kernel and production runtime construction require an authority resolver. Constrained runtimes that
lack an authority source install the explicitly named fail-closed resolver; trusted test/system
contexts may instead install the explicitly named unrestricted resolver.

Production-wiring tests must prove that verified access-token authority avoids an Auth RPC, expires
closed, and is accepted only for its matching user principal. Executions without token authority
must still prove that a revoked organization membership denies the next sensitive invocation. An
observer paired only with the explicit unavailable resolver cannot authorize an action.

[`executeBackofficeRuntimeTool()`](../apps/backoffice/app/fragno/runtime-tools/runtime-tools.ts)
should become a thin adapter that parses tool input and delegates the trusted action boundary to the
kernel.

### Tool context

Replace the current `{ actor, scope }` tool context with the complete execution context:

```ts
export type BackofficeToolContext = {
  execution: BackofficeExecutionContext;
  kernel: BackofficeKernel;
  runtimes: Record<string, unknown>;
  createScopedContext(scope: BackofficeContextScope): BackofficeToolContext;
};
```

`createScopedContext()` preserves actors and asks the kernel to authorize the scope transition.

Tool inputs contain domain arguments only. They never contain actor provenance or permission fields.

## Store design

### User-facing API

`StoreSetArgs` becomes:

```ts
export type StoreSetArgs = {
  key: string;
  value: string;
  description?: string | null;
  category?: string[];
  verification?: StoreVerification[];
};
```

Remove:

- the `actor` input schema;
- `--actor` from Bash help and parsing;
- `context.defaults.actor`;
- generated examples containing actors;
- workflow guidance telling authors to pass `event.actor`.

Schemas for user-authored tools should be strict so attempts to pass `actor`, `actors`, or execution
metadata fail clearly instead of being silently stripped.

### Persisted attribution

`kv_store` contains mutable scope-owned data and persists no actor or permission attribution. Store
set/delete authorization occurs in typed Fragment middleware immediately before the normal route
handler executes. The middleware derives the key resource from validated route input and asks the
kernel to assert current authority.

If durable per-entry attribution becomes a product requirement, add an explicit append-only audit
boundary that observes route completion. Do not add `createdByActors`, `updatedByActors`, or another
mutable provenance field to `kv_store`.

### Categories

Categories remain user-defined labels for filtering and presentation. They have no authorization
meaning.

`hasSystemCategory()` and category-based deletion protection have been removed. Categories cannot
protect trusted state. External identity bindings therefore live outside generic KV.
Claim-to-workflow correlation, Pi session routing, and default-agent selection may remain in generic
KV because those values carry no authority. The Pi session's trusted storage owns its authority
owner; a routing entry merely names that session and cannot replace or enrich the owner.
Authorization occurs when the referenced identity, workflow, Pi resource, or agent is used. If other
generic system-owned KV remains necessary, use a separate internal store or a kernel-controlled
write-policy field that user tools cannot set.

### Mutation boundary

The scoped Automations object exposes one typed `fetchWithContext(request, context)` RPC for trusted
route calls. The ordinary route caller uses it whenever `BackofficeActionRpcContext` is supplied and
otherwise uses raw `fetch()`. Execution remains a separate RPC argument and is never serialized into
request headers.

The trusted route bridge extracts only `traceparent` and optional `tracestate` from the incoming
request and places them in `BackofficeActionRpcContext`; it does not copy baggage or arbitrary
headers. `fetchWithContext()` validates that the execution scope matches the object address,
forwards that W3C propagation as lifecycle metadata, and passes only `BackofficeExecutionContext` as
application-owned request context. The Automations fragment declares that type with
`withRequestContext<T>()`, so its handler and middleware retain it through the complete request
chain. The RPC transport envelope does not leak into Fragment policy code, and execution is never
serialized into HTTP headers. Typed Fragment middleware matches store set/delete, validates the
route input, derives `{ kind: "automation-store-entry", key }`, and calls
`kernel.assertAuthorized()` for `store.modify` before allowing the normal handler to continue.
Denials preserve the kernel reason as the response code; `authority-unavailable` is HTTP 503 and
policy/capability denials are HTTP 403. The handler remains the single source of response semantics
and service mutation behavior.

Raw `fetch()` reaches the same middleware without trusted request context and therefore rejects
protected store mutation routes. Other routes flow generically through either fetch path without a
parallel command protocol; each future sensitive route must add explicit typed middleware policy
before relying on the trusted transport.

The scope-aware Automations catch-all exposes only `/_internal` outbox paths. The removed
organization-only `/api/automations/:orgId/*` compatibility proxy is not an authorization surface.
The underlying `/store/set` and `/store/delete` fragment routes remain internal implementation
surfaces and are not publicly forwarded. The separate `/api/automations-workflows/:orgId/*` route
forwards directly to the workflows fragment. KV ownership is scope-level: a principal with current
`store.modify` authority for the scope may change any ordinary key in that scoped store.

## External identity binding

An identity binding is a small trusted aggregate: an external identity resolves to one Backoffice
user, and changing it changes runtime authority. The dedicated table keeps that aggregate outside
the generic store API while retaining a KV-like implementation.

Each Automations Durable Object is already physically scoped. The binding row ID is the
deterministic encoded `source/type/id` tuple, so it is also the external-identity lookup key. A
separate consumption row records every accepted verified claim, including claims accepted while the
binding was already active and unchanged:

```ts
.addTable("external_identity_binding", (t) =>
  t
    .addColumn("id", idColumn())
    .addColumn("source", column("string"))
    .addColumn("externalType", column("string"))
    .addColumn("externalId", column("string"))
    .addColumn("userId", column("string"))
    .addColumn("verifiedByClaimId", column("string"))
    .addColumn("boundAt", column("timestamp"))
    .addColumn("revokedAt", column("timestamp").nullable()),
)
.addTable("external_identity_claim_consumption", (t) =>
  t
    .addColumn("id", idColumn())
    .addColumn("bindingId", column("string"))
    .addColumn("userId", column("string"))
    .addColumn("acceptedBindingVersion", column("integer"))
    .addColumn("acceptedAt", column("timestamp")),
)
```

The application maps `revokedAt: null` and a concrete `revokedAt` into distinct active and revoked
binding types. Fragno's built-in row `_version`, exposed through `FragnoId.version`, is the binding
version used for stale-command protection. All persisted timestamps use the Automations database's
`uow.now()`.

### Binding transitions

- Binding a missing identity creates an active binding and consumes the verified claim atomically.
- Repeating a bind for the same active user consumes a new claim even though the binding remains
  unchanged.
- Retrying any consumed claim never mutates the binding again.
- Binding an active identity to another user returns a conflict.
- Revocation requires the expected current user and built-in Fragno binding version.
- Repeating a revocation against an already revoked row returns unchanged success.
- A stale revocation conflicts when the binding is active at a newer version, even when it belongs
  to the same user.
- Binding a revoked identity with a new verified claim reactivates it for the requested user.
- A consumed claim returns revoked or superseded when its accepted binding version is no longer
  current.
- OTP completion notifies workflows only when the resulting binding remains active.
- Resolution returns only active bindings.

The persistence surface contains four operations:

```ts
getExternalIdentityBinding(input);
resolveExternalIdentity(input);
bindExternalIdentity(input);
revokeExternalIdentity(input);
```

The owning Automations Durable Object exposes typed bind, resolve-active, and revoke RPCs requiring
`BackofficeActionRpcContext`. Each RPC calls `kernel.invoke()` around the exact persistence
operation. OTP completion, automation workflow identity resolution, administrative revocation, and
rebind flows use those object methods. The kernel observer is the single authorization-observation
and future audit insertion point.

## Trusted identity-claim flow

The current starter workflow should stop writing identity mappings itself.

### Claim creation

Change:

```ts
otp.createIdentityClaim({ actor: telegramActor });
```

into:

```ts
otp.createIdentityClaim();
```

The OTP runtime asks the kernel for the external initiator. It rejects execution without an eligible
external initiator and cannot create a claim for an arbitrary chat.

### Claim completion

The trusted OTP confirmation hook knows:

- the verified claim ID;
- the claimed external Telegram identity;
- the authenticated Backoffice user ID;
- the owning Automations scope.

It invokes an internal Automations RPC that performs `bindExternalIdentity()` idempotently. The
user-authored workflow is notified only after the binding succeeds.

### Waiting-workflow correlation

The domain workflow stores `otpId -> workflowInstanceId` in the automation store before exposing the
claim URL. After binding succeeds, OTP completion emits the ordinary completion event with the
verified claim ID. The automation route resolves that correlation and notifies the waiting workflow.
The correlation controls orchestration only; it is not an identity or authorization boundary.

## Telegram-to-Pi execution flow

### 1. Unlinked Telegram message

The Telegram hook creates an external initiator:

```ts
const actors: AutomationActors = {
  initiator: {
    role: "initiator",
    scope: "external",
    source: "telegram",
    type: "chat",
    id: chatId,
  },
  principal: null,
  delegation: [],
};
```

Telegram ingress does not resolve or install an internal principal. It only records the trusted
external initiator. The domain workflow decides whether it needs an internal identity and may use
the guarded `identity.resolveExternal()` runtime tool to query the active binding.

### 2. Identity confirmation

The confirmed claim keeps the external Telegram identity as its initiator and records the linked
Backoffice user as `subject.userId`. The OTP hook binds the identity before publishing this event,
but it does not install that user as the event principal. Actor participation and event subject
remain separate concepts.

### 3. Future Telegram message

Telegram continues to emit only the external initiator with `principal: null`. A workflow that needs
the corresponding Backoffice user resolves the active binding explicitly:

```ts
const linkedIdentity = await identity.resolveExternal({
  source: "telegram",
  type: "chat",
  id: chatId,
});
```

This keeps application identity policy in workflow code instead of the Telegram capability object.
The resolution RPC remains guarded by the kernel, and callers cannot inject a principal into the
Telegram event.

Pi session selection remains automation-defined behavior. The starter automation currently chooses
one reusable session per linked principal with a key such as `telegram-pi-session/<principalId>`,
but another automation may choose a session per chat, thread, workflow instance, organization, or
message. Those choices define reuse cardinality, not execution authority: every reused session
retains the trusted authority principal established at creation. Public Pi route access is
established by resolving the requested Pi permission from the verified JWT role and organization
snapshot, not equality with that persisted principal.

Automation state may therefore store a Pi session ID in ordinary KV or workflow state. That lookup
is not sufficient on its own: the caller must still hold the required Pi permission at the current
scope. Session creation derives and persists trusted execution actors. `pi.getSession`,
`pi.runTurn`, and future Pi session mutations authorize the incoming operation using its Pi
permission, while asynchronous tools resolve current permissions for the session's persisted
authority principal.

Identity revoke/rebind does not need to atomically clean up automation routing state for authority.
A stale mapping may continue selecting the previous session, and an execution accepted by the
trusted Pi request boundary may submit work to it. The work continues under the session's persisted
authority principal, whose current permissions are reevaluated for every sensitive tool action.
Automations may replace stale mappings for correctness or user experience.

### 4. Workflow delegation

Automation definitions establish one trusted authority mode before workflow startup:

```ts
type AutomationAuthorityMode =
  | { kind: "delegated-user" }
  | { kind: "organization-automation"; automationId: string };
```

`delegated-user` requires an existing internal user principal. Workflow startup preserves that user
and appends a trusted automation delegate:

```ts
const actors = automationActorsSchema.parse({
  ...event.actors,
  delegation: [...event.actors.delegation, automationDelegate],
});
```

`organization-automation` installs the stable automation identity as principal, regardless of who
created or last configured it. A user who triggered the run remains only the initiator when that
provenance is relevant; creator identity belongs in audit metadata rather than the authority chain.
These runs continue if the creator is banned or leaves the organization, but stop when the
organization automation is disabled or its current grants are revoked.

A missing event principal is not sufficient evidence of organization ownership. Workflow startup
must reject an absent or incompatible authority mode rather than silently promoting the automation.
The automation identity must use a stable automation-definition identity, not a user-supplied name,
event ID, or individual run ID. Trusted system-service execution remains a separate explicit service
principal and is not inferred through either automation mode.

### 5. Pi session execution authority and delegation

Pi session creation derives trusted execution actors from the request context and persists them with
the session. User-created sessions retain that user principal. Sessions created by an
organization-owned automation retain the stable automation principal, not the automation's creator.
Trusted service sessions require an explicit service principal. The persisted actors contain
identity and provenance, never permission grants; permissions are resolved when sensitive tools
execute.

The session creation request contains no caller-authored authority field. The Pi object derives the
actors from trusted execution, stores them atomically with the session, and treats them as immutable
execution provenance. These actors determine the principal used by Bash, codemode, filesystem, and
runtime tools. They do not define who may read or submit commands to the session.

Each Pi operation receives the current action's execution context through an explicit trusted
Durable Object RPC:

```ts
await pi.runTurn({ workflowName, sessionId, input }, { execution, propagationContext });
```

The public request boundary resolves the requested Pi permission from the verified JWT role and
organization snapshot without rereading Auth. Trusted internal calls resolve current permission from
explicit execution context. Neither path requires the incoming principal to equal the session's
persisted principal. An accepted caller may submit a turn to an existing session, while the
resulting agent and tool execution continues under the trusted authority principal persisted with
that session.

The public Pi `fetch()` path accepts domain request data only. It rejects or ignores
`x-backoffice-execution-context` and any equivalent actor/principal metadata. The in-memory Pi fake
implements the same trusted context and permission checks as production and must not parse a header
that production ignores.

Before asynchronous workflow execution begins, the turn persists its trusted provenance while
retaining the principal from the session actors:

```ts
const actors = automationActorsSchema.parse({
  initiator: execution.actors.initiator,
  principal: session.actors.principal,
  delegation: [...execution.actors.delegation, piAssistant],
});
```

The resulting value for a linked Telegram user is:

```ts
{
  initiator: telegramInitiator,
  principal: linkedUserPrincipal,
  delegation: [automationDelegate, piAssistant],
}
```

A reusable Pi session therefore retains the authority principal established at creation, but it does
not retain a permission snapshot. Turns may have different initiators or submitters while tools
continue resolving current authority for the stable session principal. Tool construction reads the
persisted turn context rather than the Pi Durable Object's service identity or a mutable
session-global "last caller" context.

Required tests:

- a public request supplying a forged execution header cannot affect Pi session or tool actors;
- production and fake Pi objects receive context through the same typed RPC contract;
- a user-created session runs tools under that user's current authority;
- another principal accepted by the JWT scope boundary can submit a turn while tools retain the
  session principal;
- two turns on one reused session may have different initiators but retain the same authority
  principal without provenance leakage;
- banning, downgrading, or removing the persisted principal denies the next sensitive tool action;
- downstream Bash, codemode, and runtime-tool calls observe the persisted turn actor object.

### 6. Tool calls and emitted events

Pi tool calls preserve `initiator` and `principal` and append meaningful participation to
`delegation`. Ordinary technical hops such as every Durable Object or SQL query are represented as
spans rather than actors.

When execution emits a new Automation event, the execution's actor provenance is materialized into
the event's `actors` field.

### 7. Deferred Telegram delivery

Queued Telegram send/edit work persists a Backoffice-owned envelope rather than only Telegram API
arguments:

```ts
type BackofficeDeferredAction<TPayload, TResource> = {
  execution: BackofficeExecutionContext;
  operation: BackofficePermissionRequirement;
  resource: TResource;
  payload: TPayload;
  propagationContext: DurableHookPropagationContext | null;
};
```

The queueing tool may authorize creation of the durable intent, but that decision does not authorize
the future network call. On every hook attempt, the Telegram processor restores the envelope and
wraps the actual API invocation in `kernel.invoke()`.

Authorization denial is terminal: the hook records a stable denial reason, does not call Telegram,
and does not schedule another transport retry. Telegram/network failures remain retryable according
to the delivery retry policy. If Fragno durable hooks cannot distinguish terminal from retryable
failure, add that primitive before adopting deferred authorization.

Required tests revoke identity and organization permission between enqueue and attempt, and between
attempt one and attempt two. Both cases must prove that no later Telegram API call occurs.

## Permission model

The actor object identifies participants; it does not itself contain permission grants.

For each sensitive operation, the kernel should:

1. read `execution.actors.principal` directly;
2. resolve the principal's current organization membership and permissions;
3. evaluate each actor in `execution.actors.delegation` against its configured capability grants;
4. apply Pi agent/tool restrictions;
5. validate the target resource;
6. default-deny if any required authority is missing.

Effective authority is an intersection:

```text
principal permissions
  intersect automation grants
  intersect agent grants
  intersect resource policy
```

Delegation cannot increase authority.

Permissions are resolved on every sensitive action. Immediate request execution may reuse the
verified JWT authority snapshot until its 15-minute expiry; membership, administrator, and ban
changes therefore take effect for that credential at expiry. Durable retries carry no token
authority and reevaluate current state before each attempt. Actor objects never persist permission
snapshots.

For user-delegated execution, that fresh resolution includes the user's active state and membership,
so banning or removing the user stops the next action. Organization-owned execution resolves the
stable automation principal and its current grants instead; the creator's later status is
irrelevant. This prevents organizational infrastructure from accidentally depending on the
employment or account state of whichever user originally installed it.

Example `telegram.sendChatAction` policy:

- the execution scope permits access to the Telegram object;
- the principal currently belongs to the organization;
- the automation is granted `telegram.send`;
- the Pi agent, if present, is granted the Telegram tool family;
- the target chat is either the initiating Telegram chat or another explicitly authorized resource;
- an unlinked external initiator may send only bootstrap responses to its own chat.

## Propagation and tracing

Trusted execution context and W3C trace context travel together at some boundaries but remain
separate concepts and types:

```ts
export type BackofficeRpcContext = Pick<FragnoExecutionContext, "propagationContext">;

export type BackofficeActionRpcContext = BackofficeRpcContext & {
  execution: BackofficeExecutionContext;
};
```

Rules:

- `BackofficeRpcContext` is telemetry-only and does not authorize an action.
- `BackofficeActionRpcContext` is required by sensitive typed RPC calls and adds trusted execution
  explicitly.
- `execution` is accepted only from trusted in-process calls, Durable Object RPC arguments, or
  Backoffice-owned durable envelopes.
- `propagationContext` contains only opaque `traceparent` and optional `tracestate` values.
- public HTTP extraction never creates `execution`; it only parses permitted W3C trace headers.
- an explicit `null` propagation context suppresses tracing without suppressing authorization.
- user workflows, public routes, and tool schemas reject actor, principal, permission, execution,
  and propagation metadata.

Durable hooks persist trusted execution only when their Backoffice-owned payload contract requires
it. Generic Fragno hook instrumentation does not receive or inspect arbitrary payloads to discover
actors. In particular, Cloudflare instrumentation must not use shape probing such as
`payload.event.actors`, `payload.execution.actors`, or `Reflect.get()` over `unknown` values.

Cloudflare kernel observers receive already-typed action observations and attach privacy-safe
attributes such as:

```text
backoffice.scope.kind
backoffice.operation.namespace
backoffice.operation.permission
backoffice.actor.count
backoffice.actor.roles
backoffice.authorization.outcome
backoffice.authorization.reason
```

Do not include actor IDs, principal IDs, external-identity IDs, resource IDs, emails, tokens,
prompts, tool arguments, or arbitrary payloads. Durable-hook attempt spans remain generic and
include only hook namespace/name, attempt metadata, status, and whether W3C propagation exists.

Traces are sampled diagnostics, not authorization inputs or authoritative audit records.
Authorization must produce the same result when tracing is disabled or `tracing.enterSpan()` is
unavailable. Security-sensitive mutations use a separate append-only audit insertion point owned by
the kernel action observer.

## Scenario testing design

The scenario framework in [`scenario.ts`](../apps/backoffice/app/fragno/automation/scenario.ts)
should be extended as a first-class specification surface rather than relying primarily on
`then.assert()`.

### Scenario actor helpers

Add builders and assertions:

```ts
given.identity.binding({
  orgId,
  source: "telegram",
  externalType: "chat",
  externalId: "1001",
  userId: "user-1",
});

then.identity.binding({...});
then.identity.missing({...});

then.automation.event({
  id,
  actors: {
    initiator: {...},
    principal: {...},
    delegation: [{ role: "delegate", ... }, { role: "assistant", ... }],
  },
});
```

The helpers must use real Automations object/service methods rather than direct database insertion,
except for narrowly named `given.direct.*` escape hatches.

### Kernel action recorder

Introduce a small kernel observer contract:

```ts
export type BackofficeKernelObserver = {
  runAction<T>(action: BackofficeKernelAction, execute: () => Promise<T>): Promise<void>;
};
```

The observer controls the instrumentation context in which `execute()` starts, but it does not own
the action result. The kernel captures and awaits the exact execution promise, ignores any observer
return value, preserves action failures even if the observer catches them, and prevents delayed
execution after observation has completed.

Production uses a Cloudflare tracing observer. Scenario runtime uses an in-memory observer that
records:

- operation namespace and permission;
- scope;
- actor provenance object;
- resource summary;
- allowed/denied outcome;
- result/error timing.

Add scenario assertions:

```ts
then.kernel.action({
  operation: "telegram.sendChatAction",
  principalId: "user-1",
  actors: {
    initiator: "telegram:chat:1001",
    principal: "user:user-1",
    delegation: ["automation:*", "agent:*"],
  },
  outcome: "allowed",
});

then.kernel.denied({
  operation: "telegram.sendChatAction",
  reason: "principal-not-authorized",
});
```

This validates the same semantic action boundary used by production without requiring Cloudflare's
trace backend.

### Fake runtime attribution

Scenario Telegram, Pi, MCP, Resend, and other fakes should record the kernel action context they
were invoked under. Actor information is not added to user-facing function arguments.

Extend assertions where useful:

```ts
then.telegram.sentChatAction({ chatId, action, principalId: "user-1" });
then.pi.ranTurn({ sessionId, text, principalId: "user-1" });
```

These fields inspect recorded execution metadata, not domain input payloads.

### Production/fake boundary parity

Every fake that crosses a trust boundary implements the same typed interface production uses. A fake
may record additional diagnostics, but it cannot acquire execution context from headers, mutable
globals, untrusted session metadata, or other channels absent from production. Pi session authority
metadata is valid only when the same trusted creation boundary writes and consumes it in production
and the fake.

Add contract tests that run against both production-style and in-memory object adapters for:

- Pi session creation authority and turn-context RPC;
- Automations identity bind/resolve/revoke RPC;
- Pi session permission authorization for automation-supplied session IDs;
- deferred Telegram attempt authorization.

A scenario assertion is not sufficient proof when its fake bypasses the production acquisition
boundary.

### Failure diagnostics

Scenario failure snapshots should include:

- identity bindings;
- Pi session execution principals and per-turn actors;
- persisted Automation event actors;
- kernel action records;
- denied authorization decisions;
- durable-hook queues;
- workflow history;
- existing store and file snapshots.

## Implementation status

**Status as of August 3, 2026:** Slices 1 and 2 are complete. Slice 3 is implemented and pending its
review gate. The Pi scope-level route authorization implemented toward Slice 6 is the operation
access policy; each Pi session separately persists trusted actors that establish tool execution
authority without requiring caller/principal equality. Store, event, and OTP tool inputs now reject
caller-authored provenance; mutable KV rows no longer persist actor attribution; store mutation
requires a current kernel authorization check in typed Fragment middleware; and OTP claims derive
their target from the trusted external initiator. `BackofficeExecutionContext` is now the single
execution model across authenticated requests, filesystems, tools, and kernel actions; the legacy
single-actor context and its conversion adapter have been removed. Store mutations now enter through
the generic execution-bound `fetchWithContext()` route transport, while the scope-aware public
Automations proxy exposes only outbox routes. The organization-only compatibility proxy has been
removed; the workflow proxy forwards directly to the workflows fragment. Immediate system-store
mutation trusts a verified access token's administrator role until token expiry; executions without
token authority use the current Auth state. Automation runtimes preserve the event actors and add
their explicit service identity as the principal only when the event has none, or as a delegate when
it already has one. A previous all-at-once implementation was removed after review exposed
trust-boundary and asynchronous-authorization mistakes. Its code may be consulted as a prototype,
but remaining slices must be implemented independently from this plan and must not be replayed
wholesale.

No checklist item below is complete until its production path, negative tests, typecheck, and
focused scenario have landed together. Validation results from the removed prototype do not count as
validation of a new slice.

## Vertical implementation slices

Implement one slice at a time. Each slice gets its own reviewable commit or pull request and must
leave the system working. Do not begin the next slice until the current review gate is accepted.
Tests stay with the production boundary they verify; a broad scenario at the end cannot compensate
for a missing unit or adapter-contract test.

### Slice 1: Canonical Automation actor object

**Production behavior**

- [x] Add `automation/actors.ts` with the structured `AutomationActors` type and canonical
      validation schema.
- [x] Make `initiator` required, `principal` required-and-nullable, and `delegation` an ordered list
      of delegates/assistants.
- [x] Reject malformed slot/role combinations and duplicate identities rather than normalizing them.
- [x] Remove `AutomationEvent.actor`; retain only validated `AutomationEvent.actors`.
- [x] Add slot-aware route matching and remove heterogeneous actor-array searches.

**Required tests**

- [x] Accept unlinked, linked, and delegated actor objects.
- [x] Reject a principal in `delegation`, an assistant in `principal`, and duplicate identities.
- [x] Prove Telegram routing reads the `initiator` slot directly.
- [x] Prove child events retain initiator/principal and ordered delegation.

**Review gate:** accept the actor vocabulary and object shape before changing authorization or
identity storage.

### Slice 2: Fail-closed kernel and production authority wiring

**Production behavior**

- [x] Define `kernel.invoke()` around typed execution, operation, resource, and exact-once execute.
- [x] Make the production authority resolver a required kernel/runtime dependency.
- [x] Deny absent, throwing, or unavailable resolution with `authority-unavailable`.
- [x] Resolve principal permissions and delegate/assistant grants for every sensitive invocation.
- [x] Install the concrete resolver in every Cloudflare and in-memory production-style runtime.
- [x] Trust role and organization authority from a verified Backoffice access token until expiry,
      without an Auth round-trip for immediate request actions.
- [x] Reevaluate current user existence, banned status, global administration, and optional
      organization membership in one Auth lookup when execution has no token authority.
- [x] Grant the narrow explicit `system-administrator` role only from an unexpired administrator
      token or current active-administrator lookup.
- [x] Construct one request kernel in `BackofficeWorkerContext` and retain one kernel per Durable
      Object rather than rebuilding equivalent kernels in request helpers.
- [x] Remove the separate `authorizationPolicy`/`assertAllowed()` path; retain only structural
      context access checks until each sensitive action moves into `kernel.invoke()`.
- [x] Define one exhaustive namespace-permission catalog and reject wildcard or unknown grants.
- [x] Resolve identities to explicit Backoffice roles whose grants reference canonical permission
      constants; catalog additions grant nothing until each intended role is updated.
- [x] Require a concrete kernel observer and install an explicit no-op observer where observation is
      intentionally disabled.
- [x] Keep explicit bootstrap policy narrow and independent from missing-resolver fallback.

**Required tests**

- [x] Require a resolver at kernel construction and prove the explicit unavailable resolver denies.
- [x] Make the resolver throw and prove `execute()` is not called.
- [x] Revoke organization membership in the real Auth object and deny the next action.
- [x] Revoke or omit global administration and deny the next system-store mutation without writing.
- [x] Deny missing and banned users without token authority even when stale ownership, membership,
      or administrator facts remain.
- [x] Prove verified access-token authority avoids Auth lookup, rejects principal mismatch, and
      expires without falling back to current state.
- [x] Prove an observer cannot substitute for an unavailable authority source.
- [x] Prove permission grants are concrete catalog entries without wildcard matching.
- [x] Prove role grants do not automatically inherit newly cataloged permissions.
- [x] Prove the no-op observer executes an authorized callback exactly once.
- [x] Prove `execute()` runs exactly once only after authorization succeeds.
- [x] Prove the kernel waits for an execution promise that an observer starts without awaiting.
- [x] Prove an observer cannot suppress the execution promise's original error.
- [x] Prove an observer cannot start the action after its observation has completed.

**Review gate:** no sensitive store, identity, Telegram, or Pi action may adopt the kernel until
this slice proves fail-closed production wiring.

### Slice 3: Remove caller-authored provenance

**Production behavior**

- [x] Remove actor/context fields from `store.set`, `events.fire`, OTP claims, Bash options, and
      generated references.
- [x] Make user-authored schemas strict and reject unknown provenance or permission metadata.
- [x] Remove caller-controlled `kv_store.actor`; categories remain non-security labels.
- [x] Expose one generic Automations `fetchWithContext(request, context)` RPC requiring
      `BackofficeActionRpcContext` for trusted route execution.
- [x] Make the ordinary route caller select `fetchWithContext()` whenever trusted execution is
      supplied, without encoding execution into headers.
- [x] Pass only trusted `BackofficeExecutionContext` through the Fragment application request
      context, separately from W3C propagation metadata and the RPC transport envelope.
- [x] Extract only `traceparent` and optional `tracestate` at the trusted route bridge and propagate
      them through the Automations RPC without baggage or arbitrary HTTP headers.
- [x] Reject protected store mutations from raw `fetch()` and derive their operation/resource policy
      from validated input in typed Fragment middleware.
- [x] Call `kernel.assertAuthorized()` immediately before allowing the sensitive route handler to
      continue and preserve stable denial reasons, mapping `authority-unavailable` to HTTP 503.
- [x] Restrict the scope-aware Automations catch-all to outbox paths and remove the
      organization-only compatibility proxy so raw store mutation routes are not public
      authorization boundaries.

**Required tests**

- [x] Reject `actor`, `actors`, `principal`, execution-context, and propagation options.
- [x] Prove mutable KV rows contain no caller-authored or trusted actor attribution.
- [x] Prove ordinary categorized KV remains writable and deletable.
- [x] Prove user-scoped automation execution and current system administrators can mutate their
      scoped store through the same generic `fetchWithContext()` boundary.
- [x] Deny mismatched scopes and non-administrator system mutations without entering persistence.
- [x] Prove the scope-aware Automations proxy rejects direct store mutation paths while outbox
      routes remain available, and prove the separate workflow proxy still forwards workflow routes.

**Review gate:** user workflows have domain arguments only.

### Slice 4: Identity binding storage and guarded mutation RPCs

**Production behavior**

- [x] Add the single `external_identity_binding` table with a deterministic external-identity ID.
- [x] Add get, resolve, bind, and revoke persistence operations.
- [x] Enforce the active, conflict, revoke, and reactivation transitions defined above.
- [x] Expose bind and revoke as Automations object RPCs requiring `BackofficeActionRpcContext`.
- [x] Call `kernel.invoke()` inside the Automations object around the exact database mutation.
- [x] Use the kernel observer as the authorization-observation and future audit insertion point.

**Required tests**

- [x] Cover create, repeated bind, conflicting user, revoke, repeated revoke, and reactivation.
- [x] Prove an old bind claim cannot reactivate a revoked or rebound identity.
- [x] Prove a delayed revoke cannot revoke a binding now owned by another user.
- [x] Call each object RPC and observe one authorized action around one persistence operation.
- [x] Deny each mutation and prove persistence is not entered.

**Review gate:** accept identity ownership and mutation authorization before changing OTP.

### Slice 5: Trusted OTP completion and workflow-owned identity resolution

**Production behavior**

- [x] Derive OTP claim identity from the trusted external initiator.
- [x] Persist claim-to-workflow correlation in the domain workflow before exposing the claim URL.
- [x] On completion, call the guarded Automations bind RPC before notifying the workflow.
- [x] Resolve active bindings explicitly from domain workflow logic.
- [x] Discard supplied principal/delegate actors at untrusted ingress.
- [x] Keep unlinked actors restricted to explicit same-chat bootstrap actions.

**Required tests**

- [x] Prove claim creation cannot target another external identity.
- [x] Prove binding precedes workflow notification and retries converge idempotently.
- [x] Prove forged principals are discarded.
- [x] Prove revocation returns the ingress flow to unlinked behavior.

**Review gate:** accept the complete identity acquisition path before session reuse or Pi
delegation.

### Slice 6: Automation-defined Pi routing and session execution authority

**Production behavior**

- [x] Keep Pi session selection and routing cardinality in automation code and ordinary automation
      state, with each automation's workflow logic and state keys defining its reuse behavior.
- [ ] Keep default-agent selection in automation-controlled configuration; selecting an agent never
      grants permission to create a session with or delegate to that agent.
- [x] Treat session IDs as identifiers rather than capabilities.
- [x] Resolve `pi.read` or `pi.modify` from verified JWT role/scope claims for public Pi requests
      and from current trusted execution authority for internal Pi calls.
- [x] Persist immutable trusted `AutomationActors` when a Pi session is created without persisting a
      permission snapshot.
- [ ] Make user-created sessions retain the creating user principal, organization-automation
      sessions retain their stable automation principal, and trusted service sessions require an
      explicit service principal.
- [x] Authorize public session reads, turns, and mutations by resolving the requested Pi permission
      from JWT role/scope claims without requiring equality with the persisted session principal.
- [x] Resolve the persisted session principal's current permissions for tool execution rather than
      persisting role grants or using the Pi Durable Object service principal.
- [x] Preserve the current starter automation's per-principal reuse behavior as its own explicit KV
      keying strategy without making that behavior a platform invariant.
- [x] Remove category-based protection; ordinary routing and default-agent configuration values
      carry no authority and need no category-based security semantics.

`PiObject.fetchWithContext()` is the thin trusted transport that installs execution as Pi fragment
request context. Public routes verify the JWT before calling this transport. Pi fragment middleware
uses `kernel.assertAuthorized()` to resolve `pi.read` or `pi.modify`. The kernel selects the token's
role and organization snapshot without a second Auth lookup when verified request authority is
present; internal executions without token authority use current-state resolution. Session creation
persists trusted `AutomationActors` in workflow metadata. Agent and tool execution use the session's
persisted principal. Raw `fetch()` reaches the same middleware without request context and is
rejected for protected Pi routes. Automation routing KV and default-agent KV remain ordinary,
non-authoritative data; trusted Pi session storage owns the execution actor record.

Slice 7 must establish the final effective automation principal used when an automation creates or
invokes a session. Slice 8 persists turn execution and appends the Pi assistant. The remaining
transitional behavior is limited to stable automation/service principals and complete trusted turn
provenance.

**Required tests**

- [x] Prove the starter automation can resume the session selected by its per-principal KV key.
- [ ] Prove an automation can choose a different keying strategy without changing the Pi schema,
      while every resulting session still records trusted execution actors.
- [x] Create a session as a user and prove another principal accepted by the same JWT scope boundary
      can read and invoke it while tool execution retains the persisted session principal.
- [ ] Revoke and rebind an external identity while stale automation state still points at a session;
      prove the mapping may reuse the session but sensitive tools still resolve the persisted
      principal's current authority.
- [x] Downgrade, ban, or remove the persisted session principal and prove the next sensitive tool
      action resolves current authority and is denied.
- [ ] Prove an organization-owned automation session continues independently of its creator but
      stops when the automation principal loses its grants.
- [ ] Prove automation-controlled default-agent selection cannot exceed the persisted principal,
      automation, agent, or resource grants.

Existing boundary coverage proves public requests resolve Pi permissions from verified JWT claims
without a user-directory lookup, internal context resolves current authority, and raw `fetch()`
cannot access protected routes. It does not complete this slice until stable automation/service
principals and their dynamic authority are implemented in production and in-memory adapters.

**Review gate:** a routing key or session ID is insufficient without the required Pi permission, and
tool execution always uses trusted persisted session actors rather than caller-authored authority.

### Slice 7: Workflow and runtime-tool provenance propagation

**Production behavior**

- [ ] Add a trusted automation authority mode to the automation definition or equivalent
      runtime-owned configuration boundary.
- [ ] Require user-delegated mode to preserve an existing internal user principal and append the
      automation as a delegate.
- [ ] Require organization-owned mode to install a stable automation-definition identity as
      principal, independent of creator identity.
- [ ] Reject missing or incompatible authority mode instead of inferring organization ownership from
      an absent principal.
- [x] Carry `BackofficeExecutionContext` through tool, Bash, codemode, and child-event boundaries.
- [x] Enforce every runtime tool's declared permissions before direct, Bash, or codemode execution.
- [x] Define telemetry-only `BackofficeRpcContext` and execution-bearing
      `BackofficeActionRpcContext` as separate trusted contracts.
- [ ] Preserve the actor object through durable Backoffice-owned envelopes and retries.
- [x] Reject execution or propagation metadata from user-authored workflow input.

**Required tests**

- [ ] Prove event → workflow → tool → child event retains initiator/principal and ordered delegation
      through one complete vertical scenario.
- [ ] Ban or remove a delegated user before the next action and prove the action is denied.
- [ ] Ban or remove an organization automation's creator and prove the automation continues under
      its own principal; then disable it or revoke its grants and prove the next action is denied.
- [ ] Prove a principal-free event without explicit organization-owned mode cannot acquire
      automation authority.
- [x] Prove route-backed tools require the canonical execution context without fallback provenance
      channels.
- [ ] Prove explicit trace suppression does not suppress authorization.
- [ ] Prove a durable retry restores identities but resolves current permissions again.

**Review gate:** provenance reaches internal tools without relying on Pi or Telegram-specific hacks.

### Slice 8: Trusted session-authority Pi turn RPC

"Per turn" in this slice refers to preserving the initiator and delegation chain for each submitted
command. A public caller is authorized by resolving `pi.modify` from verified JWT claims but does
not replace the trusted session principal established in Slice 6.

**Production behavior**

- [ ] Add a typed internal Pi `runTurn(..., BackofficeActionRpcContext)` Durable Object RPC.
- [ ] Keep the public Pi `fetch()` path free of trusted actor/principal input.
- [ ] Remove and reject `x-backoffice-execution-context` or equivalent headers.
- [ ] Authorize the incoming public turn by resolving `pi.modify` from verified JWT role/scope
      claims, then load the persisted session actors without requiring caller/principal equality.
- [ ] Persist the turn's trusted initiator and delegation context before asynchronous execution
      while taking the principal from the immutable session actors.
- [ ] Append the Pi assistant to that turn's `delegation` and build Bash, codemode, filesystem, and
      runtime tools from the persisted turn context rather than the Pi object service context or a
      mutable session-global caller context.
- [ ] Resolve current persisted-principal and delegated-agent grants for every sensitive tool
      action.
- [ ] Make production and fake Pi objects implement the same trusted creation and turn interface.

**Required tests**

- [ ] Forge an execution header through public HTTP and prove it has no effect.
- [ ] Create a session as an administrator and prove an authorized agent tool call observes that
      administrator as principal.
- [ ] Downgrade the administrator after session creation and prove a later privileged tool call is
      denied instead of using a stored permission snapshot.
- [ ] Submit a turn as another principal accepted by the JWT scope boundary and prove it is accepted
      while agent and tool execution retain the persisted session principal.
- [ ] Run two turns with different initiators but the same persisted session principal and prove the
      principal is stable with no actor leakage.
- [ ] Execute a downstream tool in both production-style and fake Pi adapters and compare the
      complete actor object.
- [ ] Prove the fake does not parse an execution header or replace persisted session actors.

**Review gate:** do not merge Pi authority or provenance based only on scenario-fake behavior, and
do not let either the turn caller or Pi object service identity replace the persisted session
principal.

### Slice 9: Deferred Telegram attempt authorization

**Production behavior**

- [ ] Persist execution, operation, resource, payload, and trace carrier in a typed deferred action.
- [ ] Restore the envelope for every send/edit hook attempt.
- [ ] Wrap the actual Telegram API call, not merely enqueueing, in `kernel.invoke()`.
- [ ] Resolve current identity, membership, actor grants, and resource policy on every attempt.
- [ ] Distinguish terminal authorization denial from retryable transport failure.
- [ ] Record denial without calling Telegram or scheduling another delivery attempt.

**Required tests**

- [ ] Revoke permission after enqueue and before attempt one; prove no API call occurs.
- [ ] Fail attempt one, revoke before attempt two, and prove attempt two is denied.
- [ ] Revoke/rebind identity between attempts and prove the stale principal cannot deliver.
- [ ] Prove a Telegram transport failure still follows retry policy.

**Review gate:** enqueue success is never treated as authorization for asynchronous delivery.

### Slice 10: Resource-aware policy completion

**Production behavior**

- [ ] Apply principal permission, automation grant, agent grant, and resource policy intersection.
- [x] Protect store mutations with the stable `store.modify` operation and denial reasons.
- [ ] Protect identity mutations, Telegram actions, Pi session resources, and Pi agent use with
      stable operation names and denial reasons. Automation routing and default-agent values remain
      ordinary inputs whose referenced resources are authorized when used.
- [ ] Restrict unlinked Telegram bootstrap actions to the initiating chat.
- [ ] Resolve authority for every sensitive action from unexpired verified token evidence or current
      authoritative state; never persist permission snapshots in actor provenance.

**Required tests**

- [ ] Deny missing principal except documented bootstrap operations.
- [ ] Deny missing automation and agent grants independently.
- [ ] Deny cross-chat and cross-scope resource access.
- [ ] Revoke membership and capabilities between consecutive non-token/deferred actions and observe
      immediate denial; prove request-token authority ends at token expiry.

**Review gate:** review one resource policy at a time; do not land a broad wildcard policy as the
final production grant model.

### Slice 11: Observability and durable audit

**Production behavior**

- [ ] Add Cloudflare kernel spans from typed action observations.
- [ ] Keep durable-hook spans generic; never inspect arbitrary payloads for actors.
- [ ] Omit actor, principal, external-identity, and resource IDs from trace attributes.
- [ ] Keep tracing optional and authorization-independent.
- [ ] Add append-only audit records for external identity mutations and sensitive denials if the
      audit decision remains in scope. Automation routing and default-agent KV mutations remain
      ordinary store actions.

**Required tests**

- [ ] Disable tracing and prove authorization/results are unchanged.
- [ ] Prove generic hook instrumentation receives no arbitrary domain payload for actor scraping.
- [ ] Prove identity bind/revoke actions have one audit insertion point.
- [ ] Include kernel decisions, bindings, retries, and workflow history in scenario diagnostics.

**Review gate:** traces are diagnostics only; durable audit and authorization remain explicit
separate primitives.

## Open decisions and recommendations

### Persisted store attribution

**Decision:** remove actor attribution from KV rows. Trusted execution attribution is recorded at
the kernel action boundary instead of duplicating actor provenance on mutable user-owned store
entries. If durable audit requirements require persistence, add an append-only audit record rather
than reintroducing attribution fields on `kv_store`.

### Automation-defined Telegram-to-Pi routing

**Decision:** Session reuse cardinality belongs to automation behavior. The starter automation
currently stores a session ID under a per-principal key, while another automation may choose
per-chat, per-thread, per-run, or no reuse. The automation's workflow logic and state keys express
that routing policy, while the session retains the trusted execution actors established at creation.

Automation routing state may remain in generic KV or workflow state because it carries no authority
without the corresponding Pi permission. Trusted Pi session storage persists execution actors, not
permission grants. Public Pi operations resolve the requested permission from a verified JWT's role
and organization snapshot; trusted internal operations resolve current authority from explicit
execution context. Neither requires caller equality with the persisted principal. Agent and tool
execution use the persisted principal and resolve its current authority for every sensitive action.

### Default Pi agent selection

**Decision:** default-agent selection is automation-defined configuration and may remain in generic
KV. An automation may use the starter default, select another agent, or derive one from its own
event and configuration. The selected agent value grants nothing: Pi session creation and turns must
evaluate current principal permission, automation grants, agent grants, and resource policy before
using it.

### Execution-context module boundary

**Decision:** actor and chain types remain in Automations. The Backoffice kernel imports them
directly from `automation/actors.ts` rather than maintaining a second generic actor abstraction.
Trusted execution context crosses objects as an explicit typed RPC argument, separate from W3C trace
propagation.

### Permission resolution timing

**Decision:** the kernel invokes the required authority resolver for every sensitive operation and
retry. Immediate authenticated user actions may use authority from their verified Backoffice access
token until its 15-minute expiry. Executions without token authority, especially deferred retries,
resolve current Auth state. Missing, expired, or failed resolution denies, and actor objects never
persist permission snapshots.

### Automation authority ownership

**Decision:** every automation definition or equivalent trusted runtime-owned record explicitly
selects its authority mode. Authority is never inferred solely because an incoming event lacks a
principal.

- `delegated-user` execution requires an existing internal user principal, preserves that principal,
  and appends the automation as a delegate. Current user status and membership are rechecked for
  deferred actions, so banning or removing the user stops subsequent work.
- `organization-automation` execution installs the stable automation-definition identity as
  principal. The creator, installer, and last editor are attribution and audit facts only. The
  automation continues when any of those users are banned or leave, and stops when the automation is
  disabled, deleted, loses its grants, or loses access through organization policy.
- Trusted system services use their own explicit service principals. They do not acquire authority
  through an automation mode.

`createAutomationRuntimeExecution()` currently makes an automation principal when a non-system event
has no principal. Slice 7 must replace that inference with the explicit mode boundary. An eligible
internal user trigger may occupy the initiator slot without becoming principal for an
organization-owned automation. Do not duplicate one user identity into both initiator and principal
slots, silently treat an external initiator as a principal, or use creator identity as persistent
runtime authority. Delegation cannot increase whichever principal authority the selected mode
establishes.

### System authority

**Decision:** an internal user principal receives system permission from an unexpired verified
Backoffice access token only when its role is `admin`. Executions without token authority consult
current Auth state and require an active global administrator. The explicit `system-administrator`
role currently grants only `store.modify`.

Continue replacing broad system authority with narrowly identified service actors and explicit
grants. Reserve unrestricted system execution for infrastructure recovery and migration operations.

### Marketplace installation workflow authority

**Security note:** Marketplace installer artifacts are publisher-controlled JavaScript. They
currently execute with target-scoped system authority so installation can write files and reconcile
Automation routes. Preserving the requesting user's actors for emitted-event attribution does not
constrain this execution authority; provenance and authorization remain separate concerns. This
means an installer must be treated as arbitrary code holding broad mutation access, even when its
publication metadata and installation event were produced by trusted server code.

Do not trust installer-authored ownership fields such as `managedBy.listingId`, `version`, or actor
metadata. The installation runtime must derive Marketplace identity from trusted ingestion context
and enforce it at the mutation boundary. Replace general system-powered route mutation with a
constrained installation capability, preferably an atomic Marketplace route reconciliation operation
that injects ownership, preserves allowed user state, and rejects unmanaged or cross-listing
collisions. Apply the same rule to filesystem and future installation mutations: expose only the
operations and target scope required by installation rather than the general system runtime.

### External IDs in traces

**Decision:** kernel and durable-hook spans omit actor, principal, external-identity, and resource
IDs. Kernel spans may retain safe operation, scope-kind, actor-count, actor-role, and status
attributes. Generic durable-hook spans do not inspect domain payloads to derive actor attributes.

### Audit log scope

**Decision:** append-only durable audit records are required for external identity bind/revoke
operations and denied security-sensitive authorization decisions if durable audit remains in this
project's scope. Automation-defined session-routing and default-agent changes are ordinary KV
mutations and remain trace-only unless a product-specific compliance requirement promotes them.
Successful ordinary reads and other user-owned KV mutations remain trace-only. The audit schema
remains separate from sampled trace spans and mutable domain rows; kernel action observation is its
insertion point.

## Validation per slice

Every slice must pass three layers before its checkbox or review gate is accepted:

1. **Boundary tests:** focused unit or adapter-contract tests exercise the real acquisition and
   authorization boundary. This is mandatory for runtime construction, Durable Object RPC, ownership
   reads, and durable attempts.
2. **Vertical scenario:** one narrow scenario proves the user-visible flow with the same fake
   interface as production.
3. **Package validation:** typecheck, build, lint, formatting, and diff checks pass.

The review must explicitly answer:

- What value becomes trusted at this slice's entry point, and how was it acquired?
- What happens when the required resolver, principal, grant, binding, or context is absent?
- Does any fake accept metadata through a channel production does not consume?
- Does any asynchronous side effect occur after the authorization decision that supposedly guards
  it?
- Can identity revocation or rebinding expose state owned by the previous principal?
- Does tracing inspect arbitrary domain payload or influence authorization?

Run the slice's focused boundary tests and scenario first, followed by Backoffice validation:

```sh
pnpm --filter @fragno-apps/backoffice-rr exec vitest run <slice-test-files>

pnpm exec turbo types:check --filter=@fragno-apps/backoffice-rr --output-logs=errors-only
pnpm exec turbo build --filter=@fragno-apps/backoffice-rr --output-logs=errors-only
pnpm run lint:fix
pnpm run format:changed
git diff --check
```

A scenario-only pass cannot close a slice when the production adapter path is untested. Each slice
adds a narrow colocated test rather than expanding one broad scenario until its trust boundary is
hard to identify.

## Reference map

### Execution and authorization

- [`apps/backoffice/app/backoffice-runtime/context.ts`](../apps/backoffice/app/backoffice-runtime/context.ts)
- [`apps/backoffice/app/backoffice-runtime/kernel.ts`](../apps/backoffice/app/backoffice-runtime/kernel.ts)
- [`apps/backoffice/app/backoffice-runtime/authority-resolver.ts`](../apps/backoffice/app/backoffice-runtime/authority-resolver.ts)
- [`apps/backoffice/app/backoffice-runtime/authority-roles.ts`](../apps/backoffice/app/backoffice-runtime/authority-roles.ts)
- [`apps/backoffice/app/backoffice-runtime/permissions.ts`](../apps/backoffice/app/backoffice-runtime/permissions.ts)
- [`apps/backoffice/app/backoffice-runtime/object-registry.ts`](../apps/backoffice/app/backoffice-runtime/object-registry.ts)
- [`apps/backoffice/app/worker-runtime/router-context.ts`](../apps/backoffice/app/worker-runtime/router-context.ts)
- [`apps/backoffice/app/fragno/runtime-tools/runtime-tools.ts`](../apps/backoffice/app/fragno/runtime-tools/runtime-tools.ts)
- [`apps/backoffice/app/fragno/runtime-tools/tool-context.ts`](../apps/backoffice/app/fragno/runtime-tools/tool-context.ts)
- [`apps/backoffice/app/fragno/runtime-tools/route-backed-runtime-context.ts`](../apps/backoffice/app/fragno/runtime-tools/route-backed-runtime-context.ts)

### Automation events and workflows

- [`apps/backoffice/app/fragno/automation/contracts.ts`](../apps/backoffice/app/fragno/automation/contracts.ts)
- [`apps/backoffice/app/fragno/automation/schema.ts`](../apps/backoffice/app/fragno/automation/schema.ts)
- [`apps/backoffice/app/fragno/automation/definition.ts`](../apps/backoffice/app/fragno/automation/definition.ts)
- [`apps/backoffice/app/fragno/automation/event-routes.ts`](../apps/backoffice/app/fragno/automation/event-routes.ts)
- [`apps/backoffice/app/fragno/automation/content/starter-routing.ts`](../apps/backoffice/app/fragno/automation/content/starter-routing.ts)
- [`apps/backoffice/app/fragno/automation/engine/automation-codemode-workflow.ts`](../apps/backoffice/app/fragno/automation/engine/automation-codemode-workflow.ts)
- [`apps/backoffice/app/fragno/runtime-tools/families/event-runtime.ts`](../apps/backoffice/app/fragno/runtime-tools/families/event-runtime.ts)

### Store and identity-linking flow

- [`apps/backoffice/app/fragno/automation/store.ts`](../apps/backoffice/app/fragno/automation/store.ts)
- [`apps/backoffice/app/fragno/automation/bindings-storage-runtime.ts`](../apps/backoffice/app/fragno/automation/bindings-storage-runtime.ts)
- [`apps/backoffice/app/fragno/automation/bindings-route-runtime.ts`](../apps/backoffice/app/fragno/automation/bindings-route-runtime.ts)
- [`apps/backoffice/app/fragno/automation/route-callers.ts`](../apps/backoffice/app/fragno/automation/route-callers.ts)
- [`apps/backoffice/app/fragno/runtime-tools/families/automations-bindings.ts`](../apps/backoffice/app/fragno/runtime-tools/families/automations-bindings.ts)
- [`apps/backoffice/app/routes/api/automations-scoped.ts`](../apps/backoffice/app/routes/api/automations-scoped.ts)
- [`apps/backoffice/app/routes/api/automations-workflows.ts`](../apps/backoffice/app/routes/api/automations-workflows.ts)
- [`apps/backoffice/workers/automations.do.ts`](../apps/backoffice/workers/automations.do.ts)
- [`apps/backoffice/app/files/content/starter-automations.ts`](../apps/backoffice/app/files/content/starter-automations.ts)
- [`apps/backoffice/app/fragno/otp.ts`](../apps/backoffice/app/fragno/otp.ts)
- [`apps/backoffice/app/fragno/telegram.ts`](../apps/backoffice/app/fragno/telegram.ts)
- [`apps/backoffice/workers/otp.do.ts`](../apps/backoffice/workers/otp.do.ts)
- [`apps/backoffice/workers/telegram.do.ts`](../apps/backoffice/workers/telegram.do.ts)

### Scenario testing

- [`apps/backoffice/app/fragno/automation/scenario.ts`](../apps/backoffice/app/fragno/automation/scenario.ts)
- [`apps/backoffice/app/fragno/automation/starter-otp-linking.test.ts`](../apps/backoffice/app/fragno/automation/starter-otp-linking.test.ts)
- [`apps/backoffice/app/fragno/automation/scenario-starter-router.test.ts`](../apps/backoffice/app/fragno/automation/scenario-starter-router.test.ts)
- [`apps/backoffice/app/files/content/automations.test.ts`](../apps/backoffice/app/files/content/automations.test.ts)

### Propagation and tracing

- [`packages/fragno/src/api/request-context-storage.ts`](../packages/fragno/src/api/request-context-storage.ts)
- [`packages/fragno/src/api/fragment-instantiator.ts`](../packages/fragno/src/api/fragment-instantiator.ts)
- [`packages/fragno-db/src/hooks/hooks.ts`](../packages/fragno-db/src/hooks/hooks.ts)
- [`apps/backoffice/workers/lib/cloudflare-durable-hooks-instrumentation.ts`](../apps/backoffice/workers/lib/cloudflare-durable-hooks-instrumentation.ts)
