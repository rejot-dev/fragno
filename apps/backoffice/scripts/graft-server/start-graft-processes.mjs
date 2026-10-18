import { superviseNodeBackofficeProcesses } from "../server/node-process-supervisor.mjs";

await superviseNodeBackofficeProcesses(
  [{ name: "server", role: "web", entrypoint: "build-graft/backoffice-node.mjs" }],
  "build-graft/node-opentelemetry-bootstrap.mjs",
);
