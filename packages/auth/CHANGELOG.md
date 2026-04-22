# @fragno-dev/auth

## 0.0.17

### Patch Changes

- e63dc7d: fix: tighten organization permissions and cursor validation.
- 36796f7: refactor: adopt the principal-first auth contract.

  This release finalizes the auth principal + credential strategy refactor:
  - authenticated routes now rely on the ambient `fragno_auth` cookie or
    `Authorization: Bearer <token>`
  - `sessionId` request transport has been removed from the public auth route/client contract
  - sign-up, sign-in, and OAuth callback JSON responses now return `auth.token` (plus auth metadata)
    instead of `sessionId`
  - auth lifecycle hooks are now `onCredentialIssued` and `onCredentialInvalidated`
  - `SessionHookPayload` and `SessionSummary` alias exports have been removed
  - the browser-facing auth cookie is now consistently named `fragno_auth`
  - `fragment.services.buildSessionCookie(...)` has been renamed to
    `fragment.services.buildAuthCookie(...)`
  - `fragment.services.getSession(headers)` has been removed in favor of the shared request-auth
    helpers
  - session-centric organization/member/invitation/user service entrypoints have been removed in favor
    of credential-, actor-, and principal-oriented variants

  Migration notes:
  - replace `response.sessionId` with `response.auth.token`
  - stop forwarding `sessionId` in route query params or request bodies
  - update hooks from `onSessionCreated` / `onSessionInvalidated` to `onCredentialIssued` /
    `onCredentialInvalidated`
  - remove any `SessionHookPayload` / `SessionSummary` imports in favor of the credential-named types
  - update any cookie handling from `sessionid` to `fragno_auth`
  - replace `fragment.services.buildSessionCookie(...)` with `fragment.services.buildAuthCookie(...)`
  - replace `fragment.services.getSession(headers)` with the shared request-auth helpers at the auth
    boundary
  - update direct service calls from `*WithSession` / `*ForSession` to the new `*ForCredential`,
    actor, or principal variants

- f856070: Ensure all non-private packages include repository metadata in their `package.json` entries.
- Updated dependencies [03d5a5c]
- Updated dependencies [a28094e]
- Updated dependencies [9919fdd]
  - @fragno-dev/core@0.2.3
  - @fragno-dev/db@0.4.2

## 0.0.16

### Patch Changes

- 0020e39: fix: align nanostores dependencies on version 1.2 across Fragno packages
- Updated dependencies [0020e39]
  - @fragno-dev/core@0.2.2
  - @fragno-dev/db@0.4.1

## 0.0.15

### Patch Changes

- 89f2bf0: feat: expand hook payloads, enforce banned users, add active org in sessions
- b278e8f: fix: harden organization invitation lifecycle for resends, cancellations, and expiry
- d686da9: feat: add oauth flow, schema, and docs for auth fragment
- 68b0f76: feat: add organization client hooks and /me response types
- 09424e3: fix: honor org role defaults, allow clearing org fields, and hide deleted orgs
- 57c5777: feat: add auth/org hooks and organization config wiring
- 99935b8: feat: add organization routes and enrich /me payload with org data
- 4bcb53f: feat: add organization tables and active org session field to auth schema
- 972e66d: fix: correct org session limits and member listing
- d1962d2: fix: use Web Crypto helpers and widen OAuth provider typing
- 4d141f8: fix: remove development exports from published packages
- 3e0b6a3: fix(auth): enforce organization permissions, limits, and last-owner guards
- 567c3b3: feat: add default org preference helpers and session seeding
- 973cea4: feat: allow disabling email/password auth routes
- fa3f477: feat: improve organization invitations and active org defaults
- Updated dependencies [8a96998]
- Updated dependencies [3e2ff94]
- Updated dependencies [f34d7d7]
- Updated dependencies [4d141f8]
- Updated dependencies [c8841b5]
- Updated dependencies [83f6223]
- Updated dependencies [ae54a60]
- Updated dependencies [7dd7055]
- Updated dependencies [e178bf4]
- Updated dependencies [d2f68ba]
- Updated dependencies [567c3b3]
- Updated dependencies [75191db]
- Updated dependencies [d395ad2]
- Updated dependencies [75407f3]
- Updated dependencies [8a2da9d]
- Updated dependencies [bfdd4b1]
- Updated dependencies [3ffa711]
- Updated dependencies [c2c3229]
- Updated dependencies [e559425]
- Updated dependencies [fc5c256]
- Updated dependencies [93fa469]
- Updated dependencies [14e00b1]
- Updated dependencies [f33286c]
- Updated dependencies [b3ad7eb]
- Updated dependencies [95cdf95]
- Updated dependencies [eabdb9c]
- Updated dependencies [9eeba53]
- Updated dependencies [49a9f4f]
- Updated dependencies [dcba383]
- Updated dependencies [c895c07]
- Updated dependencies [ed4b4a0]
- Updated dependencies [1102ce0]
- Updated dependencies [2ae432c]
- Updated dependencies [ad2ef56]
- Updated dependencies [9f87189]
- Updated dependencies [0f9b7ef]
- Updated dependencies [6d043ea]
- Updated dependencies [fe55a13]
- Updated dependencies [01fc2cb]
- Updated dependencies [f4aedad]
- Updated dependencies [f042c9d]
- Updated dependencies [0176aa8]
- Updated dependencies [00f2631]
- Updated dependencies [c13c1c1]
- Updated dependencies [0a6c8da]
- Updated dependencies [7a40517]
- Updated dependencies [91a2ac0]
- Updated dependencies [7bda0b2]
- Updated dependencies [c115600]
- Updated dependencies [b84a3d0]
  - @fragno-dev/db@0.4.0
  - @fragno-dev/core@0.2.1

