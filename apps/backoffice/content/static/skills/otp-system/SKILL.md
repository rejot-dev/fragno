---
name: otp-system
description:
  Use the Backoffice OTP identity claim capability. Use when creating identity claim links, handling
  otp:identity.claim.completed events, or linking external actors such as Telegram users to
  Backoffice users.
---

# OTP System

Use this skill for short-lived identity claims and automations that link external actors to
authenticated users.

# OTP configuration

OTP is a system capability. It depends on the runtime environment having the public base URL needed
for identity claim links.

# OTP events

## otp:identity.claim.completed

Fires when a short-lived identity claim is completed.

Payload fields:

- `otpId`: id of the completed claim.
- `claimType`: claim type.

Actor: the external actor that was claimed, for example a Telegram user entity.

Subject:

- `userId`: Backoffice user id that completed the claim.

Common automation pattern: start a workflow that sends a claim URL to an external actor, store
`otpId -> workflowInstanceId`, and resume the workflow when this event arrives.

Send a claim URL only where its actor alone reads it, such as a Telegram private chat, whose chat ID
equals the sender's user ID. Whoever opens the URL links the actor to their own account.

Hook scope: `otp`.

# OTP tools

OTP tools can create short-lived identity claim URLs for trusted external initiators.

Use codemode first. Call `otp.createIdentityClaim({ ttlMinutes })` to create a claim URL.
