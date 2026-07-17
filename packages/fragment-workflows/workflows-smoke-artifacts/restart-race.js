import { baseUrl, request, runId } from "./smoke-support.js";

async function main() {
  const id = runId("restart_removed");
  console.log(`[restart-race] baseUrl=${baseUrl}`);
  await request(`/approval-workflow/instances/${id}/restart`, {
    method: "POST",
    expectedStatuses: [404, 405],
  });
  console.log(
    "[restart-race] restart endpoint is not part of the current workflow API; obsolete restart race skipped",
  );
}

main().catch(
  /** @param {unknown} error */
  (error) => {
    console.error(error);
    process.exit(1);
  },
);
