import { Button, ButtonLink } from "@fragno-private/design-system/controls/button";
import { Field } from "@fragno-private/design-system/controls/field";
import { TextArea } from "@fragno-private/design-system/controls/text-area";
import { BackofficeSystemState } from "@fragno-private/design-system/feedback/system-state";
import { PageHeading } from "@fragno-private/design-system/layout/page-heading";
import { SurfaceCard, SurfacePanelBody } from "@fragno-private/design-system/layout/surface-panel";
import { env } from "cloudflare:workers";
import { Form, Link, useNavigation } from "react-router";
import { z } from "zod";

import type { WaitingQuestion } from "../../workers/directory/directory";
import { canManage } from "../../workers/directory/membership";
import { deliverFirmAnswer } from "../ask/ask.server";
import { assertSameOrigin } from "../auth/session.server";
import { formatDate } from "../books/books";
import type { FormResult } from "../books/books.server";
import { FormError } from "../books/forms";
import { requireOrganization } from "../organizations/access.server";
import { organizationPath } from "../organizations/paths";
import { PlaceList } from "../shell/place-list";
import type { Route } from "./+types/dashboard";
import { confirmClients } from "./clients.server";

export function meta({ loaderData }: Route.MetaArgs) {
  return [{ title: `Clients · ${loaderData?.firmName ?? "Firm"}` }];
}

/**
 * The firm's clients, and the questions their administrations' agents ask the firm. The firm
 * manages its clients in Backoffice, so every member of the firm opens each one, with their role in
 * the firm, owners as admins, and answers their questions.
 */
export async function loader({ request, params }: Route.LoaderArgs) {
  const { organization, roles } = await requireOrganization(request, params.slug, "firm");
  await confirmClients(request, organization.id);
  const directory = env.DIRECTORY.getByName("directory");
  const clients = await directory.listClients(organization.id);
  return {
    firmName: organization.name,
    questions: await directory.listWaitingQuestions(organization.id),
    clients: clients.map(({ name, kind, slug }) => ({
      name,
      path: organizationPath(kind, slug),
      member: true,
    })),
    canCreate: canManage(roles),
  };
}

export function headers() {
  return { "Cache-Control": "private, no-store" };
}

/** The intent answering question `id` reports its result under. */
function answerIntent(id: string) {
  return `answer:${id}`;
}

const answerSchema = z.object({
  question: z.string().min(1),
  // Absent when a member sends the answer kept for the question again.
  answer: z.string().trim().min(1, "Write an answer before sending.").max(4000).optional(),
});

/**
 * A member answers a question a client's agent asked the firm: the first answer is kept, then goes
 * into the administration's conversation for the agent to pass on, and the question stops waiting.
 * Should delivering fail, the dashboard sends the kept answer again, which arrives once.
 */
export async function action({ request, params }: Route.ActionArgs): Promise<FormResult> {
  const { organization, user } = await requireOrganization(request, params.slug, "firm");
  assertSameOrigin(request);
  const form = Object.fromEntries(await request.formData());
  // Each question's form shows only its own result.
  const intent = answerIntent(typeof form.question === "string" ? form.question : "");
  const parsed = answerSchema.safeParse(form);
  if (!parsed.success) {
    return { intent, error: parsed.error.issues[0]?.message ?? "Check the answer." };
  }
  const { question: id, answer } = parsed.data;
  const directory = env.DIRECTORY.getByName("directory");
  const claimed = await directory.claimAnswer({
    firmId: organization.id,
    id,
    answer:
      answer === undefined ? null : { text: answer, answeredBy: user.name, answeredAt: Date.now() },
  });
  if (claimed === null) {
    return { intent, error: "This question was answered already." };
  }
  const refusal = await deliverFirmAnswer({
    administration: claimed.administration,
    questionId: id,
    question: claimed.question,
    answer: claimed.answer.text,
    answeredBy: claimed.answer.answeredBy,
    firmName: organization.name,
  });
  if (refusal !== null) {
    return { intent, error: `The answer was not sent: ${refusal}` };
  }
  await directory.markAnswerDelivered({ id, deliveredAt: Date.now() });
  if (answer !== undefined && !claimed.kept) {
    return {
      intent,
      error: `An earlier answer, by ${claimed.answer.answeredBy}, was sent instead.`,
    };
  }
  return { intent, error: null };
}

