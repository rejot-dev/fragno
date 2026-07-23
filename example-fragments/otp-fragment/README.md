# @fragno-dev/otp-fragment

A database-backed Fragno fragment for issuing and confirming one-time passwords.

## Features

- typed OTP routes and services
- one active OTP per `externalId` + `type`
- idempotent issuance through caller-provided request IDs
- durable hooks for issuance, confirmation, and scheduled expiry
- framework client entrypoints for React, Vue, Svelte, Solid, and vanilla JS

## Issuing an OTP

Use an object input so the subject identity and issuance identity remain explicit:

```ts
const issued = await otp.issueOtp({
  externalId: "user_123",
  type: "email_verification",
  durationMinutes: 30,
  payload: { email: "user@example.com" },
  requestId: "auth-email-verification-hook_123",
});
```

`externalId` identifies the subject being verified. Multiple OTP requests can belong to the same
subject. `requestId` identifies one issuance operation: retrying it returns the same OTP and its
current `pending`, `confirmed`, `expired`, or `invalidated` status. A request ID cannot be reused
for a different `externalId` or OTP type.

Issuing a fresh request ID invalidates earlier pending OTPs for the same `externalId` and type.

## Durable hooks

The fragment uses durable hooks in three places:

- `onOtpIssued`: queued after a new OTP is committed
- `onOtpConfirmed`: queued after a successful confirmation
- `expireOtp`: scheduled at `expiresAt` and used to transition pending OTPs to `expired`

User callbacks can be provided through `config.hooks`:

- `onOtpIssued`
- `onOtpConfirmed`
- `onOtpExpired`
