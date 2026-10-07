---
"@fragno-dev/mcp-fragment": patch
---

feat: report sanitized auth status, resume pending OAuth links, reuse the OAuth client configured at
creation, replace server configuration in place, discard tokens when reauthorizing, keep the auth
mode when clearing auth, and return tool errors as results. Export an in-process test MCP server
from `@fragno-dev/mcp-fragment/testing`.
