Yes. I’d treat the first five as **merge blockers**.

## 1. Make the data cutover explicit

There is no real migration from Fragno Auth data to Better Auth data.

This is intended: **Clean reset:** create a new Auth DO class/namespace and require re-registration.

## 2. Pick one email-verification authority — fixed

The custom OTP flow is the sole email-verification authority:

- `verify-email.tsx` only asks the OTP Durable Object to confirm the challenge.
- The OTP Durable Object recovers the trusted email from the persisted OTP, verifies that it still
  matches the Better Auth user, and marks the user verified before returning success.
- Its durable confirmation hook invokes the same idempotent operation as a retry fallback. Retrying
  an already-confirmed link also retries the operation.
- The page deliberately does not sign the user in and now directs them to continue to sign in.
- The unused `onUserEmailVerified` Auth hook is no longer enqueued.

## 3. Decide where active organization state lives — fixed

The verified Backoffice JWT's singular `organization` claim is the only active-organization
authority. Better Auth session state is not consulted by application routes.

The browser keeps `fragno-backoffice-default-organization` only as an untrusted preference. Token
issuance validates it against current membership, repairs stale values, and falls back
deterministically. Organization switching replaces the JWT before updating the preference.

## 4. Fix mixed-credential detection — fixed

Application authentication gives an explicit Authorization header precedence over cookies. It
requires a syntactically valid Backoffice bearer JWT and never falls back to cookies after malformed
or invalid input. Without Authorization, it reads only the Backoffice JWT cookie and ignores Better
Auth session and unrelated cookies. Opaque bearer sessions are unsupported.

## 5. Restore client contract quality

The handwritten compatibility client loses several important properties.

I would:

- preserve Better Auth error `code`, status, and message instead of throwing plain `Error`;
- add explicit query invalidation after mutations;
- update invitation and organization state immediately;
- expose stable mutation callbacks;
- replace numeric offset “cursors” with real cursor-based pagination.

The offset pagination is particularly inconsistent with the repository’s cursor-only data-layer
philosophy. If Better Auth only exposes offset pagination for these endpoints, add Backoffice-owned
cursor endpoints rather than leaking offsets through a cursor-shaped API.

## 6. Clarify invitation semantics

- Either support multiple invitation roles properly or make the UI single-select.
- Do not present `token` and `invitationId` as independent when both contain the same value.
- Prefer a URL containing only the opaque invitation ID, relying on authenticated email ownership.
- If a second secret is desired, add a separately generated, hashed token and validate it
  server-side.
- Configure `invitationExpiresIn` explicitly so the change from three days to 48 hours is
  intentional.
  ([better-auth.com](https://better-auth.com/docs/beta/plugins/organization?utm_source=openai))
- Refetch invitation lists after create, accept, and reject.

## 7. Re-establish durable event guarantees

The custom hook queue is separate from the Better Auth SQL mutations.

At minimum:

- add failure-injection tests between the auth commit and hook enqueue;
- persist the outbox in SQL alongside the auth mutation where possible;
- pass request propagation context into organization hooks;
- prune completed hook records;
- surface permanently failed hooks operationally.

Otherwise organization changes can commit without the corresponding automation event.

## 8. Harden deployment configuration

- Rename or alias `AUTH_ACCESS_TOKEN_SECRET` to make it clear that it is now the Better Auth
  application secret.
- Validate minimum secret length at startup.
- Use an explicit canonical `baseURL` and an allowlist of trusted origins rather than trusting each
  incoming request origin.
- Update GitHub’s callback URL to `/api/auth/callback/github`.
- Configure explicit rate limits for sign-in, sign-up, and resend endpoints.

Better Auth uses trusted origins for CSRF and callback validation, and recommends explicit base URL
configuration for stability.
([better-auth.com](https://better-auth.com/docs/reference/security?utm_source=openai))

## 9. Define the JWT boundary — fixed

The durable architecture is documented in `apps/backoffice/app/fragno/auth/README.md`. Better Auth
sessions renew identity only under `/api/auth`; Backoffice JWTs authorize both browser and service
application requests. Role, membership, and ban claims may remain stale for the token's 15-minute
lifetime.

**My preferred order:** data cutover → verification correctness → active organization → credential
parsing → client invalidation/pagination → durable hooks → invitation cleanup → deployment
hardening.
