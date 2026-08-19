---
name: otp-system
description:
  Use the Backoffice OTP identity claim capability. Use when creating identity claim links, handling
  otp:identity.claim.completed events, or linking external actors such as Telegram chats to
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

Actor: the external actor that was claimed, for example a Telegram chat entity.

Subject:

- `userId`: Backoffice user id that completed the claim.

Common automation pattern: start a workflow that sends a claim URL to an external actor, store
`otpId -> workflowInstanceId`, and resume the workflow when this event arrives.

Hook scope: `otp`.

# OTP tools

OTP tools can create short-lived identity claim URLs for trusted external initiators.

Use codemode first. Call `otp.createIdentityClaim({ ttlMinutes })` to create a claim URL.
