import { createHash } from "node:crypto";

import type { BackofficeContextScope } from "@fragno-dev/backoffice-api/v0/shared/scope";
import { defineWorkflow, NonRetryableError } from "@fragno-dev/workflows/workflow";
import { z } from "zod";

import type { BackofficeRuntimeServices } from "@/backoffice-runtime/runtime-services";

import { ONBOARDING_QUESTIONS, ONBOARDING_WORKFLOW_NAME } from "./contracts";

const onboardingWorkflowParamsSchema = z.strictObject({ userId: z.string().min(1) });

export type OnboardingWorkflowParams = z.output<typeof onboardingWorkflowParamsSchema>;

/**
 * The ID of an organization onboarding creates, at its position among them. It derives from the
 * instance, as an idempotency key does, so a repeated creation step, even one whose checkpoint a
 * restart discarded, finds the organization the first attempt made.
 */
function onboardingOrganizationId(userId: string, position: string): string {
  const digest = createHash("sha256").update(`onboarding:${userId}:${position}`).digest("hex");
  return `onboarding-${digest.slice(0, 32)}`;
}

/**
 * Onboards one person, a question at a time: what they use Backoffice for, unless they already
 * belong to an organization, and where their Durable Objects are kept, which every organization
 * they set up then shares. Each organization is created as soon as it is named; an agency names its
 * clients one by one until it finishes. Finishing creates their personal scope. It runs in System's
 * Automations, so nothing in the person's own scope exists before they choose its jurisdiction.
 */
export function defineOnboardingWorkflow(config: {
  ownerScope: BackofficeContextScope;
  runtime: BackofficeRuntimeServices | undefined;
}) {
  return defineWorkflow(
    { name: ONBOARDING_WORKFLOW_NAME, schema: onboardingWorkflowParamsSchema },
    async (event, step) => {
      const { runtime } = config;
      if (config.ownerScope.kind !== "system" || !runtime) {
        throw new NonRetryableError("Onboarding runs only in System's Automations.");
      }
      const auth = runtime.objects.auth.singleton().commands;
      const { userId } = event.payload;

      /** Waits for the onboarding page to answer the question, which it validated before sending. */
      const ask = async <TSchema extends z.ZodType>(
        question: { event: string; schema: TSchema },
        stepName: string,
      ): Promise<z.output<TSchema>> => {
        const { payload } = await step.waitForEvent(stepName, { type: question.event });
        const answer = question.schema.safeParse(payload);
        if (!answer.success) {
          throw new NonRetryableError(`Onboarding received an invalid answer: ${answer.error}`);
        }
        return answer.data;
      };

      const { member } = await step.do("find the person's organizations", async () => ({
        member: (await auth.listAccountOrganizations({ userId })).length > 0,
      }));
      // Someone who already belongs to an organization, such as one that invited them, sets none up.
      const { usage } = member
        ? { usage: "personal" as const }
        : await ask(ONBOARDING_QUESTIONS.usage, "choose how Backoffice is used");
      const { jurisdiction } = await ask(
        ONBOARDING_QUESTIONS.jurisdiction,
        "choose a jurisdiction",
      );
      // Organizations keep their objects where their creator's are, so this comes before any.
      await step.do("fix the jurisdiction", async () => {
        await auth.chooseUserJurisdiction({ userId, jurisdiction });
      });

      if (usage === "organization") {
        const { name } = await ask(
          ONBOARDING_QUESTIONS["organization-name"],
          "name the organization",
        );
        await step.do(
          "create the organization",
          async () =>
            await auth.createUserOrganization({
              id: onboardingOrganizationId(userId, "organization"),
              userId,
              name,
            }),
        );
      }
      if (usage === "agency") {
        const { name } = await ask(ONBOARDING_QUESTIONS["agency-name"], "name the agency");
        const agency = await step.do(
          "create the agency",
          async () =>
            await auth.createUserOrganization({
              id: onboardingOrganizationId(userId, "agency"),
              userId,
              name,
            }),
        );
        // Step names number the clients: names people type may hold characters steps forbid.
        for (let client = 1; ; client += 1) {
          const { name: clientName } = await ask(
            ONBOARDING_QUESTIONS["client-name"],
            `name client ${client}`,
          );
          await step.do(
            `create client ${client}`,
            async () =>
              await auth.createManagedOrganization({
                id: onboardingOrganizationId(userId, `client:${client}`),
                userId,
                managingOrganizationId: agency.id,
                name: clientName,
              }),
          );
          const { more } = await ask(
            ONBOARDING_QUESTIONS["more-clients"],
            `offer a client after client ${client}`,
          );
          if (!more) {
            break;
          }
        }
      }
      await step.do("finish onboarding", async () => {
        await auth.finishUserOnboarding({ userId });
      });
    },
  );
}
