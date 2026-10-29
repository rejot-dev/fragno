---
name: extraction
description:
  "Read PDFs and images with models.extract into JSON that matches a schema. Use when a reply or
  automation needs data from a document, such as an invoice's totals, a receipt photo, a contract's
  parties, or a statement's transactions."
---

# Extraction

`models.extract` sends PDFs and PNG, JPEG, or WebP images to a model and returns its answer as JSON
that matches your schema. The files never enter the conversation, so only the answer costs context.
Name each file by where it is kept: `{ path }` for a workspace file, `{ blob }` for a blob's key, as
files too large for the workspace are kept.

Pick the tool by what you need from the file:

- `models.extract` gets values out: fields, tables, or text.
- `models.classify` decides something about it: a category, a score, or yes or no.
- `state.viewImage` shows an image to you, to judge layout or appearance.
- Clairic, the `@cf/cloudflare/clairic` action of `backoffice#workers-ai`, gets named fields out of
  text and images with a confidence for each; see
  `/static/skills/configuring-integrations/SKILL.md`.

Text files are read with `state.readFile`. HEIC and GIF images are refused, as are any other file
types.

1. **Shape.** Read "/static/codemode/providers/models.d.ts". Name every value the code or reply
   needs, and decide for each how it appears when the document lacks it. **Complete when** every
   value has a field, a type, and an absent case.

2. **Schema.** Write it in OpenAI's strict subset, or the call fails:
   - The root is `type: "object"`.
   - Every property is required and every object is closed; the call sets `required` and
     `additionalProperties` itself.
   - A value that may be absent is nullable, such as `type: ["string", "null"]`.
   - `enum`, `anyOf`, `$defs` with `$ref`, and `description` work; `allOf`, `not`,
     `if`/`then`/`else`, and `patternProperties` do not.

   Make `transcription` the first property: a string whose `description` asks for the document's
   text as printed, in reading order, with tables as Markdown. For a long document, ask only for the
   parts the other fields come from, such as the totals block and the line table. The model writes
   the transcription before the fields, and you check the answer against it.

   Type each value for the code that reads it: `number` for amounts the code sums or compares,
   `string` for values kept as printed, and `enum` for a fixed set such as a currency. The model
   reads each field's `description` as it fills the field in, so put the field's rules there: its
   format, such as `YYYY-MM-DD`, its sign, and which of several candidates it is. **Complete when**
   the schema follows every rule above, starts with `transcription`, and every field whose name and
   type leave its meaning open has a `description`.

3. **Instructions.** Say what the documents are and what the answer is for; the field rules live in
   the schema. **Complete when** someone who never saw the conversation could fill in the answer
   from the files, the instructions, and the schema alone.

4. **Call.** Pass the files that must be read together, such as an invoice with its delivery note,
   in one call, in order: up to 16 files and 20 MiB. Give unrelated documents a call each. Start
   with the defaults, `openai/gpt-6-luna` thinking at `low`.

   A short document in an agent turn can be read in an immediate run. Read long documents, and
   anything an automation extracts, inside `step.do` of a workflow, as the workflows skill
   describes: a call can outlast an immediate run, and a replay reuses the step's answer instead of
   paying again. Give each document its own step, so a failure retries only that document:

   ```js
   defineWorkflow({ name: "read-invoice" }, async (event, step) => {
     const invoice = await step.do(
       "read invoice",
       async () =>
         await models.extract({
           files: [{ path: event.payload.path }],
           instructions:
             "Read this supplier invoice for bookkeeping. Use null for anything not printed.",
           schema: {
             type: "object",
             properties: {
               transcription: {
                 type: "string",
                 description:
                   "The invoice's text as printed, in reading order, tables as Markdown.",
               },
               supplier: { type: ["string", "null"] },
               invoiceDate: {
                 type: ["string", "null"],
                 description: "The issue date as YYYY-MM-DD, not the due date.",
               },
               total: {
                 type: ["number", "null"],
                 description: "The grand total without currency symbol; negative on a credit note.",
               },
               lines: {
                 type: "array",
                 description: "The billed items in document order.",
                 items: {
                   type: "object",
                   properties: {
                     description: { type: "string" },
                     amount: { type: ["number", "null"] },
                   },
                 },
               },
             },
           },
         }),
     );
     return invoice.output;
   });
   ```

   **Complete when** the call returns `output`.

5. **Check.** The answer always matches the schema, but its values can still be wrong. Compare it
   with its `transcription`, and check the sums the document allows, such as lines adding up to the
   subtotal and subtotal plus tax to the total. When the transcription confirms the answer,
   including a value the document lacks, the answer is final: use or report it.

   When the transcription shows a value the answer misread or missed, extract again with a higher
   `thinkingLevel`, then with `openai/gpt-6.1-sol`, which costs about 20 times as much per token. An
   automation sends answers that still fail, or lack a value its code requires, to a person, such as
   a review queue. **Complete when** every value the code or reply uses agrees with the
   transcription and the document's sums, or has gone to review.

## Failures

- `MODELS_EXTRACT_FAILED: …` carries OpenAI's error. A schema outside the strict subset fails this
  way, with a message naming the part that broke a rule: fix the schema. Retry rate limits and
  server errors.
- `MODELS_EXTRACT_INVALID_FILE`: a file is not a PDF or a PNG, JPEG, or WebP image.
- `MODELS_EXTRACT_FILES_TOO_LARGE`: the files exceed 20 MiB together. Split them across calls.
- `MODELS_EXTRACT_UNAVAILABLE`: this deployment has no extraction model configured. Tell the user.
