# Backoffice authentication boundary

Backoffice uses two credentials with separate responsibilities.

- Better Auth sessions are renewable authentication roots. Their cookies are restricted to
  `/api/auth` and are accepted only by Better Auth management, token-broker, refresh, and sign-out
  endpoints.
- Backoffice JWTs authorize application requests. Browsers carry them in an HttpOnly cookie; service
  clients carry the same JWT in an `Authorization: Bearer` header.

`POST /api/auth/backoffice-token` is the only supported JWT issuer. It validates the requested
preferred organization against current membership and signs one active organization into the JWT.
The browser stores only the selected organization ID as an untrusted preference; it never stores the
JWT.

Application request authentication is owned by `request-auth.server.ts`. An explicit Authorization
header takes precedence over cookies and never falls back after malformed or invalid input. Without
an Authorization header, only the Backoffice access-token cookie is considered. Better Auth session
cookies and unrelated cookies are ignored.

`GET /api/backoffice/me` discovers current memberships and invitations, but its active organization
always comes from the verified JWT. Organization, role, and ban changes take effect for existing
JWTs when their 15-minute lifetime ends or when the browser requests a replacement.

Changing organizations requests a replacement JWT first, then updates the client preference and
revalidates route data. Sign-out revokes the Better Auth session and expires both secure and
development access-token cookie names.
