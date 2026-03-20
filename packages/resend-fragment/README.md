# @fragno-dev/resend-fragment

Resend integration fragment for Fragno.

## Resend threading v2

This package now uses a canonical local message store:

- `emailThread` remains the denormalized thread summary and thread-resolution table.
- `emailMessage` is the single local source of truth for stored inbound and outbound messages.
- outbound `/emails` routes now read canonical `emailMessage` rows filtered to
  `direction="outbound"`.
- thread timelines now read canonical `emailMessage` rows filtered by `threadId`.
- inbound webhook processing resolves threads from canonical `messageId` rows plus `replyToken` and
  heuristic fallbacks.
- status webhooks update one canonical row instead of mirroring into a second table.

## Breaking changes

- Outgoing message IDs are now stable local canonical IDs. They no longer get replaced with the
  provider email ID after send.
- `resendId` in route payloads is now always the provider email ID (`providerEmailId`) when one
  exists.
- Webhook callback payloads now expose canonical `emailMessageId` plus `providerEmailId`.
- The old duplicated local table model (`email`, `receivedEmail`, `emailThreadMessage`) has been
  removed in favor of `emailMessage`.

## Development

```bash
pnpm exec turbo types:check --filter=@fragno-dev/resend-fragment --output-logs=errors-only
pnpm exec turbo test --filter=@fragno-dev/resend-fragment --output-logs=errors-only
```
