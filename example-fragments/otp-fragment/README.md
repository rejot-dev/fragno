# @fragno-dev/otp-fragment

A database-backed Fragno fragment for issuing and confirming one-time passwords.

## Features

- typed OTP routes and services
- one active OTP per `userId` + `type`
- durable hooks for confirmation and scheduled expiry
- framework client entrypoints for React, Vue, Svelte, Solid, and vanilla JS

## Durable hooks

The fragment uses durable hooks in two places:

- `onOtpConfirmed`: queued after a successful confirmation
- `expireOtp`: scheduled at `expiresAt` and used to transition pending OTPs to `expired`

User callbacks can be provided through `config.hooks`:

- `onOtpIssued`
- `onOtpConfirmed`
- `onOtpExpired`
