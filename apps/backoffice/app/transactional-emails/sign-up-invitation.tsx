import {
  EmailButton,
  EmailFootnote,
  EmailParagraph,
  TransactionalEmail,
} from "@fragno-private/design-system/transactional-email";

import type { ResendSendEmailInput } from "@fragno-dev/resend-fragment";

import { render } from "@react-email/render";

type SignUpInvitationEmailProps = {
  email: string;
  invitationUrl: string;
  ttlDays: number;
  publicBaseUrl: string;
};

// The default export is what `pnpm email:dev` previews.
export default function SignUpInvitationEmail({
  email,
  invitationUrl,
  ttlDays,
  publicBaseUrl,
}: SignUpInvitationEmailProps) {
  return (
    <TransactionalEmail
      preview="Create your Backoffice account to get started."
      heading="You're invited"
      homeUrl={publicBaseUrl}
      reason="You received this email because someone invited you to Backoffice. If you were not expecting it, you can ignore it."
    >
      <EmailParagraph>Create your Backoffice account to get started.</EmailParagraph>
      <EmailButton href={invitationUrl}>Create account</EmailButton>
      <EmailFootnote href={invitationUrl}>
        This invitation expires in {ttlDays} {ttlDays === 1 ? "day" : "days"} and only works for{" "}
        {email}.
      </EmailFootnote>
    </TransactionalEmail>
  );
}

SignUpInvitationEmail.PreviewProps = {
  email: "new-user@example.com",
  invitationUrl: "https://backoffice.example/backoffice/sign-up?invitation=inv_123&code=ABC12345",
  ttlDays: 7,
  publicBaseUrl: "https://backoffice.example",
} satisfies SignUpInvitationEmailProps;

export async function buildSignUpInvitationEmail(
  props: SignUpInvitationEmailProps,
): Promise<ResendSendEmailInput> {
  const message = <SignUpInvitationEmail {...props} />;
  return {
    to: props.email,
    subject: "You're invited to Backoffice",
    html: await render(message),
    text: await render(message, { plainText: true }),
    tags: [
      { name: "category", value: "transactional" },
      { name: "event", value: "sign-up-invitation" },
    ],
  };
}
