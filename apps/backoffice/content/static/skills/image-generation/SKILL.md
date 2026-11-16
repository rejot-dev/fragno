---
name: image-generation
description:
  "Generate images with models.generateImage and write them to the workspace. Use when the user
  wants an image created or an existing one changed, or an automation must produce one."
---

<!-- The prompting advice adapts OpenAI's GPT Image prompting guide. -->

# Image Generation

`models.generateImage` renders one image from a prompt and optional `references` and writes it to
`out`. Every call starts fresh: the model sees this prompt and these references only, never earlier
images or the conversation.

1. **Brief.** Read "/static/codemode/providers/models.d.ts". Settle the subject, the medium (photo,
   illustration, 3D render, diagram), where the image will be used, and any literal text it shows.
   When the image must match something that exists, such as a product, a logo, a person, a room, a
   style, or an image to change, pass it as a reference, a workspace file `{ path }` or a blob
   `{ blob }`, rather than describing it. Choose what the request leaves open and name those choices
   in your reply. **Complete when** every visible element, every reference, and the image's use are
   decided.

2. **Prompt.** Write the prompt in this order: scene, subject, key details, constraints.
   - Name the use, such as "product photo for a catalog page", to set the level of polish.
   - Be concrete about materials, shapes, lighting, framing, and viewpoint. Write "photorealistic"
     for photos.
   - Put literal text in quotes with its font, color, and placement. Spell unusual words letter by
     letter.
   - State exclusions, such as "no watermark", "no extra text", and "no logos".
   - Name references by position, such as "the lamp from the first image", and say what to keep from
     each and what to change.

   **Complete when** someone who never saw the conversation could render the image from the prompt
   alone.

3. **Settings.** Set `out`, `size`, and `quality` explicitly; `auto` settles size and quality, and
   so the cost, only after the call.
   - `out`: a new path under `/workspace/`. Use `.jpg` for photos, `.png` for text, line art, and
     diagrams, and `.webp` for web pages.
   - `size`: `1536x1024` landscape, `1024x1536` portrait, or `1024x1024` square, matching where the
     image is shown.
   - `quality`: `low` for drafts and revisions; a square image took about 8 seconds and $0.006.
     `medium` or `high` for small text, dense diagrams, close-up faces, and final assets. `xhigh`
     and `max` when the user asks for them.

   **Complete when** each setting follows from the brief.

4. **Generate.** Call it inside `step.do` of an inline workflow, as the workflows skill describes:
   generation can outlast an immediate run, and a replay reuses the step's result instead of paying
   again.

   ```js
   defineWorkflow(
     { name: "draw-desk-lamp" },
     async (event, step) =>
       await step.do(
         "draw desk lamp",
         async () =>
           await models.generateImage({
             prompt:
               "Product photo for a catalog page. White seamless background, soft studio light. " +
               "A photorealistic brass desk lamp with an angled arm, centered, eye-level. " +
               "No text, no watermark.",
             out: "/workspace/images/desk-lamp-v1.jpg",
             size: "1024x1024",
             quality: "low",
           }),
       ),
   );
   ```

   An automation that produces images gives each image its own step and a path derived from its
   item, such as the item's id, and skips items whose path `state.exists` confirms. **Complete
   when** the instance is complete and its output holds the image's path.

5. **Show and revise.** The user judges the image; you cannot see it. Show it as a Markdown image
   with the prompt and settings that produced it. To revise, change one thing in the full prompt and
   write to the next version's path, so earlier versions stay comparable. When the user likes an
   image but one detail, pass it as the first reference and ask for only that change, keeping
   everything else. **Complete when** the user has seen every image, or the automation's output
   lists every path.

## Failures

- `MODELS_GENERATE_IMAGE_FAILED: moderation_blocked: …`: the prompt or the image was refused.
  Rephrase the prompt before calling again.
- Other `MODELS_GENERATE_IMAGE_FAILED` errors carry OpenAI's error code. Retry rate limits and
  server errors; correct the request for the rest.
- `MODELS_GENERATE_IMAGE_INVALID_REFERENCE` and `MODELS_GENERATE_IMAGE_REFERENCE_TOO_LARGE`: a
  reference is not a PNG, JPEG, or WebP image, or the references exceed their size limits. Convert
  or shrink them, or pass fewer.
- `MODELS_GENERATE_IMAGE_UNAVAILABLE`: this deployment has no image model configured. Tell the user.
