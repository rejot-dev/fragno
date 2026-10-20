import {
  EmailButton,
  EmailFootnote,
  EmailParagraph,
  TransactionalEmail,
} from "@fragno-private/design-system/transactional-email";

import type { ResendSendEmailInput } from "@fragno-dev/resend-fragment";

import { render } from "@react-email/render";

import { PASSWORD_RESET_TOKEN_LIFETIME_SECONDS } from "@/fragno/auth/password-policy";

type UserPasswordResetEmailProps = {
  email: string;
  resetUrl: string;
  publicBaseUrl: string;
};

export default function UserPasswordResetEmail({
  resetUrl,
  publicBaseUrl,
}: UserPasswordResetEmailProps) {
  return (
    <TransactionalEmail
      preview="Choose a new password for your Backoffice account."
      heading="Reset your password"
      brand={{ kind: "backoffice", homeUrl: publicBaseUrl }}
      reason="You received this email because a password reset was requested for your Backoffice account. If that was not you, ignore this email. Your password will not change."
    >
      <EmailParagraph>
        Follow this link to choose a new password for your Backoffice account.
      </EmailParagraph>
      <EmailButton href={resetUrl}>Reset password</EmailButton>
      <EmailFootnote href={resetUrl}>
        This link expires {PASSWORD_RESET_TOKEN_LIFETIME_SECONDS / 60} minutes after it was
        requested and can only be used once.
      </EmailFootnote>
    </TransactionalEmail>
  );
}

UserPasswordResetEmail.PreviewProps = {
  email: "user@example.com",
  resetUrl: "https://backoffice.example/backoffice/reset-password?token=preview-token",
  publicBaseUrl: "https://backoffice.example",
} satisfies UserPasswordResetEmailProps;

export async function buildUserPasswordResetEmail(
  props: UserPasswordResetEmailProps,
): Promise<ResendSendEmailInput> {
  const message = <UserPasswordResetEmail {...props} />;
  return {
    to: props.email,
    subject: "Reset your Backoffice password",
    html: await render(message),
    text: await render(message, { plainText: true }),
    tags: [
      { name: "category", value: "transactional" },
      { name: "event", value: "password-reset" },
    ],
  };
}
