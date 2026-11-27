// Each request Bookkeeping asks starts a run of this workflow, which asks the bookkeeping agent in a
// subagent of its own, so requests are read side by side, and waits for the subagent's turn to end.
// The prompt keeps the request's ID, by which Bookkeeping follows the agent's work. The run's
// instance ID is that ID as Backoffice makes it safe, so the package's routes send the turn's end,
// which names the request, to the run by it. The agent answers Bookkeeping itself, through its
// actions; Bookkeeping shows a turn that ended without an answer, for people to ask again.
export default defineWorkflow({ name: "bookkeeping-request" }, async (event, step) => {
  const requestId = event.payload.requestId;
  await step.do("ask the bookkeeping agent", async () => {
    return await pi.submitPrompt({
      agentName: "bookkeeper",
      requestId,
      subagent: true,
      content: event.payload.prompt,
    });
  });
  const ended = await step.waitForEvent("wait for its turn to end", { type: "pi-turn-ended" });
  return await step.do("read how it ended", async () => {
    const prompt = await pi.getPrompt({ agentName: "bookkeeper", requestId });
    return {
      turn: ended.payload.eventType,
      reason: prompt?.status === "failed" ? prompt.reason : null,
    };
  });
});
