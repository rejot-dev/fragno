// Started by integrations.requestInput: asks the user for a connection's secrets in a form card, so
// they never pass through the conversation, then submits them with the rest of the input.
export default defineWorkflow({ name: "integration-input" }, async (event, step) => {
  const { connectionId, operation, input, title, secrets } =
    /** @type {IntegrationsRequestInputInput} */ (event.payload);
  /** @type {Record<string, string>} */
  const initial = Object.fromEntries(secrets.map(({ field }) => [field, ""]));
  const form = ui.form("integration-input", initial);
  await step.do(title, async () => ({
    $ui: ui.render(
      ui.stack({ gap: "md" }, [
        ...secrets.map(({ field, label, description }) =>
          ui.textInput({
            label,
            value: form.bind(field),
            secret: true,
            required: true,
            description,
          }),
        ),
        form.submit({ label: title }),
      ]),
    ),
  }));
  const submitted = await step.waitForEvent("secrets submitted", { type: form.eventType });
  // The form sends every field it declared.
  const payload = /** @type {Record<string, string>} */ (submitted.payload);
  return await step.do(`submit ${operation}`, async () => {
    const submission = {
      kind: /** @type {const} */ ("input"),
      connectionId,
      input: {
        ...input,
        ...Object.fromEntries(secrets.map(({ field }) => [field, payload[field]])),
      },
    };
    return operation === "setup"
      ? await integrations.setup(submission)
      : await integrations.reconfigure(submission);
  });
});
