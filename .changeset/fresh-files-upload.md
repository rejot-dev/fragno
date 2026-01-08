---
"@fragno-dev/core": patch
---

feat: add FormData file upload support for routes

Routes can now accept file uploads via FormData by setting `contentType: "multipart/form-data"` on
the route definition. The server validates incoming Content-Type headers and rejects mismatched
requests with 415 Unsupported Media Type.

**Route definition:**

```typescript
defineRoute({
  method: "POST",
  path: "/upload",
  contentType: "multipart/form-data",
  async handler(ctx, res) {
    const formData = ctx.formData();
    const file = formData.get("file") as File;
    return res.json({ filename: file.name });
  },
});
```

**New APIs:**

- `ctx.formData()` - Access the request body as FormData
- `ctx.isFormData()` - Check if the request body is FormData
- `RouteContentType` - Type for the `contentType` field ("application/json" | "multipart/form-data")

**Client-side:** The client automatically detects FormData/File in request bodies and sends them
with the correct Content-Type header (letting the browser set the multipart boundary).
