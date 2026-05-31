import {
  baseUrl,
  createInstance,
  request,
  runId,
  terminateInstance,
  waitForTerminal,
  waitForWaitEvent,
} from "./smoke-support.js";

async function main() {
  const id = runId("restart_fulfillment_removed");
  console.log(`[restart-fulfillment-leak] baseUrl=${baseUrl} instance=${id}`);
  await createInstance("approval-workflow", id, {
    requestId: `req_${id}`,
    amount: 10,
    requestedBy: "restart-compat",
  });
  await waitForWaitEvent("approval-workflow", id, "approval");
  await request(`/approval-workflow/instances/${id}/restart`, {
    method: "POST",
    expectedStatuses: [404, 405],
  });
  await terminateInstance("approval-workflow", id);
  await waitForTerminal("approval-workflow", id);
  console.log(
    "[restart-fulfillment-leak] restart/runNumber leak scenario is obsolete because restart is absent in the current API",
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
