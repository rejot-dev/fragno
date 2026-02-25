# Client Customization - distilled

Source: Fragno Docs — Client Customization

## Overview

Customize the `fetch` function used by Fragment clients for authentication, CORS, interceptors, or
testing.

## Configuration

Pass `fetcherConfig` when creating a Fragment client:

```typescript
import { createMyFragmentClient } from "my-fragment";

export const myFragment = createMyFragmentClient({
  baseUrl: "http://localhost:3000",
  fetcherConfig: {
    type: "options",
    options: {
      credentials: "include",
      mode: "cors",
      headers: { Authorization: `Bearer ${token}` },
    },
  },
});
```

## Configuration Types

- `{ type: "options", options: RequestInit }` - Merge RequestInit options with Fragment author's
  defaults
- `{ type: "function", fetcher: typeof fetch }` - Provide custom fetch function (overrides
  everything)

## Common Use Case: Authentication Headers

```typescript
export const myFragment = createMyFragmentClient({
  fetcherConfig: {
    type: "options",
    options: {
      headers: { Authorization: `Bearer ${getAuthToken()}` },
    },
  },
});
```

## Configuration Precedence

When the Fragment author provides default configuration:

1. Your custom function → replaces everything
2. Your RequestInit options
3. Fragment's RequestInit defaults

If you provide custom RequestInit options, and the Fragment does as well, they will be deep merged.
Your values will win conflicts.

**Note:** When you provide a custom fetch function, the Fragment author's RequestInit options are
ignored.
