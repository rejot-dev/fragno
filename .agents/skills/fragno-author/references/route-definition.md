# Route Definitions - distilled

Source: Fragno Docs — Route Definitions

Full docs:
`curl -L "https://fragno.dev/docs/fragno/for-library-authors/features/route-definition" -H "accept: text/markdown"`

## Basics

- Use `defineRoutes(definition).create(({ defineRoute }) => [ ... ])`.
- You can pass the runtime definition or use the generic overload to avoid circular imports.

## Paths

- Must start with `/`, cannot be `/`, and cannot end with `/`.
- Params: `:id` for a segment, `**:path` for a wildcard capturing the rest.
- Routes are mounted under `/api/<fragment-name>` by default.

## Input & output schemas

- Use any Standard Schema validator (e.g., Zod) for `inputSchema` and `outputSchema`.
- `input.valid()` returns parsed input and throws a validation error (mapped to 400).
- Streaming responses require an array output schema.

## Error codes & query params

- `errorCodes` and `queryParameters` are hints for consumers.
- Use `error({ message, code }, status)` to return structured errors.
- `query` is a standard `URLSearchParams` object.

## Handler contexts

- Request context: path params, query, input, headers, method.
- Response helpers: `json`, `jsonStream`, `empty`, `error`.
- `jsonStream` emits NDJSON with `stream.write(...)` per item.
