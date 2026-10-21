# Provision an organization for an owner who has not signed in yet

Status: Open Date: 2026-10-21

## Summary

`organizations.provision` requires `ownerUserId`, a Backoffice user who has already authorized the
calling app's OAuth client. A first-party app therefore cannot create an organization for someone
who has never signed in. Let the app name the owner by email instead: Backoffice creates the
organization with a pending owner invitation, installs the app, and returns the invitation so the
app can send and accept it through the existing `invitations.send` and `invitations.accept`.

This is a proposal; nothing is implemented.

## Motivation

Brand Intelligence (MI) is a first-party app whose operators (ReJot staff) create partner
organizations, such as a brand agency, from MI's operator page. Today the partner's owner must sign
in to MI first, so MI can pass their user ID. Operators ask the owner to sign in, wait, then create
the partner. Invitations into existing organizations do not have this problem: `invitations.create`
takes an email, and `invitations.accept` works for a brand-new account.

The interim workaround in MI is to provision with the operator as owner, invite the real owner with
role `owner`, and send that invitation. It leaves the operator as a permanent co-owner of every
partner, because the v0 API has no operation for an app to remove a member. That grants ReJot staff
owner rights in customer organizations, which is the wrong default.

Apps must not work around this by remembering "this organization goes to this email" and
provisioning on sign-in: membership has to come from Backoffice accepting an invitation, not from
the app matching an address.

## Current behavior

- `packages/backoffice-api/src/v0/provisioning.ts`: `provisionOrganizationInputSchema` is
  `{ externalOrganizationId, name, ownerUserId }`.
- `workers/auth.do.ts` `provisionAppOrganization`: rejects with `forbidden` unless
  `#hasAuthorizedApp(oauthClientId, ownerUserId)`, then writes the organization and an `owner`
  member in one transaction.
- `app/backoffice-api/provisioning-router.ts` `provisionOrganization`: installs the app with
  `installedByUserId: input.ownerUserId` and claims the installation for the external ID.
- The `invitation` row requires `inviterId`, and the app invitation email
  (`app/transactional-emails/app-invitation.tsx`) shows the inviter's name.
- `acceptAppInvitation` already requires the accepting user to have authorized the app and to own
  the invited, verified email.

## Proposed contract

Make the owner a union, keeping the existing form:

```ts
owner:
  | { userId: string } // today's ownerUserId: a user who authorized the app
  | { email: string; invitedByUserId: string };
```

The result gains the pending invitation when there is one:

```ts
{ organizationId, slug, created, ownerInvitation: { invitationId, expiresAt } | null }
```

For `{ email, invitedByUserId }`:

1. `invitedByUserId` must have authorized the app, as `ownerUserId` must today. A real, accountable
   person stands behind every provisioned organization, and the email names them.
2. In one transaction, create the organization **with no members** and a pending `owner` invitation
   to `email` whose `inviterId` is `invitedByUserId`. The inviter does not become a member.
3. Install the app with `installedByUserId: invitedByUserId` and claim it, as today.
4. The app calls `invitations.send` with its own acceptance URL, and `invitations.accept` once the
   person signs in. Both work unchanged, because the app is installed.

Replacing `ownerUserId` is a breaking change to v0. Either accept it while MI and Bookkeeping are
the only callers, or add `owner` alongside `ownerUserId` and reject requests that set both.

## Decisions to make

- **Ownerless organizations.** Until the invitation is accepted the organization has no members.
  Decide what Backoffice's UI, admin listings, `account.orgs.list` and authority checks do with one,
  and confirm that nothing assumes every organization has an owner. Only the invitation and the
  app's installation should be able to reach it.
- **Expiry.** If the owner invitation expires, the organization stays ownerless. A repeated
  `organizations.provision` for the same external ID should issue a fresh owner invitation when no
  owner exists and the previous one is no longer pending, and return it. It must not issue one while
  an owner exists.
- **Repeated calls with another owner.** Return the existing organization and ignore the new owner,
  as today, or answer `conflict` when no owner has accepted and the email differs. The second option
  lets an operator correct a typo.
- **Owner already known.** When `email` belongs to a user who has authorized the app, either still
  invite them (one path, explicit acceptance) or add them as owner directly. Inviting is simpler and
  leaves membership to an explicit acceptance.
- **Cancelling.** Decide who can revoke a pending owner invitation: global admins only, or the app
  as well.
- **Events.** The `organizations.provision` System event payload should show that the owner is
  pending, and accepting should record the usual membership event.

## Acceptance criteria

- `organizations.provision` with `{ email, invitedByUserId }` creates the organization with no
  members, a pending `owner` invitation from `invitedByUserId`, and the app installed and claimed.
- It rejects an `invitedByUserId` who has not authorized the app, and `invitedByUserId` never
  becomes a member.
- `invitations.send` emails that invitation in the app's name, naming the inviter.
- A person with no Backoffice account can sign in to the app, and `invitations.accept` makes them
  the organization's owner.
- Accepting with another address, or an unverified one, is still refused.
- The existing `ownerUserId` (or `{ userId }`) path behaves as today.
- Retries are idempotent, and the expiry and re-issue behavior is decided and tested.
- Scenarios in `app/backoffice-api/first-party-app.scenario.test.ts` cover the full flow: provision
  by email, send, sign in as a new user, accept, then use the organization as owner. They also cover
  the refusals above.
- `.agents/skills/backoffice-first-party-app/SKILL.md` describes provisioning for an invited owner.
