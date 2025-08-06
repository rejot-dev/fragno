# 05 · Adapter Specification

## 1. Front-end Adapter Interface

```ts
interface FrontendAdapter {
  init(ctx: AdapterInitContext): void;
  registerToolHandlers(registry: ToolRegistry): void;
  pushContext(message: ContextMessage): void; // optional manual push
}
```

### AdapterInitContext

| Field    | Description                                |
| -------- | ------------------------------------------ |
| `send`   | Function to send messages to server (POST) |
| `stream` | Function to open SSE stream                |
| `config` | Runtime config (endpoint, headers)         |

### Responsibilities

1. Capture **navigation** & **form** events.
2. Retry SSE connection on failure.
3. Provide React/Vue/Solid hooks.

## 2. Back-end Adapter Interface

```ts
interface BackendAdapter {
  handler(req: Request): Response | Promise<Response>;
}
```

Helpers convert framework-specific APIs to the standard `Request`:

- `toNextJsHandler()`
- `toExpressHandler()`
- `toHonoHandler()`

## 3. Testing Contract

- Must pass adapter test suite located in `@omniassist/adapter-tests`.
- Provide E2E example in `examples/<framework>`.

## 4. Versioning & Compatibility

| SDK minor | Adapter minor | Status             |
| --------- | ------------- | ------------------ |
| 1.x       | 1.x           | ✅ compatible      |
| 1.x       | 2.x           | ⚠️ check changelog |

## 5. Open Questions

- Do we need dedicated _Angular_ & _Svelte_ adapters or can we rely on Web Components?
