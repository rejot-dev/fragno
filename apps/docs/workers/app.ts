import { createRequestHandler, RouterContextProvider } from "react-router";
import { CloudflareContext } from "../app/cloudflare/cloudflare-context";
import { MailingList } from "./mailing-list.do";
import { Forms } from "./forms.do";
import { Auth } from "./auth.do";
import { Telegram } from "./telegram.do";
import { Resend } from "./resend.do";
import { SandboxRegistry } from "./sandbox-registry.do";
import { Sandbox } from "./sandbox.do";
import { Pi } from "./pi.do";
import { Value } from "typebox/value";
import System from "typebox/system";
import { bashParametersSchema } from "../app/fragno/pi-schema";
import { validateToolArguments } from "@mariozechner/pi-ai";

// Export Durable Object classes
export { MailingList };
export { Forms };
export { Auth };
export { Telegram };
export { Resend };
export { Sandbox };
export { SandboxRegistry };
export { Pi };

const requestHandler = createRequestHandler(
  () => import("virtual:react-router/server-build"),
  import.meta.env.MODE,
);

let typeboxSelfTestLogged = false;
let ajvSelfTestLogged = false;

System.Settings.Set({ useAcceleration: false });

export default {
  async fetch(request, env, ctx) {
    if (!typeboxSelfTestLogged) {
      typeboxSelfTestLogged = true;
      try {
        const valid = Value.Check(bashParametersSchema, { script: "echo hello" });
        const invalid = Value.Check(bashParametersSchema, { script: "" });
        console.log("TypeBoxc self-test", { valid, invalid });
      } catch (error) {
        console.error("TypeBoxc self-test failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    if (!ajvSelfTestLogged) {
      ajvSelfTestLogged = true;
      try {
        const tool = {
          name: "bash",
          description: "AJV CSP repro",
          parameters: bashParametersSchema,
        } satisfies Parameters<typeof validateToolArguments>[0];

        const toolCall = {
          type: "toolCall" as const,
          id: "ajv-self-test",
          name: "bash",
          arguments: { script: "echo hello" },
        } satisfies Parameters<typeof validateToolArguments>[1];

        validateToolArguments(tool, toolCall);
        console.log("AJV self-test passed");
      } catch (error) {
        console.error("AJV self-test failed", error);
      }
    }

    const context = new RouterContextProvider();
    context.set(CloudflareContext, { env, ctx });
    return requestHandler(request, context);
  },
} satisfies ExportedHandler<CloudflareEnv>;
