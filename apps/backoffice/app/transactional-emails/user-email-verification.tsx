import {
  EmailButton,
  EmailFootnote,
  EmailParagraph,
  TransactionalEmail,
} from "@fragno-private/design-system/transactional-email";

import type { ResendSendEmailInput } from "@fragno-dev/resend-fragment";

import { render } from "@react-email/render";

type UserEmailVerificationEmailProps = {
  email: string;
  verificationUrl: string;
  expiresInHours: number;
  publicBaseUrl: string;
};

// The default export is what `pnpm email:dev` previews.
export default function UserEmailVerificationEmail({
  verificationUrl,
  expiresInHours,
  publicBaseUrl,
}: UserEmailVerificationEmailProps) {
  return (
    <TransactionalEmail
      preview="Confirm this email address before signing in."
      heading="Verify your email"
      brand={{ kind: "backoffice", homeUrl: publicBaseUrl }}
      reason="You received this email because this address was used to create a Backoffice account. If that was not you, you can ignore it."
    >
      <EmailParagraph>Confirm this email address before signing in.</EmailParagraph>
      <EmailButton href={verificationUrl}>Verify email</EmailButton>
      <EmailFootnote href={verificationUrl}>
        This verification link expires in {expiresInHours} hours.
      </EmailFootnote>
    </TransactionalEmail>
  );
}

UserEmailVerificationEmail.PreviewProps = {
  email: "new-user@example.com",
  verificationUrl:
    "https://backoffice.example/backoffice/verify-email?userId=user_123&code=ABC12345",
  expiresInHours: 48,
  publicBaseUrl: "https://backoffice.example",
} satisfies UserEmailVerificationEmailProps;

export async function buildUserEmailVerificationEmail(
  props: UserEmailVerificationEmailProps,
): Promise<ResendSendEmailInput> {
  const message = <UserEmailVerificationEmail {...props} />;
  return {
    to: props.email,
    subject: "Verify your Backoffice email",
    html: await render(message),
    text: await render(message, { plainText: true }),
    tags: [
      { name: "category", value: "transactional" },
      { name: "event", value: "email-verification" },
    ],
  };
}