/** A question a client's agent asks the firm, with the conversation it came from and its answer. */
function QuestionCard({
  question,
  actionData,
}: {
  question: WaitingQuestion;
  actionData: FormResult | undefined;
}) {
  const navigation = useNavigation();
  const answering = navigation.formData?.get("question") === question.id;
  const conversation = `/w/${question.client.slug}/a/${question.administration.slug}/ask`;
  return (
    <SurfaceCard>
      <SurfacePanelBody>
        <p className="text-xs text-[var(--bo-muted)]">
          {question.client.name} · {question.administration.name} · asked{" "}
          {formatDate(new Date(question.askedAt).toISOString().slice(0, 10))} ·{" "}
          <Link to={conversation} className="text-[var(--bo-accent-fg)] hover:underline">
            Open the conversation
          </Link>
        </p>
        <p className="mt-2 text-sm whitespace-pre-wrap text-[var(--bo-fg)]">{question.question}</p>
        <Form method="post" className="mt-3 space-y-2">
          <input type="hidden" name="question" value={question.id} />
          {question.answer === null ? (
            <Field
              label="Answer"
              description="The assistant passes it on in the client's conversation."
            >
              <TextArea name="answer" rows={3} required />
            </Field>
          ) : (
            // The answer is kept, but did not reach the conversation: it is the one to send.
            <div className="border-l-2 border-[var(--bo-border)] pl-3 text-sm">
              <p className="text-xs text-[var(--bo-muted)]">
                {question.answer.answeredBy} answered; it has not reached the conversation yet.
              </p>
              <p className="mt-1 whitespace-pre-wrap text-[var(--bo-fg)]">{question.answer.text}</p>
            </div>
          )}
          <div className="flex items-center justify-end gap-3">
            {answering ? null : (
              <FormError result={actionData} intent={answerIntent(question.id)} />
            )}
            <Button type="submit" variant="solid" disabled={answering}>
              {answering ? "Sending…" : question.answer === null ? "Send answer" : "Send again"}
            </Button>
          </div>
        </Form>
      </SurfacePanelBody>
    </SurfaceCard>
  );
}

export default function FirmDashboard({ loaderData, actionData, params }: Route.ComponentProps) {
  const { firmName, clients, questions, canCreate } = loaderData;
  const newClient = canCreate ? (
    <ButtonLink variant="solid" to={`/f/${params.slug}/clients/new`}>
      New client
    </ButtonLink>
  ) : null;
  return (
    <div className="space-y-6">
      <PageHeading
        eyebrow={firmName}
        title="Clients"
        meta={`The businesses whose books ${firmName} keeps. Everyone in the firm opens them.`}
        actions={clients.length > 0 ? newClient : null}
      />
      {questions.length === 0 ? null : (
        <section className="space-y-3" aria-labelledby="client-questions">
          <h2 id="client-questions" className="text-sm font-semibold text-[var(--bo-fg)]">
            Questions from clients
          </h2>
          {questions.map((question) => (
            <QuestionCard key={question.id} question={question} actionData={actionData} />
          ))}
        </section>
      )}
      {clients.length === 0 ? (
        <BackofficeSystemState
          tone="empty"
          label="Getting started"
          title="No clients yet"
          description={
            canCreate
              ? "Create a client, then invite them to their books."
              : "The firm's owners and admins create its clients."
          }
          actions={newClient}
        />
      ) : (
        <PlaceList title="All clients" icon="briefcase" places={clients} />
      )}
    </div>
  );
}
