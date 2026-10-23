/**
 * Sending, stopping, and resetting change only the agent's durable conversation, which reaches
 * the page through its view stream, so the agents routes skip reloading after them. Starting an
 * agent provisions it and must reload the agent.
 */
export function isPiConversationSubmission(formData: FormData | undefined) {
  const intent = formData?.get("intent");
  return intent === "send" || intent === "stop" || intent === "reset";
}
