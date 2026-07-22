import { defineRoutes } from "@fragno-dev/core";

import { resendFragmentDefinition } from "./definition";
import { registerDomainRoutes } from "./routes/domains";
import { registerEmailRoutes } from "./routes/emails";
import { registerReceivedEmailRoutes } from "./routes/received-emails";
import { registerThreadRoutes } from "./routes/threads";
import { registerWebhookRoutes } from "./routes/webhook";

export {
  registerDomainRoutes,
  registerEmailRoutes,
  registerReceivedEmailRoutes,
  registerThreadRoutes,
  registerWebhookRoutes,
};

export const resendRoutesFactory = defineRoutes(resendFragmentDefinition).create((context) => [
  ...registerDomainRoutes(context),
  ...registerReceivedEmailRoutes(context),
  ...registerThreadRoutes(context),
  ...registerEmailRoutes(context),
  ...registerWebhookRoutes(context),
]);

export type {
  ResendDomain,
  ResendDomainDetail,
  ResendDomainRecord,
  ResendListDomainsOutput,
} from "./routes/domains";
export type {
  ResendEmailInput,
  ResendEmailRecord,
  ResendEmailSummary,
  ResendEmailDetail,
  ResendListEmailsOutput,
  ResendSendEmailInput,
} from "./routes/emails";
export type {
  ResendListReceivedEmailsOutput,
  ResendReceivedEmailRecordAttachment,
  ResendReceivedEmailDetail,
  ResendReceivedEmailSummary,
} from "./routes/received-emails";
export type {
  ResendThreadMessage,
  ResendThreadMutationOutput,
  ResendThreadReplyInput,
  ResendThreadSummary,
  ResendThreadDetail,
  ResendListThreadMessagesOutput,
  ResendListThreadsOutput,
} from "./routes/threads";
