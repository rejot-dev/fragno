import {
  assert,
  baseUrl,
  completeApprovalWorkflow,
  getCurrentStepEmissionsOnce,
  getHistory,
  runId,
} from "./smoke-support.js";

const workflowName = process.env.WORKFLOW_NAME ?? "approval-workflow";

async function main() {
  if (workflowName !== "approval-workflow") {
    throw new Error(
      "retention-gc-check currently drives approval-workflow; set WORKFLOW_NAME only after updating the driver flow",
    );
  }

  const id = runId("integrity");
  console.log(`[retention-gc-check] baseUrl=${baseUrl} instance=${id}`);
  await completeApprovalWorkflow(id, { requestedBy: "integrity-check" });

  const history = await getHistory(workflowName, id);
  assert(history.steps.length >= 3, `expected multiple steps, got ${history.steps.length}`);
  assert(
    history.events.length >= 2,
    `expected approval/fulfillment events, got ${history.events.length}`,
  );

  const consumed = history.events.filter((event) => event.consumedByStepKey);
  const stepKeys = new Set(history.steps.map((step) => step.stepKey));
  const missingConsumers = consumed.filter((event) => !stepKeys.has(event.consumedByStepKey));
  assert(
    missingConsumers.length === 0,
    `events reference missing consumedByStepKey values: ${missingConsumers.map((event) => `${event.type}:${event.consumedByStepKey}`).join(", ")}`,
  );

  const emissions = await getCurrentStepEmissionsOnce(workflowName, id);
  assert(
    emissions.length === 0,
    `terminal instance should not expose live step emissions, got ${emissions.length}`,
  );

  console.log(
    "[retention-gc-check] current source has no retention/GC API; integrity checks passed",
  );
}

main().catch(
  /** @param {unknown} error */
  (error) => {
    console.error(error);
    process.exit(1);
  },
);
