# Managing organizations

Status: Open Date: 2026-10-22

## Summary

Let a Backoffice scope manage organizations. A first-party app provisions an organization _managed
by_ a scope; in v0 that scope is always an organization. Whoever has authority in the managing scope
then reaches the managed organization through that relationship, without being its member, and the
app lists the organizations a scope manages. Applied twice, this gives first-party apps a
three-layer tenancy:

| Layer    | Bookkeeping          | Brand Intelligence (MI) | Scope that manages the next layer |
| -------- | -------------------- | ----------------------- | --------------------------------- |
| Operator | us, running the app  | ReJot                   | `org:<operator>`                  |
| Firm     | an accounting firm   | a partner (Smaac)       | `org:<firm>`                      |
| Client   | a client's workspace | a brand brain           | none                              |

Backoffice gains one relationship between scopes, not three concepts: "operator", "firm" and
"client" are the apps' words. To Backoffice, the operator organization is a scope that manages
others and is managed by none. A solo bookkeeper works through an organization of one, which can
grow into a team without moving its clients.

Two pieces it builds on are: `organizations.provisionForInvitee` (Linear BO-8) creates an
organization for an owner who has not signed in yet, and Bookkeeping's operators are the members of
an operator organization.

## Status

The relationship and access through it exist inside Backoffice, for automation agencies managing
their customers (see [Managed organizations](../app/fragno/auth/README.md#managed-organizations)).
This version differs from the proposal below:

- `organization.managingOrganizationId` replaces `managedBy`. It has no role ceiling: owners act as
  admins and everyone else keeps their role.
- A system administrator sets and ends it (`admin.org.manager.set`, `admin.org.manager.clear`). It
  is not fixed at provisioning.
- Its admins also act in O's members' personal workspaces, and like O's own members, everyone
  reaching O can read its app workspaces.
- Membership changes in O stay with O's own members, because Better Auth's organization endpoints
  serve only members. `invitations.create` and the members page's actions refuse managers.
- Credentials record no `via`. They are live through `me` and deferred authority, and an issued
  credential lasts until it expires, as after leaving an organization.

Everything for first-party apps is still open: managed provisioning, `managed.list`, `org.get`'s
`managedBy`/`access`, ownerless managed organizations, and Bookkeeping's and MI's migrations.

## Motivation

MI already has these layers, and each one works around Backoffice:

- **Operators are an allowlist.** `MI_OPERATOR_USER_IDS` lists Backoffice user IDs in an env var.
  Adding an operator is a deployment; Backoffice cannot see or audit who operates the app.
  Bookkeeping already replaced its allowlist with an operator organization, which needs nothing from
  this proposal.
- **The partner link lives only in MI.** MI's `Directory` stores each brand brain's `partnerId`.
  Backoffice does not know that Smaac manages the brand brain, so it cannot grant Smaac anything.
- **Managing means owning.** To reach a client's organization, partner staff must be its members.
  The creator is provisioned as owner and stays one; operators stay owners of every partner they
  create. Apps cannot remove members, so these ownerships are permanent.
- **Apps cannot list.** Installed apps cannot ask which organizations someone belongs to, so MI's
  partner dashboard and switcher show only what MI recorded itself.

Bookkeeping needs the same shape: we operate it, accounting firms sign up through us, and each firm
keeps the books of many clients. Its administrations (Backoffice projects inside one workspace)
cannot stand in for clients: every workspace member opens every administration, so a client could
never be let in to only their own books. Each client needs its own organization, as in MI.

If each app stored the relationship itself, two apps would duplicate an authority decision that
Backoffice owns: who may act in a scope.

## Model

An organization has at most one **managing scope**, fixed when it is provisioned:

```ts
// v0: organizations only. Scope-shaped, so other root owners can be added without a new field.
type BackofficeManagingScope = BackofficeOrganizationScope<BackofficeScopeIdNames>;

organization.managedBy: {
  scope: BackofficeManagingScope;
  roleCeiling: "admin" | "member";
} | null;
```

Only root owners can manage, because only they answer for people: an organization through its
members, a user as themselves. v0 accepts organizations only, because solo bookkeepers work through
an organization of one; a user scope could be added later, acting as a personal installation does.
The other kinds never manage:

- **System** administers Backoffice. Making operators system administrators would hand them every
  tenant; the operator layer is an ordinary organization instead.
- **App workspaces** (`app:<owner>:<appId>`) are the app's private data. An installation acting as
  itself already reaches every scope it is installed in, so it needs no relationship.
- **Projects** have no members of their own.

Only organizations are managed. A user's personal scope is theirs alone, as a personal installation
acts only for its owner.

**Authority in the managing scope.** A person acts in a managed organization O with their authority
in its managing scope, capped at the relationship's `roleCeiling`:

| Role in the managing organization `org:M` | `roleCeiling: "admin"` | `roleCeiling: "member"` |
| ----------------------------------------- | ---------------------- | ----------------------- |
| owner or admin                            | admin                  | member                  |
| member                                    | member                 | member                  |

Management never confers `owner`: a firm cannot remove its client's owners or delete the client.
Someone who is both a direct member of O and has authority in its managing scope gets the higher of
the two roles.

**What "reaching O" covers.** Management follows ownership, as installations' approved resources do:
it covers `org:O` and the projects O owns (`project:org:O:<id>`), such as Bookkeeping's
administrations. It does not cover O's app workspaces (`app:org:O:<appId>`), which stay each app's
own.

**Not containment.** `backofficeScopeContains` does not change: a credential for `org:M` never
reaches `org:O`. The manager exchanges a token for O's scope explicitly, so every credential still
names the one scope it acts in.

**Not transitive.** Access goes down one level. `org:operator` reaches firms, and `org:firm` reaches
its clients, but operators do not reach clients: an accounting firm's client books are not ours to
open. An operator who needs to help a client is invited like anyone else.

**Ownerless while managed.** A managed organization may have no owner, for example a client who
never signs in, which is common in bookkeeping. While O has no owner, the managing organization's
owners may invite O's owners; nothing else changes. An unmanaged organization still always has an
owner.

**Live, like installations.** The relationship is resolved on every protected operation, as
installation grants are. Removing someone from the firm, or ending the relationship, takes effect on
credentials already issued.

## Contract changes

### Provisioning

`organizations.provision` (owned by a user) and `organizations.provisionForInvitee` (owned by an
invited email) both gain a managing scope, and a third operation provisions a managed organization
with no owner. Fields are never optional; `null` says "none".

```ts
managedBy: {
  scope: BackofficeManagingScope;
  roleCeiling: "admin" | "member";
  // An owner or admin of the managing organization who authorized the app. Recorded as the
  // organization's creator and the installation's installer; they do not become a member.
  byUserId: string;
} | null;
```

Their results add `managedBy: BackofficeManagingScope | null`. Old clients parse results strictly,
so the new fields need new operations or a coordinated update of every first-party app.

Provisioning under a scope requires the app to be actively installed there. Repeated calls with the
same external ID return the existing organization; one that names a different managing scope answers
`conflict`.

`invitations.create` accepts an inviter whose authority in O comes from its managing scope, with
their effective role. It is how a firm invites its client, and how an ownerless client gets its
owner.

### Scoped operations

| Operation          | Scope   | Change                                                                                                                                                                                           |
| ------------------ | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `org.get`          | `org:O` | Adds `managedBy: { scope, name } \| null` and `access: { kind: "direct" } \| { kind: "managing"; via: BackofficeManagingScope }`; `roles` are the effective roles.                               |
| `managed.list`     | `org:M` | New, `org.read`: the organizations the scope manages where the calling app is installed, with `{ organizationId, name, slug, hasOwner }`, cursor-paginated. Firm and operator dashboards use it. |
| `org.members.list` | `org:O` | Unchanged: direct members only. People reaching O through its managing scope are not O's members.                                                                                                |

### Credential exchange

`POST /api/backoffice/execution-token` for `org:O`, or a project O owns, also succeeds for a user
with authority in O's managing scope, when the app is installed in O. The credential records the
path (`via: org:M`), so each operation resolves the effective role live. Events name the person as
the actor and the managing scope as the path. Kernel authority stays "the user's effective
permissions ∩ the installation's grants".

### Backoffice UI

An organization's settings show "Managed by Acme" with the role ceiling. Its owners can end the
relationship (see the decisions below). A managing scope's pages list the organizations it manages.
Neither is needed for the apps to work.

## How the apps use it

**Operator organization.** Bookkeeping already has one: `backoffice:connect` creates or reuses it,
installs the app there with the administrator as owner, and writes its ID to
`BOOKKEEPING_OPERATOR_ORGANIZATION_ID`. An operator is a confirmed member of `org:<operator>`,
checked like any other membership, and is added by invitation. MI's `MI_OPERATOR_USER_IDS` should
follow. Backoffice needs no operator concept; this proposal makes the operator organization the
managing scope of the firms.

**Bookkeeping** already has the three layers with an app-local firm link, as MI does. With this
proposal:

- `/operator`: firms, from `managed.list` in `org:<operator>`. Creating a firm provisions it managed
  by `org:<operator>` with `roleCeiling: "admin"` through `organizations.provisionForInvitee`, then
  sends the owner invitation. We help firms as admins, never as owners; today operators don't open
  firms at all unless invited.
- `/f/:slug`: the firm's clients, from `managed.list` in `org:<firm>`, and the firm's members.
  Creating a client provisions it managed by `org:<firm>`, for an invited owner or none. Every firm
  member opens every client; firm staff do not become client members.
- `/w/:slug`: the client's workspace, with its administrations, which the firm reaches as O's
  projects. `requireOrganization` accepts `access: { kind: "managing" }`.
- The `Directory` object keeps each organization's kind (operator, firm, client), which Bookkeeping
  owns, and its `firmId` becomes a cache of `managedBy` from `org.get`, which Backoffice owns.

**MI.** Partners are provisioned managed by `org:<operator>`, and brand brains by `org:<partner>`.
MI's `Directory.partnerId` becomes a cache of `managedBy`. Operators and partner creators stop being
owners: partners are provisioned for their invited owner, and partner staff reach brand brains
through management. Today's "partner membership does not open brand brains" becomes `roleCeiling`
and is MI's choice per relationship.

## Decided

- **Solo bookkeepers** work through an organization of one; v0 has no user-scope managers.
- **Whole organizations.** Management covers an organization and its projects, never a selection of
  them. Unlike installations, the relationship has no approved resources.
- **No self-serve in Bookkeeping.** As in MI, people join through invitations: operators create
  firms, and firms create clients. Bookkeeping already works this way with app-local layers; this
  proposal moves the firm-to-client link into Backoffice.

## Decisions to make

- **Attaching existing organizations.** An organization that already uses the app later hires a
  firm. This needs the client's consent, such as a management request its owner accepts, so it is
  out of scope here. `managedBy` is fixed at provisioning in v0.
- **Ending management.** Recommended: O's direct owners can end it at any time (a client leaves its
  firm). The managing scope can release O only when O has an owner, so no organization is left
  unreachable. Ending it does not delete O or uninstall the app.
- **Transitivity.** Recommended: none, as above. Revisit only for a concrete support need, and then
  as an explicit, audited grant rather than inherited access.
- **Role ceiling changes.** Recommended: O's owners can lower `roleCeiling`; raising it needs both
  sides, so it waits with attaching.
- **Who sees managers.** Recommended: O's members see the managing scope's name, not the list of its
  members. The audit trail names the individual actor.
- **One managing scope.** Recommended: at most one per organization, which keeps the rules and
  listings simple. Two firms jointly serving one client is out of scope.
- **Scope of the relationship.** Recommended: the relationship belongs to the organization, not to
  one app's installation, because Backoffice's own UI and agents should see the same authority. The
  role ceiling and the installation's grants still bound what each app may do.

## Phasing

1. **The relationship, provisioning, `org.get`, `managed.list`.** MI and Bookkeeping can model all
   three layers in Backoffice. Access to clients still needs membership, through invitations.
2. **Access through management**, in the credential exchange, the kernel and `invitations.create`.
   Firm staff stop being client members; MI's co-owners go away.
3. **Backoffice UI** for the relationship, and ending it.

## Acceptance criteria

- Provisioning managed by `org:M` creates O with `managedBy`, and the app installed and claimed. It
  requires the app's installation in M and an owner or admin of M who authorized the app as
  `byUserId`, who does not become a member of O.
- A repeated call with the same external ID returns O; one with a different managing scope answers
  `conflict`.
- A person with authority in the managing scope exchanges a user token for `org:O` or one of O's
  projects, and acts with their role capped at the ceiling. They never act as owner, never reach O's
  app workspaces, and lose access immediately when they leave M or the relationship ends.
- A credential for `org:M` does not reach `org:O`, and members of an operator organization cannot
  reach the organizations its managed organizations manage.
- `managed.list` lists exactly the scope's managed organizations where the calling app is installed.
- Scenarios in `app/backoffice-api/first-party-app.scenario.test.ts` provision operator → firm →
  client, with an invited firm owner and an ownerless client. They cover access, refusal, and the
  end of a relationship.
- Bookkeeping's fake Backoffice implements the same contract, and `.agents/skills/backoffice-apps/`
  describes managed tenancy.
