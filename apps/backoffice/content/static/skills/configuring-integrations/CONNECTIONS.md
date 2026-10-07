# Native `connections.*` services

Telegram, Resend, Upload, and other native services without a `backoffice#` setup target keep their
configuration controls in `connections.*`. Catalog IDs name services, not Open Connector accounts or
API connection slugs. Read `/static/codemode/providers/connections.d.ts` before calling it. These
steps replace the setup loop and verification of the main skill; treat them as a handshake:
**inspect → collect → configure → verify**.

1. Inspect the selected service by its catalog ID:

   ```js
   async () => ({
     status: await connections.get({ id: "telegram" }),
     schema: await connections.schema({ id: "telegram" }),
     setup: await connections.setup({ id: "telegram" }),
   });
   ```

   **Complete when** configurability, current status, required fields, masked existing values, and
   the provider skill's setup steps are known.

2. Collect missing values through the durable form described in the main skill's setup loop, with
   one control per missing field of the live schema. That fields list is the complete set of user
   inputs: providers generate managed values such as webhook secrets during configuration, so the
   form and payload carry only listed fields. **Complete when** a waiting workflow shows a control
   for every missing required field, or every required field already has a value.

3. Configure with a payload that matches the live schema:

   ```js
   async () => await connections.configure({ id: "telegram", payload: { botToken: "..." } });
   ```

   When the schema exposes no configurable fields or setup marks the service as managed, follow its
   manual steps and status `nextSteps` instead. **Complete when** configure succeeds or the managed
   path is explicit.

4. Verify and re-read status. `verification.ok` is the single authoritative verification signal:

   ```js
   async () => {
     const result = await connections.verify({ id: "telegram" });
     return { result, finalStatus: await connections.get({ id: "telegram" }) };
   };
   ```

   **Complete only when** `result.verification.ok` is true. Otherwise present
   `result.verification.message`, the `missing` fields, and `nextSteps`, and collect input again
   only when those steps require a new value.

Reset on the user's instruction with `connections.reset({ id, confirm: id })`, then re-read status
so the cleared state is visible.
