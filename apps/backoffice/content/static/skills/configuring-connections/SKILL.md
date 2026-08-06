---
name: configuring-connections
description:
  "Set up any Backoffice integration, connection, or named provider. Always use for setup requests
  such as \u2018help me set up Reson8\u2019, even when a provider-specific skill also applies; also
  use when credentials or a public origin are missing, or connection status must be verified."
---

# Configuring Connections

Treat connection setup as a handshake: **inspect → collect → configure → verify**.

## Required process

1. Read "/static/codemode/providers/connections.d.ts", then inspect the catalog and selected
   connection:

   ```js
   async () => {
     const connectionList = await connections.list({});
     const status = await connections.get({ id: "telegram" });
     const schema = await connections.schema({ id: "telegram" });
     const setup = await connections.setup({ id: "telegram" });
     return { connectionList, status, schema, setup };
   };
   ```

   Read the matching capability skill from the available skills, such as
   `/static/skills/telegram-connection/SKILL.md`, for provider-specific fields, webhook behavior,
   events, and tools. **Complete when** configurability, current status, required fields, masked
   existing values, and provider-specific setup steps are known.

2. Prefer a durable, generated setup form when required values remain missing. Read
   `/static/skills/workflows/SKILL.md` and `/static/skills/generating-backoffice-uis/SKILL.md`, then
   define an inline workflow whose completed `step.do` returns a `$ui` form and whose following
   `step.waitForEvent` collects the submission. Build controls only for missing fields, label them
   from the live schema and provider skill, bind them under one response object, and submit that
   object with one `WorkflowEventButton`. Continue configuration and verification inside durable
   `step.do` calls so the user can finish the handshake through the rendered interface. When every
   required value was already supplied in the request, proceed directly without an input workflow.

   Collect secrets, sender identities, account ids, bucket details, and public webhook origins
   exactly as supplied. Use submitted values only as the configuration payload; keep secrets out of
   labels, summaries, final output, and follow-up prose. **Complete when** a waiting workflow
   displays controls for every missing required field, or every required field already has a
   user-supplied or configured value.

3. Configure with a payload that matches the live schema, inside the setup workflow when step 2
   created one. Supply `origin` only when setup instructions require a public Backoffice origin:

   ```js
   async () => {
     return await connections.configure({
       id: "telegram",
       payload: {
         botToken: "...",
         webhookSecretToken: "...",
         webhookBaseUrl: "https://public.example.com",
       },
     });
   };
   ```

   When schema/setup exposes no configurable fields or identifies a managed connection, follow its
   manual steps and status `nextSteps` instead of calling `configure`. **Complete when** the
   configure call succeeds or the managed setup path is explicit.

4. Verify and re-read status in the same setup workflow when one is active. `connections.verify`
   always returns a required `verification` result; treat `verification.ok` as the single
   authoritative verification signal. Return a generated final UI that presents the connection
   status, verification result, and actionable next steps while preserving the raw results as
   ordinary sibling fields:

   ```js
   async () => {
     const result = await connections.verify({ id: "telegram" });
     const finalStatus = await connections.get({ id: "telegram" });
     return {
       result,
       finalStatus,
       verified: result.verification.ok,
       verificationMessage: result.verification.message,
     };
   };
   ```

   **Complete only when** `result.verification.ok` is true and the rendered final result confirms
   the configured connection. If it is false, present `result.verification.message`, `missing`
   fields, and `nextSteps` in the generated UI; start another input handshake only when those next
   steps require another user-supplied value.

Use `connections.reset({ id, confirm: id })` only for an explicit reset request, then re-read status
so the cleared state is visible.
