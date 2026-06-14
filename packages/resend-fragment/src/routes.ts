import { defineRoutes } from "@fragno-dev/core";

import { resendFragmentDefinition } from "./definition";
import {
  registerDomainRoutes,
  resendDomainDetailSchema,
  resendDomainRecordSchema,
  resendDomainSchema,
  resendListDomainsOutputSchema,
} from "./routes/domains";
import {
  registerEmailRoutes,
  resendEmailRecordSchema,
  resendEmailDetailSchema,
  resendEmailSummarySchema,
  resendListEmailsOutputSchema,
  resendSendEmailInputSchema,
  resendSendEmailOutputSchema,
  resendEmailSchema,
} from "./routes/emails";
import {
  registerReceivedEmailRoutes,
  resendListReceivedEmailsOutputSchema,
  resendReceivedEmailAttachmentSchema,
  resendReceivedEmailDetailSchema,
  resendReceivedEmailSummarySchema,
} from "./routes/received-emails";
import {
  registerThreadRoutes,
  resendListThreadMessagesOutputSchema,
  resendListThreadsOutputSchema,
  resendThreadDetailSchema,
  resendThreadMessageSchema,
  resendThreadMutationOutputSchema,
} from "./routes/threads";
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

export {
  resendListDomainsOutputSchema,
  resendDomainSchema,
  resendDomainRecordSchema,
  resendDomainDetailSchema,
  resendReceivedEmailAttachmentSchema,
  resendReceivedEmailSummarySchema,
  resendReceivedEmailDetailSchema,
  resendListReceivedEmailsOutputSchema,
  resendEmailSchema,
  resendSendEmailInputSchema,
  resendEmailRecordSchema,
  resendEmailSummarySchema,
  resendEmailDetailSchema,
  resendSendEmailOutputSchema,
  resendListEmailsOutputSchema,
  resendThreadMessageSchema,
  resendThreadDetailSchema,
  resendListThreadsOutputSchema,
  resendListThreadMessagesOutputSchema,
  resendThreadMutationOutputSchema,
};

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
