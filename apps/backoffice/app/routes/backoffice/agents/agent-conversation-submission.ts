/**
 * Sending, stopping, compacting, and resetting change only the agent's durable conversation, which reaches
 * the page through its view stream, so the agents layouts skip reloading after them. Starting an
 * agent provisions it and must reload the directory.
 */
export function isPiConversationSubmission(formData: FormData | undefined) {
  const intent = formData?.get("intent");
  return intent === "send" || intent === "stop" || intent === "compact" || intent === "reset";
}
