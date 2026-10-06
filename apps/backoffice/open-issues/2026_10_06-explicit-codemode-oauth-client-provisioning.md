# Replace automatic Codemode OAuth client creation with explicit provisioning

Status: Open Date: 2026-10-06

## Summary

Remove automatic creation of the `fragno-backoffice-codemode` OAuth client. Provision the
deployment's first-party client separately and configure its exact client ID. Better Auth still owns
the client, credentials, tokens, and device flow; Backoffice deployment configuration selects the
first-party execution policy.

This is a simplification proposal, not an implemented behavior change. The local OAuth client test
script exercises native authorization-code PKCE clients and does not replace the Codemode client.

## Current complexity

`workers/auth/better-auth-oauth.ts` currently:

- Finds the internal client through both `softwareId` and its bootstrap `referenceId`.
- Creates a fictional bootstrap user/session to call Better Auth's administrative endpoint.
- Temporarily mutates and restores Better Auth context session state.
- Special-cases that fictional identity in `clientPrivileges` and `clientReference`.
- Creates a missing client during Auth startup through `initializeBackofficeCodemodeOAuthClient`.
- Also creates it lazily through `loadBackofficeCodemodeOAuth` when loading CLI configuration or
  resolving an execution policy.

Deleting only the startup call in `workers/auth.do.ts` would retain most of this complexity and the
lazy creation behavior.

The creation helper is approximately 66 lines. Together with its initializer, privilege/reference
exceptions, constants, and startup wiring, roughly 90–100 lines could disappear gross.
Configuration, validation, and lookup would replace some of those lines: estimate 50–80 handwritten
lines removed net, subject to the provisioning design. These are estimates, not measured patch
results or latency benchmarks.

## Proposed boundary

1. Provision a public native OAuth client explicitly, with device-code and refresh-token grants and
   the existing `openid offline_access backoffice` scopes.
2. Add a deployment setting such as `AUTH_CODEMODE_OAUTH_CLIENT_ID` naming that exact Auth-owned
   client. The setting's final name and configuration surface remain to be decided.
3. Load and validate the configured client without creating one. CLI configuration and execution
   policy resolution use the same authoritative lookup.
4. Grant `first-party-user` only to a verified OAuth token whose client ID matches the configured,
   eligible, active client. Names, software metadata, app registrations, and installations must not
   establish first-party authority.
5. Remove the automatic creation helper, initializer, fictional bootstrap identity, privilege
   exception, and bootstrap reference-owner callback.

The current `admin.oauth-clients.create` tool provisions authorization-code **web or native**
clients, not device-flow clients. Explicit provisioning therefore still needs a supported device
client profile or a documented administrative setup operation. The `--application-type native`
option alone does not enable the Codemode profile.

## Failure and migration behavior

- Missing or invalid configuration should produce a clear CLI-specific error and fail execution
  closed, not prevent unrelated Auth/browser operations from starting.
- A disabled configured client must not receive first-party execution authority.
- Existing deployments can configure their already-created internal client ID; no automatic deletion
  or recreation is needed.
- Decide how development/scenario fixtures provision their client explicitly, without reintroducing
  an automatic production bootstrap path.
- Keep device approval, refresh, the shared execution-token endpoint, live user-grant resolution,
  scope ceilings, and existing JWT/kernel semantics unchanged.

## What this does not remove

- OAuth provider/device-flow plugins or their schema/migrations.
- OAuth resource registration, which is a separate concern.
- OAuth access-token verification or Backoffice execution-token issuance.
- Administrator client creation/listing and live management authorization.
- The real-administrator synthetic session used by the isolated admin creation tool. That workaround
  is independent of the fictional bootstrap identity.
- The need for a real OAuth client or deployment provisioning.
- Browser consent and personal grant revocation.
- Installation-backed external-app delegation, which remains unimplemented.

The startup saving is avoiding eager construction of the localhost Auth instance and its client
lookup, plus creation work on a fresh database. Measure startup latency separately if a performance
claim is required.

## Acceptance criteria

- Auth startup, CLI configuration, and execution exchange never implicitly create an OAuth client.
- Explicit native/device provisioning and deployment configuration are documented and testable.
- Ordinary browser Auth still works without configured CLI support.
- CLI configuration reports missing/ineligible clients clearly.
- Execution policy rejects missing, disabled, incorrectly configured, and unconfigured clients.
- Managed clients copying Codemode metadata cannot acquire first-party authority.
- Existing deployment clients can be reused across restart without changing their IDs.
- SQLite scenarios cover explicit setup, restart, missing configuration, disabled clients, device
  approval/refresh, and execution-token scope restrictions.
- The fictional bootstrap identity and its privilege/reference exceptions are gone.
