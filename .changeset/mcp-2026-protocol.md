---
"@fragno-dev/mcp-fragment": patch
---

feat: support MCP 2026-07-28 with SDK v2, legacy fallback, complete tool listing, and
issuer-validated OAuth. Tool results carry any JSON `structuredContent`, and the testing server
requires a `protocolVersion`; custom OAuth callback forwarding must preserve `iss`.
