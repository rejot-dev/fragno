---
name: classification
description:
  "Classify, route, triage, or score data with models.classify, which returns probabilities for
  choice, score, and yes/no questions. Use when code must decide something about content, such as
  picking a category, rating severity, or checking a condition."
---

# Classification

`models.classify` answers typed questions about JSON state in one fast call and returns
probabilities, not prose. Use a Pi agent when the result must be generated text.

1. Read "/static/codemode/providers/models.d.ts" and
   "/static/skills/classification/reference/classification.md". When the request names a goal rather
   than the decisions it needs, derive them with its "Find the useful shape" section. **Complete
   when** the input and answer shapes are known and every decision the code must make is named.

2. Write one question per decision, following the reference's "Design the judgments" section.
   **Complete when** every decision maps to exactly one question whose state, instructions, and
   criteria carry its complete meaning.

3. Call it. In a workflow, call it inside `step.do`, so a replay reuses the answers instead of
   classifying, and paying, again:

   ```js
   const triage = await step.do(
     "classify ticket",
     async () =>
       await models.classify({
         state: { subject: event.payload.subject, body: event.payload.body },
         questions: {
           department: {
             type: "choice",
             instructions: "Which team should handle this ticket?",
             criteria: {
               billing: "Payments, invoices, and refunds",
               technical: "Product problems",
               other: "Anything else",
             },
           },
           urgent: {
             type: "bool",
             instructions: "Does the customer need a reply today?",
             criteria: { true: "The customer is blocked or losing money", false: "It can wait" },
           },
         },
       }),
   );
   ```

   **Complete when** the call returns an answer for every question.

4. Following the reference's "Compose and verify" section, act on the answers through explicit
   thresholds and a fallback, such as a review queue, for uncertain results. **Complete when** every
   branch the code takes handles a low-confidence answer.