## 0.0.14

### Patch Changes

- 47a2e19: fix(auth): use typed client calls and harden auth helpers
- 311d05a: feat(auth): move auth fragment to packages/auth and publish as @fragno-dev/auth.
- c551339: fix(auth): align mount route defaults and tx-based services
- 12524b0: fix(auth): invalidate session/user caches after sign-out and role updates
- Updated dependencies [f569301]
- Updated dependencies [dbbbf60]
- Updated dependencies [3e07799]
- Updated dependencies [20a98f8]
- Updated dependencies [1902f30]
- Updated dependencies [15e3263]
- Updated dependencies [208cb8e]
- Updated dependencies [33f671b]
- Updated dependencies [fc803fc]
- Updated dependencies [0628c1f]
- Updated dependencies [7e1eb47]
- Updated dependencies [301e2f8]
- Updated dependencies [5f6f90e]
- Updated dependencies [1dc4e7f]
- Updated dependencies [2eafef4]
- Updated dependencies [3c9fbac]
- Updated dependencies [a5ead11]
- Updated dependencies [7d7b2b9]
- Updated dependencies [c4d4cc6]
- Updated dependencies [d4baad3]
- Updated dependencies [548bf37]
- Updated dependencies [a79e90d]
- Updated dependencies [3041732]
- Updated dependencies [7e179d1]
- Updated dependencies [0013fa6]
- Updated dependencies [7c60341]
- Updated dependencies [afb06a4]
- Updated dependencies [53e5f97]
- Updated dependencies [8e9b6cd]
- Updated dependencies [c5fd7b3]
- Updated dependencies [69b9a79]
- Updated dependencies [5cef16e]
  - @fragno-dev/core@0.2.0
  - @fragno-dev/db@0.3.0

## 0.0.13

### Patch Changes

- Updated dependencies [aca5990]
- Updated dependencies [f150db9]
- Updated dependencies [0b373fc]
- Updated dependencies [fe27e33]
- Updated dependencies [9753f15]
  - @fragno-dev/db@0.2.2

## 0.0.12

### Patch Changes

- Updated dependencies [aecfa70]
- Updated dependencies [3faac77]
- Updated dependencies [01a9c6d]
- Updated dependencies [5028ad3]
- Updated dependencies [20d824a]
  - @fragno-dev/db@0.2.1

## 0.0.11

### Patch Changes

- Updated dependencies [8429960]
- Updated dependencies [4d897c9]
- Updated dependencies [a46b59c]
- Updated dependencies [bc072dd]
- Updated dependencies [e46d2a7]
- Updated dependencies [fcce048]
- Updated dependencies [147bdd6]
- Updated dependencies [f9ae2d3]
- Updated dependencies [f3b7084]
- Updated dependencies [c3870ec]
- Updated dependencies [75e298f]
  - @fragno-dev/db@0.2.0
  - @fragno-dev/core@0.1.11

## 0.0.10

### Patch Changes

- Updated dependencies [aabd6d2]
  - @fragno-dev/core@0.1.10
  - @fragno-dev/db@0.1.15

## 0.0.9

### Patch Changes

- 5ea24d2: refactor: improve Fragment builder and instatiator
- Updated dependencies [d6a7ff5]
- Updated dependencies [e848208]
- Updated dependencies [e9b2e7d]
- Updated dependencies [5e185bc]
- Updated dependencies [ec622bc]
- Updated dependencies [219ce35]
- Updated dependencies [b34917f]
- Updated dependencies [7276378]
- Updated dependencies [462004f]
- Updated dependencies [5ea24d2]
- Updated dependencies [f22c503]
- Updated dependencies [3474006]
  - @fragno-dev/db@0.1.15
  - @fragno-dev/core@0.1.9

## 0.0.8

### Patch Changes

- Updated dependencies [acb0877]
  - @fragno-dev/core@0.1.8
  - @fragno-dev/db@0.1.14

## 0.0.7

### Patch Changes

- Updated dependencies [09a1e13]
  - @fragno-dev/core@0.1.7
  - @fragno-dev/db@0.1.13

## 0.0.6

### Patch Changes

- Updated dependencies [b54ff8b]
  - @fragno-dev/db@0.1.13

## 0.0.5

### Patch Changes

- Updated dependencies [be1a630]
- Updated dependencies [b2a88aa]
- Updated dependencies [2900bfa]
- Updated dependencies [059a249]
- Updated dependencies [f3f7bc2]
- Updated dependencies [a9f8159]
- Updated dependencies [9d4cd3a]
- Updated dependencies [fdb5aaf]
  - @fragno-dev/core@0.1.6
  - @fragno-dev/db@0.1.12

## 0.0.4

### Patch Changes

- Updated dependencies [b6dd67a]
- Updated dependencies [ec1aed0]
- Updated dependencies [9a58d8c]
  - @fragno-dev/core@0.1.5
  - @fragno-dev/db@0.1.11

## 0.0.3

### Patch Changes

- Updated dependencies [ca57fac]
  - @fragno-dev/core@0.1.4
  - @fragno-dev/db@0.1.10

## 0.0.2

### Patch Changes

- Updated dependencies [ad3e63b]
  - @fragno-dev/db@0.1.10
