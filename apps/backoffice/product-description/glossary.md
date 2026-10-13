# Glossary

The vocabulary used across these documents. A term here has the same meaning wherever it appears.

## The surface

**Backoffice.** The signed-in browser application for configuring and operating automation
workspaces and related resources.

**Application shell.** The shared header and primary navigation surrounding signed-in pages. It
exposes the current scope, project, account menu, activity control, and top-level areas.

**Scope.** The context in which a resource is viewed or changed: System, personal, organization, or
project. A scope is reflected in route paths and may determine available data and authority.

**Project.** A resource context nested under an organization and selected separately from the
organization scope where the UI offers it.

**Organization.** A shared workspace with members, invitations, billing, and scoped resources.

**System scope.** The global Backoffice context for installation-wide operations and system-owned
resources. The scope selector exposes it only to global admins.

**Billing statement.** An organization-scoped summary of recorded usage measurements for one UTC
month. The page labels the amount as an estimated total.

## Objects and work

**Automation.** A configured set of event sources and routes that can start or direct workflow
execution.

**Workflow.** Durable work made up of steps, which may wait, retry, or continue after the initiating
request has ended.

**Run.** One execution of a workflow or agent session, with a start and terminal or still-running
state. A run can create effects before it completes.

**Durable work.** Work whose progress is persisted so it can continue or be inspected after the
request or page that started it has ended.

**Session.** A persisted interaction with an agent, including its messages and execution activity. A
session can be inspected and may have an ongoing or completed run.

**File.** Content stored in a Backoffice file collection, presented within a scope and path.

**Upload provider.** A configured storage destination for organization-scoped Upload files, such as
Workspace, R2, or R2 remote.

**Virtual folder.** A folder path shown in the Upload explorer before a file exists there. It is
local UI state, not a durable empty-directory object.

**Store entry.** A scoped automation key/value record that workflows can read or write; the Store
screen can inspect and delete entries.

**MCP server.** A configured remote Model Context Protocol server whose advertised tools can be
discovered for automation use.

**Webhook endpoint.** A configured inbound HTTP endpoint that can accept external deliveries when
enabled and validly authenticated.

**Workspace files.** Persistent files stored under `/workspace` for the active personal,
organization, or project scope. They are distinct from read-only Static product files.

**Static files.** Immutable product-owned guidance and artifacts shown under `/static` for personal,
organization, and project scopes.

**System files.** Admin-only system-scope files and metadata shown under `/system`.

**Artifact.** A reusable marketplace item that can be browsed, installed into a scope, or published
by its owner.

**Listing.** The marketplace catalog record for an artifact, including its publisher, summary,
category, tags, and published versions.

**Version.** A named release of a marketplace listing. A version can be selected for installation
independently of the latest release.

**Installation.** The process that ingests a selected listing version into a workspace folder and
records its installed release. Request acceptance and completed installation are separate states.

**Cursor.** An opaque pagination value carried in a URL query. It identifies a continuation point;
it is not a page number.

**Integration.** A configured connection to an external service or protocol, such as GitHub,
Telegram, email, an API endpoint, or MCP.

**Event source.** A source that emits events into the automation workspace. The dashboard can show
it as a lane node.

**Trigger.** A configured condition that responds to an event or schedule and can start a workflow.
A disabled trigger is visible but does not act on its source.

**Inspector.** The contextual dashboard panel opened for a selected source, event, trigger, or
action.

**Swimlane.** The automation dashboard's visual lanes for Sources, When, and Then, which show
relationships among event sources and workflow routes.

**Activity.** A view of operational or recent work exposed from the application shell; the precise
contents depend on the current product surface.

## State and access

**Authority.** The effective permission to perform an operation, derived from the signed-in identity
and resource scope. A visible control is not a guarantee that the server will accept the operation.

**Member.** A user associated with an organization and assigned one or more organization roles.

**Role.** A named set of permissions assigned at an account or organization boundary. A global admin
account role is distinct from organization owner/admin roles; the role grant matrix determines
individual capabilities.

**Invitation.** A pending request for a user to join an organization with proposed roles and an
expiry. Accepting adds membership; rejecting declines the invitation.

**Preferred organization.** The organization Backoffice selects as the user's preferred active
organization when resolving organization context. It can be changed from the organization directory.

**OAuth.** A delegated authorization flow that lets an application act using a user's approval,
often by redirecting through an external provider. Backoffice's personal OAuth consents are separate
from organization app installations.

**OAuth consent.** A user's recorded approval for an OAuth client, including granted scopes and
other requested access. The user can revoke a consent from Authorized applications.

**Dirty.** A form has local edits that have not yet been accepted as a successful save. Whether
navigation warns about dirty state is feature-specific and must not be assumed.

**Saved.** A change has been accepted by the relevant server-side operation and is reflected in the
resulting page or data. A pending visual update alone is not proof of saved state.

**Queued.** A service has accepted work for later execution, such as an outgoing email. Queued does
not mean delivered or completed.

**Pending.** An operation has started but has not yet reached a visible success or failure result.

**Streaming.** Session output is arriving incrementally while an agent run is in progress.

**Disabled.** A workflow route or other feature is configured but not currently enabled to act on
its trigger.

## Interaction and interruption

**Page/form lifecycle.** The shared interaction model: arrive, leave untouched, begin editing, while
editing, submit.

**Cancel.** The user explicitly abandons a dialog or pending interaction using a cancel control,
Escape, or an equivalent explicit action. Effects already accepted by the server are not implied to
roll back.

**Navigate or switch.** The user leaves a page or changes scope, project, or top-level area while
work is in progress.

**Complete.** An operation reaches its intended successful endpoint. For a save, this means the
server accepted the change; for a session run, it means the run reached a terminal state.

**Interrupt.** A failure or external change prevents an operation from proceeding normally. It may
leave already-persisted effects intact.

**Session expiration.** The authentication state no longer authorizes the current request; pages or
actions may redirect or fail according to the route's handling.

## Events that end or interrupt an interaction

**Explicit cancel.** A user-triggered cancel action or Escape when the active control handles
Escape.

**Navigation interrupt.** Leaving the current route, switching scope/project, or selecting a
different application area.

**Competing completion.** A separate action submits, saves, or otherwise completes work relevant to
the same page or target.

**Request failure.** A request fails, times out, or loses its network connection before the result
is known.

**Page termination.** Reloading or closing the tab; in-flight client activity may stop, while
already-saved server data remains.

**Target change.** Another actor changes or removes the target, or the current identity loses access
before the operation completes.

**Browser/input change.** Browser focus, autofill, keyboard behavior, or another tab changes the
state while the user is interacting.

**Feature-specific state change.** A run, workflow, organization, or external integration changes
state in a way that alters what the page can do.

## Interface

**Route.** A URL-addressable Backoffice page or nested page. Route parameters often encode scope and
selected resource.

**Toast.** A transient status message shown after an action; do not assume every action has one.

**URL state.** Query parameters or path segments that encode selected scope, view, filters, or
resource identity and can therefore be restored by navigation or reload.

**Local-first collection.** A browser collection that presents data through local persistence while
synchronizing with a remote source. It can be loading, ready, or failed; local visibility alone does
not prove remote completion.

**Nano-USD.** A billing quantity unit equal to one billionth of a US dollar. Backoffice converts
this quantity to a dollar-formatted estimated amount.

**UTC month.** A calendar month boundary calculated in Coordinated Universal Time. Backoffice
billing assigns completed usage to the UTC month, not the viewer's local month.
