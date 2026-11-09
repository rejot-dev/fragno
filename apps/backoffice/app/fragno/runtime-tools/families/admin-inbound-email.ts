import { BACKOFFICE_PERMISSION } from "@fragno-dev/backoffice-api/v0/shared/permissions";
import { z } from "zod";

import { defineCliArgsParser } from "@/fragno/runtime-tools/bash-cli";

import { defineBackofficeRuntimeTool, type BackofficeToolContext } from "../runtime-tools";
import type { AdminRuntime } from "./admin";

type AdminInboundEmailToolContext = BackofficeToolContext<Partial<{ admin: AdminRuntime }>>;

const replaceInboundEmailTool = defineBackofficeRuntimeTool({
  id: "admin.inbound-email.replace",
  namespace: "admin",
  name: "inboundEmailReplace",
  description:
    "Give a person a new inbound email address, three random words, such as after their address gets spam. People keep one address for good and cannot replace it themselves. The old address stops receiving at once and is never issued again.",
  requiredPermissions: [BACKOFFICE_PERMISSION.admin.usersManage],
  inputSchema: z.strictObject({ userId: z.string().trim().min(1) }),
  outputSchema: z.strictObject({ userId: z.string(), address: z.string() }),
  execute: async (input, context: AdminInboundEmailToolContext) => {
    const admin = context.runtimes.admin;
    if (!admin) {
      throw new Error("Admin runtime is not available in this execution context.");
    }
    return await admin.replaceInboundEmailAddress(input);
  },
  adapters: {
    bash: {
      command: "admin.inbound-email.replace",
      help: {
        summary: "admin.inbound-email.replace gives a person a new inbound email address.",
        options: [
          {
            name: "user",
            required: true,
            valueRequired: true,
            valueName: "id",
            description: "ID of the user whose address is replaced",
          },
        ],
        examples: ["admin.inbound-email.replace --user user_123"],
      },
      parse: defineCliArgsParser("admin.inbound-email.replace", {
        userId: { kind: "string", option: "user", required: true },
      }),
      format: (result, options) =>
        options.format === "json" || options.print
          ? { data: result }
          : { data: result, stdout: `${result.userId} now receives email at ${result.address}.\n` },
    },
  },
});

function defineInboundEmailSendingTool({
  id,
  name,
  suspended,
  description,
  summary,
}: {
  id: "admin.inbound-email.suspend-sending" | "admin.inbound-email.resume-sending";
  name: string;
  suspended: boolean;
  description: string;
  summary: string;
}) {
  return defineBackofficeRuntimeTool({
    id,
    namespace: "admin",
    name,
    description,
    requiredPermissions: [BACKOFFICE_PERMISSION.admin.usersManage],
    inputSchema: z.strictObject({ userId: z.string().trim().min(1) }),
    outputSchema: z.strictObject({ userId: z.string(), sendingSuspended: z.boolean() }),
    execute: async (input, context: AdminInboundEmailToolContext) => {
      const admin = context.runtimes.admin;
      if (!admin) {
        throw new Error("Admin runtime is not available in this execution context.");
      }
      return await admin.setInboundEmailSending({ ...input, suspended });
    },
    adapters: {
      bash: {
        command: id,
        help: {
          summary,
          options: [
            {
              name: "user",
              required: true,
              valueRequired: true,
              valueName: "id",
              description: "ID of the user whose address sends or stops",
            },
          ],
          examples: [`${id} --user user_123`],
        },
        parse: defineCliArgsParser(id, {
          userId: { kind: "string", option: "user", required: true },
        }),
        format: (result, options) =>
          options.format === "json" || options.print
            ? { data: result }
            : {
                data: result,
                stdout: `${result.userId}'s inbound address ${result.sendingSuspended ? "no longer sends" : "sends again"}; it still receives.\n`,
              },
      },
    },
  });
}

const suspendInboundEmailSendingTool = defineInboundEmailSendingTool({
  id: "admin.inbound-email.suspend-sending",
  name: "inboundEmailSuspendSending",
  suspended: true,
  description:
    "Stop a person sending from their inbound email address, such as after spam complaints. It still receives. A recipient marking their email as spam does this on its own.",
  summary: "admin.inbound-email.suspend-sending stops a person sending from their inbound address.",
});

const resumeInboundEmailSendingTool = defineInboundEmailSendingTool({
  id: "admin.inbound-email.resume-sending",
  name: "inboundEmailResumeSending",
  suspended: false,
  description:
    "Let a person send from their inbound email address again, after support suspended it or a recipient marked their email as spam.",
  summary:
    "admin.inbound-email.resume-sending lets a person send from their inbound address again.",
});

export const adminInboundEmailRuntimeTools = [
  replaceInboundEmailTool,
  suspendInboundEmailSendingTool,
  resumeInboundEmailSendingTool,
] as const;
