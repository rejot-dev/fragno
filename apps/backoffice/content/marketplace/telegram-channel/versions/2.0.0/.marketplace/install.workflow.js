/// <reference path="/static/codemode/workflow-authoring.d.ts" />

// The package's routes are declared in installation.json; this workflow only sets up its agent.
export default defineWorkflow(
  { name: "install-telegram-channel" },
  async (/** @type {WorkflowEvent<any>} */ event, step) => {
    const agent = {
      agentName: "telegram",
      description: "Answers messages from Telegram chats linked to Backoffice users.",
      model: null,
      permissions: ["*"],
      instructions: [
        "Messages arrive from Telegram chats linked to Backoffice users. Each one starts with the chat",
        "it came from, such as `[Telegram chat 1001]`, and runs with the permissions of that chat's",
        "linked user.",
        "",
        "IMPORTANT: your final answer to each message is AUTOMATICALLY sent back to its chat in Telegram",
        "Markdown parse mode. Keep it short, and do not repeat the chat prefix.",
      ].join("\n"),
      managedBy: {
        kind: "marketplace",
        listingId: event.payload.listingId,
        resourceKey: "telegram-agent",
        version: event.payload.version,
      },
    };
    await step.do("ensure telegram agent", async () => {
      const { agents } = await pi.listAgents({});
      const existing = agents.find((candidate) => candidate.agentName === agent.agentName);
      if (!existing) {
        return await pi.createAgent(agent);
      }
      const managedBy = existing.managedBy;
      if (
        managedBy?.kind !== "marketplace" ||
        managedBy.listingId !== event.payload.listingId ||
        managedBy.resourceKey !== agent.managedBy.resourceKey
      ) {
        throw new Error(
          `Pi agent '${agent.agentName}' already exists and is not managed by this Marketplace installation.`,
        );
      }
      return await pi.updateAgent(agent);
    });
  },
);
