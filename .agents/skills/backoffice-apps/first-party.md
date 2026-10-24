# First-party apps

A first-party app is part of Backoffice: a product Backoffice's operators run, such as Bookkeeping.
People sign in under the product's name and need not know Backoffice exists. First-party trust
removes consent friction, not tenant isolation or permission checks. Read
[first-party apps](../../../apps/backoffice/app/fragno/apps/README.md#first-party-apps) and
[signing in through a first-party app](../../../apps/backoffice/app/fragno/auth/README.md#signing-in-through-a-first-party-app).

## Declare the trust (step 2)

A system administrator sets it with `admin.apps.update-trust`, which `backoffice:connect` runs:

```json
{
  "kind": "first-party",
  "provisioningPermissions": ["organizations.provision", "invitations.create"],
  "branding": {
    "displayName": "Bookkeeping",
    "logoUrl": "https://bookkeeping.example/logo.svg",
    "accentColor": "#2f6f4e",
    "homeUrl": "https://bookkeeping.example",
    "supportUrl": "https://bookkeeping.example/help"
  }
}
```

- **Provisioning permissions** are per operation. Bookkeeping holds all six because it implements
  every provisioning flow; grant only the operations the product calls.
- **Branding** names the app on Backoffice's sign-in page and in its emails. The logo and support
  URL are real public app resources, not placeholder deployment URLs; invitation links must be on
  the origin of `homeUrl`.
- **Installations follow the app's request.** Nobody reviewed their grants, so changing requested
  permissions changes every installation within the registry cache lifetime (currently one minute).
- **Actions** may use `changeApproval: "automatic"`, which is reserved for apps administrators
  operate.
- **Operators** of the product, if it has any, are the members of an operator organization that
  `backoffice:connect` creates with the administrator as owner and the app installed, not an
  allowlist of user IDs. Bookkeeping writes its ID to `BOOKKEEPING_OPERATOR_ORGANIZATION_ID`.

Making the app third-party again ends all of this at once, except consents and installations already
recorded; those installations fall back to the grants stored when they were made.

## Branded sign-in (step 2)

A provider-signed authorization request from a first-party client selects the app's sign-in on
Backoffice: its branding, an email field or GitHub, then a 6-digit code or the account's password.

- **Anyone signs up.** A correct code for a new address creates a verified Backoffice account, even
  where Backoffice's own sign-up needs an invitation. Product copy can say “Get started”; people
  need not link a second account or know Backoffice's name.
- **Consent is recorded, not asked.** The consent page approves the request through Better Auth's
  consent endpoint. The consent is hidden from the person's Authorized applications and cannot be
  revoked there.
- **Branding comes only from the signed request,** never a free `appId` or branding query parameter.
- **Codes stay in Backoffice.** A loopback Backoffice prints them for development; production needs
  its email delivery (Resend) configured.

**Sign-in criterion:** a new address and an existing Backoffice user both return to the app signed
in, with the correct subject and no consent review.

## Tenants (step 4)

Create tenants, projects, and invitations as the app through
[provisioning](references/provisioning.md): sign-up creates no organization, so provisioning is an
explicit product onboarding action. An owner can also link an existing organization through the
install page in [tenancy](references/tenancy.md); for a first-party app it only asks where to
install.

## Scenarios (step 5)

Extend Backoffice's
[first-party scenarios](../../../apps/backoffice/app/backoffice-api/first-party-app.scenario.test.ts)
and
[app sign-in scenarios](../../../apps/backoffice/app/routes/backoffice/app-sign-in.scenario.test.ts)
for changes to Backoffice itself. In the app, also cover:

- Provisioning retries after partial success produce one tenant/domain object; durable onboarding
  resumes with its saved answers, including duplicate submissions after completion.
- Invitations work for the invited verified address, not another user, including someone signed in
  as another account who follows the invitation link.
