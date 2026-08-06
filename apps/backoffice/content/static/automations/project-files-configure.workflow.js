defineWorkflow({ name: "project-files-configure" }, async (event, step) => {
  const automationEvent = event.payload.automationEvent;

  if (automationEvent.source !== "automations" || automationEvent.eventType !== "project.created") {
    return { skipped: true, reason: "not-project-created" };
  }

  const projectId = automationEvent.subject?.projectId ?? automationEvent.payload.project?.id;
  if (!projectId) {
    throw new Error("project.created event is missing subject.projectId.");
  }

  return await step.do("configure project database filesystem", async () => {
    return await internal.projectFilesConfigure({ projectId });
  });
});
