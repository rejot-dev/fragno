---
"@fragno-dev/api-fragment": minor
---

Replace `onConnectionAvailable` with `onConnectionReadinessChanged`, which receives
`{ connectionId, ready }` when a write changes whether stored auth can authorize requests: on
creation, and when credentials, consent, or tokens flip readiness. Restarting consent while
discarding tokens and clearing credentials now report the connection as not ready.

This is a pre-1.0 breaking change: `onConnectionAvailable` and `ApiConnectionAvailablePayload` are
removed.
