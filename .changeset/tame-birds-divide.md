---
"@fragno-dev/auth": patch
---

refactor: adopt the principal-first auth contract.

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
