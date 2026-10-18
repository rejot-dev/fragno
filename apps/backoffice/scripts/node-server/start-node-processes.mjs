import { superviseNodeBackofficeProcesses } from "../server/node-process-supervisor.mjs";

await superviseNodeBackofficeProcesses(
  [
    { name: "server", role: "web", entrypoint: "build-node/node-server.mjs" },
    {
      name: "hook processor",
      role: "processor",
      entrypoint: "build-node/node-hook-processor.mjs",
    },
  ],
  "build-node/node-opentelemetry-bootstrap.mjs",
);
