import { parseCodemodeValue, stringifyCodemodeValue } from "@fragno-dev/codemode/runtime-api";
import { createCodemodeNodeExecutor } from "@fragno-dev/codemode/transport/codemode-node-client";

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

const result = await execute(
  {
    kind: "immediate",
    code: `async () => {
      console.log("Hello from Cloudflare");
      const answer = await math.multiply(6, 7);
      return { answer: answer + 1 };
    }`,
    dependencies: {},
    // Only the tool names go to Cloudflare; their implementations stay in Node.
    providers: [{ name: "math", tools: ["multiply"] }],
    timeoutMs: 10_000,
  },
  {
    async handle(call) {
      if (
        call.operation !== "provider.call" ||
        call.provider !== "math" ||
        call.tool !== "multiply"
      ) {
        throw new Error("CODEMODE_EXAMPLE_UNKNOWN_TOOL: only math.multiply is allowed.");
      }

      const args = parseCodemodeValue(call.argsJson);
      if (
        !Array.isArray(args) ||
        args.length !== 2 ||
        !args.every((value) => typeof value === "number" && Number.isFinite(value))
      ) {
        throw new Error(
          "CODEMODE_EXAMPLE_INVALID_ARGUMENTS: math.multiply expects two finite numbers.",
        );
      }

      console.log("[Node] math.multiply called");
      const [left, right] = args;
      return stringifyCodemodeValue({ result: left * right });
    },
    close() {},
    async settle() {
      return null;
    },
  },
);

console.dir(result, { depth: null });
if (result.status !== "completed") {
  process.exitCode = 1;
}
