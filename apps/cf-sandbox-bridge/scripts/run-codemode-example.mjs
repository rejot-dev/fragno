import { createCodemodeHost } from "@fragno-dev/codemode/host/codemode-host-capabilities";
import { createCodemodeNodeExecutor } from "@fragno-dev/codemode/remote/codemode-node-executor";

const apiKey = process.env.CLOUDFLARE_BRIDGE_API_KEY;
if (!apiKey) {
  throw new Error(
    "Set CLOUDFLARE_BRIDGE_API_KEY to the deployed bridge's SANDBOX_API_KEY before running this example.",
  );
}
const execute = createCodemodeNodeExecutor({
  url: process.env.CLOUDFLARE_BRIDGE_URL ?? "https://cf-sandbox-bridge.rejot.workers.dev/",
  apiKey,
});
const host = createCodemodeHost(
  [
    {
      name: "math",
      fns: {
        async multiply(...args) {
          if (
            args.length !== 2 ||
            !args.every((value) => typeof value === "number" && Number.isFinite(value))
          ) {
            throw new Error(
              "CODEMODE_EXAMPLE_INVALID_ARGUMENTS: math.multiply expects two finite numbers.",
            );
          }
          console.log("[Node] math.multiply called");
          const [left, right] = args;
          return left * right;
        },
      },
    },
  ],
  null,
);
const result = await execute(
  {
    kind: "immediate",
    code: `async () => {
    console.log("Hello from Cloudflare");
    const answer = await math.multiply(6, 7);
    return { answer: answer + 1 };
  }`,
    dependencies: {},
    // Only tool names and narrow RPC capabilities go to Cloudflare; implementations stay in Node.
    providers: [{ name: "math", tools: ["multiply"] }],
    timeoutMs: 10_000,
  },
  host,
);
console.dir(result, { depth: null });
if (result.status !== "completed") {
  process.exitCode = 1;
}
