import { define } from "gunshi";
import { baseArgs, createClientFromContext } from "../../utils/options.js";
import { formatDate, formatJson } from "../../utils/format.js";

export const artifactsListCommand = define({
  name: "list",
  description: "List artifacts for a run",
  args: {
    ...baseArgs,
    run: {
      type: "string",
      short: "r",
      description: "Run ID",
    },
    json: {
      type: "boolean",
      description: "Output JSON",
    },
  },
  run: async (ctx) => {
    const runId = ctx.values["run"] as string | undefined;
    if (!runId) {
      throw new Error("Missing --run");
    }

    const client = createClientFromContext(ctx);
    const response = await client.listArtifacts({ runId });

    if (ctx.values["json"]) {
      console.log(formatJson(response));
      return;
    }

    if (!response.artifacts.length) {
      console.log("No artifacts found.");
      return;
    }

    console.log(`Artifacts for ${runId}:`);
    for (const artifact of response.artifacts) {
      const id = String(artifact["id"] ?? "-");
      const type = String(artifact["type"] ?? "-");
      const title = artifact["title"] ? ` title:${artifact["title"]}` : "";
      const mime = artifact["mimeType"] ? ` mime:${artifact["mimeType"]}` : "";
      const updatedAt = artifact["updatedAt"]
        ? ` updated:${formatDate(artifact["updatedAt"])}`
        : "";
      console.log(`- ${id} ${type}${title}${mime}${updatedAt}`);
    }
  },
});
