import { define } from "gunshi";
import { baseArgs, createClientFromContext } from "../../utils/options.js";
import { formatDate, formatJson } from "../../utils/format.js";

export const artifactsGetCommand = define({
  name: "get",
  description: "Get an artifact",
  args: {
    ...baseArgs,
    artifact: {
      type: "string",
      short: "a",
      description: "Artifact ID",
    },
    json: {
      type: "boolean",
      description: "Output JSON",
    },
  },
  run: async (ctx) => {
    const artifactId = ctx.values["artifact"] as string | undefined;
    if (!artifactId) {
      throw new Error("Missing --artifact");
    }

    const client = createClientFromContext(ctx);
    const artifact = await client.getArtifact({ artifactId });

    if (ctx.values["json"]) {
      console.log(formatJson(artifact));
      return;
    }

    console.log(`Artifact ${artifactId}`);
    console.log(`runId: ${String(artifact["runId"] ?? "-")}`);
    console.log(`threadId: ${String(artifact["threadId"] ?? "-")}`);
    console.log(`type: ${String(artifact["type"] ?? "-")}`);
    console.log(`title: ${String(artifact["title"] ?? "-")}`);
    console.log(`mimeType: ${String(artifact["mimeType"] ?? "-")}`);
    console.log(`text: ${String(artifact["text"] ?? "-")}`);
    console.log(`data: ${formatJson(artifact["data"])}`);
    console.log(`createdAt: ${formatDate(artifact["createdAt"])}`);
    console.log(`updatedAt: ${formatDate(artifact["updatedAt"])}`);
  },
});
