<!-- Adapted from the typesafe-ai skill by TypeSafe AI (MIT License). -->

# Classification reference

## Find the useful shape

Start from the behavior the user wants: what will the automation show, select, change, or hand off?
Work backward to the judgments it needs. Keep known rules, calculations, exact lookups, and side
effects in code; use `models.classify` where code needs semantic understanding.

Classification is more than picking a category. The patterns below are starting points: combine
questions around the user's goal, including ideas that fit none of them.

- **Route and fill known arguments.** One call can select a handler with a `choice` and select its
  arguments with further `choice` questions over candidate values code already found. Ask every
  branch's questions up front and consume only the answers of the branch taken.
- **Select instead of generate.** Find candidate values or source spans in code, select the intended
  one with a `choice`, then copy or normalize it in code. The answer can only be a candidate the
  question offers.
- **Find and judge evidence.** Gather candidates from files, `store`, or an integration, put them in
  the state, and ask one `score` question per candidate about its relevance to the query; code ranks
  them and keeps the useful context.
- **Turn judgments into reusable data.** Score each dimension once and keep the raw answers, for
  example in `store`, so later code changes weights, thresholds, rankings, and views without
  classifying again.
- **Verify and escalate.** Check specific claims or fields against their evidence with `bool`
  questions; hand uncertain or failing cases to a person through a workflow UI, or to a Pi agent
  when the case needs reasoning or written output.
- **Respond to changing state.** A workflow keeps goals and observations in its steps while fresh
  judgments guide the next bounded step. Keep inferred answers distinct from observed facts, and
  classify again before acting on an answer whose state has since changed, for example after
  `step.waitForEvent`.

For an open-ended request, offer the few directions that best serve the user's goal and recommend a
starting point. For a concrete request, choose the pattern and build.

## Design the judgments

Choose the question type by what the answer means:

| Need                      | Type     | Important distinction                                                                               |
| ------------------------- | -------- | --------------------------------------------------------------------------------------------------- |
| One of a defined set      | `choice` | Picks one option; its probabilities compare the competing options                                   |
| Whether a condition holds | `bool`   | Probability of true, without a separate confidence; ask one `bool` per label when several may apply |
| Degree along a dimension  | `score`  | Probability-weighted 0-based position on ordered levels; comparable per-item scores support ranking |

Give each question enough **state** to answer: source text, identities, relationships, policies, and
current facts. Name the parts of the state as JSON fields. The state reaches the model as JSON text,
so reference nested fields with backticked paths such as `ticket.messages[0].text`.

Put the judgment in **instructions** and define its possible answers in **criteria**: a `choice`
maps each option to when it applies, a `score` lists its levels lowest first, and a `bool` says what
true and false each mean. Question names identify answers in code; carry the complete meaning in the
instructions and criteria.

Ask one narrow, coherent judgment per question. Split independently useful dimensions without
destroying the relationship being judged. A bounded action selection or a contextual interpretation
is a valid judgment; narrow does not mean literal fact extraction or a one-sentence limit. Criteria
are strings, so write the definitions, contrasts, exclusions, or examples that clarify an answer
into them. Each `score` level describes a concrete situation and stands on its own.

Keep the needed answers available. Include a no-match option such as `other` when nothing may fit,
and ask a separate `bool` about presence when that is independently useful. When selecting among
candidate values, check that the candidates cover the intended one.

Keep the state to the evidence the questions need: it is billed by input tokens, and requests above
roughly 600K input tokens time out.

## Image evidence

Pass an ordered `images` array alongside `state`, each image a workspace file `{ path }` or a blob
`{ blob }` by key. The classifier sees those images together with the JSON evidence. Describe each
image's role in the state or question instructions using its position, such as "the first image is
the reference, the second is the draft". Putting a path in `state` alone does not attach an image.

Use PNG, JPEG, or WebP files already stored under `/workspace/`, including paths returned by
`models.generateImage`, or blobs, which hold images too large for the workspace. File reads require
`upload.read`; text-only calls need only `models.classify`. The generated models declaration lists
image count and byte limits. Image bytes contribute to billed input tokens. URLs, traversal paths,
SVG, and GIF are not accepted.

To judge generated work, keep generation and review in separate workflow steps, so a review failure
does not repeat a completed generation:

```js
const { path } = await step.do(
  "generate draft",
  async () =>
    await models.generateImage({ prompt: event.payload.brief, out: "/workspace/images/draft.png" }),
);
const review = await step.do(
  "review draft",
  async () =>
    await models.classify({
      state: { brief: event.payload.brief },
      images: [{ path }],
      questions: {
        matchesBrief: {
          type: "bool",
          instructions: "Does the image satisfy the brief?",
          criteria: {
            true: "The requested elements are present",
            false: "An element is missing or wrong",
          },
        },
      },
    }),
);
```

Treat this as model evidence, not proof of visual correctness: route uncertain judgments to a
person. Correct unreadable, unsupported, or oversized files before retrying; those failures happen
before a provider call.

## Compose and verify

**Ask independent questions about the same state in one call**, including useful speculative ones.
Questions in a call cannot see one another's answers. State each speculative premise in its
instructions, such as "If this is a billing ticket, ...", and let code consume only the applicable
answers. Make a second call when an earlier answer is needed to fetch evidence, build new state, or
determine the next options. Each call is billed by input tokens, so one call with several questions
costs less than repeating the state across calls.

Use probabilities and confidence to guide behavior, with thresholds chosen from the user's data and
the cost of a wrong decision. `choice` and `score` confidence summarizes how concentrated the
distribution is, not whether the workflow is correct or allowed to act. A `bool` probability near
0.5 means true and false are about equally likely, not a medium intensity. Several acceptable
options can also spread probability, so low confidence need not invalidate a harmless preference.
Ignore the uncertainty of answers on branches the code does not take.

Keep policy explicit in code and raw answers reusable. Weighted scores suit compensating
preferences; an "any serious violation" rule needs a separate `bool` per condition. Changing a
weight or a display filter needs no new classification while the evidence and question meanings are
unchanged. Typed answers guarantee the interface, not the truth: validate behavior on the user's own
cases.

Test representative cases through the automation and check its resulting behavior. For a failure,
inspect the exact state, questions, answers, the code that combined them, and the observed outcome.
Separate missing evidence, model errors, code errors, and service failures: `MODELS_CLASSIFY_FAILED`
reports a failed or refused classification, and `MODELS_CLASSIFY_UNAVAILABLE` means no classifier is
configured.
